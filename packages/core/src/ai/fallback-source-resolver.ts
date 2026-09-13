import { getBook } from "../db/database";
import {
  getBookContentSearchProvider,
  type FallbackChapter,
  type FallbackTextSegment,
  fallbackContentService,
} from "./fallback-content-service";
export interface FallbackChaptersResult {
  bookTitle: string;
  chapters: FallbackChapter[];
}

export interface ResolvedFallbackSource {
  chapterTitle: string;
  chapterIndex: number;
  text: string;
  cfi: string;
}

export async function getFallbackChaptersForBook(
  bookId: string,
): Promise<FallbackChaptersResult | { error: string }> {
  const book = await getBook(bookId);
  if (!book) return { error: "Book not found" };

  try {
    const chapters = await fallbackContentService.getChapters(book);
    if (chapters.length === 0) return { error: "No readable content found for this book" };
    return { bookTitle: book.meta.title, chapters };
  } catch (error) {
    // The mobile reader is the content provider: when the book isn't open (or
    // the provider isn't registered), every fallback tool would fail. Tell the
    // model this is NOT a retryable error so it stops trying fallback*
    // and answers from what it has (or asks the user to open the book).
    const message = error instanceof Error ? error.message : "Unable to read the book without vectorization";
    if (/not registered|not ready|No reading context/i.test(message)) {
      return {
        error: `${message}. The book is not open in the reader — fallback content is unavailable. Do NOT retry other fallback tools (fallbackToc/fallbackSearch/fallbackChapterContext) for this book; answer from general knowledge or ask the user to open the book first.`,
      };
    }
    return { error: message };
  }
}

function normalizeForLookup(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

function normalizeForTerms(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function getQuoteNeedles(quotedText: string): string[] {
  const normalized = normalizeForLookup(quotedText);
  if (!normalized) return [];

  const needles = [normalized];
  if (normalized.length > 80) needles.push(normalized.slice(0, 80));
  if (normalized.length > 40) needles.push(normalized.slice(0, 40));
  if (normalized.length > 24) needles.push(normalized.slice(-40));

  // Models often shorten a quote with an ellipsis. Match the substantial
  // fragments on either side instead of requiring the omitted text to be
  // adjacent in the source paragraph.
  for (const fragment of quotedText.split(/(?:…{1,}|\.{3,})/u)) {
    const normalizedFragment = normalizeForLookup(fragment);
    if (normalizedFragment.length >= 8) {
      needles.push(normalizedFragment);
      if (normalizedFragment.length > 40) needles.push(normalizedFragment.slice(0, 40));
    }
  }

  return Array.from(new Set(needles.filter((needle) => needle.length >= 8)));
}

function hasQuoteMatch(segmentText: string, quotedText: string): boolean {
  const segment = normalizeForLookup(segmentText);
  return getQuoteNeedles(quotedText).some((needle) => segment.includes(needle));
}

function findFallbackSegmentByQuote(
  chapter: FallbackChapter,
  quotedText: string,
  preferredCfi?: string,
): FallbackTextSegment | null {
  const segments = chapter.segments?.filter((segment) => segment.text?.trim() && segment.cfi) ?? [];
  if (segments.length === 0) return null;

  if (preferredCfi) {
    const preferred = segments.find((segment) => segment.cfi === preferredCfi);
    if (preferred && (!quotedText.trim() || hasQuoteMatch(preferred.text, quotedText))) {
      return preferred;
    }
  }

  return segments.find((segment) => hasQuoteMatch(segment.text, quotedText)) ?? null;
}

export function findFallbackSegmentByTerms(
  chapter: FallbackChapter,
  terms: string[],
): FallbackTextSegment | null {
  const segments = chapter.segments?.filter((segment) => segment.text?.trim() && segment.cfi) ?? [];
  if (segments.length === 0) return null;

  let best: { segment: FallbackTextSegment; score: number } | null = null;
  for (const segment of segments) {
    const haystack = normalizeForTerms(segment.text);
    let score = 0;
    for (const term of terms) {
      if (!term) continue;
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      score += haystack.match(new RegExp(escaped, "g"))?.length ?? 0;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { segment, score };
    }
  }

  return best?.segment ?? null;
}

export function buildFallbackSnippet(text: string, terms: string[]): string {
  const content = text.replace(/\s+/g, " ").trim();
  if (!content) return "";

  const lower = content.toLowerCase();
  const index = terms
    .map((term) => lower.indexOf(term))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max(0, (index ?? 0) - 320);
  return content.slice(start, start + 900);
}

export async function resolveFallbackCitationSource(args: {
  bookId: string;
  chapterIndex: number;
  quotedText: string;
  preferredCfi?: string;
}): Promise<ResolvedFallbackSource | null> {
  // Mobile: reader session (single chapter read, 5s cap). The old full-book
  // extraction is REMOVED on mobile — it hit the 45s wall and blocked the tool.
  const provider = getBookContentSearchProvider();
  if (!provider) {
    // Desktop (no provider registered): keep the old local extraction.
    const data = await getFallbackChaptersForBook(args.bookId);
    if ("error" in data) return null;

    const chapter = data.chapters.find((item) => item.index === args.chapterIndex);
    if (!chapter) return null;

    const segment = findFallbackSegmentByQuote(chapter, args.quotedText, args.preferredCfi);
    if (!segment?.cfi) return null;

    return {
      chapterTitle: chapter.title,
      chapterIndex: chapter.index,
      text: segment.text,
      cfi: segment.cfi,
    };
  }

  try {
    const chapter = await Promise.race([
      provider.getChapter(args.bookId, args.chapterIndex),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (!chapter?.content) return null;
    const quoteAt = args.quotedText ? chapter.content.indexOf(args.quotedText.trim()) : -1;
    if (quoteAt >= 0) {
      return {
        chapterTitle: chapter.chapterTitle,
        chapterIndex: args.chapterIndex,
        text: chapter.content.slice(Math.max(0, quoteAt - 80), quoteAt + args.quotedText.length + 80),
        cfi: args.preferredCfi || "",
      };
    }
    if (args.preferredCfi) {
      return {
        chapterTitle: chapter.chapterTitle,
        chapterIndex: args.chapterIndex,
        text: chapter.content.slice(0, 200),
        cfi: args.preferredCfi,
      };
    }
    return null;
  } catch (err) {
    console.warn("[resolveFallbackCitationSource] provider failed, returning null:", err);
    return null;
  }
}
