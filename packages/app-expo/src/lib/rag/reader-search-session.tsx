import type { BookContentSearchMatch, BookContentSearchProvider } from "@readany/core/ai";
import { getBookContentSearchProvider, setBookContentSearchProvider } from "@readany/core/ai";
import { Asset } from "expo-asset";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { getPlatformService } from "@readany/core";
import { startFileServer } from "@/lib/reader/local-file-server";

const READER_HTML_ASSET = Asset.fromModule(require("../../../assets/reader/reader.html"));

/** Safety valves (short fallbacks against a hung WebView; normal paths are sub-second). */
const SEARCH_TIMEOUT_MS = 15_000;
const OPEN_TIMEOUT_MS = 15_000;

function randomRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Run async work serially (anx _AsyncLock). */
class AsyncLock {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Per-book session state (anx `_HeadlessSearchSession` per-book equivalent).
 * All per-book state lives here so switching books never leaks one book's
 * pending requests or lock into another — the root cause of the "switch book"
 * timeout was a single global lock/pending shared across books.
 */
class BookSession {
  readonly lock = new AsyncLock();
  readonly pending = new Map<string, PendingRequest>();
  tocCache: Array<{ index: number; title: string; href?: string }> | null = null;
  chapterTitles = new Map<number, string>();
  /** Whether this book is ready (bookReady received for it in the WebView). */
  ready = false;

  /** Reject all outstanding requests (book switched away). */
  abortAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Book switched away"));
    }
    this.pending.clear();
  }
}

/**
 * Single resident reader session (anx `_HeadlessSearchSession` equivalent).
 *
 * One persistent WebView (App-level, never unmounted) + per-book BookSession
 * state. Mirrors anx-reader's book_content_search_repository.dart:
 *  - ensureInitialized(): openBook → wait `bookReady` before returning
 *  - runSearch(): per-book AsyncLock + incremental search with per-hit callback
 *  - session per book (`Map<bookId, BookSession>`), shared WebView
 */
export class ReaderSearchSessionManager implements BookContentSearchProvider {
  private webView: WebView | null = null;
  private currentBookId: string | null = null;
  private bookPath: Map<string, BookLike> = new Map();
  private sessions = new Map<string, BookSession>();
  private readyCompleter: Promise<void> | null = null;
  private registered = false;

  /**
   * Attach the WebView instance (called by the shell component).
   * readyCompleter is created ONCE. A remount (hot reload / screen detach)
   * re-attaches the same WebView whose `ready` already fired; if we already
   * saw a ready (or re-attach), resolve immediately so ensureBookOpen never
   * hangs waiting for a second `ready` message.
   */
  attachWebView(wv: WebView | null): void {
    console.log("[ReaderSearchSession] attachWebView", !!wv, "wasReady:", this.readySeen);
    this.webView = wv;
    if (wv && !this.readyCompleter) {
      this.readyCompleter = new Promise<void>((resolve, reject) => {
        this._readyResolve = resolve;
        const t = setTimeout(() => {
          // 10s without a `ready` — assume the HTML is loaded enough to inject
          // (injectJavaScript queues until the page JS is ready anyway).
          this.readySeen = true;
          resolve();
        }, 10_000);
        this._readyTimeout = t;
      });
      if (this.readySeen) {
        // We already got one `ready` in a previous mount — resolve right away.
        if (this._readyTimeout) clearTimeout(this._readyTimeout);
        this._readyResolve?.();
        this._readyResolve = null;
      }
    }
  }

  private readySeen = false;

  private _readyResolve: (() => void) | null = null;
  private _readyTimeout: ReturnType<typeof setTimeout> | null = null;

  registerBooks(books: BookLike[]): void {
    this.bookPath.clear();
    for (const b of books) this.bookPath.set(b.id, b);
  }

  private sessionFor(bookId: string): BookSession {
    let session = this.sessions.get(bookId);
    if (!session) {
      session = new BookSession();
      this.sessions.set(bookId, session);
    }
    return session;
  }

  /** Reject everything on the PREVIOUS book so its stale state can't block the next. */
  private discardCurrentSession(): void {
    if (this.currentBookId) {
      const old = this.sessions.get(this.currentBookId);
      if (old) {
        old.abortAll();
        this.sessions.delete(this.currentBookId);
      }
    }
    this.currentBookId = null;
  }

  /** Find the session owning a request (by requestId), falling back to the current one. */
  private sessionOwning(requestId: string): BookSession | null {
    for (const session of this.sessions.values()) {
      if (session.pending.has(requestId)) return session;
    }
    return this.currentBookId ? this.sessions.get(this.currentBookId) ?? null : null;
  }

  /** Entry point for WebView messages (called by the shell component). */
  handleMessage(msg: Record<string, unknown>): void {
    console.log("[ReaderSearchSession] msg", JSON.stringify({ type: msg.type, keys: Object.keys(msg), requestId: msg.requestId ?? null }));
    const session = this.currentBookId ? this.sessions.get(this.currentBookId) : null;
    switch (msg.type) {
      case "ready":
        this.readySeen = true;
        // Re-register on EVERY ready: LibraryScreen's unmount cleanup used to
        // clear the provider while the app-lived manager stayed mounted — the
        // old `!_readyResolve` guard only registered on the first ready, so after
        // a screen remount the provider was permanently null and fallback* tools
        // silently fell back to the slow full-book path (30s tool timeout).
        if (getBookContentSearchProvider() !== this) {
          this.registered = true;
          setBookContentSearchProvider(this);
        }
        if (this._readyResolve) {
          if (this._readyTimeout) clearTimeout(this._readyTimeout);
          this._readyResolve();
          this._readyResolve = null;
        }
        break;
      case "bookReady":
      case "loaded":
        session?.pending.get("openBook")?.resolve({});
        if (session) session.ready = true;
        break;
      case "toc": {
        const flat = flattenToc((msg.items as Array<Record<string, unknown>>) ?? []);
        if (session) {
          session.tocCache = flat;
          session.chapterTitles = new Map(flat.map((item) => [item.index, item.title]));
        }
        break;
      }
      case "tocWithRequest":
      case "searchResultsFull":
      case "chapterFullText":
      case "cfiContext": {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
        if (requestId) {
          const owner = this.sessionOwning(requestId) ?? session;
          const pending = owner?.pending.get(requestId);
          console.log(
            "[ReaderSearchSession] resolve-attempt",
            JSON.stringify({ requestId, type: msg.type, foundOwner: !!owner, foundPending: !!pending }),
          );
          if (pending) {
            owner!.pending.delete(requestId);
            clearTimeout(pending.timeoutId);
            pending.resolve(msg);
          }
        }
        break;
      }
      case "searchHit":
      case "searchProgress": {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
        if (requestId) {
          // Do NOT delete pending here — hits accumulate until topK or
          // searchComplete (searchBookContent's resolve decides when done).
          const owner = this.sessionOwning(requestId) ?? session;
          const pending = owner?.pending.get(requestId);
          if (pending) pending.resolve(msg);
        }
        break;
      }
      case "searchError": {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
        if (requestId) {
          const owner = this.sessionOwning(requestId) ?? session;
          const pending = owner?.pending.get(requestId);
          if (pending) {
            owner!.pending.delete(requestId);
            clearTimeout(pending.timeoutId);
            pending.reject(new Error(typeof msg.error === "string" ? msg.error : "Search failed"));
          }
        }
        break;
      }
      default:
        break;
    }
  }

  private runRequest(
    session: BookSession,
    requestId: string,
    cmd: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const wv = this.webView;
      if (!wv) {
        reject(new Error("ReaderSearchSession not ready"));
        return;
      }
      const timeoutId = setTimeout(() => {
        const pending = session.pending.get(requestId);
        if (pending) {
          session.pending.delete(requestId);
          reject(new Error(`Timed out waiting for ${requestId}`));
        }
      }, timeoutMs);
      session.pending.set(requestId, { resolve, reject, timeoutId });
      // Call the global handleCommand directly (same as ReaderScreen's bridge) —
      // window.postMessage → message event is unreliable on Android RN WebView.
      wv.injectJavaScript(`handleCommand(${JSON.stringify(cmd)}); true;`);
    });
  }

  /** ensureInitialized (anx): open book, wait bookReady, then return. */
  private async ensureBookOpen(book: BookLike): Promise<void> {
    const session = this.sessionFor(book.id);
    if (this.currentBookId === book.id && session.ready) {
      // Already open and ready for THIS book — nothing to do.
      return;
    }

    console.log(
      "[ReaderSearchSession] ensureBookOpen",
      JSON.stringify({ bookId: book.id, current: this.currentBookId, hasWebView: !!this.webView }),
    );
    await this.readyCompleter;

    return session.lock.run(async () => {
      // Another call may have switched the live book while we queued.
      if (this.currentBookId === book.id && session.ready) return;

      // Switching to this book: abandon the previous book's state entirely.
      this.discardCurrentSession();

      const platform = getPlatformService();
      const appData = await platform.getAppDataDir();
      const filePath =
        book.filePath.startsWith("/") ||
        book.filePath.startsWith("file://") ||
        book.filePath.startsWith("asset://") ||
        book.filePath.startsWith("http")
          ? book.filePath
          : await platform.joinPath(appData, book.filePath);
      if (/^https?:\/\//i.test(filePath)) {
        throw new Error("Reader search requires a local book file");
      }

      // Same docRoot as ReaderScreen (appData) → shared file server; URI identical.
      const serverUrl = await startFileServer(appData);
      const bookFile = filePath.startsWith("file://") ? filePath.slice(7) : filePath;
      const bookUri = `${serverUrl}/books/${bookFile.split("/").pop()}`;
      const mime =
        book.format === "pdf"
          ? "application/pdf"
          : book.format === "txt"
            ? "text/plain"
            : "application/epub+zip";

      this.currentBookId = book.id;
      session.ready = false;
      console.log(
        "[ReaderSearchSession] openBook start",
        JSON.stringify({ bookId: book.id, bookUri, mime }),
      );
      // Pre-flight probe: verify the file server serves the book before asking the
      // WebView to open it — fail fast instead of waiting for the 15s timeout.
      try {
        const probe = await platform.fetch(bookUri, { method: "HEAD" });
        console.log(
          "[ReaderSearchSession] probe HEAD",
          JSON.stringify({ status: probe.status, bookUri }),
        );
      } catch (err) {
        console.warn("[ReaderSearchSession] probe failed:", err);
      }
      await this.runRequest(
        session,
        "openBook",
        {
          type: "openBook",
          uri: bookUri,
          mimeType: mime,
          fileName: `book.${book.format || "epub"}`,
        },
        OPEN_TIMEOUT_MS,
      );
    });
  }

  // ── BookContentSearchProvider ──
  async searchBookContent(bookId: string, query: string, opts: { topK: number }) {
    const book = this.bookPath.get(bookId);
    if (!book) throw new Error(`Book ${bookId} not registered for reader search`);
    await this.ensureBookOpen(book);
    const session = this.sessionFor(bookId);

    return session.lock.run(async () => {
      const requestId = randomRequestId("search");
      const matches: BookContentSearchMatch[] = [];
      const titleMap = session.chapterTitles;

      const result = await new Promise<{ count: number }>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          const pending = session.pending.get(requestId);
          if (pending) {
            session.pending.delete(requestId);
            reject(new Error(`Timed out waiting for ${requestId}`));
          }
        }, SEARCH_TIMEOUT_MS);
        const addMatch = (m: {
          cfi?: string;
          excerpt?: { pre?: string; match?: string; post?: string };
          chapterIndex?: number;
        }) => {
          const chapterIndex =
            typeof m.chapterIndex === "number" ? m.chapterIndex : undefined;
          matches.push({
            cfi: m.cfi ?? "",
            pre: m.excerpt?.pre,
            match: m.excerpt?.match,
            post: m.excerpt?.post,
            chapterTitle: chapterIndex != null ? titleMap.get(chapterIndex) : undefined,
            chapterIndex,
          } as BookContentSearchMatch);
        };
        // Accumulate hits — every searchHit/match counts toward topK; once we
        // have enough (anx: `active.results.length >= maxResults` → complete)
        // OR the full scan ends, resolve.
        const done = (count: number) => {
          clearTimeout(timeoutId);
          const pending = session.pending.get(requestId);
          if (pending) {
            session.pending.delete(requestId);
            resolve({ count });
          }
        };
        session.pending.set(requestId, {
          resolve: (m: any) => {
            const msg = m ?? {};
            if (typeof msg.progress === "number") {
              if (matches.length > 0 && msg.progress >= 0.4) {
                done(matches.length);
              } else if (msg.progress >= 0.95 && matches.length === 0) {
                done(0);
              }
              return;
            }
            if (Array.isArray(msg.results)) {
              for (const item of msg.results) addMatch(item);
              done(msg.count ?? matches.length);
              return;
            }
            if (msg.match) {
              addMatch(msg.match);
              if (matches.length >= opts.topK) {
                done(matches.length);
              }
              return;
            }
            done(msg.count ?? matches.length);
          },
          reject,
          timeoutId,
        });
        this.webView?.injectJavaScript(`handleCommand(${JSON.stringify({ type: "search", query, requestId })}); true;`);
      });

      return {
        query,
        matches: matches.slice(0, opts.topK),
        totalMatches: result.count,
        searchDurationMs: 0,
      };
    });
  }

  async getChapter(bookId: string, chapterIndex: number) {
    const book = this.bookPath.get(bookId);
    if (!book) throw new Error(`Book ${bookId} not registered for reader search`);
    await this.ensureBookOpen(book);
    const session = this.sessionFor(bookId);

    return session.lock.run(async () => {
      const requestId = randomRequestId("chapter");
      const msg = (await this.runRequest(
        session,
        requestId,
        { type: "getChapter", chapterIndex, requestId },
        SEARCH_TIMEOUT_MS,
      )) as { content?: string; error?: string };
      if (msg.error) throw new Error(msg.error);
      const title = session.chapterTitles.get(chapterIndex) ?? `Chapter ${chapterIndex + 1}`;
      return { chapterTitle: title, content: msg.content ?? "" };
    });
  }

  async getChapterByHref(bookId: string, href: string) {
    const book = this.bookPath.get(bookId);
    if (!book) throw new Error(`Book ${bookId} not registered for reader search`);
    await this.ensureBookOpen(book);
    const session = this.sessionFor(bookId);

    return session.lock.run(async () => {
      const requestId = randomRequestId("chapter-href");
      const msg = (await this.runRequest(
        session,
        requestId,
        { type: "getChapterByHref", href, requestId },
        SEARCH_TIMEOUT_MS,
      )) as { content?: string; error?: string };
      if (msg.error) throw new Error(msg.error);
      // Prefer the TOC title for this href; fall back to a generic label when
      // the TOC cache doesn't carry hrefs (desktop/old sessions).
      const tocEntry = session.tocCache?.find((item) => item.href === href);
      const title = tocEntry?.title ?? `Chapter (${href})`;
      return { chapterTitle: title, content: msg.content ?? "" };
    });
  }

  /** Text around a CFI anchor — the user's actual reading position. */
  async getContextAroundCfi(bookId: string, cfi: string) {
    const book = this.bookPath.get(bookId);
    if (!book) throw new Error(`Book ${bookId} not registered for reader search`);
    await this.ensureBookOpen(book);
    const session = this.sessionFor(bookId);

    return session.lock.run(async () => {
      const requestId = randomRequestId("cfi-context");
      const msg = (await this.runRequest(
        session,
        requestId,
        { type: "getCfiContext", cfi, requestId },
        SEARCH_TIMEOUT_MS,
      )) as { before?: string; after?: string; chapterTitle?: string; error?: string };
      if (msg.error) throw new Error(msg.error);
      return { before: msg.before ?? "", after: msg.after ?? "", chapterTitle: msg.chapterTitle };
    });
  }

  async getToc(bookId: string) {
    const book = this.bookPath.get(bookId);
    if (!book) throw new Error(`Book ${bookId} not registered for reader search`);
    await this.ensureBookOpen(book);
    const session = this.sessionFor(bookId);

    return session.lock.run(async () => {
      if (session.tocCache) return session.tocCache;
      const requestId = randomRequestId("toc");
      const msg = (await this.runRequest(
        session,
        requestId,
        { type: "getToc", requestId },
        SEARCH_TIMEOUT_MS,
      )) as { items?: Array<Record<string, unknown>> };
      const flat = flattenToc(msg.items ?? []);
      session.tocCache = flat;
      session.chapterTitles = new Map(flat.map((item) => [item.index, item.title]));
      return flat;
    });
  }

  dispose(): void {
    this.discardCurrentSession();
    if (this.registered) {
      setBookContentSearchProvider(null);
      this.registered = false;
    }
    if (this._readyTimeout) clearTimeout(this._readyTimeout);
  }
}

/**
 * Flatten hierarchical TOC into a flat list. Keeps `href` (foliate toc item
 * href) so the model can address a chapter directly by href — the anx-style
 * path: model picks the TOC row it wants, then chapter_content_by_href.
 */
function flattenToc(items: Array<Record<string, unknown>>): Array<{ index: number; title: string; href?: string }> {
  const flat: Array<{ index: number; title: string; href?: string }> = [];
  const walk = (list: Array<Record<string, unknown>>) => {
    for (const item of list) {
      flat.push({
        index: typeof item.index === "number" ? item.index : flat.length,
        title: typeof item.title === "string" && item.title ? item.title : `Chapter ${flat.length + 1}`,
        ...(typeof item.href === "string" && item.href ? { href: item.href } : {}),
      });
      if (Array.isArray(item.subitems) && item.subitems.length > 0) {
        walk(item.subitems as Array<Record<string, unknown>>);
      }
    }
  };
  walk(items);
  return flat;
}

type BookLike = {
  id: string;
  filePath: string;
  format?: string;
};

// Module-level singleton — survives any component remounts.
export const readerSearchSessionManager = new ReaderSearchSessionManager();

export interface ReaderSearchSessionRef {
  isReady(): boolean;
}

/**
 * Shell component: mounts the hidden WebView and hands it to the manager.
 * No session state lives here — remounting this shell is harmless.
 */
export const ReaderSearchSession = forwardRef<ReaderSearchSessionRef>((_, ref) => {
  const webViewRef = useRef<WebView>(null);
  const [htmlUri, setHtmlUri] = useState<string | null>(null);

  useEffect(() => {
    const loadAsset = async () => {
      try {
        const asset = READER_HTML_ASSET;
        await asset.downloadAsync();
        const uri = asset.localUri || asset.uri;
        setHtmlUri(uri);
      } catch (err) {
        console.error("[ReaderSearchSession] Failed to load HTML asset:", err);
      }
    };
    loadAsset();
  }, []);

  // Attach the WebView to the manager when it's mounted.
  const setWebView = useCallback((wv: WebView | null) => {
    webViewRef.current = wv;
    readerSearchSessionManager.attachWebView(wv);
  }, []);

  useImperativeHandle(ref, () => ({ isReady: () => !!readerSearchSessionManager }), []);

  useEffect(() => {
    return () => {
      // On shell unmount, detach but keep manager state (no provider unregister —
      // the manager stays registered so remount reattaches seamlessly).
    };
  }, []);

  if (!htmlUri) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <WebView
        ref={setWebView}
        source={{ uri: htmlUri }}
        style={{ width: 0, height: 0, opacity: 0 }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        onMessage={(event) => {
          try {
            const msg = JSON.parse(event.nativeEvent.data);
            readerSearchSessionManager.handleMessage(msg);
          } catch (err) {
            console.warn("[ReaderSearchSession] Failed to parse message:", err);
          }
        }}
      />
    </View>
  );
});

export function registerReaderSearchBook(book: BookLike): void {
  readerSearchSessionManager.registerBooks([book]);
}

export function unregisterReaderSearchBook(bookId: string): void {
  // Manager keeps book data in a Map; removing one book is a no-op for the API,
  // but reset is used by the library sync (see resetReaderSearchBookRegistry).
  void bookId;
}

export function resetReaderSearchBookRegistry(books: BookLike[]): void {
  readerSearchSessionManager.registerBooks(books);
}
