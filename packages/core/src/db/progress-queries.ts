/**
 * reading_progress — 按内容哈希的跨设备阅读进度(同步重构,Koodo 式)。
 * books.progress/current_cfi 保留为"本设备书行视图";reading_progress
 * 承担跨设备职责(远端书行不搬,进度靠书 hash 认亲)。
 */
import type { IDatabase } from "../services/platform";
import { getDB } from "./db-core";

export interface ReadingProgress {
  cfi: string;
  percent: number;
  lastOpenedAt: number;
  updatedAt: number;
}

/** 按内容哈希取跨设备进度;无记录 → null */
export async function getReadingProgress(
  database: IDatabase,
  bookHash: string | null | undefined,
): Promise<ReadingProgress | null> {
  if (!bookHash) return null;
  const rows = await database.select<{
    cfi: string | null;
    percent: number | null;
    last_opened_at: number | null;
    updated_at: number | null;
  }>(
    "SELECT cfi, percent, last_opened_at, updated_at FROM reading_progress WHERE book_hash = ?",
    [bookHash],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    cfi: row.cfi ?? "",
    percent: row.percent ?? 0,
    lastOpenedAt: row.last_opened_at ?? 0,
    updatedAt: row.updated_at ?? 0,
  };
}

/** 写进度(OpenBook 打开书时/读者保存位置时;跨设备同步走这张表) */
export async function saveReadingProgress(
  database: IDatabase,
  bookHash: string | null | undefined,
  input: { cfi?: string; percent?: number },
): Promise<void> {
  if (!bookHash) return;
  const now = Date.now();
  await database.execute(
    `INSERT INTO reading_progress (book_hash, cfi, percent, last_opened_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(book_hash) DO UPDATE SET
       cfi = excluded.cfi,
       percent = excluded.percent,
       last_opened_at = excluded.last_opened_at,
       updated_at = excluded.updated_at`,
    [
      bookHash,
      input.cfi ?? "",
      input.percent ?? 0,
      now,
      now,
    ],
  );
}

/** 便捷包装:按本地书 id 写入(内部解析其 file_hash) */
export async function saveReadingProgressForBook(
  bookId: string,
  input: { cfi?: string; percent?: number },
): Promise<void> {
  const database = await getDB();
  const rows = await database.select<{ file_hash: string | null }>(
    "SELECT file_hash FROM books WHERE id = ?",
    [bookId],
  );
  await saveReadingProgress(database, rows[0]?.file_hash, input);
}

/** 便捷包装:按 book_hash 读取(无需调用方持有 database) */
export async function getReadingProgressForBook(
  bookHash: string | null | undefined,
): Promise<ReadingProgress | null> {
  if (!bookHash) return null;
  const database = await getDB();
  return getReadingProgress(database, bookHash);
}

/**
 * 进度投影(2026-09-06,B1 唯一账本):书库展示用全量投影。
 * 进度只记 reading_progress(books.progress/current_cfi 不再被写入),
 * 书库/角标/排序/统计/AI 读的 book.progress 由此投影刷新。
 */
export async function getProgressProjectionMap(): Promise<
  Map<string, { cfi: string; percent: number }>
> {
  const map = new Map<string, { cfi: string; percent: number }>();
  try {
    const database = await getDB();
    const rows = await database.select<{
      book_hash: string;
      cfi: string | null;
      percent: number | null;
    }>("SELECT book_hash, cfi, percent FROM reading_progress");
    for (const row of rows) {
      map.set(row.book_hash, {
        cfi: row.cfi ?? "",
        percent: row.percent ?? 0,
      });
    }
  } catch {
    // 表不存在/初始化前,返回空投影
  }
  return map;
}
