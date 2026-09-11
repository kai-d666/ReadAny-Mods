import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ISyncBackend } from "../sync-backend";
import { REMOTE_BOOKS_ROOT } from "../sync-types";

const mockAdapter = {
  getAppDataDir: vi.fn().mockResolvedValue("/appdata"),
  getTempDir: vi.fn().mockResolvedValue("/tmp"),
  joinPath: vi.fn((...segs: string[]) => segs.join("/")),
  fileExists: vi.fn(),
  hashFile: vi.fn().mockResolvedValue(null),
  readFileBytes: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  getFileSize: vi.fn().mockResolvedValue(null),
  maxBufferedTransferBytes: undefined as number | undefined,
  writeFileBytes: vi.fn(),
  copyFile: vi.fn(),
  deleteFile: vi.fn(),
  ensureDir: vi.fn(),
  listFiles: vi.fn().mockResolvedValue([]),
};
vi.mock("../sync-adapter", () => ({
  getSyncAdapter: vi.fn(() => mockAdapter),
}));

const mockSelect = vi.fn();
const mockSetBookSyncStatus = vi.fn();
const mockUpdateBook = vi.fn();
vi.mock("../../db/database", () => ({
  getDB: vi.fn(async () => ({ select: mockSelect })),
  setBookSyncStatus: mockSetBookSyncStatus,
  updateBook: mockUpdateBook,
}));

const { syncFiles, downloadBookFile } = await import("../sync-files");

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

function createMockBackend(overrides: Record<string, unknown> = {}): ISyncBackend {
  return {
    type: "webdav",
    testConnection: vi.fn(),
    ensureDirectories: vi.fn(),
    put: vi.fn(),
    get: vi.fn().mockResolvedValue(new Uint8Array([10, 20, 30])),
    getJSON: vi.fn(),
    putJSON: vi.fn(),
    listDir: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    move: vi.fn(),
    getDisplayName: vi.fn(),
    ...overrides,
  } as ISyncBackend;
}

function bookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "book-1",
    file_path: "books/book-1.epub",
    format: "epub",
    file_hash: H1,
    cover_url: null,
    title: "Test Book",
    sync_status: "local",
    ...overrides,
  };
}

function remoteFile(name: string) {
  return { name, path: `${REMOTE_BOOKS_ROOT}/${name}`, size: 100, lastModified: 0, isDirectory: false };
}

describe("sync-files v2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockResolvedValue([]);
    mockAdapter.listFiles.mockResolvedValue([]);
    mockAdapter.maxBufferedTransferBytes = undefined;
    mockAdapter.hashFile.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns zero counts when no books exist", async () => {
    const backend = createMockBackend();
    const result = await syncFiles(backend);
    expect(result).toEqual({
      filesUploaded: 0,
      filesDownloaded: 0,
      filesUploadFailed: 0,
      filesDownloadFailed: 0,
    });
  });

  it("uploads local book files with the v2 hash-based name", async () => {
    mockSelect.mockResolvedValue([bookRow()]);
    mockAdapter.fileExists.mockResolvedValue(true);
    const backend = createMockBackend();

    const result = await syncFiles(backend);

    expect(result.filesUploaded).toBe(1);
    expect(backend.put).toHaveBeenCalledWith(
      `${REMOTE_BOOKS_ROOT}/Test Book-${H1}.epub`,
      expect.any(Uint8Array),
    );
    // 绝不出现 {title}-{uuid} 目录式上传
    expect(backend.put).not.toHaveBeenCalledWith(
      expect.stringContaining("Test Book-book-1"),
      expect.anything(),
    );
  });

  it("skips upload when the same hash already exists remotely (no duplicates)", async () => {
    mockSelect.mockResolvedValue([bookRow()]);
    mockAdapter.fileExists.mockResolvedValue(true);
    const backend = createMockBackend({
      listDir: vi.fn().mockResolvedValue([remoteFile(`Test Book-${H1}.epub`)]),
    });

    const result = await syncFiles(backend);

    expect(result.filesUploaded).toBe(0);
    expect(backend.put).not.toHaveBeenCalled();
  });

  it("never uploads cloud-excluded books (在线书源导入 = 纯本地)", async () => {
    mockSelect.mockResolvedValue([bookRow({ cloud_excluded: 1 })]);
    mockAdapter.fileExists.mockResolvedValue(true);
    const backend = createMockBackend();

    const result = await syncFiles(backend);
    expect(result.filesUploaded).toBe(0);
    expect(backend.put).not.toHaveBeenCalled();

    // 强制全量上传也不例外
    const forced = await syncFiles(backend, undefined, { forceUploadAll: true });
    expect(forced.filesUploaded).toBe(0);
    expect(backend.put).not.toHaveBeenCalled();
  });

  it("re-uploads when forceUploadAll is set even if the hash exists remotely", async () => {
    mockSelect.mockResolvedValue([bookRow()]);
    mockAdapter.fileExists.mockResolvedValue(true);
    const backend = createMockBackend({
      listDir: vi.fn().mockResolvedValue([remoteFile(`Test Book-${H1}.epub`)]),
    });

    const result = await syncFiles(backend, undefined, { forceUploadAll: true });

    expect(result.filesUploaded).toBe(1);
    expect(backend.put).toHaveBeenCalledWith(
      `${REMOTE_BOOKS_ROOT}/Test Book-${H1}.epub`,
      expect.any(Uint8Array),
    );
  });

  it("downloads a matching remote file when local file is missing and sets status local", async () => {
    mockSelect.mockResolvedValue([bookRow()]);
    mockAdapter.fileExists.mockResolvedValue(false);
    const backend = createMockBackend({
      listDir: vi.fn().mockResolvedValue([remoteFile(`Test Book-${H1}.epub`)]),
    });

    const result = await syncFiles(backend, undefined, { downloadRemoteBooks: true });

    expect(result.filesDownloaded).toBe(1);
    expect(backend.get).toHaveBeenCalledWith(`${REMOTE_BOOKS_ROOT}/Test Book-${H1}.epub`);
    expect(mockSetBookSyncStatus).toHaveBeenCalledWith("book-1", "local");
  });

  it("marks a fileless book as remote when the matching hash exists remotely (download badge)", async () => {
    mockSelect.mockResolvedValue([bookRow()]);
    mockAdapter.fileExists.mockResolvedValue(false);
    const backend = createMockBackend({
      listDir: vi.fn().mockResolvedValue([remoteFile(`Test Book-${H1}.epub`)]),
    });

    await syncFiles(backend);

    expect(mockSetBookSyncStatus).toHaveBeenCalledWith("book-1", "remote");
  });

  it("skips books without a content hash (unsyncable)", async () => {
    mockSelect.mockResolvedValue([bookRow({ file_hash: null })]);
    mockAdapter.fileExists.mockResolvedValue(true);
    const backend = createMockBackend();

    const result = await syncFiles(backend);

    expect(result.filesUploaded).toBe(0);
    expect(backend.put).not.toHaveBeenCalled();
  });

  it("does not download remote-only books unknown locally (no ghost propagation)", async () => {
    mockSelect.mockResolvedValue([bookRow({ file_hash: H2 })]);
    mockAdapter.fileExists.mockResolvedValue(false);
    const backend = createMockBackend({
      listDir: vi.fn().mockResolvedValue([remoteFile(`Remote Only-${H1}.epub`)]),
    });

    const result = await syncFiles(backend, undefined, { downloadRemoteBooks: true });

    expect(result.filesDownloaded).toBe(0);
    expect(backend.get).not.toHaveBeenCalled();
  });
});

describe("downloadBookFile v2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.getAppDataDir.mockResolvedValue("/appdata");
  });

  it("downloads via the v2 hash path and marks the book local", async () => {
    mockSelect.mockResolvedValue([
      { id: "book-1", file_hash: H1, title: "Test Book", format: "epub" },
    ]);
    mockAdapter.fileExists.mockResolvedValue(true);

    const result = await downloadBookFile(createMockBackend(), "book-1", "books/book-1.epub");

    expect(result.ok).toBe(true);
    expect(mockSetBookSyncStatus).toHaveBeenCalledWith("book-1", "local");
    expect(mockUpdateBook).toHaveBeenCalledWith("book-1", {
      filePath: "books/book-1.epub",
      syncStatus: "local",
    });
  });

  it("rejects books without a content hash", async () => {
    mockSelect.mockResolvedValue([{ id: "book-1", file_hash: null, title: "T", format: "epub" }]);

    const result = await downloadBookFile(createMockBackend(), "book-1", "books/book-1.epub");

    expect(result.ok).toBe(false);
  });
});
