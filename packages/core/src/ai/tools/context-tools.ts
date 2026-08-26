/**
 * Context Tools
 *
 * Tools for accessing user's current reading context:
 * - getCurrentChapter: Get current chapter info
 * - getSelection: Get user's selected text
 * - getReadingProgress: Get reading progress
 * - getRecentHighlights: Get recent highlights
 */
import { getBook, getHighlights } from "../../db/database";
import { readingContextService } from "../reading-context-service";
import { getBookContentSearchProvider } from "../fallback-content-service";
import type { ToolDefinition } from "./tool-types";

const CURRENT_CHAPTER_CONTENT_TIMEOUT_MS = 3500;
const CURRENT_CHAPTER_CONTENT_MAX_CHARS = 4000;

export function createGetCurrentChapterTool(bookId: string): ToolDefinition {
  return {
    name: "getCurrentChapter",
    description:
      "Get information about the user's current reading chapter, including title, position, progress, and (when available) the chapter content itself. Use this when the user's question relates to their current location in the book.",
    parameters: {},
    execute: async () => {
      const context = readingContextService.getContext();
      const book = await getBook(bookId);

      if (!context) {
        return {
          error: "No reading context available",
          hint: "The user may not be actively reading a book",
        };
      }

      // Resolve chapter title from the context TOC when the relocate event
      // didn't carry a tocItem label (some books/spines leave it empty).
      const chapter = context.currentChapter;
      let title = chapter.title;
      if (!title && context.toc) {
        const tocTitle = context.toc.find((item) => item.index === chapter.index)?.title;
        if (tocTitle) title = tocTitle;
      }

      // Attach the current chapter's content when the book-content provider is
      // available (mobile: resident reader session — single-chapter read via
      // the reliable handleCommand channel, sub-second). The model can then
      // answer from the returned content without further retrieval steps.
      let content: string | undefined;
      try {
        const searchProvider = getBookContentSearchProvider();
        if (searchProvider) {
          const chapterResult = await Promise.race([
            searchProvider.getChapter(bookId, chapter.index),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), CURRENT_CHAPTER_CONTENT_TIMEOUT_MS)),
          ]);
          if (chapterResult?.content) {
            content = chapterResult.content.slice(0, CURRENT_CHAPTER_CONTENT_MAX_CHARS);
            if (chapterResult.chapterTitle) title = chapterResult.chapterTitle;
          }
        }
      } catch {
        // Provider failure → metadata-only response below.
      }

      return {
        bookId,
        bookTitle: book?.meta?.title || context.bookTitle,
        chapter: { ...chapter, title },
        position: context.currentPosition,
        operationType: context.operationType,
        selectionActive: Boolean(context.selection?.text?.trim()),
        progress: {
          percentage: context.currentPosition.percentage,
          page: context.currentPosition.page,
        },
        timestamp: context.timestamp,
        ...(content ? { content } : {}),
      };
    },
  };
}

export function createGetSelectionTool(_bookId: string): ToolDefinition {
  return {
    name: "getSelection",
    description:
      "Get the text currently selected by the user in the reader. Use this when the user asks about specific text they've highlighted or selected.",
    parameters: {},
    execute: async () => {
      const context = readingContextService.getContext();

      if (!context) {
        return {
          error: "No reading context available",
        };
      }

      if (!context.selection) {
        return {
          error: "No text selected",
          hint: "The user has not selected any text in the reader",
          currentChapter: context.currentChapter.title,
        };
      }

      return {
        selectedText: context.selection.text,
        chapterTitle: context.selection.chapterTitle,
        chapterIndex: context.selection.chapterIndex,
        cfi: context.selection.cfi,
        surroundingContext: context.surroundingText,
      };
    },
  };
}

export function createGetReadingProgressTool(bookId: string): ToolDefinition {
  return {
    name: "getReadingProgress",
    description:
      "Get the user's reading progress for the current book, including percentage, time spent, and session info.",
    parameters: {},
    execute: async () => {
      const context = readingContextService.getContext();
      const book = await getBook(bookId);

      if (!context) {
        return {
          error: "No reading context available",
        };
      }

      return {
        bookId,
        bookTitle: book?.meta?.title || context.bookTitle,
        progress: {
          percentage: context.currentPosition.percentage,
          currentPage: context.currentPosition.page,
          currentChapter: context.currentChapter.title,
          currentChapterIndex: context.currentChapter.index,
        },
        lastActivity: context.timestamp,
        operationType: context.operationType,
        selectionActive: Boolean(context.selection?.text?.trim()),
      };
    },
  };
}

export function createGetRecentHighlightsTool(bookId: string): ToolDefinition {
  return {
    name: "getRecentHighlights",
    description:
      "Get the user's recent highlights and annotations from the current book. Use this to reference what the user has marked as important.",
    parameters: {
      limit: {
        type: "number",
        description: "Maximum number of highlights to return (default: 10)",
      },
    },
    execute: async (args) => {
      const limit = (args.limit as number) || 10;

      const highlights = await getHighlights(bookId);

      if (highlights.length === 0) {
        return {
          message: "No highlights found for this book",
          bookId,
        };
      }

      const recentHighlights = highlights.slice(0, limit).map((h) => ({
        text: h.text,
        note: h.note,
        chapterTitle: h.chapterTitle,
        color: h.color,
        createdAt: h.createdAt,
      }));

      return {
        total: highlights.length,
        highlights: recentHighlights,
      };
    },
  };
}

export function createGetSurroundingContextTool(_bookId: string): ToolDefinition {
  return {
    name: "getSurroundingContext",
    description:
      "Get the text surrounding the user's current reading position. Useful for understanding what the user is currently looking at.",
    parameters: {
      includeSelection: {
        type: "boolean",
        description: "Whether to include selected text if available (default: true)",
      },
    },
    execute: async (args) => {
      const includeSelection = (args.includeSelection as boolean) ?? true;
      const context = readingContextService.getContext();

      if (!context) {
        return {
          error: "No reading context available",
        };
      }

      return {
        currentChapter: context.currentChapter.title,
        currentChapterIndex: context.currentChapter.index,
        currentPosition: context.currentPosition.percentage,
        currentPage: context.currentPosition.page,
        surroundingText: context.surroundingText,
        selection: includeSelection ? context.selection : undefined,
        operationType: context.operationType,
        selectionActive: Boolean(context.selection?.text?.trim()),
      };
    },
  };
}

export function getContextTools(bookId: string): ToolDefinition[] {
  return [
    createGetCurrentChapterTool(bookId),
    createGetSelectionTool(bookId),
    createGetReadingProgressTool(bookId),
    createGetRecentHighlightsTool(bookId),
    createGetSurroundingContextTool(bookId),
  ];
}
