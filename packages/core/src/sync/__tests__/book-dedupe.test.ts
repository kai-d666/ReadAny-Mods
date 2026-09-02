import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSelect = vi.fn();
const mockExecute = vi.fn();
vi.mock("../../db/database", () => ({
  getDB: vi.fn(async () => ({ select: mockSelect, execute: mockExecute })),
}));

const mockAdapter = {
  getAppDataDir: vi.fn(async () => "/app"),
  joinPath: vi.fn((a: string, b: string) => `${a}/${b}`),
  fileExists: vi.fn(),
};
vi.mock("../sync-adapter", () => ({
  getSyncAdapter: vi.fn(() => mockAdapter),
}));

const { dedupeDuplicateBooksByHash, cleanupGhostBooks } = await import("../book-dedupe");

function bookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "book-1",
    file_hash: "h1",
    file_path: "books/book-1.epub",
    format: "epub",
    sync_status: "local",
    updated_at: 1000,
    ...overrides,
  };
}

describe("dedupeDuplicateBooksByHash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.getAppDataDir.mockResolvedValue("/app");
  });

  it("keeps the local-file book and removes the fileless ghost duplicate", async () => {
    mockSelect.mockImplementation(async (sql: string, _params: unknown[]) => {
      if (sql.startsWith("SELECT id, file_hash")) {
        return [
          bookRow({ id: "h1-local", file_hash: "h1", file_path: "books/h1-local.epub" }),
          bookRow({ id: "h1-ghost", file_hash: "h1", file_path: "books/h1-ghost.epub", sync_status: "remote", updated_at: 3000 }),
        ];
      }
      if (sql.startsWith("SELECT COUNT(*) AS c")) {
        // 无任何标注
        return [{ c: 0 }];
      }
      return [];
    });
    mockAdapter.fileExists.mockImplementation(async (path: string) =>
      path.endsWith("/books/h1-local.epub"),
    );

    const report = await dedupeDuplicateBooksByHash();

    expect(report.removed).toBe(1);
    expect(report.removedIds).toEqual(["h1-ghost"]);
    expect(report.keptIds).toEqual(["h1-local"]);
    expect(mockExecute).toHaveBeenCalledWith(
      "DELETE FROM books WHERE id = ? AND file_hash = ?",
      ["h1-ghost", "h1"],
    );
  });

  it("skips candidates that carry annotations even if fileless", async () => {
    mockSelect.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.startsWith("SELECT id, file_hash")) {
        return [
          bookRow({ id: "h2-main", file_hash: "h2" }),
          bookRow({ id: "h2-annotated", file_hash: "h2", sync_status: "remote", updated_at: 3000 }),
        ];
      }
      if (sql.startsWith("SELECT COUNT(*) AS c")) {
        return [{ c: params?.[0] === "h2-annotated" ? 2 : 0 }];
      }
      return [];
    });
    mockAdapter.fileExists.mockResolvedValue(false);

    const report = await dedupeDuplicateBooksByHash();

    expect(report.removed).toBe(0);
    expect(report.skippedWithAnnotations).toEqual(["h2-annotated"]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("keeps the non-remote record over a fileless remote one", async () => {
    mockSelect.mockImplementation(async (sql: string, _params: unknown[]) => {
      if (sql.startsWith("SELECT id, file_hash")) {
        return [
          bookRow({ id: "h3-main", file_hash: "h3", updated_at: 5000 }),
          bookRow({ id: "h3-remote", file_hash: "h3", sync_status: "remote", updated_at: 500 }),
        ];
      }
      if (sql.startsWith("SELECT COUNT(*) AS c")) return [{ c: 0 }];
      return [];
    });
    mockAdapter.fileExists.mockResolvedValue(false);

    const report = await dedupeDuplicateBooksByHash();

    expect(report.keptIds).toEqual(["h3-main"]);
    expect(report.removedIds).toEqual(["h3-remote"]);
  });
});

describe("cleanupGhostBooks", () => {
  const H1 = "a".repeat(64);
  const H2 = "b".repeat(64);
  const mockBackendV2 = (files: string[], fail = false): never =>
    ({
      listDir: fail ? vi.fn().mockRejectedValue(new Error("network")) : vi.fn().mockResolvedValue(
        files.map((name) => ({ name, path: name, size: 1, lastModified: 0, isDirectory: false })),
      ),
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.getAppDataDir.mockResolvedValue("/app");
  });

  it("deletes remote ghosts whose hash is absent from the remote v2 index", async () => {
    mockSelect.mockImplementation(async (sql, _p) => {
      if (sql.startsWith("SELECT id, file_hash") && sql.includes("sync_status = 'remote'")) {
        return [
          bookRow({ id: "ghost-1", file_hash: H1, sync_status: "remote" }),
          bookRow({ id: "real-1", file_hash: H2, sync_status: "remote" }),
        ];
      }
      if (sql.startsWith("SELECT COUNT(*) AS c")) return [{ c: 0 }];
      return [];
    });
    mockAdapter.fileExists.mockResolvedValue(false);

    const report = await cleanupGhostBooks(mockBackendV2(["Any-" + H2 + ".epub"]));

    expect(report.removedIds).toEqual(["ghost-1"]);
    expect(report.keptRemoteIds).toEqual(["real-1"]);
    expect(mockExecute).toHaveBeenCalledWith(
      "DELETE FROM books WHERE id = ? AND sync_status = 'remote'",
      ["ghost-1"],
    );
  });

  it("keeps everything when the remote scan fails", async () => {
    mockSelect.mockImplementation(async (sql, _p) => {
      if (sql.startsWith("SELECT id, file_hash") && sql.includes("sync_status = 'remote'")) {
        return [bookRow({ id: "ghost-1", file_hash: H1, sync_status: "remote" })];
      }
      if (sql.startsWith("SELECT COUNT(*) AS c")) return [{ c: 0 }];
      return [];
    });
    mockAdapter.fileExists.mockResolvedValue(false);

    const report = await cleanupGhostBooks(mockBackendV2([], true));

    expect(report.uncertainIds).toEqual(["ghost-1"]);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
