/**
 * Sync file operations — v2 (Koodo 式):平铺单文件布局 + 内容哈希身份。
 *
 * Remote layout (v2): /RA_dev/data/books/{书名}-{内容SHA256}.{ext}
 *   - 同一本书(内容一致)跨设备必然同名 → 重复从结构上不可能
 *   - 封面同 stem 不同扩展名(COVER_EXTENSIONS 区分)
 *   - 本地布局不变:{appData}/books/{id}.{ext} + covers/{id}.{ext}
 *   - 旧布局({title}-{uuid} 目录 / legacy file/cover)不再读写,只存在于旧根
 *   - 不做:目录迁移/孤儿删除/别名接管/远端文件删除(云 = 备份+中转语义,
 *     本地删除书不删远端文件;远端文件的删除由用户在清理入口显式管理)
 */

import { getDB } from "../db/database";
import { canonicalBookFilePath } from "./local-book-paths";
import { getSyncAdapter } from "./sync-adapter";
import type { ISyncBackend, RemoteFile } from "./sync-backend";
import {
  buildBookRemoteFileNameV2,
  isCoverFileName,
  parseV2FileName,
} from "./sync-naming";
import { parallelLimit } from "./sync-transfer";
import {
  REMOTE_BOOKS_ROOT,
  type SyncProgress,
} from "./sync-types";

const UPLOAD_CONCURRENCY = 3;
const DOWNLOAD_CONCURRENCY = 5;

export interface SyncFilesOptions {
  forceUploadAll?: boolean;
  forceDownloadAll?: boolean;
  downloadRemoteBooks?: boolean;
  disableUploads?: boolean;
  disableRemoteDeletes?: boolean;
}

function isAbsoluteOrProtocolPath(path: string): boolean {
  return /^(file|asset|http|content|blob|data|appdata):\/\//i.test(path) || path.startsWith("/");
}

function getExt(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

function isDirectFileTransferUnsupported(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /not support|unsupported|not implemented|method not allowed|405/i.test(msg);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export async function uploadFileToRemote(
  backend: ISyncBackend,
  remotePath: string,
  localPath: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<number | null> {
  const adapter = getSyncAdapter();
  if (backend.putFile) {
    try {
      await backend.putFile(remotePath, localPath, onProgress);
      return null;
    } catch (e) {
      if (!isDirectFileTransferUnsupported(e)) throw e;
      console.warn(
        `[Sync] Direct upload unsupported for ${remotePath}; falling back to buffered upload`,
      );
    }
  }

  if (adapter.maxBufferedTransferBytes != null) {
    const fileSize = await adapter.getFileSize(localPath);
    if (fileSize != null && fileSize > adapter.maxBufferedTransferBytes) {
      throw new Error(
        `Buffered upload would exceed platform memory limit for ${remotePath}: ${formatBytes(fileSize)} > ${formatBytes(adapter.maxBufferedTransferBytes)}`,
      );
    }
  }

  const data = await adapter.readFileBytes(localPath);
  onProgress?.(0, data.length);
  await backend.put(remotePath, data);
  onProgress?.(data.length, data.length);
  return data.length;
}

export async function downloadRemoteFileToPath(
  backend: ISyncBackend,
  remotePath: string,
  localPath: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<number | null> {
  const adapter = getSyncAdapter();
  const bytes = await backend.get(remotePath);
  onProgress?.(0, bytes.length);
  await adapter.writeFileBytes(localPath, bytes);
  onProgress?.(bytes.length, bytes.length);
  return bytes.length;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export async function hashFileSafe(filePath: string): Promise<string | null> {
  try {
    const adapter = getSyncAdapter();
    if (adapter.hashFile) return await adapter.hashFile(filePath);
    const bytes = await adapter.readFileBytes(filePath);
    const hash = await globalThis.crypto?.subtle?.digest(
      "SHA-256",
      bytes.buffer as ArrayBuffer,
    );
    if (!hash) return null;
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    console.warn(`[Sync] Failed to hash ${filePath}:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

type FileTask = {
  label: string;
  sizeBytes?: number | null;
  run: (onProgress?: (loaded: number, total: number) => void) => Promise<boolean>;
};

// ---------------------------------------------------------------------------
// BookInfo + 远端扫描
// ---------------------------------------------------------------------------

interface BookRow {
  id: string;
  file_path: string | null;
  format: string | null;
  file_hash: string | null;
  cover_url: string | null;
  title: string | null;
  sync_status: string | null;
}

interface BookInfo {
  book: BookRow & { file_hash: string };
  fileExt: string;
  coverExt: string;
  localFilePath: string;
  localCoverPath: string;
  remoteFileName: string;
  remoteCoverFileName: string;
  hasFile: boolean;
  hasCover: boolean;
}

/** 远端 v2 目录的单文件槽位:同 hash 最多一书文件 + 一封面(扩展名不同) */
export interface RemoteV2FileEntry {
  fileName: string;
  size: number | null;
}

/** 远端 v2 目录的一次扫描结果:hash → {书文件?, 封面文件?} */
export type RemoteV2Index = Map<
  string,
  {
    book: RemoteV2FileEntry | null;
    cover: RemoteV2FileEntry | null;
  }
>;

export async function scanRemoteV2Index(backend: ISyncBackend): Promise<RemoteV2Index> {
  const index: RemoteV2Index = new Map();
  let entries: RemoteFile[] = [];
  try {
    entries = await backend.listDir(REMOTE_BOOKS_ROOT);
  } catch (e) {
    console.warn(`[Sync] Failed to list remote book dir; assuming empty:`, e);
    return index;
  }
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const parsed = parseV2FileName(entry.name);
    if (!parsed) continue; // 旧布局/未知文件不参与 v2 列表
    const slot = index.get(parsed.hash) ?? { book: null, cover: null };
    const fileEntry: RemoteV2FileEntry = {
      fileName: entry.name,
      size: isPositiveFiniteNumber(entry.size) ? entry.size : null,
    };
    // isCoverFileName 以文件名入参(按其内部扩展名判定)
    if (isCoverFileName(entry.name)) slot.cover ??= fileEntry;
    else slot.book ??= fileEntry;
    index.set(parsed.hash, slot);
  }
  return index;
}

// ---------------------------------------------------------------------------
// syncFiles — v2 主流程
// ---------------------------------------------------------------------------

export async function syncFiles(
  backend: ISyncBackend,
  onProgress?: (progress: SyncProgress) => void,
  options: SyncFilesOptions = {},
): Promise<{
  filesUploaded: number;
  filesDownloaded: number;
  filesUploadFailed: number;
  filesDownloadFailed: number;
}> {
  const syncFilesStart = Date.now();
  console.log("[Sync] 📁 Starting file sync (v2 layout)…");

  const adapter = getSyncAdapter();
  const db = await getDB();
  const { setBookSyncStatus } = await import("../db/database");
  const {
    forceUploadAll = false,
    forceDownloadAll = false,
    downloadRemoteBooks = false,
    disableUploads = false,
  } = options;
  let filesUploaded = 0;
  let filesDownloaded = 0;
  let filesUploadFailed = 0;
  let filesDownloadFailed = 0;

  const books = await db.select<BookRow>(
    "SELECT id, file_path, format, file_hash, cover_url, title, sync_status FROM books WHERE deleted_at IS NULL",
    [],
  );

  const appDataDir = await adapter.getAppDataDir();

  // --- 补算缺失的 file_hash(SHA-256):v2 身份依赖内容哈希 ---
  if (books.some((b) => !b.file_hash)) {
    const { updateBook } = await import("../db/database");
    await Promise.all(
      books
        .filter((b) => !b.file_hash && b.file_path)
        .map(async (b) => {
          const rel = canonicalBookFilePath(b.id, b.file_path ?? "", b.format ?? "epub");
          if (!rel) return;
          const h = await hashFileSafe(adapter.joinPath(appDataDir, rel));
          if (h) {
            b.file_hash = h;
            try {
              await updateBook(b.id, { fileHash: h });
            } catch {}
          }
        }),
    );
  }

  // --- 本地文件存在性与大小 ---
  const infos: BookInfo[] = [];
  const allLocalPaths: string[] = [];
  for (const book of books) {
    const canonicalFilePath = canonicalBookFilePath(book.id, book.file_path ?? "", book.format ?? "epub");
    const fileExt = canonicalFilePath ? getExt(canonicalFilePath) || "epub" : "";
    const coverExt = book.cover_url ? getExt(book.cover_url) || "jpg" : "";
    const localFilePath = canonicalFilePath ? adapter.joinPath(appDataDir, canonicalFilePath) : "";
    const localCoverPath = book.cover_url
      ? isAbsoluteOrProtocolPath(book.cover_url)
        ? book.cover_url
        : adapter.joinPath(appDataDir, book.cover_url)
      : "";
    infos.push({
      book: book as BookInfo["book"],
      fileExt,
      coverExt,
      localFilePath,
      localCoverPath,
      remoteFileName: book.file_hash ? buildBookRemoteFileNameV2(book.title, book.file_hash, fileExt) : "",
      remoteCoverFileName: book.file_hash && coverExt ? buildBookRemoteFileNameV2(book.title, book.file_hash, coverExt) : "",
      hasFile: !!canonicalFilePath,
      hasCover: !!book.cover_url,
    });
    if (localFilePath) allLocalPaths.push(localFilePath);
    if (localCoverPath) allLocalPaths.push(localCoverPath);
  }

  const existsResults = await Promise.all(allLocalPaths.map((p) => adapter.fileExists(p)));
  const sizeResults = await Promise.all(
    allLocalPaths.map((p, i) => (existsResults[i] ? adapter.getFileSize(p) : Promise.resolve(null))),
  );
  const localExistsMap = new Map(allLocalPaths.map((p, i) => [p, existsResults[i]]));
  const localSizeMap = new Map(allLocalPaths.map((p, i) => [p, sizeResults[i]]));

  // --- 远端扫描(一次 listDir;解析 v2 文件) ---
  const remoteIndex = await scanRemoteV2Index(backend);
  console.log(`[Sync] Remote v2 index: ${remoteIndex.size} file(s)`);

  const uploadTasks: FileTask[] = [];
  const downloadTasks: FileTask[] = [];

  for (const info of infos) {
    const { book } = info;
    const hash = book.file_hash?.toLowerCase();
    if (!hash) {
      console.warn(`[Sync] Book ${book.id} has no file_hash; skipping (cannot identify)`);
      continue;
    }

    const hashFileIndex = remoteIndex.get(hash);
    const remoteFileExists = !!hashFileIndex?.book;
    const localFileExists = info.hasFile && (localExistsMap.get(info.localFilePath) ?? false);
    const localFileSize = localSizeMap.get(info.localFilePath) ?? null;

    // --- 书文件 ---
    if (info.hasFile && info.fileExt) {
      if (!disableUploads && localFileExists && (forceUploadAll || !remoteFileExists)) {
        const remotePath = `${REMOTE_BOOKS_ROOT}/${info.remoteFileName}`;
        const sizeBytes = localFileSize;
        uploadTasks.push({
          label: `📤 ${book.title} (${info.remoteFileName})`,
          sizeBytes,
          run: async (onProgress) => {
            try {
              console.log(`[Sync] Uploading ${book.title} → ${remotePath}`);
              await uploadFileToRemote(backend, remotePath, info.localFilePath, onProgress);
              return true;
            } catch (e) {
              console.warn(`[Sync] ✗ Upload failed ${book.title}:`, e instanceof Error ? e.message : String(e));
              return false;
            }
          },
        });
      }

      if (
        remoteFileExists &&
        !localFileExists &&
        (forceDownloadAll || (downloadRemoteBooks && !localFileExists))
      ) {
        const remoteBook = hashFileIndex!.book!;
        const remotePath = `${REMOTE_BOOKS_ROOT}/${remoteBook.fileName}`;
        downloadTasks.push({
          label: `📥 ${book.title} (${remoteBook.fileName})`,
          sizeBytes: remoteBook.size,
          run: async (onProgress) => {
            try {
              console.log(`[Sync] Downloading ${book.title} ← ${remotePath}`);
              const ok = await downloadRemoteFileToPath(
                backend,
                remotePath,
                info.localFilePath,
                onProgress,
              );
              if (ok !== null) {
                await setBookSyncStatus(book.id, "local");
              }
              return ok !== null;
            } catch (e) {
              console.warn(`[Sync] ✗ Download failed ${book.title}:`, e instanceof Error ? e.message : String(e));
              return false;
            }
          },
        });
      } else if (!localFileExists && remoteFileExists) {
        try {
          await setBookSyncStatus(book.id, "remote");
        } catch {}
      }
    }

    // --- 封面 ---
    // ⚠️ 封面必须伴随书文件上传:"未下载书"(本地只有封面、书文件缺失)
    // 的封面会孤零零上云(云端凭空多出"只有 jpg"的空壳书,是本崩溃的根)。
    if (info.hasCover && info.coverExt && info.remoteCoverFileName) {
      const localCoverExists = localExistsMap.get(info.localCoverPath) ?? false;
      const localCoverSize = localSizeMap.get(info.localCoverPath) ?? null;
      const remoteCoverExists = !!remoteIndex.get(hash)?.cover;
      if (localFileExists && !disableUploads && localCoverExists && (forceUploadAll || !remoteCoverExists)) {
        const remoteCoverPath = `${REMOTE_BOOKS_ROOT}/${info.remoteCoverFileName}`;
        uploadTasks.push({
          label: `🖼 ${book.title} cover`,
          sizeBytes: localCoverSize,
          run: async (onProgress) => {
            console.log(`[Sync] Uploading cover ${book.title} → ${remoteCoverPath}`);
            const ok = await uploadFileToRemote(backend, remoteCoverPath, info.localCoverPath, onProgress);
            return ok !== null || true;
          },
        });
      }
    }
  }

  // --- 执行任务 ---
  onProgress?.({
    phase: "files",
    operation: "upload",
    completedFiles: 0,
    totalFiles: uploadTasks.length,
    totalTransferBytes: uploadTasks.reduce((s, t) => s + (t.sizeBytes ?? 0), 0),
    message: `上传 ${uploadTasks.length} 个文件…`,
  });
  const uploadResults = (await parallelLimit(
    uploadTasks.map((t) => t.run),
    UPLOAD_CONCURRENCY,
  ).catch(() => [] as boolean[])) as boolean[];
  filesUploaded = uploadResults.filter(Boolean).length;
  filesUploadFailed = uploadTasks.length - filesUploaded;

  onProgress?.({
    phase: "files",
    operation: "download",
    completedFiles: 0,
    totalFiles: downloadTasks.length,
    totalTransferBytes: downloadTasks.reduce((s, t) => s + (t.sizeBytes ?? 0), 0),
    message: `下载 ${downloadTasks.length} 个文件…`,
  });
  const downloadResults = (await parallelLimit(
    downloadTasks.map((t) => t.run),
    DOWNLOAD_CONCURRENCY,
  ).catch(() => [] as boolean[])) as boolean[];
  filesDownloaded = downloadResults.filter(Boolean).length;
  filesDownloadFailed = downloadTasks.length - filesDownloaded;

  // 远端"新书"(hash 不在本地任何书里)不是错误——只是未被登记,P2 云端列表功能处理
  const localHashes = new Set(infos.map((i) => i.book.file_hash?.toLowerCase()).filter(Boolean));
  const remoteOnly = [...remoteIndex.keys()].filter((h) => !localHashes.has(h));
  if (remoteOnly.length > 0) {
    console.log(`[Sync] ${remoteOnly.length} remote book file(s) not in local library (skipped)`);
  }

  console.log(
    `[Sync] ✅ File sync (v2) completed in ${Date.now() - syncFilesStart}ms: ` +
      `uploaded=${filesUploaded}, downloaded=${filesDownloaded}`,
  );
  return {
    filesUploaded,
    filesDownloaded,
    filesUploadFailed,
    filesDownloadFailed,
  };
}

// ---------------------------------------------------------------------------
// 单书下载(下载按钮/打开远程书入口) — v2 路径
// ---------------------------------------------------------------------------

export async function downloadBookFile(
  backend: ISyncBackend,
  bookId: string,
  filePath: string,
  onProgress?: (progress: { downloaded: number; total: number }) => void,
): Promise<{ ok: boolean; error?: string; localPath?: string }> {
  const adapter = getSyncAdapter();
  const db = await getDB();
  const { setBookSyncStatus, updateBook } = await import("../db/database");

  const rows = await db.select<{ id: string; file_hash: string | null; title: string | null; format: string | null }>(
    "SELECT id, file_hash, title, format FROM books WHERE id = ?",
    [bookId],
  );
  const book = rows[0] ?? null;
  if (!book) return { ok: false, error: "Book not found" };
  if (!book.file_hash) return { ok: false, error: "Book has no content hash" };

  const localRelativePath = canonicalBookFilePath(book.id, filePath, book.format ?? "epub");
  if (!localRelativePath) return { ok: false, error: "Missing local path" };
  const localPath = adapter.joinPath(await adapter.getAppDataDir(), localRelativePath);
  const ext = getExt(localRelativePath) || "epub";
  const remotePath = `${REMOTE_BOOKS_ROOT}/${buildBookRemoteFileNameV2(book.title, book.file_hash, ext)}`;

  onProgress?.({ downloaded: 0, total: 100 });
  try {
    await downloadRemoteFileToPath(backend, remotePath, localPath, (loaded, total) =>
      onProgress?.({ downloaded: Math.round((loaded / Math.max(1, total)) * 100), total: 100 }),
    );
    await setBookSyncStatus(book.id, "local");
    await updateBook(book.id, { filePath: localRelativePath, syncStatus: "local" });
    onProgress?.({ downloaded: 100, total: 100 });
    return { ok: true, localPath };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[Sync] downloadBookFile failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
