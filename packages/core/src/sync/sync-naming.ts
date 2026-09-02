/**
 * Naming helpers for the per-book remote layout:
 *
 *     /readany/data/books/{sanitized-title}-{book.id}/{sanitized-title}.{ext}
 *
 * The folder name is `{sanitized-title}-{uuid}`; the file and cover share the
 * sanitized title as their stem and are distinguished by their extension.
 *
 * Local storage stays UUID-flat (`books/{id}.{ext}`, `covers/{id}.{ext}`).
 */

import {
  COVER_EXTENSIONS,
  REMOTE_BOOKS_ROOT,
} from "./sync-types";

const FALLBACK_TITLE = "未命名";
const MAX_TITLE_LEN = 64;
// UUID v4 form: 8-4-4-4-12 hex chars (36 chars total).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strip filesystem / WebDAV-unsafe characters, collapse whitespace,
 * cap length, and fall back to a placeholder for empty input.
 */
export function sanitizeBookTitleForFs(title: string | null | undefined): string {
  if (!title) return FALLBACK_TITLE;
  const cleaned = title
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return FALLBACK_TITLE;
  return cleaned.slice(0, MAX_TITLE_LEN);
}

/** Build the per-book remote directory: /readany/data/books/{title}-{id}. */
export function buildBookRemoteDir(book: { id: string; title?: string | null }): string {
  return `${REMOTE_BOOKS_ROOT}/${buildBookFolderName(book)}`;
}

/** Build just the folder name segment (no leading path), `{title}-{id}`. */
export function buildBookFolderName(book: { id: string; title?: string | null }): string {
  return `${sanitizeBookTitleForFs(book.title)}-${book.id}`;
}

/** File path inside the book dir, e.g. {title}.epub. */
export function buildBookRemoteFile(book: { id: string; title?: string | null }, ext: string): string {
  return `${buildBookRemoteDir(book)}/${sanitizeBookTitleForFs(book.title)}.${ext}`;
}

/** Cover path inside the book dir, e.g. {title}.jpg. */
export function buildBookRemoteCover(book: { id: string; title?: string | null }, ext: string): string {
  return `${buildBookRemoteDir(book)}/${sanitizeBookTitleForFs(book.title)}.${ext}`;
}

/**
 * Extract book.id from a folder name `{title}-{uuid}`.
 * Returns null when the trailing 36 chars do not match a UUID-v4-shaped string.
 */
export function parseBookFolderName(folderName: string): string | null {
  if (folderName.length < 37) return null;
  const candidateId = folderName.slice(-36);
  if (!UUID_RE.test(candidateId)) return null;
  if (folderName[folderName.length - 37] !== "-") return null;
  return candidateId;
}

/** Heuristic: file is a cover if its extension is a known image format. */
export function isCoverFileName(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = fileName.slice(dot + 1).toLowerCase();
  if (!ext) return false;
  return COVER_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// v2 布局(Koodo 式):{书名}-{内容哈希}.{ext} 平铺于 REMOTE_BOOKS_ROOT。
// 内容哈希(SHA-256,64 hex)即"同一本书"的跨设备身份——同名同内容必然
// 落到同一文件名,重复从结构上不可能;旧 {title}-{uuid} 目录布局不再读写。
// ---------------------------------------------------------------------------

/** v2 文件哈希段:64 位小写 hex(SHA-256)。 */
const V2_HASH_RE = /^[0-9a-f]{64}$/i;

/**
 * v2 文件名:{sanitizedTitle}-{fileHash}.{ext}
 * 例:Dune-21ab5506c8eb2ac8….epub(书名最多 64 字符,总长可控)
 */
export function buildBookRemoteFileNameV2(
  title: string | null | undefined,
  fileHash: string,
  ext: string,
): string {
  return `${sanitizeBookTitleForFs(title)}-${fileHash.toLowerCase()}.${ext.toLowerCase()}`;
}

export interface ParsedV2FileName {
  title: string;
  hash: string;
  ext: string;
}

/**
 * 解析 v2 文件名。非 v2 或非 64-hex 哈希 → null
 * (旧 {title}-{uuid}/未知文件将被视为不可识别,不参与 v2 列表)。
 */
export function parseV2FileName(fileName: string): ParsedV2FileName | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  const stem = fileName.slice(0, dot);
  const dashIdx = stem.lastIndexOf("-");
  if (dashIdx <= 0) return null;
  const hash = stem.slice(dashIdx + 1);
  if (!V2_HASH_RE.test(hash)) return null;
  return { title: stem.slice(0, dashIdx), hash: hash.toLowerCase(), ext };
}
