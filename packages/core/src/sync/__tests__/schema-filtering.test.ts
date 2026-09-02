import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecute = vi.fn();
const mockSelect = vi.fn();
const mockDb = {
  execute: mockExecute,
  select: mockSelect,
  close: vi.fn(),
};

const dbMocks = vi.hoisted(() => ({
  getDB: vi.fn(),
  ensureNoTransaction: vi.fn(),
  cleanupOrphanedSyncRows: vi.fn(),
  getDeviceId: vi.fn(),
}));

vi.mock("../../db/database", () => dbMocks);

vi.mock("../../db/write-retry", () => ({
  runSerializedDbTask: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

vi.mock("../../services/platform", () => ({
  getPlatformService: vi.fn(() => ({
    isDesktop: false,
  })),
}));

const { applyChanges } = await import("../simple-sync");

describe("sync schema filtering (records tables)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getDB.mockResolvedValue(mockDb);
    dbMocks.ensureNoTransaction.mockResolvedValue(undefined);
    dbMocks.cleanupOrphanedSyncRows.mockResolvedValue(undefined);
    dbMocks.getDeviceId.mockResolvedValue("device-local");

    mockSelect.mockImplementation(async (sql: string) => {
      if (sql.startsWith("PRAGMA table_info(highlights)")) {
        return [
          { name: "id" },
          { name: "book_id" },
          { name: "cfi" },
          { name: "text" },
          { name: "updated_at" },
          { name: "deleted_at" },
        ];
      }

      if (
        sql.startsWith("SELECT id AS id, updated_at AS timestamp") &&
        sql.includes("FROM highlights")
      ) {
        return [];
      }

      if (sql.startsWith("SELECT updated_at FROM highlights WHERE id = ?")) {
        return [];
      }

      return [];
    });
    mockExecute.mockResolvedValue(undefined);
  });

  it("simple sync ignores unknown remote columns", async () => {
    const result = await applyChanges({
      deviceId: "device-remote",
      timestamp: Date.now(),
      since: 0,
      tables: {
        highlights: {
          records: [
            {
              id: "hl-1",
              book_id: "book-1",
              cfi: "epubcfi(/6/2)",
              text: "Test highlight",
              updated_at: 1000,
              reading_status: "reading",
            },
          ],
          deletedIds: [],
        },
      },
    });

    expect(result).toEqual({ applied: 1, skipped: 0 });
    expect(mockExecute).toHaveBeenCalled();

    const [sql, params] = mockExecute.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO highlights"),
    )!;
    expect(sql).toContain("INSERT INTO highlights (id, book_id, cfi, text, updated_at)");
    expect(sql).not.toContain("reading_status");
    expect(params).toEqual(["hl-1", "book-1", "epubcfi(/6/2)", "Test highlight", 1000]);
  });

  it("simple sync applies a tied-timestamp remote soft delete", async () => {
    mockSelect.mockImplementation(async (sql: string) => {
      if (sql.startsWith("PRAGMA table_info(highlights)")) {
        return [
          { name: "id" },
          { name: "book_id" },
          { name: "cfi" },
          { name: "text" },
          { name: "updated_at" },
          { name: "deleted_at" },
        ];
      }

      if (
        sql.startsWith("SELECT id AS id, updated_at AS timestamp") &&
        sql.includes("FROM highlights")
      ) {
        return [{ id: "hl-1", timestamp: 1000, deleted_at: null }];
      }

      return [];
    });

    const result = await applyChanges({
      deviceId: "device-remote",
      timestamp: Date.now(),
      since: 0,
      tables: {
        highlights: {
          records: [
            {
              id: "hl-1",
              book_id: "book-1",
              cfi: "epubcfi(/6/2)",
              text: "Deleted remotely",
              updated_at: 1000,
              deleted_at: 900,
            },
          ],
          deletedIds: [],
        },
      },
    });

    expect(result).toEqual({ applied: 1, skipped: 0 });

    const insertCall = mockExecute.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO highlights"),
    );
    expect(insertCall?.[0]).toContain("deleted_at");
    expect(insertCall?.[1]).toEqual(["hl-1", "book-1", "epubcfi(/6/2)", "Deleted remotely", 1000, 900]);
  });

  it("simple sync keeps a tied-timestamp local soft delete over a live remote row", async () => {
    mockSelect.mockImplementation(async (sql: string) => {
      if (sql.startsWith("PRAGMA table_info(highlights)")) {
        return [
          { name: "id" },
          { name: "book_id" },
          { name: "cfi" },
          { name: "text" },
          { name: "updated_at" },
          { name: "deleted_at" },
        ];
      }

      if (
        sql.startsWith("SELECT id AS id, updated_at AS timestamp") &&
        sql.includes("FROM highlights")
      ) {
        return [{ id: "hl-1", timestamp: 1000, deleted_at: 900 }];
      }

      return [];
    });

    const result = await applyChanges({
      deviceId: "device-remote",
      timestamp: Date.now(),
      since: 0,
      tables: {
        highlights: {
          records: [
            {
              id: "hl-1",
              book_id: "book-1",
              cfi: "epubcfi(/6/2)",
              text: "Live remotely",
              updated_at: 1000,
              deleted_at: null,
            },
          ],
          deletedIds: [],
        },
      },
    });

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(mockExecute).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO highlights"),
      expect.anything(),
    );
  });
});
