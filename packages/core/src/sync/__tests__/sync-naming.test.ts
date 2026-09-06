import { describe, expect, it } from "vitest";

import {
  buildBookFolderName,
  isCoverFileName,
  parseBookFolderName,
  sanitizeBookTitleForFs,
} from "../sync-naming";

describe("sync-naming", () => {
  describe("sanitizeBookTitleForFs", () => {
    it("keeps CJK and ascii letters as-is", () => {
      expect(sanitizeBookTitleForFs("三体")).toBe("三体");
      expect(sanitizeBookTitleForFs("Brave New World")).toBe("Brave New World");
    });

    it("replaces forbidden chars with underscore", () => {
      expect(sanitizeBookTitleForFs("Hello/World")).toBe("Hello_World");
      expect(sanitizeBookTitleForFs("a\\b:c*d?e\"f<g>h|i")).toBe("a_b_c_d_e_f_g_h_i");
    });

    it("strips control chars and collapses whitespace", () => {
      expect(sanitizeBookTitleForFs("ctrl\x01char")).toBe("ctrlchar");
      expect(sanitizeBookTitleForFs("  multiple   spaces  ")).toBe("multiple spaces");
    });

    it("falls back to placeholder for empty / nullish / whitespace-only input", () => {
      expect(sanitizeBookTitleForFs("")).toBe("未命名");
      expect(sanitizeBookTitleForFs(null)).toBe("未命名");
      expect(sanitizeBookTitleForFs(undefined)).toBe("未命名");
      expect(sanitizeBookTitleForFs("   ")).toBe("未命名");
    });

    it("caps overlong titles at 64 chars", () => {
      const long = "a".repeat(200);
      expect(sanitizeBookTitleForFs(long).length).toBe(64);
    });
  });

  describe("parseBookFolderName", () => {
    const UUID = "550e8400-e29b-41d4-a716-446655440000";

    it("returns the uuid suffix from {title}-{uuid}", () => {
      expect(parseBookFolderName(`三体-${UUID}`)).toBe(UUID);
      expect(parseBookFolderName(`Brave_New_World-${UUID}`)).toBe(UUID);
    });

    it("rejects folder names without a valid uuid suffix", () => {
      expect(parseBookFolderName("just-a-name")).toBeNull();
      expect(parseBookFolderName(UUID)).toBeNull(); // missing leading "{title}-"
      expect(parseBookFolderName(`prefix${UUID}`)).toBeNull(); // missing separator
    });

    it("rejects folder names that are too short", () => {
      expect(parseBookFolderName("abc")).toBeNull();
    });
  });

  describe("isCoverFileName", () => {
    it("treats common image extensions as covers", () => {
      expect(isCoverFileName("三体.jpg")).toBe(true);
      expect(isCoverFileName("title.JPEG")).toBe(true);
      expect(isCoverFileName("a.png")).toBe(true);
      expect(isCoverFileName("a.webp")).toBe(true);
    });

    it("treats book extensions as non-covers", () => {
      expect(isCoverFileName("三体.epub")).toBe(false);
      expect(isCoverFileName("doc.pdf")).toBe(false);
      expect(isCoverFileName("legacy.mobi")).toBe(false);
    });

    it("returns false when there is no extension", () => {
      expect(isCoverFileName("README")).toBe(false);
      expect(isCoverFileName(".gitkeep")).toBe(false); // ext "gitkeep" not in cover set
    });
  });

  describe("buildBookFolderName / buildBookRemoteDir / buildBookRemoteFile / buildBookRemoteCover", () => {
    const UUID = "550e8400-e29b-41d4-a716-446655440000";
    const book = { id: UUID, title: "三体" };

    it("builds folder name as {title}-{id}", () => {
      expect(buildBookFolderName(book)).toBe(`三体-${UUID}`);
    });

    it("falls back to placeholder when title is null/empty", () => {
      const noTitle = { id: UUID, title: null };
      expect(buildBookFolderName(noTitle)).toBe(`未命名-${UUID}`);
    });

    it("round-trips via parseBookFolderName", () => {
      expect(parseBookFolderName(buildBookFolderName(book))).toBe(UUID);
    });
  });
});
