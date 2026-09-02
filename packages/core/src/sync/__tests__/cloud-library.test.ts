import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ISyncBackend, RemoteFile } from "../sync-backend";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const dbMocks = vi.hoisted(() => ({
  getDB: vi.fn(),
}));

vi.mock("../../db/database", () => ({
  getDB: dbMocks.getDB,
  // cloud-library 链路只用 getDB(其余来自 sync-files 的动静分派)
  updateBook: vi.fn(),
  setBookSyncStatus: vi.fn(),
  getDeviceId: vi.fn(async () => "device-test"),
}));

const adapterMocks = vi.hoisted(() => ({
  getTempDir: vi.fn(async () => "/tmp"),
  getAppDataDir: vi.fn(async () => "/appdata"),
  joinPath: vi.fn((...segments: string[]) => segments.join("/")),
  fileExists: vi.fn(async () => true),
  hashFile: vi.fn(async () => HASH_A),
  writeFileBytes: vi.fn(async () => {}),
  readFileBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
  getFileSize: vi.fn(async () => 123),
  maxBufferedTransferBytes: 100 * 1024 * 1024,
}));

vi.mock("../sync-adapter", () => ({
  getSyncAdapter: vi.fn(() => adapterMocks),
}));

const { listRemoteBooks, downloadRemoteBookToLocal, uploadBookToCloud, deleteRemoteBookFromCloud } =
  await import("../cloud-library");

class MemoryBackend implements ISyncBackend {
  readonly type = "webdav" as const;
  entries: RemoteFile[] = [];
  readonly files = new Map<string, Uint8Array>();
  deleted: string[] = [];
  readonly putFile = vi.fn(async (remotePath: string, _localPath: string) => {
    this.files.set(remotePath, new Uint8Array([1, 2, 3]));
  });

  async testConnection(): Promise<boolean> {
    return true;
  }
  async ensureDirectories(): Promise<void> {}
  async put(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
  }
  async get(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw new Error("404");
    return data;
  }
  async getJSON<T>(_path: string): Promise<T | null> {
    return null;
  }
  async putJSON<T>(_path: string, _data: T): Promise<void> {}
  async listDir(): Promise<RemoteFile[]> {
    return this.entries;
  }
  async delete(path: string): Promise<void> {
    this.deleted.push(path);
    this.files.delete(path);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async move(_fromPath: string, _toPath: string): Promise<void> {}
  async getDisplayName(): Promise<string> {
    return "Memory";
  }
}

function fileEntry(name: string, size = 100): RemoteFile {
  return { name, path: `/RA_dev/data/books/${name}`, size, lastModified: 0, isDirectory: false };
}

describe("cloud library (Koodo-style manual list/download/upload/delete)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.fileExists.mockResolvedValue(true);
  });

  it("lists remote v2 books with cover flag and local match", async () => {
    const backend = new MemoryBackend();
    backend.entries = [
      fileEntry(`My Book-${HASH_A}.epub`, 5000),
      fileEntry(`My Book-${HASH_A}.jpg`, 2000),
      fileEntry(`Other-${HASH_B}.epub`, 3000),
      fileEntry(`OnlyCover-${'c'.repeat(64)}.jpg`, 100), // 空壳封面不列表
    ];
    dbMocks.getDB.mockResolvedValue({
      select: vi.fn(async () => [{ id: "local-book-1", file_hash: HASH_A }]),
    });

    const entries = await listRemoteBooks(backend);

    expect(entries).toHaveLength(2);
    const byHash = new Map(entries.map((e) => [e.fileHash, e]));
    expect(byHash.get(HASH_A)).toMatchObject({
      title: "My Book",
      size: 5000,
      hasRemoteCover: true,
      localBookId: "local-book-1",
    });
    expect(byHash.get(HASH_B)).toMatchObject({ title: "Other", hasRemoteCover: false, localBookId: null });
    // 排序:My Book < Other
    expect(entries[0].title).toBe("My Book");
  });

  it("downloads a remote book file into the temp dir", async () => {
    const backend = new MemoryBackend();
    backend.entries = [fileEntry(`My Book-${HASH_A}.epub`)];
    backend.files.set(`/RA_dev/data/books/My Book-${HASH_A}.epub`, new Uint8Array([9, 9]));

    const result = await downloadRemoteBookToLocal(backend, HASH_A);

    expect(result.ok).toBe(true);
    expect(result.localPath).toBe("/tmp/My Book-a….epub".replace("a…", HASH_A));
    expect(result.fileName).toBe(`My Book-${HASH_A}.epub`);
    expect(adapterMocks.writeFileBytes).toHaveBeenCalled();
  });

  it("fails download when the hash is not in the cloud index", async () => {
    const backend = new MemoryBackend();
    backend.entries = [];
    const result = await downloadRemoteBookToLocal(backend, HASH_A);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it("uploads a book (file + cover) to the cloud when absent", async () => {
    const backend = new MemoryBackend();
    dbMocks.getDB.mockResolvedValue({
      select: vi.fn(async () => [
        {
          id: "book-1",
          title: "My Book",
          file_path: "books/book-1.epub",
          format: "epub",
          file_hash: HASH_A,
          cover_url: "covers/book-1.jpg",
        },
      ]),
    });

    const result = await uploadBookToCloud(backend, "book-1");

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(backend.files.has(`/RA_dev/data/books/My Book-${HASH_A}.epub`)).toBe(true);
    expect(backend.files.has(`/RA_dev/data/books/My Book-${HASH_A}.jpg`)).toBe(true);
  });

  it("skips upload when the same hash already exists remotely", async () => {
    const backend = new MemoryBackend();
    backend.entries = [fileEntry(`My Book-${HASH_A}.epub`)];
    dbMocks.getDB.mockResolvedValue({
      select: vi.fn(async () => [
        {
          id: "book-1",
          title: "My Book",
          file_path: "books/book-1.epub",
          format: "epub",
          file_hash: HASH_A,
          cover_url: null,
        },
      ]),
    });

    const result = await uploadBookToCloud(backend, "book-1");

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(backend.putFile).not.toHaveBeenCalled();
  });

  it("deletes both book file and cover from the cloud", async () => {
    const backend = new MemoryBackend();
    backend.entries = [
      fileEntry(`My Book-${HASH_A}.epub`),
      fileEntry(`My Book-${HASH_A}.jpg`),
    ];
    backend.files.set(`/RA_dev/data/books/My Book-${HASH_A}.epub`, new Uint8Array([1]));
    backend.files.set(`/RA_dev/data/books/My Book-${HASH_A}.jpg`, new Uint8Array([1]));

    const result = await deleteRemoteBookFromCloud(backend, HASH_A);

    expect(result.ok).toBe(true);
    expect(backend.deleted).toHaveLength(2);
  });
});
