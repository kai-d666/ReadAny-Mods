import { estimateTokens } from "../../rag/chunker";
import type { FallbackChapter } from "../fallback-content-service";
import { getBookContentSearchProvider } from "../fallback-content-service";
import {
  buildFallbackSnippet,
  findFallbackSegmentByTerms,
  getFallbackChaptersForBook,
} from "../fallback-source-resolver";
import { resolveChapterReference } from "../chapter-reference-resolver";
import type { ToolDefinition } from "./tool-types";

const SEARCH_TOKEN_BUDGET = 3600;
const CHAPTER_TOKEN_BUDGET = 3200;
const DEFAULT_TOC_LIMIT = 20;
const MAX_TOC_LIMIT = 60;

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeQuery(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function clampLimit(value: unknown, fallback = DEFAULT_TOC_LIMIT): number {
  return Math.max(1, Math.min(MAX_TOC_LIMIT, Number(value) || fallback));
}

function scoreChapter(chapter: FallbackChapter, terms: string[]): number {
  const haystack = normalize(`${chapter.title}\n${chapter.content}`);
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = haystack.match(new RegExp(escaped, "g"));
    score += matches?.length ?? 0;
  }
  return score;
}

function findSnippet(chapter: FallbackChapter, terms: string[]): string {
  const content = chapter.content.replace(/\s+/g, " ").trim();
  if (!content) return "";

  const lower = content.toLowerCase();
  const index = terms
    .map((term) => lower.indexOf(term))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max(0, (index ?? 0) - 320);
  return content.slice(start, start + 900);
}

/** Build a display snippet from a reader-search match's pre/match/post excerpt. */
function buildMatchSnippet(match: {
  cfi?: string;
  pre?: string;
  match?: string;
  post?: string;
}): string {
  const pre = (match.pre ?? "").replace(/\s+/g, " ").trim();
  const m = (match.match ?? "").replace(/\s+/g, " ").trim();
  const post = (match.post ?? "").replace(/\s+/g, " ").trim();
  if (!pre && !m && !post) return "";
  return [pre, m ? `「${m}」` : "", post].filter(Boolean).join(" ");
}

export function createFallbackTocTool(bookId: string): ToolDefinition {
  return {
    name: "fallbackToc",
    description:
      "Get a compact chapter list from the original file without vectorization. Use query/aroundChapter/offset/limit instead of loading the full table of contents.",
    parameters: {
      query: {
        type: "string",
        description: "Optional chapter title or chapter number text to search for",
      },
      aroundChapter: {
        type: "number",
        description: "Optional chapter index to return nearby chapters around",
      },
      offset: {
        type: "number",
        description: "Pagination offset when browsing the chapter list",
      },
      limit: {
        type: "number",
        description: "Maximum chapters to return (default 20, max 60)",
      },
      includePreview: {
        type: "boolean",
        description: "Whether to include short previews for returned chapters (default false)",
      },
    },
    execute: async (args) => {
      // Prefer the platform search provider (mobile: TOC parsed by the reader on
      // openBook — no full-book extraction).
      const searchProvider = getBookContentSearchProvider();
      let chapters: { index: number; title: string; content: string }[] | null = null;
      let bookTitle = "";
      if (searchProvider) {
        try {
          const toc = await searchProvider.getToc(bookId);
          chapters = toc.map((item) => ({ index: item.index, title: item.title, content: "" }));
          bookTitle = "";
        } catch (err) {
          console.warn(`[fallbackToc] provider failed for book ${bookId}:`, err);
        }
      }

      if (!chapters) {
        const data = await getFallbackChaptersForBook(bookId);
        if ("error" in data) return data;
        bookTitle = data.bookTitle;
        chapters = data.chapters.map((chapter) => ({
          index: chapter.index,
          title: chapter.title,
          content: chapter.content,
        }));
      }

      const query = String(args.query || "").trim();
      const aroundChapter =
        typeof args.aroundChapter === "number" ? Number(args.aroundChapter) : undefined;
      const limit = clampLimit(args.limit);
      const includePreview = Boolean(args.includePreview);
      let offset = Math.max(0, Number(args.offset) || 0);

      if (query) {
        const normalized = normalizeQuery(query);
        chapters = chapters.filter((chapter) =>
          normalizeQuery(`${chapter.index + 1}${chapter.title}`).includes(normalized),
        );
        offset = 0;
      } else if (aroundChapter !== undefined && Number.isFinite(aroundChapter)) {
        const half = Math.floor(limit / 2);
        const aroundIndex = chapters.findIndex((chapter) => chapter.index >= aroundChapter);
        offset =
          aroundIndex >= 0 ? Math.max(0, aroundIndex - half) : Math.max(0, chapters.length - limit);
      }

      const pagedChapters = chapters.slice(offset, offset + limit);
      return {
        bookTitle,
        chapters: pagedChapters.map((chapter) => ({
          index: chapter.index,
          title: chapter.title,
          ...(includePreview
            ? { preview: chapter.content.replace(/\s+/g, " ").trim().slice(0, 180) }
            : {}),
        })),
        totalChapters: chapters.length,
        matchedChapters: chapters.length,
        returned: pagedChapters.length,
        offset,
        limit,
        hasMore: offset + pagedChapters.length < chapters.length,
        nextOffset:
          offset + pagedChapters.length < chapters.length
            ? offset + pagedChapters.length
            : undefined,
        instruction:
          "This is a compact chapter list. Use resolveChapterReference for user-provided chapter numbers or fuzzy chapter titles.",
      };
    },
  };
}

export function createFallbackResolveChapterReferenceTool(bookId: string): ToolDefinition {
  return {
    name: "resolveChapterReference",
    description:
      "Resolve a user-mentioned chapter number or fuzzy chapter title to the internal chapterIndex. Use before fallbackChapterContext when the user asks about a specific chapter.",
    parameters: {
      query: {
        type: "string",
        description: "The user's chapter reference, such as '245章' or a chapter title",
        required: true,
      },
      maxCandidates: {
        type: "number",
        description: "Maximum candidates to return when ambiguous (default 3)",
      },
    },
    execute: async (args) => {
      // Prefer the reader-session TOC (real labels, sub-second) — matching the
      // chapter indexes used by provider.getChapter, so the resolved index
      // lines up with fallbackChapterContext.
      let entries: Array<{ chapterIndex: number; chapterTitle: string; preview: string }>;
      try {
        const searchProvider = getBookContentSearchProvider();
        const toc = searchProvider
          ? await Promise.race([
              searchProvider.getToc(bookId),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
            ])
          : null;
        if (toc && toc.length > 0) {
          entries = toc.map((chapter) => ({
            chapterIndex: chapter.index,
            chapterTitle: chapter.title,
            preview: "",
          }));
        } else {
          throw new Error("No reader TOC");
        }
      } catch {
        const data = await getFallbackChaptersForBook(bookId);
        if ("error" in data) return data;
        entries = data.chapters.map((chapter) => ({
          chapterIndex: chapter.index,
          chapterTitle: chapter.title,
          preview: chapter.content.slice(0, 500),
        }));
      }

      return resolveChapterReference(
        String(args.query || ""),
        entries,
        Number(args.maxCandidates) || 3,
      );
    },
  };
}

export function createFallbackSearchTool(bookId: string): ToolDefinition {
  return {
    name: "fallbackSearch",
    description:
      "Keyword search the original book file without a vector index. Slower and less semantic than RAG, but useful when the book has not been vectorized. Returns a CFI only when the match can be mapped to a concrete reader text segment.",
    parameters: {
      query: { type: "string", description: "Keywords or phrase to search for", required: true },
      topK: { type: "number", description: "Number of chapters/snippets to return (default: 5)" },
    },
    execute: async (args) => {
      const query = String(args.query || "").trim();
      if (!query) return { error: "Query is empty" };
      const topK = Math.max(1, Math.min(10, Number(args.topK) || 5));

      // Prefer the platform search provider (mobile: resident reader session via
      // foliate incremental search — no full-book extraction, no 45s timeout).
      const searchProvider = getBookContentSearchProvider();
      if (searchProvider) {
        try {
          const result = await searchProvider.searchBookContent(bookId, query, { topK });
          const results = result.matches.slice(0, topK).map((match) => ({
            chapterTitle: match.chapterTitle ?? "",
            chapterIndex: match.chapterIndex ?? 0,
            content: buildMatchSnippet(match),
            score: 0,
            ...(match.cfi ? { cfi: match.cfi, cfiPrecision: "segment" as const } : {}),
          }));
          return {
            query,
            results,
            totalResults: result.totalMatches,
            returnedResults: results.length,
            totalTokens: results.reduce((sum, r) => sum + estimateTokens(r.content), 0),
            tokenBudget: SEARCH_TOKEN_BUDGET,
            instruction:
              "These are keyword fallback results from the original file, not semantic vector results. If a result has a non-empty cfi, you may call addCitation with that exact cfi and quotedText. If no cfi is present, cite chapterTitle/chapterIndex in plain text.",
          };
        } catch (err) {
          // Provider failure → fall through to the original-file path below.
          console.warn(`[fallbackSearch] provider failed for book ${bookId}:`, err);
        }
      }

      const data = await getFallbackChaptersForBook(bookId);
      if ("error" in data) return data;

      const terms = normalize(query)
        .split(/[\s,，。.!?;；:：、]+/)
        .filter(Boolean);
      if (terms.length === 0) return { error: "Query is empty" };

      const ranked = data.chapters
        .map((chapter) => ({ chapter, score: scoreChapter(chapter, terms) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      let totalTokens = 0;
      const results = [];
      for (const { chapter, score } of ranked) {
        const matchedSegment = findFallbackSegmentByTerms(chapter, terms);
        const snippet = matchedSegment
          ? buildFallbackSnippet(matchedSegment.text, terms)
          : findSnippet(chapter, terms);
        const tokens = estimateTokens(snippet);
        if (totalTokens + tokens > SEARCH_TOKEN_BUDGET) break;
        totalTokens += tokens;
        const result: {
          chapterTitle: string;
          chapterIndex: number;
          content: string;
          score: number;
          cfi?: string;
          cfiPrecision?: "segment";
        } = {
          chapterTitle: chapter.title,
          chapterIndex: chapter.index,
          content: snippet,
          score,
        };
        if (matchedSegment?.cfi) {
          result.cfi = matchedSegment.cfi;
          result.cfiPrecision = "segment";
        }
        results.push(result);
      }

      return {
        query,
        results,
        totalResults: ranked.length,
        returnedResults: results.length,
        totalTokens,
        tokenBudget: SEARCH_TOKEN_BUDGET,
        instruction:
          "These are keyword fallback results from the original file, not semantic vector results. If a result has a non-empty cfi, you may call addCitation with that exact cfi and quotedText. If no cfi is present, cite chapterTitle/chapterIndex in plain text.",
      };
    },
  };
}

export function createFallbackChapterContextTool(bookId: string): ToolDefinition {
  return {
    name: "fallbackChapterContext",
    description:
      "Read a chapter from the original book file without vectorization. Use it after fallbackToc or when the user asks about a known chapter.",
    parameters: {
      chapterIndex: {
        type: "number",
        description: "Chapter index from fallbackToc",
        required: true,
      },
    },
    execute: async (args) => {
      const chapterIndex = Number(args.chapterIndex);

      // Prefer the platform search provider (mobile: resident reader session —
      // single-chapter read, no full-book extraction).
      const searchProvider = getBookContentSearchProvider();
      if (searchProvider) {
        try {
          const chapter = await searchProvider.getChapter(bookId, chapterIndex);
          const tokens = estimateTokens(chapter.content);
          const content =
            tokens > CHAPTER_TOKEN_BUDGET
              ? chapter.content.slice(0, CHAPTER_TOKEN_BUDGET * 4)
              : chapter.content;
          const sourceRefs = content
            ? [
                {
                  id: `${chapterIndex}-0`,
                  excerpt: content.slice(0, 180),
                  chapterTitle: chapter.chapterTitle,
                  chapterIndex,
                },
              ]
            : [];
          return {
            chapterTitle: chapter.chapterTitle,
            chapterIndex,
            content,
            sourceRefs,
            totalTokens: Math.min(tokens, CHAPTER_TOKEN_BUDGET),
            tokenBudget: CHAPTER_TOKEN_BUDGET,
            truncated: estimateTokens(chapter.content) > CHAPTER_TOKEN_BUDGET,
            instruction:
              "Summarize or analyze this chapter using only the returned content. If the specific chunk you cite has a non-empty cfi, you may call addCitation with that exact cfi and quotedText. If no cfi is present, cite chapterTitle/chapterIndex in plain text.",
          };
        } catch (err) {
          // Provider failure → fall through to the original-file path below.
          console.warn(`[fallbackChapterContext] provider failed for book ${bookId}:`, err);
        }
      }

      const data = await getFallbackChaptersForBook(bookId);
      if ("error" in data) return data;

      const chapter = data.chapters.find((item) => item.index === chapterIndex);
      if (!chapter) return { error: `Chapter ${chapterIndex} not found` };

      const sourceRefs: Array<{
        id: string;
        excerpt: string;
        chapterTitle: string;
        chapterIndex: number;
        cfi?: string;
        cfiPrecision?: "segment";
      }> = [];
      const contentParts: string[] = [];
      const chunks: Array<{
        content: string;
        chapterTitle: string;
        chapterIndex: number;
        cfi?: string;
        cfiPrecision?: "segment";
      }> = [];
      let totalTokens = 0;

      for (const segment of chapter.segments ?? []) {
        const text = segment.text?.trim();
        if (!text) continue;
        const tokens = estimateTokens(text);
        const shouldTruncateFirstSegment = chunks.length === 0 && tokens > CHAPTER_TOKEN_BUDGET;
        if (!shouldTruncateFirstSegment && totalTokens + tokens > CHAPTER_TOKEN_BUDGET) break;
        const content = shouldTruncateFirstSegment ? text.slice(0, CHAPTER_TOKEN_BUDGET * 4) : text;
        totalTokens += Math.min(tokens, CHAPTER_TOKEN_BUDGET);
        const chunk: {
          content: string;
          chapterTitle: string;
          chapterIndex: number;
          cfi?: string;
          cfiPrecision?: "segment";
        } = {
          content,
          chapterTitle: chapter.title,
          chapterIndex: chapter.index,
        };
        contentParts.push(content);
        if (segment.cfi) {
          chunk.cfi = segment.cfi;
          chunk.cfiPrecision = "segment";
        }
        chunks.push(chunk);
        sourceRefs.push({
          id: `${chapter.index}-${sourceRefs.length}`,
          excerpt: content.slice(0, 180),
          chapterTitle: chapter.title,
          chapterIndex: chapter.index,
          cfi: segment.cfi,
          ...(segment.cfi ? { cfiPrecision: "segment" as const } : {}),
        });
        if (shouldTruncateFirstSegment) break;
      }

      if (chunks.length === 0) {
        const tokens = estimateTokens(chapter.content);
        const content =
          tokens > CHAPTER_TOKEN_BUDGET
            ? chapter.content.slice(0, CHAPTER_TOKEN_BUDGET * 4)
            : chapter.content;
        totalTokens = Math.min(tokens, CHAPTER_TOKEN_BUDGET);
        contentParts.push(content);
        sourceRefs.push({
          id: `${chapter.index}-0`,
          excerpt: content.slice(0, 180),
          chapterTitle: chapter.title,
          chapterIndex: chapter.index,
        });
      }

      const content = contentParts.join("\n\n");

      return {
        chapterTitle: chapter.title,
        chapterIndex: chapter.index,
        content,
        sourceRefs,
        totalTokens,
        tokenBudget: CHAPTER_TOKEN_BUDGET,
        truncated: estimateTokens(chapter.content) > totalTokens,
        instruction:
          "Summarize or analyze this chapter using only the returned content. If the specific chunk you cite has a non-empty cfi, you may call addCitation with that exact cfi and quotedText. If no cfi is present, cite chapterTitle/chapterIndex in plain text.",
      };
    },
  };
}
