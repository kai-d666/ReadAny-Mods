/**
 * Simplified sync service — incremental, per-device, JSON-based.
 *
 * Design:
 * 1. Each device writes to its own file: /readany/sync/device-{id}.json
 *    → No write conflicts between devices
 * 2. Pull all other devices' files and apply changes (last-write-wins per record)
 * 3. Push local changes since last sync
 * 4. Tombstones for deletions
 *
 * v2 终局语义(2026-09-03 用户拍板,照 Koodo):
 * - 同步只传"人类阅读记录"(高亮/笔记/书签/阅读会话)。
 * - **books 不进快照**:书库=本地拥有(导入 + 云书库手动下载),书行永不跨设备搬,
 *   重复/幽灵/吃书/双三体全部从结构上根除。
 * - AI 对话(threads/messages/skills)不进同步;书库组织(分组/标签)本地化。
 * - 记录的 book_id 是"本地书 UUID",跨设备靠【同步重构-1b】的 book_hash 映射关联。
 */

import {
  cleanupOrphanedSyncRows,
  ensureNoTransaction,
  getDB,
  getDeviceId as getLocalDeviceId,
} from "../db/database";
import { runSerializedDbTask } from "../db/write-retry";
import { getPlatformService } from "../services/platform";
import type { ISyncBackend } from "./sync-backend";
import type { SyncFilesOptions } from "./sync-files";
import type { SyncProgress } from "./sync-types";

interface SyncTableConfig {
  name: string;
  pk: string;
  timestampCol: string;
  excludeColumns?: readonly string[];
}

interface ExistingRecordState {
  timestamp: number;
  deletedAt?: number | null;
}

export interface SimpleSyncOptions {
  receiveOnly?: boolean;
  /** When true, bypass timestamp comparisons and force-apply all remote records */
  forceApply?: boolean;
  fileSyncOptions?: SyncFilesOptions;
}

/** Tables included in sync — 人类阅读记录 only(2026-09-03 用户拍板)
 * - books/threads/messages/skills/tags/book_tags/book_groups 均不进快照
 *   (书库=本地拥有;AI 对话与书库组织本地化;详情见文件头注释)
 * - reading_progress:跨设备阅读进度(按内容哈希),承接原 books.progress 的跨设备职责
 */
const SYNC_TABLES: SyncTableConfig[] = [
  { name: "highlights", pk: "id", timestampCol: "updated_at" },
  { name: "notes", pk: "id", timestampCol: "updated_at" },
  { name: "bookmarks", pk: "id", timestampCol: "updated_at" },
  { name: "reading_sessions", pk: "id", timestampCol: "updated_at" },
  { name: "reading_progress", pk: "book_hash", timestampCol: "updated_at" },
];

/** 记录表(带 book_hash):跨设备靠 hash 认亲,远端 book_id 改写为本地书 id */
const RECORD_TABLES = new Set(["highlights", "notes", "bookmarks", "reading_sessions"]);

/** Remote directory for per-device sync files */
const SYNC_DIR = "/RA_dev/sync";
const SYNC_INDEX_PATH = `${SYNC_DIR}/index.json`;

/** Build the remote path for a device's changeset file */
function deviceSyncPath(deviceId: string): string {
  return `${SYNC_DIR}/device-${deviceId}.json`;
}

interface DeviceSyncIndex {
  version: 1;
  updatedAt: number;
  devices: Record<
    string,
    {
      path: string;
      timestamp: number;
    }
  >;
}

const DB_LOCK_MAX_RETRIES = 6;
const DB_LOCK_RETRY_DELAY_MS = 500;

function isDatabaseLockedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("database is locked") || message.includes("(code: 5)");
}

function isForeignKeyConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("FOREIGN KEY constraint failed") || message.includes("(code: 787)");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function yieldToEventLoop(): Promise<void> {
  await sleep(0);
}

function shouldRunSyncCleanup(): boolean {
  try {
    return getPlatformService().isDesktop;
  } catch (err) {
    console.warn("[Sync] Failed to check platform for sync cleanup:", err);
    return false;
  }
}

const tableColumnCache = new Map<string, Set<string>>();

async function getTableColumns(
  db: Awaited<ReturnType<typeof getDB>>,
  table: string,
): Promise<Set<string>> {
  const cached = tableColumnCache.get(table);
  if (cached) return cached;

  const rows = await db.select<{ name: string }>(`PRAGMA table_info(${table})`);
  const columns = new Set(rows.map((row) => row.name));
  tableColumnCache.set(table, columns);
  return columns;
}

async function filterRecordToExistingColumns(
  db: Awaited<ReturnType<typeof getDB>>,
  table: string,
  record: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const existingColumns = await getTableColumns(db, table);
  return Object.fromEntries(
    Object.entries(record).filter(([column]) => existingColumns.has(column)),
  );
}

async function withDatabaseLockRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= DB_LOCK_MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isDatabaseLockedError(error) || attempt === DB_LOCK_MAX_RETRIES) {
        throw error;
      }

      const delay = DB_LOCK_RETRY_DELAY_MS * attempt;
      console.warn(
        `[SimpleSync] ${label} hit a locked database, retrying (${attempt}/${DB_LOCK_MAX_RETRIES}) in ${delay}ms...`,
      );
      await sleep(delay);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface TableChangeset {
  records: Record<string, unknown>[];
  deletedIds: string[];
  deletedTimestamps?: Record<string, number>;
}

export interface DeviceSyncPayload {
  deviceId: string;
  /** Unix ms timestamp of when this payload was generated */
  timestamp: number;
  /** The last sync timestamp this device used to collect changes */
  since: number;
  tables: {
    [tableName: string]: TableChangeset;
  };
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

async function getDeviceId(): Promise<string> {
  return getLocalDeviceId();
}

async function getLastSyncTimestamp(): Promise<number> {
  const db = await getDB();
  const rows = await db.select<{ value: string }>(
    "SELECT value FROM sync_metadata WHERE key = 'last_sync_at'",
  );
  return rows[0]?.value ? Number.parseInt(rows[0].value, 10) : 0;
}

async function setLastSyncTimestamp(timestamp: number): Promise<void> {
  const db = await getDB();
  await db.execute("INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('last_sync_at', ?)", [
    String(timestamp),
  ]);
}

// ---------------------------------------------------------------------------
// Collect local changes
// ---------------------------------------------------------------------------

export async function collectChanges(since: number): Promise<DeviceSyncPayload> {
  await ensureNoTransaction();
  const db = await getDB();
  if (shouldRunSyncCleanup()) {
    await cleanupOrphanedSyncRows(db);
  }
  const deviceId = await getDeviceId();
  const now = Date.now();

  const payload: DeviceSyncPayload = {
    deviceId,
    timestamp: now,
    since,
    tables: {},
  };

  for (const { name, pk, timestampCol, excludeColumns } of SYNC_TABLES) {
    const exclude = excludeColumns ?? [];

    // Build column list — SELECT * then strip excluded columns client-side,
    // or use explicit column list when exclusions exist
    let records: Record<string, unknown>[];
    if (exclude.length > 0) {
      const allRows = await db.select<Record<string, unknown>>(
        `SELECT * FROM ${name} WHERE ${timestampCol} > ?`,
        [since],
      );
      records = allRows.map((row) => {
        const filtered = { ...row };
        for (const col of exclude) delete filtered[col];
        return filtered;
      });
    } else {
      records = await db.select<Record<string, unknown>>(
        `SELECT * FROM ${name} WHERE ${timestampCol} > ?`,
        [since],
      );
    }

    let deletedIds: string[] = [];
    const deletedTimestamps: Record<string, number> = {};
    try {
      const tombstones = await db.select<{ id: string; deleted_at: number }>(
        `SELECT id, deleted_at
         FROM sync_tombstones
         WHERE table_name = ?
           AND deleted_at > ?
           AND NOT EXISTS (SELECT 1 FROM ${name} WHERE ${pk} = sync_tombstones.id)`,
        [name, since],
      );
      deletedIds = tombstones.map((t) => t.id);
      for (const t of tombstones) {
        deletedTimestamps[t.id] = t.deleted_at;
      }
    } catch {
      // sync_tombstones may not exist on older schema
    }

    if (records.length > 0 || deletedIds.length > 0) {
      payload.tables[name] = { records, deletedIds, deletedTimestamps };
    }
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Apply remote changes
// ---------------------------------------------------------------------------

export async function applyChanges(
  payload: DeviceSyncPayload,
  options: { forceApply?: boolean } = {},
): Promise<{ applied: number; skipped: number }> {
  return runSerializedDbTask(() =>
    withDatabaseLockRetry(async () => {
      await ensureNoTransaction();
      const db = await getDB();
      if (shouldRunSyncCleanup()) {
        await cleanupOrphanedSyncRows(db);
      }
      let applied = 0;
      let skipped = 0;
      // 每设备应用指针:快照是覆盖式全量,重复同步只走指针之后的记录。
      const lastApplied = options.forceApply
        ? 0
        : await getLastAppliedTs(db, payload.deviceId);

      // Keep this transaction-free. On some adapters, explicit BEGIN/COMMIT can
      // lose state across awaited calls and end with "cannot commit - no transaction is active".
      for (const tableInfo of SYNC_TABLES) {
        const tableName = tableInfo.name;
        const tableData = payload.tables[tableName];
        if (!tableData) continue;

        const { pk, timestampCol } = tableInfo;
        const exclude = tableInfo.excludeColumns ?? [];
        // 指针过滤:已应用时间戳之前/等于的记录与墓碑不再重复处理
        const freshRecords = tableData.records.filter(
          (record) => (record[timestampCol] as number) > lastApplied,
        );
        const freshDeletedIds = tableData.deletedIds.filter(
          (id) => (tableData.deletedTimestamps?.[id] ?? 0) > lastApplied,
        );
        if (freshRecords.length === 0 && freshDeletedIds.length === 0) {
          console.log(
            `[SimpleSync] Table ${tableName} from ${payload.deviceId}: already applied (pointer=${lastApplied}), skipping`,
          );
          continue;
        }
        console.log(
          `[SimpleSync] Applying table ${tableName}: ${freshRecords.length} record(s), ${freshDeletedIds.length} deletion(s)`,
        );
        const allIdsToCheck = [
          ...freshRecords.map((record) => record[pk]).filter((value) => value !== undefined),
          ...freshDeletedIds,
        ];
        const existingRecords = await loadExistingRecordStates(
          db,
          tableName,
          pk,
          timestampCol,
          allIdsToCheck,
        );
        const remoteRecordIds = new Set(
          freshRecords
            .map((record) => record[pk])
            .filter((value) => value !== undefined)
            .map(String),
        );
        // 记录表按 book_hash 认亲:远端记录的书 id 是"对方设备的书 UUID",
        // 书行不跨设备,必须先映射到本地同 hash 的书,记录才有宿主。
        const bookHashToLocalId = await buildBookHashMap(db, tableName, freshRecords);
        let processedRecords = 0;

        for (const record of freshRecords) {
          const pkValue = record[pk];
          const remoteTs = record[timestampCol] as number;

          const safeRecord =
            exclude.length > 0
              ? Object.fromEntries(Object.entries(record).filter(([k]) => !exclude.includes(k)))
              : record;

          const localState = existingRecords.get(String(pkValue));
          if (!options.forceApply && !shouldApplyRemoteRecord(record, timestampCol, localState)) {
            skipped++;
          } else {
            let recordToApply = safeRecord;
            if (RECORD_TABLES.has(tableName)) {
              const remoteHash = typeof record.book_hash === "string" ? record.book_hash : "";
              if (remoteHash) {
                const localBookId = bookHashToLocalId.get(remoteHash);
                if (!localBookId) {
                  console.log(
                    `[SimpleSync] Skipping ${tableName}/${String(pkValue)}: book hash ${remoteHash.slice(0, 12)}… is not present locally`,
                  );
                  skipped++;
                  continue;
                }
                if (String(safeRecord.book_id) !== localBookId) {
                  recordToApply = { ...safeRecord, book_id: localBookId };
                }
                if (
                  !options.forceApply &&
                  (await isDuplicateRecord(db, tableName, localBookId, recordToApply))
                ) {
                  console.log(
                    `[SimpleSync] Skipping duplicate ${tableName}/${String(pkValue)} at cfi ${String(recordToApply.cfi ?? "")}`,
                  );
                  skipped++;
                  continue;
                }
              } else {
                // 旧格式记录(无 book_hash)没有宿主,插入必然 FK 失败(759 次日志刷屏);
                // 前置跳过,不再逐条试插。
                skipped++;
                continue;
              }
            }
            try {
              await upsertRecord(db, tableName, recordToApply, pk);
              applied++;
              existingRecords.set(String(pkValue), {
                timestamp: remoteTs,
                deletedAt: normalizeDeletedAt(record.deleted_at),
              });
            } catch (error) {
              if (isForeignKeyConstraintError(error)) {
                console.warn(
                  `[SimpleSync] Skipping orphaned ${tableName} record ${String(pkValue)}: ${error instanceof Error ? error.message : String(error)}`,
                );
                skipped++;
                continue;
              }
              throw error;
            }
          }

          processedRecords++;
          if (processedRecords % 100 === 0) {
            console.log(
              `[SimpleSync] Applying table ${tableName}: ${processedRecords}/${freshRecords.length} record(s) processed`,
            );
            await yieldToEventLoop();
          }
        }

        for (const deletedId of freshDeletedIds) {
          if (remoteRecordIds.has(String(deletedId))) {
            console.warn(
              `[SimpleSync] Ignoring stale tombstone for live ${tableName}/${deletedId} from device ${payload.deviceId}`,
            );
            skipped++;
            continue;
          }

          const deletedAt = tableData.deletedTimestamps?.[deletedId] ?? 0;
          if (!options.forceApply && deletedAt > 0) {
            const localState = existingRecords.get(String(deletedId));
            const localTs = localState?.timestamp;
            if (localTs !== undefined && localTs > deletedAt) {
              console.log(
                `[SimpleSync] Skipping deletion of ${tableName}/${deletedId}: local record is newer (${localTs} > ${deletedAt})`,
              );
              skipped++;
              continue;
            }
          }
          await db.execute(`DELETE FROM ${tableName} WHERE ${pk} = ?`, [deletedId]);
          if (deletedAt > 0) {
            await rememberRemoteTombstone(db, tableName, deletedId, deletedAt, payload.deviceId);
          }
          applied++;
          existingRecords.set(String(deletedId), {
            timestamp: deletedAt,
          });
        }

        console.log(
          `[SimpleSync] Finished table ${tableName}: applied=${applied}, skipped=${skipped}`,
        );
      }

      // 全部表应用成功 → 推进该设备指针(下次快照只处理更新的记录)
      if (!options.forceApply) {
        await setLastAppliedTs(db, payload.deviceId, payload.timestamp);
      }

      return { applied, skipped };
    }, "apply remote changes"),
  );
}

/**
 * 每设备"最后已应用"指针(全局同步提速,2026-09-03):
 * 设备快照是覆盖式全量,重复同步会对同一批记录反复走 DB 应用。
 * 指针 = 已成功应用的 payload.timestamp,之后再收到的该设备快照中
 * 更旧的记录/墓碑直接跳过(近似幂等,不回滚旧版本)。forceApply 忽略指针。
 */
async function getLastAppliedTs(
  db: Awaited<ReturnType<typeof getDB>>,
  deviceId: string,
): Promise<number> {
  try {
    const rows = await db.select<{ value: string }>(
      "SELECT value FROM sync_metadata WHERE key = ?",
      [`last_applied_${deviceId}`],
    );
    return rows[0]?.value ? Number.parseInt(rows[0].value, 10) : 0;
  } catch {
    return 0;
  }
}

async function setLastAppliedTs(
  db: Awaited<ReturnType<typeof getDB>>,
  deviceId: string,
  ts: number,
): Promise<void> {
  try {
    await db.execute(
      "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES (?, ?)",
      [`last_applied_${deviceId}`, String(ts)],
    );
  } catch {
    // sync_metadata may not exist on older schema variants.
  }
}

/**
 * 记录表远端 book_hash → 本地同 hash 书 id 的映射(一次批量查询)。
 * 映射不到 = 本地还没有这本书 → 该记录无宿主,跳过(与 Koodo 一致:
 * 记录只依附于"我已拥有的书")。
 */
async function buildBookHashMap(
  db: Awaited<ReturnType<typeof getDB>>,
  tableName: string,
  records: Record<string, unknown>[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!RECORD_TABLES.has(tableName)) return map;

  const hashes = new Set<string>();
  for (const record of records) {
    const hash = record.book_hash;
    if (typeof hash === "string" && hash) hashes.add(hash);
  }
  if (hashes.size === 0) return map;

  const chunkSize = 200;
  for (let offset = 0; offset < hashes.size; offset += chunkSize) {
    const chunk = [...hashes].slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await db.select<{ id: string; file_hash: string }>(
      `SELECT id, file_hash FROM books WHERE file_hash IN (${placeholders}) AND deleted_at IS NULL`,
      chunk,
    );
    for (const row of rows) map.set(row.file_hash, row.id);
  }
  return map;
}

/**
 * 同书同位置的记录去重:同一本书(按 hash)两端各自标了同一位置时,
 * 远端那一条不应再插一份。键=书 id+cfi+内容标识;reading_sessions 天然独立不去重。
 */
async function isDuplicateRecord(
  db: Awaited<ReturnType<typeof getDB>>,
  tableName: string,
  bookId: string,
  record: Record<string, unknown>,
): Promise<boolean> {
  const cfi = typeof record.cfi === "string" ? record.cfi : "";
  if (!cfi) return false;

  if (tableName === "highlights") {
    const text = String(record.text ?? "");
    const rows = await db.select<{ id: string }>(
      "SELECT id FROM highlights WHERE book_id = ? AND cfi = ? AND text = ? LIMIT 1",
      [bookId, cfi, text],
    );
    return rows.length > 0;
  }
  if (tableName === "bookmarks") {
    const label = String(record.label ?? "");
    const rows = await db.select<{ id: string }>(
      "SELECT id FROM bookmarks WHERE book_id = ? AND cfi = ? AND COALESCE(label, '') = ? LIMIT 1",
      [bookId, cfi, label],
    );
    return rows.length > 0;
  }
  if (tableName === "notes") {
    const title = String(record.title ?? "");
    const content = String(record.content ?? "");
    const rows = await db.select<{ id: string }>(
      "SELECT id FROM notes WHERE book_id = ? AND COALESCE(cfi, '') = ? AND title = ? AND content = ? LIMIT 1",
      [bookId, cfi, title, content],
    );
    return rows.length > 0;
  }
  return false;
}

async function upsertRecord(
  db: Awaited<ReturnType<typeof getDB>>,
  table: string,
  record: Record<string, unknown>,
  pk: string,
): Promise<void> {
  const filteredRecord = await filterRecordToExistingColumns(db, table, record);
  const columns = Object.keys(filteredRecord);
  if (columns.length === 0 || !columns.includes(pk)) return;

  const values = Object.values(filteredRecord);
  const placeholders = columns.map(() => "?").join(", ");
  const updateColumns = columns.filter((c) => c !== pk);
  const updateSet = updateColumns.map((c) => `${c} = excluded.${c}`).join(", ");

  if (updateColumns.length === 0) {
    await db.execute(
      `INSERT INTO ${table} (${columns.join(", ")})
       VALUES (${placeholders})
       ON CONFLICT(${pk}) DO NOTHING`,
      values,
    );
    return;
  }

  await db.execute(
    `INSERT INTO ${table} (${columns.join(", ")})
     VALUES (${placeholders})
     ON CONFLICT(${pk}) DO UPDATE SET ${updateSet}`,
    values,
  );
}

function normalizeDeletedAt(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "number" ? value : Number(value) || null;
}

function shouldApplyRemoteRecord(
  record: Record<string, unknown>,
  timestampCol: string,
  localState: ExistingRecordState | undefined,
): boolean {
  if (!localState) return true;

  const remoteTs = record[timestampCol] as number;
  if (remoteTs > localState.timestamp) return true;
  if (remoteTs < localState.timestamp) return false;

  // Preserved book deletes are represented as regular rows with deleted_at set.
  // When timestamps tie, let the newer delete marker break the tie so devices
  // cannot stay split between live and deleted copies of the same book.
  if (!Object.prototype.hasOwnProperty.call(record, "deleted_at")) return false;

  const remoteDeletedAt = normalizeDeletedAt(record.deleted_at);
  const localDeletedAt = localState.deletedAt ?? null;
  if (remoteDeletedAt === undefined || remoteDeletedAt === localDeletedAt) return false;

  return (remoteDeletedAt ?? 0) > (localDeletedAt ?? 0);
}

async function rememberRemoteTombstone(
  db: Awaited<ReturnType<typeof getDB>>,
  tableName: string,
  id: string,
  deletedAt: number,
  deviceId: string,
): Promise<void> {
  try {
    await db.execute(
      `INSERT INTO sync_tombstones (id, table_name, deleted_at, device_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id, table_name) DO UPDATE SET
         deleted_at = CASE
           WHEN excluded.deleted_at > sync_tombstones.deleted_at
           THEN excluded.deleted_at
           ELSE sync_tombstones.deleted_at
         END,
         device_id = CASE
           WHEN excluded.deleted_at > sync_tombstones.deleted_at
           THEN excluded.device_id
           ELSE sync_tombstones.device_id
         END`,
      [id, tableName, deletedAt, deviceId],
    );
  } catch {
    // sync_tombstones may not exist on older schema variants.
  }
}

async function loadExistingRecordStates(
  db: Awaited<ReturnType<typeof getDB>>,
  tableName: string,
  pk: string,
  timestampCol: string,
  ids: unknown[],
): Promise<Map<string, ExistingRecordState>> {
  const states = new Map<string, ExistingRecordState>();
  if (ids.length === 0) return states;

  const columns = await getTableColumns(db, tableName);
  const deletedAtSelect = columns.has("deleted_at") ? ", deleted_at AS deleted_at" : "";

  const chunkSize = 200;
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const chunk = ids.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await db.select<{
      id: string;
      timestamp: number | null;
      deleted_at?: number | null;
    }>(
      `SELECT ${pk} AS id, ${timestampCol} AS timestamp${deletedAtSelect} FROM ${tableName} WHERE ${pk} IN (${placeholders})`,
      chunk,
    );

    for (const row of rows) {
      states.set(String(row.id), {
        timestamp: row.timestamp ?? 0,
        deletedAt: normalizeDeletedAt(row.deleted_at),
      });
    }
  }

  try {
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const tombstones = await db.select<{ id: string; deleted_at: number }>(
        `SELECT id, deleted_at
         FROM sync_tombstones
         WHERE table_name = ?
           AND id IN (${placeholders})`,
        [tableName, ...chunk],
      );
      for (const tombstone of tombstones) {
        const id = String(tombstone.id);
        const deletedAt = tombstone.deleted_at ?? 0;
        const existing = states.get(id);
        if (!existing || deletedAt > existing.timestamp) {
          states.set(id, {
            timestamp: deletedAt,
          });
        }
      }
    }
  } catch {
    // sync_tombstones may not exist on older schema variants.
  }

  return states;
}

// ---------------------------------------------------------------------------
// Remote file helpers
// ---------------------------------------------------------------------------

async function loadDeviceSyncIndex(backend: ISyncBackend): Promise<DeviceSyncIndex | null> {
  try {
    const index = await backend.getJSON<DeviceSyncIndex>(SYNC_INDEX_PATH);
    if (!index || index.version !== 1 || !index.devices || typeof index.devices !== "object") {
      return null;
    }
    return index;
  } catch (error) {
    console.warn(
      `[SimpleSync] Failed to load remote device index: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function listRemoteDeviceFiles(
  backend: ISyncBackend,
): Promise<{ deviceId: string; path: string }[]> {
  const deviceFilesById = new Map<string, { deviceId: string; path: string }>();
  const index = await loadDeviceSyncIndex(backend);
  if (index) {
    for (const [deviceId, entry] of Object.entries(index.devices)) {
      if (!entry?.path) continue;
      deviceFilesById.set(deviceId, { deviceId, path: entry.path });
    }
    console.log(
      `[SimpleSync] Remote device index listed ${deviceFilesById.size} device snapshot candidate(s)`,
    );
  }

  try {
    const files = await backend.listDir(SYNC_DIR);
    const deviceFiles = files
      .filter((f) => !f.isDirectory && f.name.startsWith("device-") && f.name.endsWith(".json"))
      .map((f) => ({
        deviceId: f.name.replace(/^device-/, "").replace(/\.json$/, ""),
        path: f.path || `${SYNC_DIR}/${f.name}`,
      }));
    for (const file of deviceFiles) {
      deviceFilesById.set(file.deviceId, file);
    }

    console.log(
      `[SimpleSync] Remote sync dir listed ${files.length} item(s), ${deviceFiles.length} device snapshot candidate(s)`,
    );
  } catch (error) {
    console.warn(
      `[SimpleSync] Failed to list remote device snapshots: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return [...deviceFilesById.values()];
}

async function saveDeviceSnapshot(
  backend: ISyncBackend,
  deviceId: string,
  payload: DeviceSyncPayload,
): Promise<void> {
  const path = deviceSyncPath(deviceId);
  await backend.putJSON(path, payload);
  try {
    const existingIndex = await loadDeviceSyncIndex(backend);
    const nextIndex: DeviceSyncIndex = {
      version: 1,
      updatedAt: Date.now(),
      devices: {
        ...(existingIndex?.devices ?? {}),
        [deviceId]: {
          path,
          timestamp: payload.timestamp,
        },
      },
    };
    await backend.putJSON(SYNC_INDEX_PATH, nextIndex);
    console.log(
      `[SimpleSync] Updated remote device index with ${Object.keys(nextIndex.devices).length} device(s)`,
    );
  } catch (error) {
    console.warn(
      `[SimpleSync] Failed to update remote device index (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main sync entry point
// ---------------------------------------------------------------------------

export async function runSimpleSync(
  backend: ISyncBackend,
  onProgress?: (progress: SyncProgress) => void,
  options: SimpleSyncOptions = {},
): Promise<{
  success: boolean;
  changes: number;
  filesUploaded: number;
  filesDownloaded: number;
  filesUploadFailed: number;
  filesDownloadFailed: number;
  error?: string;
}> {
  try {
    const { receiveOnly = false, forceApply = false } = options;
    onProgress?.({
      phase: "database",
      operation: receiveOnly ? "download" : "upload",
      completedFiles: 0,
      totalFiles: 0,
      message: "准备同步...",
    });

    const lastSync = await getLastSyncTimestamp();
    const localDeviceId = await getDeviceId();
    const now = Date.now();

    // 1. Ensure remote sync directory exists
    onProgress?.({
      phase: "database",
      operation: receiveOnly ? "download" : "upload",
      completedFiles: 0,
      totalFiles: 0,
      message: "检查远程目录...",
    });
    try {
      await backend.ensureDirectories();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`无法创建远程同步目录，请检查存储服务配置和权限：${msg}`);
    }

    // 2. Pull and apply all other devices' changesets
    onProgress?.({
      phase: "database",
      operation: "download",
      completedFiles: 0,
      totalFiles: 0,
      message: "获取其他设备的变更...",
    });
    const remoteFiles = await listRemoteDeviceFiles(backend);
    console.log(`[SimpleSync] Found ${remoteFiles.length} remote device snapshot(s)`);

    let totalApplied = 0;
    let skippedRemoteSnapshots = 0;
    for (const { deviceId, path } of remoteFiles) {
      // Skip our own file
      if (deviceId === localDeviceId) continue;

      let payload: DeviceSyncPayload | null;
      try {
        console.log(`[SimpleSync] Downloading changes from device ${deviceId}...`);
        payload = await backend.getJSON<DeviceSyncPayload>(path);
      } catch (e) {
        skippedRemoteSnapshots++;
        console.warn(
          `[SimpleSync] Skipping unreadable remote snapshot from device ${deviceId}: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }

      if (!payload) continue;
      try {
        console.log(
          `[SimpleSync] Downloaded device ${deviceId}: ${Object.keys(payload.tables).length} table(s)`,
        );

        onProgress?.({
          phase: "database",
          operation: "download",
          completedFiles: 0,
          totalFiles: 0,
          message: `应用设备 ${deviceId.slice(0, 8)} 的变更...`,
        });
        const result = await applyChanges(payload, { forceApply });
        console.log(
          `[SimpleSync] Applied device ${deviceId}: applied=${result.applied}, skipped=${result.skipped}`,
        );
        totalApplied += result.applied;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.warn(`[SimpleSync] Failed to apply changes from device ${deviceId}: ${error}`);
        throw e;
      }
    }

    if (skippedRemoteSnapshots > 0) {
      console.warn(
        `[SimpleSync] Skipped ${skippedRemoteSnapshots} unreadable remote device snapshot(s)`,
      );
    }

    // 3. Collect and push local changes
    let changeCount = 0;
    if (!receiveOnly) {
      onProgress?.({
        phase: "database",
        operation: "upload",
        completedFiles: 0,
        totalFiles: 0,
        message: "收集本地变更...",
      });
      const localDelta = await collectChanges(lastSync);
      let snapshotPayload: DeviceSyncPayload | null = null;
      const getSnapshotPayload = async () => {
        snapshotPayload ??= await collectChanges(0);
        return snapshotPayload;
      };

      changeCount = Object.values(localDelta.tables).reduce(
        (sum, t) => sum + t.records.length + t.deletedIds.length,
        0,
      );

      try {
        if (changeCount > 0 || totalApplied > 0) {
          onProgress?.({
            phase: "database",
            operation: "upload",
            completedFiles: 0,
            totalFiles: 0,
            message: `上传 ${changeCount + totalApplied} 条变更...`,
          });
          await saveDeviceSnapshot(backend, localDeviceId, await getSnapshotPayload());
        } else {
          // Keep a full snapshot on the server so devices that sync later can still
          // bootstrap from this device even when there are no new local changes.
          const existing = await backend
            .getJSON<DeviceSyncPayload>(deviceSyncPath(localDeviceId))
            .catch(() => null);
          if (!existing || now - existing.timestamp > 5 * 60 * 1000) {
            await saveDeviceSnapshot(backend, localDeviceId, await getSnapshotPayload());
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`上传本地变更失败，请检查网络连接或存储服务权限：${msg}`);
      }
    } else if (totalApplied > 0) {
      // receiveOnly mode: still upload merged snapshot so other devices see the result
      onProgress?.({
        phase: "database",
        operation: "upload",
        completedFiles: 0,
        totalFiles: 0,
        message: "上传合并后的快照...",
      });
      try {
        const snapshotPayload = await collectChanges(0);
        await saveDeviceSnapshot(backend, localDeviceId, snapshotPayload);
        console.log("[SimpleSync] Uploaded merged snapshot after receive-only sync");
      } catch (e) {
        console.warn("[SimpleSync] Failed to upload merged snapshot (non-fatal):", e);
      }
    }

    // 4. Sync book files and covers
    let filesUploaded = 0;
    let filesDownloaded = 0;
    let filesUploadFailed = 0;
    let filesDownloadFailed = 0;
    onProgress?.({
      phase: "files",
      operation: receiveOnly ? "download" : "upload",
      completedFiles: 0,
      totalFiles: 0,
      message: "同步书籍和封面文件...",
    });
    try {
      const { syncFiles } = await import("./sync-files");
      const defaultFileOptions: SyncFilesOptions = receiveOnly
        ? {
            downloadRemoteBooks: true,
            disableUploads: true,
            disableRemoteDeletes: true,
          }
        : {};
      const fileResult = await syncFiles(
        backend,
        (progress) => {
          onProgress?.(progress);
        },
        { ...defaultFileOptions, ...options.fileSyncOptions },
      );
      filesUploaded = fileResult.filesUploaded;
      filesDownloaded = fileResult.filesDownloaded;
      filesUploadFailed = fileResult.filesUploadFailed;
      filesDownloadFailed = fileResult.filesDownloadFailed;
      console.log(
        `[SimpleSync] File sync: ${filesUploaded} uploaded, ${filesDownloaded} downloaded, ` +
          `${filesUploadFailed} upload-failed, ${filesDownloadFailed} download-failed`,
      );
    } catch (e) {
      console.warn("[SimpleSync] File sync failed (non-fatal):", e);
      // Don't fail the whole sync if file sync fails — but flag it so the UI
      // can surface that the file-sync phase didn't complete cleanly.
      filesUploadFailed = Math.max(filesUploadFailed, 1);
    }

    // 5. Update last sync timestamp
    await setLastSyncTimestamp(now);

    onProgress?.({
      phase: "database",
      operation: receiveOnly ? "download" : "upload",
      completedFiles: 0,
      totalFiles: 0,
      message: "同步完成",
    });
    return {
      success: true,
      changes: changeCount + totalApplied,
      filesUploaded,
      filesDownloaded,
      filesUploadFailed,
      filesDownloadFailed,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[SimpleSync] Sync failed:", error);
    return {
      success: false,
      changes: 0,
      filesUploaded: 0,
      filesDownloaded: 0,
      filesUploadFailed: 0,
      filesDownloadFailed: 0,
      error,
    };
  }
}
