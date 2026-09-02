import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ISyncBackend, RemoteFile } from "../sync-backend";

type Row = Record<string, unknown>;

const dbMocks = vi.hoisted(() => ({
  currentDb: null as FakeSyncDb | null,
  currentDeviceId: "device-a",
  getDB: vi.fn(),
  ensureNoTransaction: vi.fn(),
  cleanupOrphanedSyncRows: vi.fn(),
  getDeviceId: vi.fn(),
}));

vi.mock("../../db/database", () => ({
  getDB: dbMocks.getDB,
  ensureNoTransaction: dbMocks.ensureNoTransaction,
  cleanupOrphanedSyncRows: dbMocks.cleanupOrphanedSyncRows,
  getDeviceId: dbMocks.getDeviceId,
}));

vi.mock("../../db/write-retry", () => ({
  runSerializedDbTask: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

vi.mock("../../services/platform", () => ({
  getPlatformService: vi.fn(() => ({ isDesktop: false })),
}));

const syncFileMocks = vi.hoisted(() => ({
  syncFiles: vi.fn(async () => ({ filesUploaded: 0, filesDownloaded: 0 })),
}));

vi.mock("../sync-files", () => syncFileMocks);

const { applyChanges, collectChanges, runSimpleSync } = await import("../simple-sync");

const TABLE_COLUMNS: Record<string, string[]> = {
  book_groups: ["id", "name", "sort_order", "created_at", "updated_at"],
  books: [
    "id",
    "file_path",
    "format",
    "title",
    "author",
    "cover_url",
    "added_at",
    "updated_at",
    "deleted_at",
    "progress",
    "is_vectorized",
    "vectorize_progress",
    "sync_status",
  ],
  highlights: [
    "id",
    "book_id",
    "book_hash",
    "cfi",
    "text",
    "color",
    "note",
    "chapter_title",
    "created_at",
    "updated_at",
  ],
  notes: [
    "id",
    "book_id",
    "book_hash",
    "highlight_id",
    "cfi",
    "title",
    "content",
    "chapter_title",
    "tags",
    "created_at",
    "updated_at",
  ],
  bookmarks: [
    "id",
    "book_id",
    "book_hash",
    "cfi",
    "label",
    "chapter_title",
    "created_at",
    "updated_at",
  ],
  threads: [
    "id",
    "book_id",
    "title",
    "memory_summary",
    "memory_updated_at",
    "memory_message_count",
    "created_at",
    "updated_at",
  ],
  messages: ["id", "thread_id", "role", "content", "created_at"],
  skills: ["id", "name", "description", "created_at", "updated_at"],
  tags: ["id", "name", "updated_at"],
  book_tags: ["id", "book_id", "tag_id", "updated_at"],
  reading_sessions: [
    "id",
    "book_id",
    "book_hash",
    "started_at",
    "ended_at",
    "total_active_time",
    "pages_read",
    "characters_read",
    "state",
    "updated_at",
  ],
  reading_progress: ["book_hash", "cfi", "percent", "last_opened_at", "updated_at"],
};

const SYNC_TABLES = Object.keys(TABLE_COLUMNS);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class FakeSyncDb {
  readonly tables = new Map<string, Map<string, Row>>();
  readonly syncMetadata = new Map<string, string>();
  readonly tombstones = new Map<string, { id: string; table_name: string; deleted_at: number }>();

  constructor() {
    for (const table of SYNC_TABLES) {
      this.tables.set(table, new Map());
    }
  }

  insert(table: string, row: Row): void {
    this.assertKnownTable(table);
    this.assertForeignKeys(table, row);
    this.tables.get(table)?.set(String(row.id), clone(row));
  }

  patch(table: string, id: string, updates: Row): void {
    const existing = this.get(table, id);
    if (!existing) throw new Error(`Missing ${table}/${id}`);
    this.insert(table, { ...existing, ...updates });
  }

  get(table: string, id: string): Row | undefined {
    return this.tables.get(table)?.get(id);
  }

  deleteWithTombstone(table: string, id: string, deletedAt: number): void {
    this.tables.get(table)?.delete(id);
    this.tombstones.set(`${table}:${id}`, { id, table_name: table, deleted_at: deletedAt });
  }

  exportRecords(): Record<string, Row[]> {
    return Object.fromEntries(
      SYNC_TABLES.map((table) => [
        table,
        [...(this.tables.get(table)?.values() ?? [])]
          .map((row) => sortRow(row))
          .sort((a, b) => String(a.id).localeCompare(String(b.id))),
      ]),
    );
  }

  async select<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const normalized = sql.replace(/\s+/g, " ").trim();

    const pragmaMatch = normalized.match(/^PRAGMA table_info\((\w+)\)$/);
    if (pragmaMatch) {
      return (TABLE_COLUMNS[pragmaMatch[1]] ?? []).map((name) => ({ name })) as T[];
    }

    if (normalized === "SELECT value FROM sync_metadata WHERE key = 'last_sync_at'") {
      const value = this.syncMetadata.get("last_sync_at");
      return (value === undefined ? [] : [{ value }]) as T[];
    }

    const changedRowsMatch = normalized.match(/^SELECT \* FROM (\w+) WHERE (\w+) > \?$/);
    if (changedRowsMatch) {
      const [, table, timestampCol] = changedRowsMatch;
      const since = Number(params[0]);
      return [...(this.tables.get(table)?.values() ?? [])]
        .filter((row) => Number(row[timestampCol] ?? 0) > since)
        .map((row) => clone(row)) as T[];
    }

    if (
      normalized.startsWith(
        "SELECT id, deleted_at FROM sync_tombstones WHERE table_name = ? AND deleted_at > ?",
      )
    ) {
      const [tableName, since] = params;
      return [...this.tombstones.values()]
        .filter((row) => row.table_name === tableName && row.deleted_at > Number(since))
        .filter((row) => !this.tables.get(row.table_name)?.has(row.id))
        .map(({ id, deleted_at }) => ({ id, deleted_at })) as T[];
    }

    if (
      normalized.startsWith(
        "SELECT id, deleted_at FROM sync_tombstones WHERE table_name = ? AND id IN",
      )
    ) {
      const [tableName, ...ids] = params.map(String);
      const idSet = new Set(ids);
      return [...this.tombstones.values()]
        .filter((row) => row.table_name === tableName && idSet.has(row.id))
        .map(({ id, deleted_at }) => ({ id, deleted_at })) as T[];
    }

    if (normalized.startsWith("SELECT id, file_hash FROM books WHERE file_hash IN")) {
      const hashSet = new Set(params.map(String));
      const bookRows = [...(this.tables.get("books")?.values() ?? [])];
      return bookRows
        .filter((row) => row.deleted_at == null && hashSet.has(String(row.file_hash)))
        .map((row) => ({ id: row.id, file_hash: row.file_hash })) as T[];
    }

    const dupMatch = normalized.match(
      /^SELECT id FROM (\w+) WHERE book_id = \? AND cfi = \? (?:AND|AND COALESCE\()/,
    );
    if (dupMatch) {
      const [, dupTable] = dupMatch;
      const [bookId, cfi] = params.map(String);
      const rows = [...(this.tables.get(dupTable)?.values() ?? [])];
      let hit = rows.find((row) => String(row.book_id) === bookId && String(row.cfi) === cfi);
      if (hit && dupTable === "highlights") {
        hit = rows.find(
          (row) =>
            String(row.book_id) === bookId &&
            String(row.cfi) === cfi &&
            String(row.text ?? "") === String(params[2] ?? ""),
        );
      }
      if (hit && dupTable === "notes") {
        hit = rows.find(
          (row) =>
            String(row.book_id) === bookId &&
            String(row.cfi ?? "") === cfi &&
            String(row.title ?? "") === String(params[2] ?? "") &&
            String(row.content ?? "") === String(params[3] ?? ""),
        );
      }
      if (hit && dupTable === "bookmarks") {
        hit = rows.find(
          (row) =>
            String(row.book_id) === bookId &&
            String(row.cfi) === cfi &&
            String(row.label ?? "") === String(params[2] ?? ""),
        );
      }
      return (hit ? [{ id: hit.id }] : []) as T[];
    }

    const stateMatch = normalized.match(
      /^SELECT (\w+) AS id, (\w+) AS timestamp(.*?) FROM (\w+) WHERE (\w+) IN \(/,
    );
    if (stateMatch) {
      const [, pk, timestampCol, extraSelects, table] = stateMatch;
      const includeDeletedAt = extraSelects.includes("deleted_at AS deleted_at");
      const ids = new Set(params.map(String));
      return [...(this.tables.get(table)?.values() ?? [])]
        .filter((row) => ids.has(String(row[pk])))
        .map((row) => ({
          id: row[pk],
          timestamp: row[timestampCol] ?? 0,
          ...(includeDeletedAt ? { deleted_at: row.deleted_at ?? null } : {}),
        })) as T[];
    }

    throw new Error(`Unexpected select: ${normalized}`);
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized === "ROLLBACK") return;

    if (
      normalized === "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('last_sync_at', ?)"
    ) {
      this.syncMetadata.set("last_sync_at", String(params[0]));
      return;
    }

    if (normalized.startsWith("INSERT INTO sync_tombstones")) {
      const [id, tableName, deletedAt] = params;
      this.tombstones.set(`${String(tableName)}:${String(id)}`, {
        id: String(id),
        table_name: String(tableName),
        deleted_at: Number(deletedAt),
      });
      return;
    }

    const deleteMatch = normalized.match(/^DELETE FROM (\w+) WHERE (\w+) = \?$/);
    if (deleteMatch) {
      const [, table, pk] = deleteMatch;
      const id = String(params[0]);
      const row = this.tables.get(table)?.get(id);
      if (row && String(row[pk]) === id) {
        this.tables.get(table)?.delete(id);
        if (table === "books") {
          this.deleteBookDependents(id);
        }
      }
      return;
    }

    const insertMatch = normalized.match(
      /^INSERT INTO (\w+) \(([^)]+)\) VALUES \([^)]+\) ON CONFLICT\((\w+)\) DO (UPDATE SET .+|NOTHING)$/,
    );
    if (insertMatch) {
      const [, table, columnList, pk, conflictAction] = insertMatch;
      const columns = columnList.split(",").map((column) => column.trim());
      const record = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
      const key = String(record[pk]);
      const tableRows = this.tables.get(table);
      if (!tableRows) throw new Error(`Unknown table ${table}`);

      const existing = tableRows.get(key);
      if (existing && conflictAction === "NOTHING") return;

      const nextRow = existing ? { ...existing, ...record } : record;
      this.assertForeignKeys(table, nextRow);
      tableRows.set(key, clone(nextRow));
      return;
    }

    throw new Error(`Unexpected execute: ${normalized}`);
  }

  private assertKnownTable(table: string): void {
    if (!this.tables.has(table)) throw new Error(`Unknown table ${table}`);
  }

  private assertForeignKeys(table: string, row: Row): void {
    if (
      ["highlights", "notes", "bookmarks", "book_tags", "reading_sessions"].includes(table) &&
      row.book_id &&
      !this.tables.get("books")?.has(String(row.book_id))
    ) {
      throw new Error("FOREIGN KEY constraint failed");
    }

    if (
      table === "messages" &&
      row.thread_id &&
      !this.tables.get("threads")?.has(String(row.thread_id))
    ) {
      throw new Error("FOREIGN KEY constraint failed");
    }

    if (table === "book_tags" && row.tag_id && !this.tables.get("tags")?.has(String(row.tag_id))) {
      throw new Error("FOREIGN KEY constraint failed");
    }
  }

  private deleteBookDependents(bookId: string): void {
    for (const table of ["highlights", "notes", "bookmarks", "book_tags", "reading_sessions"]) {
      const rows = this.tables.get(table);
      for (const [id, row] of rows ?? []) {
        if (row.book_id === bookId) rows?.delete(id);
      }
    }
  }
}

class MemoryBackend implements ISyncBackend {
  readonly type = "webdav";
  readonly jsonFiles = new Map<string, unknown>();
  readonly unreadableJsonPaths = new Set<string>();

  async testConnection(): Promise<boolean> {
    return true;
  }

  async ensureDirectories(): Promise<void> {}

  async put(): Promise<void> {}

  async get(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  async getJSON<T>(path: string): Promise<T | null> {
    if (this.unreadableJsonPaths.has(path)) {
      throw new Error(`WebDAV GET failed for ${path}: 403 Forbidden`);
    }
    return this.jsonFiles.has(path) ? clone(this.jsonFiles.get(path) as T) : null;
  }

  async putJSON<T>(path: string, data: T): Promise<void> {
    this.jsonFiles.set(path, clone(data));
  }

  async listDir(path: string): Promise<RemoteFile[]> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    return [...this.jsonFiles.keys()]
      .filter((filePath) => filePath.startsWith(prefix))
      .map((filePath) => filePath.slice(prefix.length))
      .filter((name) => name && !name.includes("/"))
      .map((name) => ({
        name,
        path: `${prefix}${name}`,
        size: JSON.stringify(this.jsonFiles.get(`${prefix}${name}`)).length,
        lastModified: 0,
        isDirectory: false,
      }));
  }

  async delete(path: string): Promise<void> {
    this.jsonFiles.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.jsonFiles.has(path);
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const data = this.jsonFiles.get(fromPath);
    if (data === undefined) throw new Error(`MemoryBackend MOVE: source not found ${fromPath}`);
    if (this.jsonFiles.has(toPath)) {
      throw new Error(`MemoryBackend MOVE: destination exists ${toPath}`);
    }
    this.jsonFiles.set(toPath, data);
    this.jsonFiles.delete(fromPath);
  }

  async getDisplayName(): Promise<string> {
    return "Memory";
  }
}

function sortRow(row: Row): Row {
  const {
    is_vectorized: _isVectorized,
    vectorize_progress: _vectorizeProgress,
    sync_status: _syncStatus,
    ...syncedRow
  } = row;
  return Object.fromEntries(Object.entries(syncedRow).sort(([a], [b]) => a.localeCompare(b)));
}

function bookRow(overrides: Row = {}): Row {
  return {
    id: "book-1",
    file_path: "books/book-1.epub",
    format: "epub",
    title: "Original",
    author: "Author",
    cover_url: "covers/book-1.jpg",
    added_at: 1000,
    updated_at: 1000,
    deleted_at: null,
    progress: 0,
    is_vectorized: 1,
    vectorize_progress: 0.5,
    sync_status: "local",
    ...overrides,
  };
}

function highlightRow(overrides: Row = {}): Row {
  return {
    id: "hl-1",
    book_id: "book-1",
    cfi: "epubcfi(/6/2)",
    text: "Marked text",
    color: "yellow",
    note: null,
    chapter_title: "Chapter 1",
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

async function syncDevice(
  deviceId: string,
  db: FakeSyncDb,
  backend: ISyncBackend,
): Promise<Awaited<ReturnType<typeof runSimpleSync>>> {
  dbMocks.currentDeviceId = deviceId;
  dbMocks.currentDb = db;
  return runSimpleSync(backend);
}

describe("simple sync convergence (v2: records only)", () => {
  let now = 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    dbMocks.getDB.mockImplementation(async () => dbMocks.currentDb);
    dbMocks.getDeviceId.mockImplementation(async () => dbMocks.currentDeviceId);
    dbMocks.ensureNoTransaction.mockResolvedValue(undefined);
    dbMocks.cleanupOrphanedSyncRows.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dbMocks.currentDb = null;
    dbMocks.currentDeviceId = "device-a";
  });

  it("converges highlight/note records across two devices (books stay local-only)", async () => {
    const backend = new MemoryBackend();
    const deviceA = new FakeSyncDb();
    const deviceB = new FakeSyncDb();

    // 书行是本地拥有的:两台设备各自持有自己导入的书(本地同 id 仅为夹具 FK 需要)
    deviceA.insert("books", bookRow());
    deviceB.insert("books", bookRow());

    deviceA.insert("highlights", highlightRow());
    deviceA.insert("notes", {
      id: "note-1",
      book_id: "book-1",
      highlight_id: null,
      cfi: "epubcfi(/6/2)",
      title: "",
      content: "My note",
      chapter_title: "Chapter 1",
      tags: "[]",
      created_at: 1000,
      updated_at: 1000,
    });

    now = 1100;
    await syncDevice("device-a", deviceA, backend);

    now = 1200;
    await syncDevice("device-b", deviceB, backend);
    expect(deviceB.get("highlights", "hl-1")).toBeTruthy();
    expect(deviceB.get("notes", "note-1")).toBeTruthy();

    // 书行不跨设备搬:device-b 的书库不会带上 device-a 的书行之外的东西
    expect(deviceB.tables.get("books")?.size).toBe(1);

    now = 1300;
    deviceA.patch("highlights", "hl-1", { text: "Local highlight", updated_at: now });

    now = 1400;
    await syncDevice("device-a", deviceA, backend);

    now = 1500;
    await syncDevice("device-b", deviceB, backend);
    expect(deviceB.get("highlights", "hl-1")?.text).toBe("Local highlight");
    expect(deviceA.get("books", "book-1")?.title).toBe("Original");
  });

  it("ignores books table in remote payloads entirely (no insert, no delete, no overwrite)", async () => {
    const target = new FakeSyncDb();
    target.insert("books", bookRow({ title: "Local", updated_at: 2500 }));
    dbMocks.currentDb = target;
    dbMocks.currentDeviceId = "device-local";

    const result = await applyChanges({
      deviceId: "device-remote",
      timestamp: now,
      since: 0,
      tables: {
        books: {
          records: [bookRow({ updated_at: 9999, title: "Remote overwrite" })],
          deletedIds: [],
        },
      },
    });

    // books 不在 SYNC_TABLES:远端 payload 对该表的一切都被忽略
    expect(result).toEqual({ applied: 0, skipped: 0 });
    expect(target.get("books", "book-1")?.title).toBe("Local");
  });

  it("does not upsert highlights whose remote book_id is missing locally (FK guard)", async () => {
    const target = new FakeSyncDb();
    dbMocks.currentDb = target;
    dbMocks.currentDeviceId = "device-local";

    const result = await applyChanges({
      deviceId: "device-remote",
      timestamp: now,
      since: 0,
      tables: {
        highlights: {
          records: [highlightRow({ book_id: "remote-book-uuid", updated_at: 9999 })],
          deletedIds: [],
        },
      },
    });

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(target.get("highlights", "hl-1")).toBeUndefined();
  });

  it("keeps a newer local record when an older remote tombstone arrives", async () => {
    const target = new FakeSyncDb();
    target.insert("books", bookRow({ updated_at: 2500 }));
    target.insert("highlights", highlightRow({ updated_at: 2500, text: "Local newer" }));
    dbMocks.currentDb = target;
    dbMocks.currentDeviceId = "device-local";

    const result = await applyChanges({
      deviceId: "device-remote",
      timestamp: now,
      since: 0,
      tables: {
        highlights: {
          records: [],
          deletedIds: ["hl-1"],
          deletedTimestamps: { "hl-1": 2000 },
        },
      },
    });

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(target.get("highlights", "hl-1")?.text).toBe("Local newer");
  });

  it("ignores a stale tombstone when the same payload still contains a live record", async () => {
    const target = new FakeSyncDb();
    target.insert("books", bookRow());
    dbMocks.currentDb = target;
    dbMocks.currentDeviceId = "device-local";

    const result = await applyChanges({
      deviceId: "device-remote",
      timestamp: now,
      since: 0,
      tables: {
        notes: {
          records: [
            {
              id: "note-1",
              book_id: "book-1",
              highlight_id: null,
              cfi: "epubcfi(/6/2)",
              title: "",
              content: "Live note",
              chapter_title: null,
              tags: "[]",
              created_at: 1000,
              updated_at: 1000,
            },
          ],
          deletedIds: ["note-1"],
          deletedTimestamps: { "note-1": 2000 },
        },
      },
    });

    expect(result).toEqual({ applied: 1, skipped: 1 });
    expect(target.get("notes", "note-1")?.content).toBe("Live note");
  });

  it("does not upload stale tombstones for records that still exist locally", async () => {
    const source = new FakeSyncDb();
    source.insert("books", bookRow({}));
    source.insert("highlights", highlightRow({ updated_at: 1000 }));
    source.tombstones.set("highlights:hl-1", {
      id: "hl-1",
      table_name: "highlights",
      deleted_at: 2000,
    });
    dbMocks.currentDb = source;
    dbMocks.currentDeviceId = "device-source";

    const payload = await collectChanges(0);

    expect(payload.tables.highlights?.records).toHaveLength(1);
    expect(payload.tables.highlights?.deletedIds).toEqual([]);
  });

  it("keeps a remote record tombstone from being resurrected by an older device snapshot", async () => {
    const target = new FakeSyncDb();
    target.insert("books", bookRow());
    dbMocks.currentDb = target;
    dbMocks.currentDeviceId = "device-local";

    const deleted = await applyChanges({
      deviceId: "device-a",
      timestamp: 3000,
      since: 0,
      tables: {
        highlights: {
          records: [],
          deletedIds: ["hl-1"],
          deletedTimestamps: { "hl-1": 3000 },
        },
      },
    });

    const staleRecord = await applyChanges({
      deviceId: "device-b",
      timestamp: 2000,
      since: 0,
      tables: {
        highlights: {
          records: [highlightRow({ updated_at: 2000 })],
          deletedIds: [],
        },
      },
    });

    expect(deleted).toEqual({ applied: 1, skipped: 0 });
    expect(staleRecord).toEqual({ applied: 0, skipped: 1 });
    expect(target.get("highlights", "hl-1")).toBeUndefined();
    expect(target.tombstones.get("highlights:hl-1")?.deleted_at).toBe(3000);
  });

  it("uploads a refreshed snapshot after receiving remote-only changes", async () => {
    const backend = new MemoryBackend();
    const deviceB = new FakeSyncDb();
    deviceB.insert("books", bookRow());
    deviceB.syncMetadata.set("last_sync_at", "2000");

    backend.jsonFiles.set("/RA_dev/sync/device-a.json", {
      deviceId: "device-a",
      timestamp: 1000,
      since: 0,
      tables: {
        highlights: {
          records: [highlightRow({ updated_at: 1000 })],
          deletedIds: [],
        },
      },
    });

    now = 3000;
    const result = await syncDevice("device-b", deviceB, backend);

    expect(result.success).toBe(true);
    expect(deviceB.get("highlights", "hl-1")).toBeTruthy();
    expect(
      (
        backend.jsonFiles.get("/RA_dev/sync/device-device-b.json") as {
          tables: Record<string, unknown>;
        }
      ).tables,
    ).toHaveProperty("highlights");
  });

  it("downloads remote snapshots using the listed path", async () => {
    class AliasPathBackend extends MemoryBackend {
      async listDir(path: string): Promise<RemoteFile[]> {
        const files = await super.listDir(path);
        return files.map((file) =>
          file.name === "device-a.json" ? { ...file, path: "/logical/device-a.json" } : file,
        );
      }

      async getJSON<T>(path: string): Promise<T | null> {
        if (path === "/logical/device-a.json") {
          return super.getJSON<T>("/RA_dev/sync/device-a.json");
        }
        if (path === "/RA_dev/sync/device-a.json") {
          throw new Error("should use listed path");
        }
        return super.getJSON<T>(path);
      }
    }

    const backend = new AliasPathBackend();
    const deviceB = new FakeSyncDb();
    deviceB.insert("books", bookRow());

    backend.jsonFiles.set("/RA_dev/sync/device-a.json", {
      deviceId: "device-a",
      timestamp: 1000,
      since: 0,
      tables: {
        highlights: {
          records: [highlightRow({ updated_at: 1000 })],
          deletedIds: [],
        },
      },
    });

    now = 3000;
    const result = await syncDevice("device-b", deviceB, backend);

    expect(result.success).toBe(true);
    expect(deviceB.get("highlights", "hl-1")).toBeTruthy();
  });

  it("downloads remote snapshots from the device index when directory listing is empty", async () => {
    class EmptyListBackend extends MemoryBackend {
      async listDir(): Promise<RemoteFile[]> {
        return [];
      }
    }

    const backend = new EmptyListBackend();
    const deviceB = new FakeSyncDb();
    deviceB.insert("books", bookRow());

    backend.jsonFiles.set("/RA_dev/sync/index.json", {
      version: 1,
      updatedAt: 1000,
      devices: {
        "device-a": {
          path: "/RA_dev/sync/device-a.json",
          timestamp: 1000,
        },
      },
    });
    backend.jsonFiles.set("/RA_dev/sync/device-a.json", {
      deviceId: "device-a",
      timestamp: 1000,
      since: 0,
      tables: {
        highlights: {
          records: [highlightRow({ updated_at: 1000 })],
          deletedIds: [],
        },
      },
    });

    now = 3000;
    const result = await syncDevice("device-b", deviceB, backend);

    expect(result.success).toBe(true);
    expect(deviceB.get("highlights", "hl-1")).toBeTruthy();
    expect(backend.jsonFiles.get("/RA_dev/sync/index.json")).toMatchObject({
      devices: {
        "device-a": {
          path: "/RA_dev/sync/device-a.json",
        },
        "device-b": {
          path: "/RA_dev/sync/device-device-b.json",
        },
      },
    });
  });

  it("skips unreadable remote device snapshots and continues syncing", async () => {
    const backend = new MemoryBackend();
    const local = new FakeSyncDb();
    local.insert("books", bookRow({ title: "Local", updated_at: 3000 }));

    backend.jsonFiles.set("/RA_dev/sync/device-locked.json", {
      deviceId: "locked",
      timestamp: 1000,
      since: 0,
      tables: {
        notes: {
          records: [
            {
              id: "note-remote",
              book_id: "book-1",
              highlight_id: null,
              cfi: "epubcfi(/6/2)",
              title: "",
              content: "Locked remote note",
              chapter_title: null,
              tags: "[]",
              created_at: 1000,
              updated_at: 1000,
            },
          ],
          deletedIds: [],
        },
      },
    });
    backend.unreadableJsonPaths.add("/RA_dev/sync/device-locked.json");

    now = 4000;
    const result = await syncDevice("device-local", local, backend);

    expect(result.success).toBe(true);
    expect(local.get("notes", "note-remote")).toBeUndefined();
    expect(backend.jsonFiles.has("/RA_dev/sync/device-device-local.json")).toBe(true);
  });

  it("maps remote record book_id to the local book by hash (cross-device attach)", async () => {
    const target = new FakeSyncDb();
    target.insert("books", bookRow({ id: "local-book-1", file_hash: "hash-abc" }));
    dbMocks.currentDb = target;
    dbMocks.currentDeviceId = "device-local";

    const result = await applyChanges({
      deviceId: "device-remote",
      timestamp: now,
      since: 0,
      tables: {
        highlights: {
          records: [
            highlightRow({
              id: "hl-remote",
              book_id: "remote-book-uuid",
              book_hash: "hash-abc",
              updated_at: 9999,
            }),
          ],
          deletedIds: [],
        },
      },
    });

    expect(result).toEqual({ applied: 1, skipped: 0 });
    expect(target.get("highlights", "hl-remote")?.book_id).toBe("local-book-1");
  });

  it("skips remote record when its book hash is not present locally (no host book)", async () => {
    const target = new FakeSyncDb();
    dbMocks.currentDb = target;
    dbMocks.currentDeviceId = "device-local";

    const result = await applyChanges({
      deviceId: "device-remote",
      timestamp: now,
      since: 0,
      tables: {
        highlights: {
          records: [
            highlightRow({
              id: "hl-remote",
              book_id: "remote-book-uuid",
              book_hash: "hash-unknown",
              updated_at: 9999,
            }),
          ],
          deletedIds: [],
        },
      },
    });

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(target.get("highlights", "hl-remote")).toBeUndefined();
  });

  it("deduplicates a remote highlight at the same book position", async () => {
    const target = new FakeSyncDb();
    target.insert("books", bookRow({ id: "local-book-1", file_hash: "hash-abc" }));
    target.insert(
      "highlights",
      highlightRow({ id: "hl-local", book_id: "local-book-1", cfi: "epubcfi(/6/2)", text: "Marked text" }),
    );
    dbMocks.currentDb = target;
    dbMocks.currentDeviceId = "device-local";

    const result = await applyChanges({
      deviceId: "device-remote",
      timestamp: now,
      since: 0,
      tables: {
        highlights: {
          records: [
            highlightRow({
              id: "hl-remote",
              book_id: "remote-book-uuid",
              book_hash: "hash-abc",
              cfi: "epubcfi(/6/2)",
              text: "Marked text",
              updated_at: 9999,
            }),
          ],
          deletedIds: [],
        },
      },
    });

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(target.get("highlights", "hl-remote")).toBeUndefined();
    expect(target.get("highlights", "hl-local")).toBeTruthy();
  });

  it("syncs reading_progress across devices by book hash", async () => {
    const backend = new MemoryBackend();
    const deviceA = new FakeSyncDb();
    const deviceB = new FakeSyncDb();
    deviceA.insert("books", bookRow({ id: "book-1", file_hash: "hash-abc" }));
    deviceB.insert("books", bookRow({ id: "local-book-1", file_hash: "hash-abc" }));

    deviceA.insert("reading_progress", {
      book_hash: "hash-abc",
      cfi: "epubcfi(/6/14)",
      percent: 0.42,
      last_opened_at: 1000,
      updated_at: 1000,
    });

    now = 1100;
    await syncDevice("device-a", deviceA, backend);

    now = 1200;
    await syncDevice("device-b", deviceB, backend);
    expect(deviceB.get("reading_progress", "hash-abc")?.cfi).toBe("epubcfi(/6/14)");
    expect(deviceB.get("reading_progress", "hash-abc")?.percent).toBe(0.42);
    // 书行仍不跨设备
    expect(deviceB.get("books", "book-1")).toBeUndefined();
  });
});
