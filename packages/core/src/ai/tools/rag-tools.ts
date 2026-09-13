/**
 * RAG Tools — search, table of contents, and context retrieval
 */
import { getChunks } from "../../db/database";
import { estimateTokens } from "../../rag/chunker";
import { search } from "../../rag/search";
import type { SearchQuery, SearchResult } from "../../types";
import { resolveChapterReference } from "../chapter-reference-resolver";
import { fallbackContentService } from "../fallback-content-service";
import { getFallbackChaptersForBook } from "../fallback-source-resolver";
import { getBookContentSearchProvider } from "../fallback-content-service";
import type { ToolDefinition } from "./tool-types";
import { bookLanguageHint } from "./book-language-hint";

const DEFAULT_TOC_LIMIT = 20;
const MAX_TOC_LIMIT = 60;

function clampLimit(value: unknown, fallback = DEFAULT_TOC_LIMIT): number {
  return Math.max(1, Math.min(MAX_TOC_LIMIT, Number(value) || fallback));
}

function normalizeQuery(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function isGenericSectionTitle(title: string): boolean {
  return /^Section\s+\d+$/i.test(title.trim());
}

function shouldPreferOriginalToc(chapters: Map<number, string>): boolean {
  if (chapters.size === 0) return false;
  const titles = Array.from(chapters.values());
  const genericCount = titles.filter(isGenericSectionTitle).length;
  return genericCount >= Math.max(2, Math.ceil(titles.length * 0.6));
}

function getTocDebugInfo(
  chapters: Map<number, string>,
  fallback?: { attempted: boolean; error?: string; chapterCount?: number; sampleTitles?: string[] },
) {
  const titles = Array.from(chapters.values());
  const genericCount = titles.filter(isGenericSectionTitle).length;
  return {
    vectorChapterCount: chapters.size,
    genericSectionCount: genericCount,
    genericSectionRatio:
      titles.length > 0 ? Math.round((genericCount / titles.length) * 100) / 100 : 0,
    preferOriginalToc: shouldPreferOriginalToc(chapters),
    vectorSampleTitles: titles.slice(0, 8),
    fallback,
  };
}

type TocChapter = { index: number; title: string };

function formatCompactTocResult(options: {
  chapters: TocChapter[];
  totalChapters: number;
  args: Record<string, unknown>;
  source: "vector-index" | "original-file";
  bookTitle?: string;
  debug?: unknown;
  warning?: string;
  instruction?: string;
}) {
  let chapterList = options.chapters;
  const query = String(options.args.query || "").trim();
  const aroundChapter =
    typeof options.args.aroundChapter === "number" ? Number(options.args.aroundChapter) : undefined;
  const limit = clampLimit(options.args.limit);
  let offset = Math.max(0, Number(options.args.offset) || 0);

  if (query) {
    const normalized = normalizeQuery(query);
    chapterList = chapterList.filter((chapter) =>
      normalizeQuery(`${chapter.index + 1}${chapter.title}`).includes(normalized),
    );
    offset = 0;
  } else if (aroundChapter !== undefined && Number.isFinite(aroundChapter)) {
    const half = Math.floor(limit / 2);
    const aroundIndex = chapterList.findIndex((chapter) => chapter.index >= aroundChapter);
    offset =
      aroundIndex >= 0 ? Math.max(0, aroundIndex - half) : Math.max(0, chapterList.length - limit);
  }

  const pagedChapters = chapterList.slice(offset, offset + limit);
  const nextOffset = offset + pagedChapters.length;

  return {
    ...(options.bookTitle ? { bookTitle: options.bookTitle } : {}),
    chapters: pagedChapters.map((chapter, ordinal) => ({
      index: chapter.index,
      number: offset + ordinal + 1,
      title: chapter.title,
    })),
    totalChapters: options.totalChapters,
    matchedChapters: chapterList.length,
    returned: pagedChapters.length,
    offset,
    limit,
    hasMore: nextOffset < chapterList.length,
    nextOffset: nextOffset < chapterList.length ? nextOffset : undefined,
    source: options.source,
    ...(options.debug ? { debug: options.debug } : {}),
    ...(options.warning ? { warning: options.warning } : {}),
    instruction:
      options.instruction ??
      "This is a compact chapter list. Use resolveChapterReference for user-provided chapter numbers or fuzzy chapter titles.",
  };
}

/** Excerpt length for one retrieved location — enough to judge relevance, not to answer from. */
const EXCERPT_CHARS = 200;
/**
 * Total excerpt budget for one ragSearch call, counted in real characters.
 * The old code counted `estimateTokens` (chars/4), which under-counts CJK ~4x,
 * so the nominal 4000-token budget never actually bound.
 */
const MAX_TOTAL_EXCERPT_CHARS = 8000;
const DEFAULT_TOP_K = 20;
const MAX_TOP_K = 50;

const RAG_SEARCH_INSTRUCTION =
  "These are LOCATIONS, not the passage text — the excerpt is only a relevance hint. Before answering a content question, read the relevant locations with ragContext(chapterIndex, anchorCfi). Only 'where does X appear' questions can be answered from this list alone.";

function clampTopK(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TOP_K;
  return Math.max(1, Math.min(MAX_TOP_K, Math.floor(parsed)));
}

/** Prefer the match-centred snippet (BM25 fills it) over the head of the chunk. */
function excerptFor(result: SearchResult): string {
  const highlight = result.highlights?.find((snippet) => snippet.trim().length > 0);
  const text = highlight ?? result.chunk.content;
  return text.length > EXCERPT_CHARS ? text.slice(0, EXCERPT_CHARS) : text;
}

/** Create RAG search tool for a specific book */
export function createRagSearchTool(bookId: string, bookLanguage?: string): ToolDefinition {
  return {
    name: "ragSearch",
    description:
      "Find WHERE a topic/keyword/theme appears in the book — returns a ranked list of LOCATIONS (chapter, cfi, a short excerpt, and how long the whole chunk is). This is a locator, NOT the text: to actually read a hit, call ragContext with its chapterIndex and pass its cfi as anchorCfi. NOT for locating a specific chapter — if the user mentions a chapter number or title (e.g. '第八章', 'Salamander'), call resolveChapterReference first, then ragContext to read that chapter. IMPORTANT: If getSurroundingContext (or ragContext) already returned the chapter's content, ANSWER FROM THAT — do not ragSearch the same chapter again; the whole chapter is already in context. Only ragSearch for details NOT in the returned chapter (other locations, cross-chapter themes). Each location carries a 'cfi' — if addCitation is among your available tools, pass the cfi of any location you cite so users can jump to the exact spot; otherwise cite chapterTitle/chapterIndex in plain text." + bookLanguageHint(bookLanguage),
    parameters: {
      query: {
        type: "string",
        description:
          "What to look for, as a natural phrase or short clause in the book's language, carrying the key proper nouns/terms the answer would contain — e.g. 'Ender 的真实姓名与身份'. Not a bare keyword list: the semantic half of the search matches on meaning and retrieves worse from keyword soup.",
        required: true,
      },
      mode: {
        type: "string",
        description:
          'Search mode: "hybrid" (recommended), "vector" (semantic), or "bm25" (keyword)',
      },
      topK: {
        type: "number",
        description: `Number of locations to return (default: ${DEFAULT_TOP_K}, max: ${MAX_TOP_K})`,
      },
    },
    execute: async (args) => {
      const rawQuery = typeof args.query === "string" ? args.query.trim() : "";
      if (!rawQuery) {
        return { error: "Query is empty" };
      }
      const requestedMode = args.mode as string;
      const query: SearchQuery = {
        query: rawQuery,
        bookId,
        // Anything outside the whitelist used to reach search()'s switch and
        // return undefined, which crashed the loop below.
        mode: requestedMode === "vector" || requestedMode === "bm25" ? requestedMode : "hybrid",
        topK: clampTopK(args.topK),
        threshold: 0.3,
      };

      const results = await search(query);

      // Return a locator list rather than the chunks themselves. Shipping whole
      // chunks made every search a handful of ~1200-char walls of text: few
      // points, large payload, and the reading step left implicit. Excerpts keep
      // the points dense and push reading into ragContext(anchorCfi).
      const locations: Array<{
        chapter: string;
        chapterIndex: number;
        cfi: string;
        score: number;
        matchType: SearchResult["matchType"];
        excerpt: string;
        chunkChars: number;
      }> = [];
      let totalChars = 0;

      for (const r of results) {
        const excerpt = excerptFor(r);
        // The first location always goes in: an over-long excerpt must not turn
        // a search into "no results".
        if (locations.length > 0 && totalChars + excerpt.length > MAX_TOTAL_EXCERPT_CHARS) break;
        totalChars += excerpt.length;
        locations.push({
          chapter: r.chunk.chapterTitle,
          chapterIndex: r.chunk.chapterIndex,
          cfi: r.chunk.startCfi || "",
          score: Math.round(r.score * 1000) / 1000,
          matchType: r.matchType,
          excerpt,
          chunkChars: r.chunk.content.length,
        });
      }

      return {
        query: rawQuery,
        mode: query.mode,
        locations,
        totalResults: results.length,
        returnedLocations: locations.length,
        ...(locations.length < results.length
          ? { omittedResults: results.length - locations.length }
          : {}),
        instruction: RAG_SEARCH_INSTRUCTION,
        ...(results[0]?.vectorStatus
          ? {
              vectorStatus: results[0].vectorStatus,
              vectorError: results[0].vectorError,
            }
          : {}),
      };
    },
  };
}

/** Create RAG TOC tool for a specific book */
export function createRagTocTool(bookId: string, bookLanguage?: string): ToolDefinition {
  return {
    name: "ragToc",
    description:
      "Get a compact, limited chapter list. Use query/aroundChapter/offset/limit instead of loading the full table of contents." + bookLanguageHint(bookLanguage),
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
    },
    execute: async (args) => {
      // Get unique chapter titles from chunks
      const chunks = await getChunks(bookId);
      const chapters = new Map<number, string>();
      for (const chunk of chunks) {
        if (!chapters.has(chunk.chapterIndex)) {
          chapters.set(chunk.chapterIndex, chunk.chapterTitle);
        }
      }
      const chapterList = Array.from(chapters.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([index, title]) => ({ index, title }));

      if (shouldPreferOriginalToc(chapters)) {
        // Fast path first: the reader-session provider can return the real TOC
        // in ~1ms (it was parsed on openBook). Only when that is unavailable
        // (desktop / no provider) do we attempt the slow full-book extraction —
        // which previously hit the 45s wall and blew the 20s tool timeout.
        let fallback: Awaited<ReturnType<typeof getFallbackChaptersForBook>> | null = null;
        const searchProvider = getBookContentSearchProvider();
        if (searchProvider) {
          try {
            const tocPromise = searchProvider.getToc(bookId);
            const toc = await Promise.race([
              tocPromise,
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
            ]);
            if (toc && toc.length > 0) {
              console.log("[ragToc] Rebuilt generic section TOC from reader session", {
                bookId,
                chapters: toc.length,
                sampleTitles: toc.slice(0, 5).map((chapter) => chapter.title),
              });
              return formatCompactTocResult({
                bookTitle: "",
                chapters: toc.map((chapter) => ({
                  index: chapter.index,
                  title: chapter.title,
                })),
                totalChapters: toc.length,
                source: "original-file",
                args,
                debug: getTocDebugInfo(chapters, {
                  attempted: true,
                  chapterCount: toc.length,
                  sampleTitles: toc.slice(0, 8).map((chapter) => chapter.title),
                }),
                instruction:
                  "The vector index has generic Section titles, so this TOC was rebuilt from the original book file. Re-vectorize the book to refresh RAG chapter titles.",
              });
            }
          } catch (err) {
            console.warn("[ragToc] Reader-session TOC failed, trying original-file extraction:", err);
          }
        }

        fallbackContentService.clear(bookId);
        fallback = await getFallbackChaptersForBook(bookId);
        if (!("error" in fallback) && fallback.chapters.length > 0) {
          console.log("[ragToc] Rebuilt generic section TOC from original book", {
            bookId,
            chapters: fallback.chapters.length,
            sampleTitles: fallback.chapters.slice(0, 5).map((chapter) => chapter.title),
          });
          return formatCompactTocResult({
            bookTitle: fallback.bookTitle,
            chapters: fallback.chapters.map((chapter) => ({
              index: chapter.index,
              title: chapter.title,
            })),
            totalChapters: fallback.chapters.length,
            source: "original-file",
            args,
            debug: getTocDebugInfo(chapters, {
              attempted: true,
              chapterCount: fallback.chapters.length,
              sampleTitles: fallback.chapters.slice(0, 8).map((chapter) => chapter.title),
            }),
            instruction:
              "The vector index has generic Section titles, so this TOC was rebuilt from the original book file. Re-vectorize the book to refresh RAG chapter titles.",
          });
        }

        const fallbackError = "error" in fallback ? fallback.error : "Original file TOC was empty";
        console.warn("[ragToc] Failed to rebuild generic section TOC from original book", {
          bookId,
          error: fallbackError,
        });
        return formatCompactTocResult({
          chapters: chapterList,
          totalChapters: chapters.size,
          source: "vector-index",
          args,
          debug: getTocDebugInfo(chapters, {
            attempted: true,
            error: fallbackError,
          }),
          warning:
            "The vector index has mostly generic Section titles, but rebuilding the TOC from the original book failed. See debug.fallback.error.",
        });
      }

      return formatCompactTocResult({
        chapters: chapterList,
        totalChapters: chapters.size,
        source: "vector-index",
        args,
        debug: getTocDebugInfo(chapters, { attempted: false }),
      });
    },
  };
}

export function createResolveChapterReferenceTool(bookId: string, bookLanguage?: string): ToolDefinition {
  return {
    name: "resolveChapterReference",
    description:
      "Resolve a user-mentioned chapter number or fuzzy chapter title to the internal chapterIndex. Use before ragContext/summarize when the user asks about a specific chapter. When matched=true with confidence≥0.7, use the returned chapterIndex directly with ragContext — do not re-search or call ragToc for the same chapter." + bookLanguageHint(bookLanguage),
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
      // Prefer the reader-session TOC (real chapter labels parsed on openBook)
      // so "第四章" style references resolve against actual titles. Fall back
      // to vector-index chapter titles (generic "Section N") when unavailable.
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
        const chunks = await getChunks(bookId);
        const chapters = new Map<number, { title: string; preview: string }>();
        for (const chunk of chunks) {
          if (!chapters.has(chunk.chapterIndex)) {
            chapters.set(chunk.chapterIndex, {
              title: chunk.chapterTitle,
              preview: chunk.content.slice(0, 500),
            });
          }
        }
        entries = Array.from(chapters.entries()).map(([chapterIndex, chapter]) => ({
          chapterIndex,
          chapterTitle: chapter.title,
          preview: chapter.preview,
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

/** Create RAG context tool for a specific book */
export function createRagContextTool(bookId: string, bookLanguage?: string): ToolDefinition {
  const MAX_TOTAL_TOKENS = 3000;

  return {
    name: "ragContext",
    description:
      "Read a chapter's text. Returns up to range*2+1 chunks centred on the anchor: pass anchorCfi (the cfi of a ragSearch location) to reach the MIDDLE or END of a long chapter; without it, reading starts at the chapter start. Each chunk can run past a thousand characters, so for 'what happens in this chapter' use range 5-8 to get enough in ONE call; avoid calling with a small range then repeating with a larger one. The response reports anchorUsed and chunksIncluded/totalChunksInChapter — when chunksIncluded < totalChunksInChapter you have not seen the whole chapter. Returns chunks with CFI information - if addCitation is among your available tools, use the CFI from the chunk containing your quoted text when calling addCitation; otherwise cite chapterTitle/chapterIndex in plain text." + bookLanguageHint(bookLanguage),
    parameters: {
      chapterIndex: { type: "number", description: "The chapter index", required: true },
      range: {
        type: "number",
        description: "Number of chunks to include before and after the anchor (default: 2)",
      },
      anchorCfi: {
        type: "string",
        description:
          "Optional: a cfi returned by ragSearch. Reading is centred on that location instead of the chapter start — the only way to reach the middle or end of a long chapter.",
      },
    },
    execute: async (args) => {
      const chapterIndex = args.chapterIndex as number;
      const range = Math.max(1, Math.min(10, Number(args.range) || 2));
      const anchorCfi = typeof args.anchorCfi === "string" ? args.anchorCfi.trim() : "";

      const chunks = await getChunks(bookId);
      const chapterChunks = chunks.filter((c) => c.chapterIndex === chapterIndex);

      // Anchor the window on the requested location. Without this the tool could
      // only ever hand back the chapter head, so a ragSearch hit in the middle of
      // a long chapter was reachable but unreadable.
      let windowStart = 0;
      let anchorUsed = false;
      if (anchorCfi) {
        const anchorIndex = chapterChunks.findIndex((c) => c.startCfi && c.startCfi === anchorCfi);
        if (anchorIndex >= 0) {
          windowStart = Math.max(0, anchorIndex - range);
          anchorUsed = true;
        }
      }
      const windowChunks = chapterChunks.slice(windowStart, windowStart + range * 2 + 1);

      // Get surrounding chunks with token budget
      const sourceRefs: Array<{ id: string; excerpt: string; cfi: string }> = [];
      const contextParts: string[] = [];
      let totalTokens = 0;

      for (const c of windowChunks) {
        const chunkTokens = estimateTokens(c.content);
        if (totalTokens + chunkTokens > MAX_TOTAL_TOKENS) {
          // Truncate to fit budget
          const remaining = MAX_TOTAL_TOKENS - totalTokens;
          if (remaining > 100) {
            const charLimit = remaining * 4;
            const content = c.content.slice(0, charLimit);
            contextParts.push(content);
            sourceRefs.push({
              id: c.id,
              excerpt: content.slice(0, 180),
              cfi: c.startCfi || "",
            });
          }
          break;
        }
        contextParts.push(c.content);
        sourceRefs.push({
          id: c.id,
          excerpt: c.content.slice(0, 180),
          cfi: c.startCfi || "",
        });
        totalTokens += chunkTokens;
      }

      return {
        chapterTitle: chapterChunks[0]?.chapterTitle || "Unknown",
        chapterIndex: chapterIndex,
        context: contextParts.join("\n\n"),
        sourceRefs,
        anchorUsed,
        startChunkIndex: windowStart,
        chunksIncluded: contextParts.length,
        totalChunksInChapter: chapterChunks.length,
        totalTokens,
        tokenBudget: MAX_TOTAL_TOKENS,
      };
    },
  };
}
