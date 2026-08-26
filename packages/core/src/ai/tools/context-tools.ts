/**
 * Context Tools
 *
 * Tools for accessing user's current reading context:
 * - getSurroundingContext: Current position + anchored text (eats getCurrentChapter's job)
 * - getSelection: Get user's selected text
 * - getReadingProgress: Get reading progress
 * - getRecentHighlights: Get recent highlights
 */
import { getBook, getHighlights } from "../../db/database";
import { readingContextService } from "../reading-context-service";
import { getBookContentSearchProvider } from "../fallback-content-service";
import type { ToolDefinition } from "./tool-types";

const CURRENT_CHAPTER_CONTENT_TIMEOUT_MS = 3500;
const MAX_SURROUNDING_CHARS = 6000;

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

export function createGetSurroundingContextTool(bookId: string): ToolDefinition {
  return {
    name: "getSurroundingContext",
    description:
      "Get the user's current reading position (chapter + location) and the text AROUND it. The anchor is the user's ACTIVE SELECTION when one exists, otherwise their reading position — the text returned is where the user is actually looking, not the chapter start. Use this when the question relates to what the user is currently reading ('这段讲了什么', '我读到哪了'). Call once; the text it returns is the current context — do not also call other retrieval tools for the same position.",
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

      // Anchor: active selection first (the user's attention is on selected
      // text), otherwise the reading position. The reader session resolves
      // whichever cfi we pass to text around it.
      const selectionCfi = context.selection?.cfi;
      const anchorCfi = selectionCfi || context.currentPosition.cfi;

      // Fill surroundingText: snapshot may carry it (desktop), else resolve
      // from the reader session anchored at the chosen cfi. selection text is
      // returned separately below (not merged into surroundingText).
      let surroundingText = context.surroundingText;
      if (!surroundingText) {
        try {
          const searchProvider = getBookContentSearchProvider();
          if (searchProvider && anchorCfi && typeof searchProvider.getContextAroundCfi === "function") {
            const result = await Promise.race([
              searchProvider.getContextAroundCfi(bookId, anchorCfi),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), CURRENT_CHAPTER_CONTENT_TIMEOUT_MS)),
            ]);
            if (result) {
              surroundingText = [result.before, result.after].filter(Boolean).join("\n...\n").slice(0, MAX_SURROUNDING_CHARS);
            }
          }
        } catch {
          // Provider failure → keep whatever snapshot had.
        }
      }

      return {
        bookId,
        bookTitle: context.bookTitle,
        currentChapter: context.currentChapter.title,
        currentChapterIndex: context.currentChapter.index,
        currentPosition: context.currentPosition.percentage,
        currentPage: context.currentPosition.page,
        cfi: anchorCfi,
        surroundingText,
        // Selected text is the anchor when present — include it explicitly so
        // the model knows what's selected (it's NOT merged into surroundingText).
        ...(includeSelection && context.selection?.text?.trim()
          ? { selectedText: context.selection.text, selectionCfi }
          : {}),
        operationType: context.operationType,
        selectionActive: Boolean(context.selection?.text?.trim()),
      };
    },
  };
}

export function getContextTools(bookId: string): ToolDefinition[] {
  return [
    createGetSelectionTool(bookId),
    createGetReadingProgressTool(bookId),
    createGetRecentHighlightsTool(bookId),
    createGetSurroundingContextTool(bookId),
  ];
}
