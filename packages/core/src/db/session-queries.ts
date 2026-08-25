import type { ReadingSession } from "../types/reading";
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

export async function insertReadingSession(session: ReadingSession): Promise<void> {
  const database = await getDB();
  const now = Date.now();
  const deviceId = await getDeviceId();
  const syncVersion = await nextSyncVersion(database, "reading_sessions");
  // UPSERT: a session can be re-saved (e.g. saveCurrentSession racing stopSession)
  // with the same id — id is the PK. Conflict → update instead of failing.
  await database.execute(
    "INSERT INTO reading_sessions (id, book_id, started_at, ended_at, total_active_time, pages_read, characters_read, state, updated_at, sync_version, last_modified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, total_active_time = excluded.total_active_time, pages_read = excluded.pages_read, characters_read = excluded.characters_read, state = excluded.state, updated_at = excluded.updated_at, sync_version = excluded.sync_version, last_modified_by = excluded.last_modified_by",
    [
      session.id,
      session.bookId,
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
