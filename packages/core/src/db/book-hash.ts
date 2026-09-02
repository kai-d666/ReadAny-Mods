/**
 * book_hash 工具:记录表(高亮/笔记/书签/会话)写库时冗余内容哈希,
 * 供跨设备记录按 hash 认亲(同步重构,Koodo 式,2026-09-03)。
 */
import type { IDatabase } from "../services/platform";

/** 查任意本地书的 file_hash(空/无该行 → null) */
export async function resolveBookHash(
  database: IDatabase,
  bookId: string | null | undefined,
): Promise<string | null> {
  if (!bookId) return null;
  const rows = await database.select<{ file_hash: string | null }>(
    "SELECT file_hash FROM books WHERE id = ? AND file_hash IS NOT NULL AND file_hash != '' LIMIT 1",
    [bookId],
  );
  return rows[0]?.file_hash ?? null;
}
