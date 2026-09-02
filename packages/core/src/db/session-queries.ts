import type { ReadingSession } from "../types/reading";
import { resolveBookHash } from "./book-hash";
import { getDB, getDeviceId, nextSyncVersion, nextUpdatedAt } from "./db-core";

type ReadingSessionRow = {
  id: string;
  book_id: string;
  started_at: number;
  ended_at: number | null;
  total_active_time: number;
  pages_read: number;
  characters_read: number | null;
  state: string;
};

function mapReadingSessionRow(r: ReadingSessionRow): ReadingSession {
  return {
    id: r.id,
    bookId: r.book_id,
    startedAt: r.started_at,
    endedAt: r.ended_at || undefined,
    totalActiveTime: r.total_active_time,
    pagesRead: r.pages_read,
    charactersRead: r.characters_read ?? 0,
    state: r.state as ReadingSession["state"],
  };
}

export async function getReadingSessions(bookId: string): Promise<ReadingSession[]> {
  const database = await getDB();
  const rows = await database.select<ReadingSessionRow>(
    "SELECT * FROM reading_sessions WHERE book_id = ? ORDER BY started_at DESC",
    [bookId],
  );
  return rows.map(mapReadingSessionRow);
}

export async function getAllReadingSessions(): Promise<ReadingSession[]> {
  const database = await getDB();
  const rows = await database.select<ReadingSessionRow>(
    "SELECT * FROM reading_sessions ORDER BY started_at DESC",
  );
  return rows.map(mapReadingSessionRow);
}

export async function getReadingSessionsByDateRange(
  startDate: Date,
  endDate: Date,
): Promise<ReadingSession[]> {
  const database = await getDB();
  const rows = await database.select<ReadingSessionRow>(
    "SELECT * FROM reading_sessions WHERE started_at >= ? AND started_at <= ? ORDER BY started_at DESC",
    [startDate.getTime(), endDate.getTime()],
  );
  return rows.map(mapReadingSessionRow);
}

export interface ReadingSessionDayRow {
  date: string; // UTC YYYY-MM-DD
  totalActiveTimeMs: number;
  pagesRead: number;
  charactersRead: number;
  sessionsCount: number;
}

/**
 * 按 UTC 日期聚合的每日阅读行。原 getDailyStats 拉全部 session 行在 JS 侧分组
 * (大 JSON 跨桥 + 逐行循环),GROUP BY 后每日一行,传输与循环成本降一个数量级。
 */
export async function getReadingSessionsDaily(
  startAt: number,
  endAt: number,
): Promise<ReadingSessionDayRow[]> {
  const database = await getDB();
  const rows = await database.select<{
    date: string;
    t: number | null;
    p: number | null;
    ch: number | null;
    c: number | null;
  }>(
    "SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS date, SUM(total_active_time) AS t, SUM(pages_read) AS p, SUM(characters_read) AS ch, COUNT(*) AS c FROM reading_sessions WHERE started_at >= ? AND started_at <= ? GROUP BY date ORDER BY date ASC",
    [startAt, endAt],
  );
  return rows.map((r) => ({
    date: r.date,
    totalActiveTimeMs: r.t ?? 0,
    pagesRead: r.p ?? 0,
    charactersRead: r.ch ?? 0,
    sessionsCount: r.c ?? 0,
  }));
}

export interface ReadingSessionSummary {
  totalSessions: number;
  totalActiveTimeMs: number;
  totalPagesRead: number;
  totalCharactersRead: number;
  /** books.progress > 0 的书 ∪ 有 session 的书(与原 getOverallStats 逐本遍历语义一致,含软删) */
  totalBooksStarted: number;
  /** UTC 日期(YYYY-MM-DD),与原版 new Date(ms).toISOString().split("T")[0] 一致 */
  readingDays: string[];
}

/**
 * 聚合版整体统计。原 getOverallStats 逐本书 SELECT 是 N+1(实测 ~400ms),
 * 此输出由 3 条 SQL 聚合,语义与逐本遍历版完全一致:
 * - totalBooksStarted = sessions 的 DISTINCT book_id ∪ books.progress > 0
 * - readingDays 用 strftime UTC 日期,与 UTC ISO 截断等价
 */
export async function getReadingSessionSummary(): Promise<ReadingSessionSummary> {
  const database = await getDB();

  const sums = await database.select<{
    c: number | null;
    t: number | null;
    p: number | null;
    ch: number | null;
    b: number | null;
  }>(
    "SELECT COUNT(*) AS c, SUM(total_active_time) AS t, SUM(pages_read) AS p, SUM(characters_read) AS ch, COUNT(DISTINCT book_id) AS b FROM reading_sessions",
  );
  const s = sums[0] ?? { c: 0, t: 0, p: 0, ch: 0, b: 0 };

  const bookCount = await database.select<{ c: number }>(
    "SELECT (SELECT COUNT(DISTINCT book_id) FROM reading_sessions) + (SELECT COUNT(*) FROM books b WHERE b.progress > 0 AND NOT EXISTS (SELECT 1 FROM reading_sessions rs WHERE rs.book_id = b.id)) AS c",
  );

  const days = await database.select<{ date: string }>(
    "SELECT DISTINCT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS date FROM reading_sessions ORDER BY date ASC",
  );

  return {
    totalSessions: s.c ?? 0,
    totalActiveTimeMs: s.t ?? 0,
    totalPagesRead: s.p ?? 0,
    totalCharactersRead: s.ch ?? 0,
    totalBooksStarted: bookCount[0]?.c ?? 0,
    readingDays: days.map((d) => d.date),
  };
}

export async function insertReadingSession(session: ReadingSession): Promise<void> {
  const database = await getDB();
  const now = Date.now();
  // 并行取无依赖的写入元数据(各跨 JNI,串行时每次 focus 保存多 ~百 ms)
  const [deviceId, syncVersion, bookHash] = await Promise.all([
    getDeviceId(),
    nextSyncVersion(database, "reading_sessions"),
    resolveBookHash(database, session.bookId),
  ]);
  // UPSERT: a session can be re-saved (e.g. saveCurrentSession racing stopSession)
  // with the same id — id is the PK. Conflict → update instead of failing.
  await database.execute(
    "INSERT INTO reading_sessions (id, book_id, book_hash, started_at, ended_at, total_active_time, pages_read, characters_read, state, updated_at, sync_version, last_modified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, total_active_time = excluded.total_active_time, pages_read = excluded.pages_read, characters_read = excluded.characters_read, state = excluded.state, updated_at = excluded.updated_at, sync_version = excluded.sync_version, last_modified_by = excluded.last_modified_by",
    [
      session.id,
      session.bookId,
      bookHash,
      session.startedAt,
      session.endedAt || null,
      session.totalActiveTime,
      session.pagesRead,
      session.charactersRead ?? 0,
      session.state,
      now,
      syncVersion,
      deviceId,
    ],
  );
}

export async function updateReadingSession(
  id: string,
  updates: Partial<ReadingSession>,
): Promise<void> {
  const database = await getDB();
  const deviceId = await getDeviceId();
  const syncVersion = await nextSyncVersion(database, "reading_sessions");
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.endedAt !== undefined) {
    sets.push("ended_at = ?");
    values.push(updates.endedAt);
  }
  if (updates.totalActiveTime !== undefined) {
    sets.push("total_active_time = ?");
    values.push(updates.totalActiveTime);
  }
  if (updates.pagesRead !== undefined) {
    sets.push("pages_read = ?");
    values.push(updates.pagesRead);
  }
  if (updates.charactersRead !== undefined) {
    sets.push("characters_read = ?");
    values.push(updates.charactersRead);
  }
  if (updates.state !== undefined) {
    sets.push("state = ?");
    values.push(updates.state);
  }

  if (sets.length === 0) return;

  const updatedAt = await nextUpdatedAt(database, "reading_sessions", id);
  sets.push("updated_at = ?");
  values.push(updatedAt);
  sets.push("sync_version = ?");
  values.push(syncVersion);
  sets.push("last_modified_by = ?");
  values.push(deviceId);

  values.push(id);
  await database.execute(`UPDATE reading_sessions SET ${sets.join(", ")} WHERE id = ?`, values);
}
