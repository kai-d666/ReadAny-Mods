import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookContentSearchProvider } from "../fallback-content-service";
import { setBookContentSearchProvider } from "../fallback-content-service";
import { buildQuoteContextSection } from "../quote-context";

function quote(text: string, cfi?: string) {
  return { id: `q-${text}`, text, cfi };
}

function makeProvider(overrides?: Partial<BookContentSearchProvider>): BookContentSearchProvider {
  return {
    searchBookContent: vi.fn(),
    getChapter: vi.fn(),
    getToc: vi.fn(),
    getChapterByHref: vi.fn(),
    getContextAroundCfi: vi.fn(async () => ({
      before: "BEFORE TEXT",
      after: "AFTER TEXT",
      chapterTitle: "Ch 2",
    })),
    ...overrides,
  } as unknown as BookContentSearchProvider;
}

describe("buildQuoteContextSection", () => {
  beforeEach(() => {
    setBookContentSearchProvider(makeProvider());
  });

  afterEach(() => {
    setBookContentSearchProvider(null);
    vi.useRealTimers();
  });

  it("injects before/after around the quote's cfi as background material", async () => {
    const section = await buildQuoteContextSection("book-1", [quote("quote text", "epubcfi(abc)")]);

    expect(section).toContain("引文附近的原文内容");
    expect(section).toContain("BEFORE TEXT");
    expect(section).toContain("AFTER TEXT");
    expect(section).toContain("...");
    expect(section).toContain("不要复述、解释这段材料");
    // The raw cfi string must not leak into the prompt (model would narrate it)
    expect(section).not.toContain("epubcfi(abc)");
  });

  it("skips quotes without a cfi", async () => {
    const section = await buildQuoteContextSection("book-1", [quote("quote text")]);
    expect(section).toBe("");
  });

  it("fails open when provider throws", async () => {
    setBookContentSearchProvider(
      makeProvider({
        getContextAroundCfi: vi.fn(async () => {
          throw new Error("reader gone");
        }),
      }),
    );

    await expect(
      buildQuoteContextSection("book-1", [quote("q", "epubcfi(abc)")]),
    ).resolves.toBe("");
  });

  it("returns empty without a provider", async () => {
    setBookContentSearchProvider(null);
    const section = await buildQuoteContextSection("book-1", [quote("q", "epubcfi(abc)")]);
    expect(section).toBe("");
  });

  it("joins multiple quotes in order", async () => {
    setBookContentSearchProvider(
      makeProvider({
        getContextAroundCfi: vi.fn(async (_bookId: string, cfi: string) => {
          const tag = cfi.includes("one") ? "FIRST" : "SECOND";
          return { before: `${tag}-BEFORE`, after: `${tag}-AFTER`, chapterTitle: "Ch" };
        }),
      }),
    );

    const section = await buildQuoteContextSection("book-1", [
      quote("first", "epubcfi(one)"),
      quote("second", "epubcfi(two)"),
    ]);

    expect(section.indexOf("FIRST-BEFORE")).toBeLessThan(section.indexOf("SECOND-BEFORE"));
  });

  it("returns empty for a general chat (no bookId)", async () => {
    expect(await buildQuoteContextSection("", [quote("q", "epubcfi(abc)")])).toBe("");
  });
});
