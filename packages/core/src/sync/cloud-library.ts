/**
 * 云书库(Koodo importDialog 式,用户拍板 2026-09-03):
 * 云端书 = 手动列表 + 手动下载;本地书 = 手动"上传云端"(绑定)。
 * 书行永不跨设备搬;云端清单按内容哈希展示;删除云端只发生在云书库页。
 *
 * 与 syncFiles 的关系:syncFiles 是"自动对账"通道(本方案中只对记录生效的
 * 是 simple-sync;文件层由本模块接管全生命周期)——上传/下载/删除全部显式。
 */
import { getDB } from "../db/database";
import { getSyncAdapter } from "./sync-adapter";
import type { ISyncBackend } from "./sync-backend";
import {
  buildBookRemoteFileNameV2,
  parseV2FileName,
} from "./sync-naming";
import { REMOTE_BOOKS_ROOT } from "./sync-types";
import {
  downloadRemoteFileToPath,
  hashFileSafe,
  scanRemoteV2Index,
  uploadFileToRemote,
} from "./sync-files";

export interface CloudBookEntry {
  /** 小写 64hex(SHA-256),跨设备"同一本书"的身份 */
  fileHash: string;
  /** 文件名解析出的书名 */
  title: string;
  /** 云端文件名:{书名}-{hash}.{ext} */
  fileName: string;
  /** 书文件字节数(封面的大小不计) */
  size: number | null;
  /** 云端带同书名封面文件 */
  hasRemoteCover: boolean;
  /** 本地已有同 hash 书行 → "已导入"状态 */
  localBookId: string | null;
}

/**
 * 列出云端书库(v2 单文件)。列表 = 书文件(封面不单列,仅作 hasRemoteCover)。
 * 按书名排序;封面行(同 hash 无书文件)不会出现。
 */
export async function listRemoteBooks(
  backend: ISyncBackend,
): Promise<CloudBookEntry[]> {
  const index = await scanRemoteV2Index(backend);
  const db = await getDB();
  const rows = await db.select<{ id: string; file_hash: string | null }>(
    "SELECT id, file_hash FROM books WHERE deleted_at IS NULL AND file_hash IS NOT NULL",
  );
  const localByHash = new Map<string, string>();
  for (const row of rows) {
    const hash = row.file_hash?.toLowerCase();
    if (hash) localByHash.set(hash, row.id);
  }

  const entries: CloudBookEntry[] = [];
  for (const [hash, slot] of index) {
    if (!slot.book) continue; // 只有封面的空壳不列表
    const parsed = parseV2FileName(slot.book.fileName);
    entries.push({
      fileHash: hash,
      title: parsed?.title || slot.book.fileName,
      fileName: slot.book.fileName,
      size: slot.book.size,
      hasRemoteCover: !!slot.cover,
      localBookId: localByHash.get(hash) ?? null,
    });
  }
  return entries.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * 从云端下载一本书(line:手动,不经对账)。
 * 返回:书文件下载到「本地 books 目录但按 v2 名称」?——不:下载到临时文件,
 * 交给 UI 层走标准导入流程(importBooks → hash 去重入库)。
 * 因此本函数产物 = 本地缓存文件路径 {临时目录}/{fileName}。
 */
export async function downloadRemoteBookToLocal(
  backend: ISyncBackend,
  fileHash: string,
  onProgress?: (progress: { downloaded: number; total: number }) => void,
): Promise<{ ok: boolean; error?: string; localPath?: string; fileName?: string }> {
  const index = await scanRemoteV2Index(backend);
  const slot = index.get(fileHash.toLowerCase());
  const bookFile = slot?.book;
  if (!bookFile) return { ok: false, error: "Cloud book not found" };

  const adapter = getSyncAdapter();
  const tmpDir = await adapter.getTempDir();
  const localPath = adapter.joinPath(tmpDir, bookFile.fileName);
  try {
    await downloadRemoteFileToPath(
      backend,
      `${REMOTE_BOOKS_ROOT}/${bookFile.fileName}`,
      localPath,
      (loaded, total) => onProgress?.({ downloaded: loaded, total }),
    );
    return { ok: true, localPath, fileName: bookFile.fileName };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[CloudLibrary] Download failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * 上传一本书到云端(绑定动作):书文件 + 封面一起上。
 * 幂等:云端已有同 hash 书文件则跳过(内容一致,无需重传);封面按需补。
 */
export async function uploadBookToCloud(
  backend: ISyncBackend,
  bookId: string,
  onProgress?: (progress: { uploaded: number; total: number }) => void,
): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const db = await getDB();
  const rows = await db.select<{
    id: string;
    title: string | null;
    file_path: string | null;
    format: string | null;
    file_hash: string | null;
    cover_url: string | null;
  }>("SELECT id, title, file_path, format, file_hash, cover_url FROM books WHERE id = ?", [
    bookId,
  ]);
  const book = rows[0];
  if (!book) return { ok: false, error: "Book not found" };
  if (!book.file_path) return { ok: false, error: "Book has no local file" };

  const adapter = getSyncAdapter();
  const appDataDir = await adapter.getAppDataDir();
  // book.file_path 已是规范相对路径(导入时归一);由 canonicalBookFilePath 处理 double 检查
  const localPath = adapter.joinPath(appDataDir, book.file_path);

  let fileHash = book.file_hash?.toLowerCase() ?? "";
  if (!fileHash) {
    fileHash = (await hashFileSafe(localPath)) ?? "";
  }
  if (!fileHash) return { ok: false, error: "Failed to hash book file" };

  const { canonicalBookFilePath } = await import("./local-book-paths");
  const relPath = canonicalBookFilePath(book.id, book.file_path, book.format ?? "epub");
  if (!relPath) return { ok: false, error: "Missing canonical book path" };
  const ext = relPath.split(".").pop()?.toLowerCase() || "epub";
  const remoteFileName = buildBookRemoteFileNameV2(book.title, fileHash, ext);
  const remotePath = `${REMOTE_BOOKS_ROOT}/${remoteFileName}`;

  const index = await scanRemoteV2Index(backend);
  const remoteHasBook = !!index.get(fileHash)?.book;
  let skipped = true;

  if (!remoteHasBook) {
    try {
      await uploadFileToRemote(backend, remotePath, localPath, (l, t) =>
        onProgress?.({ uploaded: l, total: t }),
      );
      skipped = false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Upload failed: ${msg}` };
    }
  }

  // 封面:仅当本地有封面文件且云端尚无封面
  if (book.cover_url && !isAbsolutePlan(book.cover_url)) {
    const coverExt = book.cover_url.split(".").pop()?.toLowerCase() || "jpg";
    const remoteCoverFileName = buildBookRemoteFileNameV2(book.title, fileHash, coverExt);
    const remoteCoverPath = `${REMOTE_BOOKS_ROOT}/${remoteCoverFileName}`;
    const localCoverPath = adapter.joinPath(appDataDir, book.cover_url);
    const coverExists = await adapter.fileExists(localCoverPath).catch(() => false);
    const remoteHasCover = !!index.get(fileHash)?.cover;
    if (coverExists && !remoteHasCover) {
      try {
        await uploadFileToRemote(backend, remoteCoverPath, localCoverPath, (l, t) =>
          onProgress?.({ uploaded: l, total: t }),
        );
        skipped = false;
      } catch (e) {
        // 封面失败不致命:书文件已传成功
        console.warn(`[CloudLibrary] Cover upload failed:`, e instanceof Error ? e.message : String(e));
      }
    }
  }

  return { ok: true, skipped };
}

function isAbsolutePlan(value: string): boolean {
  return /^(file|asset|http|content|blob|data|appdata):\/\//i.test(value);
}

/**
 * 从云端删除一本书:书文件 + 封面全删(用户 9/3 拍板"都删")。
 * 记录层面:云端没有集中记录库(记录经设备快照增量传播),删除后新设备
 * 不会再收到该书记录(simple-sync 对"本地无此书"的记录跳过);已有设备
 * 的本地记录不动(本地拥有)——本函数即所能达到的"全删"上界。
 */
export async function deleteRemoteBookFromCloud(
  backend: ISyncBackend,
  fileHash: string,
): Promise<{ ok: boolean; error?: string }> {
  const index = await scanRemoteV2Index(backend);
  const slot = index.get(fileHash.toLowerCase());
  if (!slot?.book && !slot?.cover) return { ok: true };
  try {
    if (slot.book) await backend.delete(`${REMOTE_BOOKS_ROOT}/${slot.book.fileName}`);
    if (slot.cover) await backend.delete(`${REMOTE_BOOKS_ROOT}/${slot.cover.fileName}`);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
