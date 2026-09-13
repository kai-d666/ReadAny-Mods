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
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ topK: 50 }));

    mocks.search.mockClear();
    await tool.execute({ query: "astronomy", topK: 0 });
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ topK: 20 }));
  });

  it("falls back to hybrid for an unsupported mode", async () => {
    const tool = createRagSearchTool("book-1");

    await tool.execute({ query: "astronomy", mode: "semantic" });

    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ mode: "hybrid" }));
  });

  it("returns thin locations instead of the whole chunk", async () => {
    mocks.search.mockResolvedValue([
      {
        chunk: {
          id: "book-1-2-0",
          bookId: "book-1",
          chapterIndex: 2,
          chapterTitle: "Ch 2",
          content: "x".repeat(1200),
          tokenCount: 300,
          startCfi: "epubcfi(/6/9)",
          endCfi: "",
        },
        score: 0.81234,
        matchType: "hybrid",
      },
    ]);

    const tool = createRagSearchTool("book-1");
    const result = (await tool.execute({ query: "astronomy" })) as {
      locations: Array<Record<string, unknown>>;
      returnedLocations: number;
    };

    expect(result.returnedLocations).toBe(1);
    expect(result.locations[0].excerpt).toHaveLength(200);
    // The full size is reported so the model knows the excerpt is only a hint.
    expect(result.locations[0].chunkChars).toBe(1200);
    expect(result.locations[0]).not.toHaveProperty("content");
    expect(result.locations[0].cfi).toBe("epubcfi(/6/9)");
    expect(result.locations[0].score).toBe(0.812);
  });

  it("stops at the excerpt budget and reports what was omitted", async () => {
    mocks.search.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => ({
        chunk: {
          id: `book-1-0-${i}`,
          bookId: "book-1",
          chapterIndex: 0,
          chapterTitle: "Ch 0",
          content: "y".repeat(200),
          tokenCount: 50,
          startCfi: `epubcfi(/6/${i})`,
          endCfi: "",
        },
        score: 0.9,
        matchType: "hybrid",
      })),
    );

    const tool = createRagSearchTool("book-1");
    const result = (await tool.execute({ query: "astronomy", topK: 50 })) as {
      totalResults: number;
      returnedLocations: number;
      omittedResults: number;
    };

    // 8000-char budget / 200-char excerpts = 40 locations, the other 20 reported as omitted
    expect(result.totalResults).toBe(60);
    expect(result.returnedLocations).toBe(40);
    expect(result.omittedResults).toBe(20);
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

  it("centres the window on anchorCfi instead of the chapter start", async () => {
    mocks.getChunks.mockResolvedValue(Array.from({ length: 11 }, (_, i) => chunk(4, i)));
    const tool = createRagContextTool("book-1");

    const result = (await tool.execute({
      chapterIndex: 4,
      range: 2,
      anchorCfi: "epubcfi(/6/5)",
    })) as {
      anchorUsed: boolean;
      startChunkIndex: number;
      chunksIncluded: number;
      totalChunksInChapter: number;
      context: string;
    };

    // Anchor is chunk 5; range 2 → window [3, 7]. Without this the middle of a
    // chapter was locatable by ragSearch but not readable.
    expect(result.anchorUsed).toBe(true);
    expect(result.startChunkIndex).toBe(3);
    expect(result.chunksIncluded).toBe(5);
    expect(result.totalChunksInChapter).toBe(11);
    expect(result.context.startsWith("chunk 3 body")).toBe(true);
  });

  it("falls back to the chapter start when the anchor is unknown", async () => {
    mocks.getChunks.mockResolvedValue(Array.from({ length: 11 }, (_, i) => chunk(4, i)));
    const tool = createRagContextTool("book-1");

    const result = (await tool.execute({
      chapterIndex: 4,
      range: 2,
      anchorCfi: "epubcfi(/6/999)",
    })) as { anchorUsed: boolean; startChunkIndex: number; chunksIncluded: number };

    expect(result.anchorUsed).toBe(false);
    expect(result.startChunkIndex).toBe(0);
    expect(result.chunksIncluded).toBe(5);
  });
});
