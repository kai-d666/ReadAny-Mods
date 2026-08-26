import type { Book } from "../types";

export interface FallbackTextSegment {
  text: string;
  cfi?: string;
}

export interface FallbackChapter {
  index: number;
  title: string;
  content: string;
  segments?: FallbackTextSegment[];
}

export interface FallbackContentProvider {
  getChapters(book: Book): Promise<FallbackChapter[]>;
}

/**
 * Book content search provider — registered per platform (mobile: single resident
 * reader session using foliate incremental search; desktop: stays on
 * FallbackContentProvider / local extraction). fallback* tools prefer this
 * provider when registered; otherwise they fall back to getFallbackChaptersForBook.
 *
 * Unlike FallbackContentProvider (full-book chapter extraction), these are
 * incremental/on-demand queries that never parse the whole book at once.
 */
export interface BookContentSearchProvider {
  /** Search the book inside the loaded reader session. Returns cfi+excerpt matches. */
  searchBookContent(
    bookId: string,
    query: string,
    opts: { topK: number },
  ): Promise<BookContentSearchResult>;
  /** Full text of one chapter from the loaded reader session. */
  getChapter(bookId: string, chapterIndex: number): Promise<{ chapterTitle: string; content: string }>;
  /** Chapter list (TOC) — parsed by the reader when the book is opened. */
  getToc(bookId: string): Promise<{ index: number; title: string; href?: string }[]>;
  /** Full text of a chapter addressed by TOC href (anx-style: model picks the
   *  TOC row, then fetches by its href — no chapter-number parsing needed). */
  getChapterByHref(
    bookId: string,
    href: string,
  ): Promise<{ chapterTitle: string; content: string }>;
  /** Text around a CFI anchor — the user's actual reading position, not the
   *  chapter start. Returns the text before/after the anchor within its
   *  section (bounded), so "what am I reading right now" answers are anchored
   *  where the user actually is. */
  getContextAroundCfi(
    bookId: string,
    cfi: string,
  ): Promise<{ before: string; after: string; chapterTitle?: string }>;
}

export interface BookContentSearchMatch {
  cfi: string;
  pre?: string;
  match?: string;
  post?: string;
  chapterTitle?: string;
  chapterIndex?: number;
}
export interface BookContentSearchResult {
  query: string;
  matches: BookContentSearchMatch[];
  totalMatches: number;
  searchDurationMs: number;
}

let bookContentSearchProvider: BookContentSearchProvider | null = null;

export function setBookContentSearchProvider(provider: BookContentSearchProvider | null): void {
  bookContentSearchProvider = provider;
}

export function getBookContentSearchProvider(): BookContentSearchProvider | null {
  return bookContentSearchProvider;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 8;
const PROVIDER_TIMEOUT_MS = 45_000;

interface CachedChapters {
  chapters: FallbackChapter[];
  cachedAt: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("Timed out reading original book content"));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

class FallbackContentService {
  private provider: FallbackContentProvider | null = null;
  private cache = new Map<string, CachedChapters>();

  setProvider(provider: FallbackContentProvider | null): void {
    this.provider = provider;
    this.cache.clear();
  }

  clear(bookId?: string): void {
    if (bookId) {
      this.cache.delete(bookId);
      return;
    }
    this.cache.clear();
  }

  async getChapters(book: Book): Promise<FallbackChapter[]> {
    if (!this.provider) {
      throw new Error("Fallback content provider is not registered");
    }

    const cached = this.cache.get(book.id);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.chapters;
    }

    const chapters = await withTimeout(this.provider.getChapters(book), PROVIDER_TIMEOUT_MS);
    this.cache.set(book.id, { chapters, cachedAt: Date.now() });

    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    return chapters;
  }
}

export const fallbackContentService = new FallbackContentService();

export function setFallbackContentProvider(provider: FallbackContentProvider | null): void {
  fallbackContentService.setProvider(provider);
}
