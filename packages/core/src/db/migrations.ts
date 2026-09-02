/**
 * Database migration management — platform-agnostic via IDatabase
 */
import type { IDatabase } from "../services/platform";
import { getPlatformService } from "../services/platform";
import { getDatabaseFilePath } from "./database";

interface Migration {
  version: number;
  description: string;
  up: string | string[]; // single or multiple SQL statements
}

const migrations: Migration[] = [
  {
    version: 1,
    description: "Initial schema",
    up: "", // schema.sql handles initial creation via initDatabase
  },
  {
    version: 2,
    description: "Add format column to books",
    up: "ALTER TABLE books ADD COLUMN format TEXT NOT NULL DEFAULT 'epub'",
  },
  {
    version: 3,
    description: "Add segment_cfis column to chunks",
    up: "ALTER TABLE chunks ADD COLUMN segment_cfis TEXT",
  },
  {
    version: 4,
    description: "Add sync_status column to books for on-demand download",
    up: "ALTER TABLE books ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local'",
  },
  {
    version: 5,
    description: "Add updated_at column to chunks for sync",
    up: "ALTER TABLE chunks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;",
  },
  {
    version: 6,
    description: "Create reading_sessions table in main DB for sync",
    up: `
      CREATE TABLE IF NOT EXISTS reading_sessions (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        total_active_time INTEGER DEFAULT 0,
        pages_read INTEGER DEFAULT 0,
        state TEXT DEFAULT 'active',
        updated_at INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reading_sessions_book ON reading_sessions(book_id);
    `,
  },
  {
    version: 7,
    description: "Add characters_read column to reading_sessions",
    up: "ALTER TABLE reading_sessions ADD COLUMN characters_read INTEGER DEFAULT 0",
  },
  {
    version: 8,
    description: "Add deleted_at column to books for soft-delete history retention",
    up: `
      ALTER TABLE books ADD COLUMN deleted_at INTEGER;
      CREATE INDEX IF NOT EXISTS idx_books_deleted_at ON books(deleted_at);
    `,
  },
  {
    version: 9,
    description: "Add book groups",
    up: [
      `CREATE TABLE IF NOT EXISTS book_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT 0,
        sync_version INTEGER DEFAULT 0,
        last_modified_by TEXT
      )`,
      "ALTER TABLE books ADD COLUMN group_id TEXT",
      "CREATE INDEX IF NOT EXISTS idx_books_group ON books(group_id)",
    ],
  },
  {
    version: 10,
    description: "Add feedback table",
    up: `CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      issue_number INTEGER NOT NULL,
      issue_url TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'other',
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    )`,
  },
  {
    version: 11,
    description: "Track feedback replies",
    up: [
      "ALTER TABLE feedback ADD COLUMN has_new_reply INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE feedback ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0",
    ],
  },
  {
    version: 12,
    description: "Add user rating and reviews to books",
    up: ["ALTER TABLE books ADD COLUMN rating REAL", "ALTER TABLE books ADD COLUMN reviews TEXT"],
  },
  {
    version: 13,
    description: "Add rolling memory summary to chat threads",
    up: [
      "ALTER TABLE threads ADD COLUMN memory_summary TEXT",
      "ALTER TABLE threads ADD COLUMN memory_updated_at INTEGER",
      "ALTER TABLE threads ADD COLUMN memory_message_count INTEGER DEFAULT 0",
    ],
  },
  {
    version: 14,
    description:
      "Sync rework (Koodo-style): book_hash on record tables + reading_progress table",
    // 记录按文件内容哈希跨设备关联:书行不再进快照,记录靠 book_hash 认亲。
    // reading_progress 承接原 books.progress/current_cfi 的跨设备职责。
    up: [
      "ALTER TABLE highlights ADD COLUMN book_hash TEXT",
      "ALTER TABLE notes ADD COLUMN book_hash TEXT",
      "ALTER TABLE bookmarks ADD COLUMN book_hash TEXT",
      "ALTER TABLE reading_sessions ADD COLUMN book_hash TEXT",
      `CREATE TABLE IF NOT EXISTS reading_progress (
        book_hash TEXT PRIMARY KEY,
        cfi TEXT DEFAULT '',
        percent REAL DEFAULT 0,
        last_opened_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )`,
      "UPDATE highlights SET book_hash = (SELECT file_hash FROM books WHERE id = highlights.book_id)",
      "UPDATE notes SET book_hash = (SELECT file_hash FROM books WHERE id = notes.book_id)",
      "UPDATE bookmarks SET book_hash = (SELECT file_hash FROM books WHERE id = bookmarks.book_id)",
      "UPDATE reading_sessions SET book_hash = (SELECT file_hash FROM books WHERE id = reading_sessions.book_id)",
      `INSERT OR IGNORE INTO reading_progress (book_hash, cfi, percent, last_opened_at, updated_at)
       SELECT file_hash, COALESCE(current_cfi, ''), COALESCE(progress, 0),
              COALESCE(last_opened_at, 0), COALESCE(updated_at, 0)
       FROM books
       WHERE file_hash IS NOT NULL AND file_hash != ''`,
    ],
  },
];

/** Run pending migrations */
export async function runMigrations(): Promise<void> {
  const platform = getPlatformService();
  const db: IDatabase = await platform.loadDatabase(
    `sqlite:${await getDatabaseFilePath("readany.db")}`,
  );

  // Create migrations table if not exists
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      applied_at INTEGER NOT NULL
    )
  `);

  // Get current version
  const currentVersion = await getSchemaVersion();

  // Run pending migrations in order
  for (const migration of migrations) {
    if (migration.version > currentVersion && migration.up) {
      const statements = Array.isArray(migration.up) ? migration.up : [migration.up];
      for (const sql of statements) {
        try {
          await db.execute(sql);
        } catch {
          // Migration SQL may fail if already applied (e.g., column already exists)
        }
      }
      await db.execute(
        "INSERT OR REPLACE INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
        [migration.version, migration.description, Date.now()],
      );
    }
  }
}

/** Get current schema version */
export async function getSchemaVersion(): Promise<number> {
  try {
    const platform = getPlatformService();
    const db: IDatabase = await platform.loadDatabase(
      `sqlite:${await getDatabaseFilePath("readany.db")}`,
    );
    const rows = await db.select<{ max_version: number | null }>(
      "SELECT MAX(version) as max_version FROM schema_migrations",
    );
    return rows[0]?.max_version ?? 0;
  } catch {
    return 0;
  }
}
