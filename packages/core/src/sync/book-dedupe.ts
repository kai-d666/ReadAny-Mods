import { getDB } from "../db/database";
import { canonicalBookFilePath } from "./local-book-paths";
import { getSyncAdapter } from "./sync-adapter";
import type { ISyncBackend } from "./sync-backend";
import { REMOTE_BOOKS_ROOT } from "./sync-types";
import { parseV2FileName } from "./sync-naming";

/**
 * 存量重复书清理(用户拍板:修复时附带一次性清理)。
 *
 * 背景:旧同步以"本地 UUID"为同书身份,跨设备会把同一本书(各自 UUID)
 * 重复同步进库。本函数按 file_hash 分组,同内容多条中保留一条
 * (优先级:本地文件存在 > sync_status 非 remote > updated_at 最早),
 * 其余**仅当无本地文件且无任何用户数据(高亮/笔记/书签/阅读会话/标签)
 * 时才删除**,其余保守跳过并写入报告。
 *
 * 为纯数据层操作,由桌面/移动同步设置页触发。
 */

/** 云端幽灵清理报告(含云端判定结果) */
export interface GhostCleanupReport {
  /** 已删除的云端幽灵记录数(远端新目录里不存在的 remote 无文件记录) */
  removed: number;
  removedIds: string[];
  /** 云端真实存在(待下载正经书)→ 保留 */
  keptRemoteIds: string[];
  /** 无法判定(manifest 缺失):全部保留 */
  uncertainIds: string[];
  /** 防御性跳过:本地文件存在的 */
  keptWithLocalFile: string[];
  /** 防御性跳过:带标注的 */
  skippedWithAnnotations: string[];
  errors: string[];
}

/**
 * 清理"云端幽灵"记录(用户的 11 条无文件书卡问题)。
 *
 * v2 判据(安全边界):sync_status=remote 且无本地文件且无标注的 books 行,
 * 仅当该行的**内容 hash 在新布局(RA_dev/data/books,平铺 {书名}-{hash}.ext)
 * 扫描中不存在**——存在 = 另一设备最近上传的真实书(待下载),保留;
 * 行无 hash 或扫描失败 → 保守,全部保留。
 */
export async function cleanupGhostBooks(backend: ISyncBackend): Promise<GhostCleanupReport> {
  const report: GhostCleanupReport = {
    removed: 0,
    removedIds: [],
    keptRemoteIds: [],
    uncertainIds: [],
    keptWithLocalFile: [],
    skippedWithAnnotations: [],
    errors: [],
  };

  const db = await getDB();
  const adapter = getSyncAdapter();
  const appDataDir = await adapter.getAppDataDir();

  let remoteHashes: Set<string> | null = null;
  try {
    const entries = await backend.listDir(REMOTE_BOOKS_ROOT).catch(() => null);
    if (entries === null) throw new Error("listDir failed");
    const hashes = new Set<string>();
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const parsed = parseV2FileName(entry.name);
      if (parsed) hashes.add(parsed.hash);
    }
    remoteHashes = hashes;
  } catch (e) {
    // 扫描失败 → remoteHashes 保持 null → 全部保守保留,绝不误删
    console.warn("[CleanupGhosts] Failed to scan remote v2 index; will keep everything:", e);
  }

  const rows = await db.select<DedupeBookRow>(
    "SELECT id, file_hash, file_path, format, sync_status, updated_at FROM books WHERE deleted_at IS NULL AND sync_status = 'remote'",
  );

  const fileExistsCache = new Map<string, boolean>();
  async function localFileExists(row: DedupeBookRow): Promise<boolean> {
    if (fileExistsCache.has(row.id)) return fileExistsCache.get(row.id)!;
    const rel = canonicalBookFilePath(row.id, row.file_path ?? "", row.format ?? "epub");
    if (!rel) {
      fileExistsCache.set(row.id, false);
      return false;
    }
    const ok = await adapter.fileExists(adapter.joinPath(appDataDir, rel));
    fileExistsCache.set(row.id, ok);
    return ok;
  }

  async function hasAnnotations(id: string): Promise<boolean> {
    for (const table of ANNOTATION_TABLES) {
      const [countRow] = await db.select<{ c: number }>(
        `SELECT COUNT(*) AS c FROM ${table} WHERE book_id = ?`,
        [id],
      );
      if (countRow && Number(countRow.c) > 0) return true;
    }
    return false;
  }

  for (const row of rows) {
    if (remoteHashes === null) {
      report.uncertainIds.push(row.id);
      continue;
    }
    // 云端存在同 hash 文件 = 待下载真实书 → 保留。
    // hash 为空的旧行:"哈希即身份"下无法证明它云端存在 → 视作不存在,
    // 与"扫描不到"一视同仁(仍会过下面的本地文件/标注防御)。
    const hashMatched =
      !!row.file_hash && remoteHashes.has(row.file_hash.toLowerCase());
    if (hashMatched) {
      report.keptRemoteIds.push(row.id);
      continue;
    }
    if (await localFileExists(row)) {
      report.keptWithLocalFile.push(row.id);
      continue;
    }
    if (await hasAnnotations(row.id)) {
      report.skippedWithAnnotations.push(row.id);
      continue;
    }
    try {
      await db.execute("DELETE FROM books WHERE id = ? AND sync_status = 'remote'", [row.id]);
      report.removed++;
      report.removedIds.push(row.id);
    } catch (e) {
      report.errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return report;
}

/** 去重报告:success 仅当 errors 为空时视为完全成功 */
export interface DedupeBooksReport {
  /** 已删除的幽灵重复记录数 */
  removed: number;
  removedIds: string[];
  /** 保留的书 id(hash 每组一条) */
  keptIds: string[];
  /** 跳过:本地有文件的记录(可能持有真实文件,不删) */
  skippedWithLocalFile: string[];
  /** 跳过:带有用户标注/阅读会话的记录(不删,保留用户数据) */
  skippedWithAnnotations: string[];
  /** 跳过:其他原因(如删除失败) */
  errors: string[];
}

interface DedupeBookRow {
  id: string;
  file_hash: string | null;
  file_path: string | null;
  format: string | null;
  sync_status: string | null;
  updated_at: number | null;
}

const ANNOTATION_TABLES = ["highlights", "notes", "bookmarks", "reading_sessions", "book_tags"] as const;

export async function dedupeDuplicateBooksByHash(): Promise<DedupeBooksReport> {
  const report: DedupeBooksReport = {
    removed: 0,
    removedIds: [],
    keptIds: [],
    skippedWithLocalFile: [],
    skippedWithAnnotations: [],
    errors: [],
  };

  const db = await getDB();
  const adapter = getSyncAdapter();
  const appDataDir = await adapter.getAppDataDir();

  const rows = await db.select<DedupeBookRow>(
    "SELECT id, file_hash, file_path, format, sync_status, updated_at FROM books WHERE deleted_at IS NULL AND COALESCE(file_hash, '') != ''",
  );
  const byHash = new Map<string, DedupeBookRow[]>();
  for (const row of rows) {
    if (!row.file_hash) continue;
    const list = byHash.get(row.file_hash) ?? [];
    list.push(row);
    byHash.set(row.file_hash, list);
  }

  const fileExistsCache = new Map<string, boolean>();
  async function localFileExists(row: DedupeBookRow): Promise<boolean> {
    if (fileExistsCache.has(row.id)) return fileExistsCache.get(row.id)!;
    const rel = canonicalBookFilePath(row.id, row.file_path ?? "", row.format ?? "epub");
    if (!rel) {
      fileExistsCache.set(row.id, false);
      return false;
    }
    const abs = adapter.joinPath(appDataDir, rel);
    const ok = await adapter.fileExists(abs);
    fileExistsCache.set(row.id, ok);
    return ok;
  }

  async function hasAnnotations(id: string): Promise<boolean> {
    for (const table of ANNOTATION_TABLES) {
      const [countRow] = await db.select<{ c: number }>(
        `SELECT COUNT(*) AS c FROM ${table} WHERE book_id = ?`,
        [id],
      );
      if (countRow && Number(countRow.c) > 0) return true;
    }
    return false;
  }

  for (const [hash, group] of byHash) {
    if (group.length <= 1) continue;

    // 只对"无本地文件且无标注"的候选做删除判定;其余全部保守跳过
    const details = await Promise.all(
      group.map(async (row) => ({
        row,
        localFile: await localFileExists(row),
        annotated: await hasAnnotations(row.id),
      })),
    );

    // 保留优先级:有本地文件 > sync_status 非 remote > updated_at 最早
    const ranked = [...details].sort((a, b) => {
      if (a.localFile !== b.localFile) return a.localFile ? -1 : 1;
      const aRemote = a.row.sync_status === "remote" ? 1 : 0;
      const bRemote = b.row.sync_status === "remote" ? 1 : 0;
      if (aRemote !== bRemote) return aRemote - bRemote;
      return (a.row.updated_at ?? 0) - (b.row.updated_at ?? 0);
    });

    report.keptIds.push(ranked[0].row.id);

    for (const candidate of ranked.slice(1)) {
      const { row } = candidate;
      if (candidate.localFile) {
        report.skippedWithLocalFile.push(row.id);
        continue;
      }
      if (candidate.annotated) {
        report.skippedWithAnnotations.push(row.id);
        continue;
      }
      try {
        await db.execute("DELETE FROM books WHERE id = ? AND file_hash = ?", [row.id, hash]);
        report.removed++;
        report.removedIds.push(row.id);
      } catch (e) {
        report.errors.push(
          `${row.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  return report;
}
