import { describe, expect, it } from "vitest";
import { resolveChapterReference } from "../chapter-reference-resolver";

describe("resolveChapterReference", () => {
  const chapters = [
    {
      chapterIndex: 241,
      chapterTitle: "Section 242",
      preview: "第242章 你说，我去做\n\n一些正文。",
    },
    {
      chapterIndex: 244,
      chapterTitle: "Section 245",
      preview: "第245章 交锋\n\n难道她见了萧宝月？",
    },
    {
      chapterIndex: 245,
      chapterTitle: "Section 246",
      preview: "第246章 收尾\n\n另一章正文。",
    },
  ];

  it("matches human chapter numbers from real chapter titles, not Section numbers", () => {
    const result = resolveChapterReference("跟我讲一下245章的内容", chapters);

    expect(result.matched).toBe(true);
    expect(result.chapterIndex).toBe(244);
    expect(result.chapterTitle).toContain("第245章");
    expect(result.detectedChapterNumber).toBe(245);
  });

  it("supports Chinese numeric chapter references", () => {
    const result = resolveChapterReference("第二百四十五章讲了什么", chapters);

    expect(result.matched).toBe(true);
    expect(result.chapterIndex).toBe(244);
  });

  it("can use fuzzy title text when no chapter number is present", () => {
    const result = resolveChapterReference("交锋这一章讲什么", chapters);

    expect(result.matched).toBe(true);
    expect(result.chapterIndex).toBe(244);
  });

  it("does not trust synthetic Section titles as real chapter numbers", () => {
    const result = resolveChapterReference("第244章讲什么", chapters);

    expect(result.matched).toBe(false);
    expect(result.candidates[0]?.chapterIndex).not.toBe(244);
  });

  // Real-world EPUB TOCs (Dune / 1984 use "Chapter 09"; Ender's Game uses "12. Bonzo").
  const englishChapters = [
    { chapterIndex: 15, chapterTitle: "10. Dragon", preview: "10\n\nDRAGON" },
    { chapterIndex: 17, chapterTitle: "12. Bonzo", preview: "12\n\nBONZO" },
    { chapterIndex: 16, chapterTitle: "Chapter 09", preview: "Chapter 09" },
    { chapterIndex: 18, chapterTitle: "Chapter 10", preview: "Chapter 10" },
  ];

  it("matches 'Chapter N' prefix (Dune-style: '第九章' -> 'Chapter 09')", () => {
    const result = resolveChapterReference("第九章", englishChapters);

    expect(result.matched).toBe(true);
    expect(result.chapterIndex).toBe(16);
    expect(result.chapterTitle).toBe("Chapter 09");
    expect(result.detectedChapterNumber).toBe(9);
  });

  it("matches 'N. Title' prefix (Ender's Game-style: '第十二章' -> '12. Bonzo')", () => {
    const result = resolveChapterReference("第十二章", englishChapters);

    expect(result.matched).toBe(true);
    expect(result.chapterIndex).toBe(17);
    expect(result.chapterTitle).toBe("12. Bonzo");
    expect(result.detectedChapterNumber).toBe(12);
  });

  it("distinguishes 'Chapter 09' from 'Chapter 10' (no off-by-one)", () => {
    const duneChapters = [
      { chapterIndex: 16, chapterTitle: "Chapter 09", preview: "Chapter 09" },
      { chapterIndex: 18, chapterTitle: "Chapter 10", preview: "Chapter 10" },
    ];
    const result = resolveChapterReference("第十章", duneChapters);

    expect(result.matched).toBe(true);
    expect(result.chapterIndex).toBe(18);
    expect(result.detectedChapterNumber).toBe(10);
  });

  it("handles Arabic vs Chinese digits ('第9章' and '第九章' both -> 9)", () => {
    const a = resolveChapterReference("第9章", englishChapters);
    const b = resolveChapterReference("第九章", englishChapters);
    expect(a.matched).toBe(true);
    expect(b.matched).toBe(true);
    expect(a.chapterIndex).toBe(b.chapterIndex);
    expect(a.chapterIndex).toBe(16);
  });
});
