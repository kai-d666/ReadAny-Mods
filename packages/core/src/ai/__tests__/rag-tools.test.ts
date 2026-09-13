import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chunk } from "../../types";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  getChunks: vi.fn(),
}));

vi.mock("../../rag/search", () => ({ search: mocks.search }));
vi.mock("../../db/database", () => ({
  getChunks: mocks.getChunks,
  getBook: vi.fn(),
}));

const { createRagContextTool, createRagSearchTool } = await import("../tools/rag-tools");

function chunk(chapterIndex: number, index: number): Chunk {
  return {
    id: `book-1-${chapterIndex}-${index}`,
    bookId: "book-1",
    chapterIndex,
    chapterTitle: `Chapter ${chapterIndex}`,
    content: `chunk ${index} body`,
    tokenCount: 3,
    startCfi: `epubcfi(/6/${index})`,
    endCfi: "",
  };
}

describe("ragSearch tool guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.search.mockResolvedValue([]);
  });

  it("refuses an empty query instead of searching", async () => {
    const tool = createRagSearchTool("book-1");

    await expect(tool.execute({ query: "   " })).resolves.toEqual({ error: "Query is empty" });
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("clamps topK to the supported range", async () => {
    const tool = createRagSearchTool("book-1");

    await tool.execute({ query: "astronomy", topK: 999 });
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ topK: 10 }));

    mocks.search.mockClear();
    await tool.execute({ query: "astronomy", topK: 0 });
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ topK: 5 }));
  });

  it("falls back to hybrid for an unsupported mode", async () => {
    const tool = createRagSearchTool("book-1");

    await tool.execute({ query: "astronomy", mode: "semantic" });

    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ mode: "hybrid" }));
  });
});

describe("ragContext tool window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads from the start of the chapter and reports the chapter size", async () => {
    mocks.getChunks.mockResolvedValue(
      Array.from({ length: 11 }, (_, index) => chunk(4, index)),
    );
    const tool = createRagContextTool("book-1");

    const result = (await tool.execute({ chapterIndex: 4, range: 2 })) as {
      chunksIncluded: number;
      totalChunksInChapter: number;
    };

    // range 2 → 2*2+1 = 5 chunks, and the caller can tell the chapter is longer.
    expect(result.chunksIncluded).toBe(5);
    expect(result.totalChunksInChapter).toBe(11);
  });

  it("clamps an oversized range", async () => {
    mocks.getChunks.mockResolvedValue(Array.from({ length: 30 }, (_, i) => chunk(4, i)));
    const tool = createRagContextTool("book-1");

    const result = (await tool.execute({ chapterIndex: 4, range: 999 })) as {
      chunksIncluded: number;
    };

    expect(result.chunksIncluded).toBe(21);
  });
});
