/**
 * Reading Context Service
 *
 * Tracks user's current reading state including:
 * - Current chapter and position
 * - Text selection
 * - Recent highlights
 * - Reading progress
 *
 * Provides real-time context for AI tools.
 */
import { useEffect, useState } from "react";
import { getHighlights } from "../db/database";
import { getPlatformService } from "../services/platform";
import type { ReadingContext } from "../types/chat";

type ReadingContextListener = (context: ReadingContext | null) => void;

const STORE_DIR = "readany-store";
const SNAPSHOT_FILE = "reader-context.json";

class ReadingContextService {
  private context: ReadingContext | null = null;
  private listeners: Set<ReadingContextListener> = new Set();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotWriteQueue: Promise<void> = Promise.resolve();

  subscribe(listener: ReadingContextListener): () => void {
    this.listeners.add(listener);
    listener(this.context);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((listener) => listener(this.context));
  }

  private debouncedNotify() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.notify();
      this.debounceTimer = null;
    }, 50);
  }

  private scheduleSnapshotWrite(): void {
    const snapshot = this.context;
    this.snapshotWriteQueue = this.snapshotWriteQueue.then(
      () => this.writeSnapshot(snapshot),
      () => this.writeSnapshot(snapshot),
    );
  }

  async flushSnapshot(): Promise<void> {
    await this.snapshotWriteQueue;
  }

  private async writeSnapshot(snapshot: ReadingContext | null): Promise<void> {
    try {
      const platform = getPlatformService();
      const dataDir = await platform.getDataDir();
      const dir = await platform.joinPath(dataDir, STORE_DIR);
      await platform.mkdir(dir);
      const filePath = await platform.joinPath(dir, SNAPSHOT_FILE);
      if (!snapshot) {
        if (await platform.exists(filePath)) {
          await platform.deleteFile(filePath);
        }
        return;
      }
      await platform.writeTextFile(filePath, JSON.stringify(snapshot));
    } catch (error) {
      console.warn("[ReadingContext] Failed to persist context snapshot:", error);
    }
  }

  getContext(): ReadingContext | null {
    return this.context;
  }

  async updateContext(partial: Partial<ReadingContext>): Promise<void> {
    if (!partial.bookId) {
      this.context = null;
      this.notify();
      this.scheduleSnapshotWrite();
      return;
    }

    const now = Date.now();

    if (!this.context || this.context.bookId !== partial.bookId) {
      const highlights = await getHighlights(partial.bookId);
      const recentHighlights = highlights.slice(0, 5).map((h) => ({
        text: h.text,
        cfi: h.cfi,
        note: h.note,
      }));

      this.context = {
        bookId: partial.bookId,
        bookTitle: partial.bookTitle || "",
        currentChapter: partial.currentChapter || { index: 0, title: "", href: "" },
        currentPosition: partial.currentPosition || { cfi: "", percentage: 0 },
        surroundingText: partial.surroundingText || "",
        recentHighlights,
        operationType: partial.operationType || "reading",
        ...(partial.toc ? { toc: partial.toc } : {}),
        timestamp: now,
      };
    } else {
      this.context = {
        ...this.context,
        ...partial,
        timestamp: now,
      };
    }

    this.debouncedNotify();
    this.scheduleSnapshotWrite();
  }

  updateSelection(selection: ReadingContext["selection"]): void {
    if (!this.context) return;

    this.context = {
      ...this.context,
      selection,
      operationType: selection ? "selecting" : "reading",
      timestamp: Date.now(),
    };

    this.debouncedNotify();
    this.scheduleSnapshotWrite();
  }

  clearSelection(): void {
    if (!this.context) return;

    this.context = {
      ...this.context,
      selection: undefined,
      operationType: "reading",
      timestamp: Date.now(),
    };

    this.debouncedNotify();
    this.scheduleSnapshotWrite();
  }

  updatePosition(position: Partial<ReadingContext["currentPosition"]>): void {
    if (!this.context) return;

    this.context = {
      ...this.context,
      currentPosition: {
        ...this.context.currentPosition,
        ...position,
      },
      timestamp: Date.now(),
    };

    this.debouncedNotify();
    this.scheduleSnapshotWrite();
  }

  updateChapter(chapter: Partial<ReadingContext["currentChapter"]>): void {
    if (!this.context) return;

    this.context = {
      ...this.context,
      currentChapter: {
        ...this.context.currentChapter,
        ...chapter,
      },
      timestamp: Date.now(),
    };

    this.debouncedNotify();
    this.scheduleSnapshotWrite();
  }

  setOperationType(type: ReadingContext["operationType"]): void {
    if (!this.context) return;

    this.context = {
      ...this.context,
      operationType: type,
      timestamp: Date.now(),
    };

    this.debouncedNotify();
    this.scheduleSnapshotWrite();
  }

  clearContext(): void {
    this.context = null;
    this.notify();
    this.scheduleSnapshotWrite();
  }
}

export const readingContextService = new ReadingContextService();

export function useReadingContext(): ReadingContext | null {
  const [context, setContext] = useState<ReadingContext | null>(() =>
    readingContextService.getContext(),
  );

  useEffect(() => readingContextService.subscribe(setContext), []);

  return context;
}

export function getReadingContextSnapshot(): ReadingContext | null {
  return readingContextService.getContext();
}
