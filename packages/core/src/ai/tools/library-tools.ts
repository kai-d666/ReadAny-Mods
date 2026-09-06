/**
 * Library Tools — listBooks, searchAllHighlights, searchAllNotes, readingStats, classifyBooks,
 * tagBooks, manageBookTags, updateBookMetadata, manageBookGroups
 */
import {
  deleteGroup,
  getAllHighlights,
  getAllNotes,
  getBook,
  getBooks,
  getChunks,
  getGroups,
  getReadingSessionsByDateRange,
  insertGroup,
  updateBook,
  updateGroup,
} from "../../db/database";
import { emitLibraryChanged } from "../../events/library-events";
import { debouncedSave, loadFromFS } from "../../stores/persist";
import type { Book, BookMeta, BookReview } from "../../types";
import { getProgressPercent, useProgressStore } from "../../stores/progress-store";
import { splitEditableList } from "../../utils/book-metadata";
import { generateId } from "../../utils/generate-id";
import type { ToolDefinition } from "./tool-types";

const BOOK_METADATA_FIELDS = [
  "title",
  "author",
  "publisher",
  "language",
  "isbn",
  "description",
  "coverUrl",
  "publishDate",
  "rating",
  "subjects",
  "tags",
  "reviews",
  "groupId",
] as const;

type BookMetadataField = (typeof BOOK_METADATA_FIELDS)[number];

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseStringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) throw new Error("Expected a JSON array");
      return Array.from(new Set(parsed.map((item) => String(item).trim()).filter(Boolean)));
    }
    return splitEditableList(trimmed);
  }
  throw new Error("Expected a string list or JSON array");
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function normalizeMetadataReviews(
  value: unknown,
  originalReviews: BookReview[],
): BookReview[] | undefined {
  if (value === undefined) return undefined;
  const now = Date.now();
  const originalById = new Map(originalReviews.map((review) => [review.id, review]));

  if (Array.isArray(value)) {
    const reviews = value
      .map((item) => {
        if (typeof item === "string") {
          const content = item.trim();
          if (!content) return null;
          return { id: generateId(), content, createdAt: now, updatedAt: now };
        }
        if (!item || typeof item !== "object") return null;
        const raw = item as Partial<BookReview>;
        const content = String(raw.content ?? "").trim();
        if (!content) return null;
        const original = raw.id ? originalById.get(raw.id) : undefined;
        return {
          id: raw.id || generateId(),
          content,
          createdAt: raw.createdAt || original?.createdAt || now,
          updatedAt: original && original.content.trim() === content ? original.updatedAt : now,
        };
      })
      .filter((review): review is BookReview => Boolean(review));
    return reviews;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed) as unknown;
    return normalizeMetadataReviews(parsed, originalReviews);
  }

  throw new Error("Expected reviews to be a JSON array");
}

function buildMetadataToolUpdate(
  book: Book,
  rawUpdates: Record<string, unknown>,
): { updates: Partial<Book>; changedFields: BookMetadataField[]; ignoredFields: string[] } {
  const nextMeta: BookMeta = { ...book.meta };
  const update: Partial<Book> = {};
  const changedFields: BookMetadataField[] = [];
  const ignoredFields = Object.keys(rawUpdates).filter(
    (field) => !BOOK_METADATA_FIELDS.includes(field as BookMetadataField),
  );

  const setMetaString = (
    field: keyof Pick<
      BookMeta,
      "publisher" | "language" | "isbn" | "description" | "coverUrl" | "publishDate"
    >,
  ) => {
    if (!Object.prototype.hasOwnProperty.call(rawUpdates, field)) return;
    nextMeta[field] = normalizeOptionalString(rawUpdates[field]);
    changedFields.push(field as BookMetadataField);
  };

  if (Object.prototype.hasOwnProperty.call(rawUpdates, "title")) {
    const title = normalizeOptionalString(rawUpdates.title);
    if (title) {
      nextMeta.title = title;
      changedFields.push("title");
    }
  }
  if (Object.prototype.hasOwnProperty.call(rawUpdates, "author")) {
    nextMeta.author = String(rawUpdates.author ?? "").trim();
    changedFields.push("author");
  }

  setMetaString("publisher");
  setMetaString("language");
  setMetaString("isbn");
  setMetaString("description");
  setMetaString("coverUrl");
  setMetaString("publishDate");

  if (Object.prototype.hasOwnProperty.call(rawUpdates, "rating")) {
    const rawRating = rawUpdates.rating;
    if (rawRating === null || rawRating === "" || rawRating === undefined) {
      nextMeta.rating = undefined;
    } else {
      const rating = Math.max(0, Math.min(5, Number(rawRating)));
      nextMeta.rating = Number.isFinite(rating) ? rating : undefined;
    }
    changedFields.push("rating");
  }

  if (Object.prototype.hasOwnProperty.call(rawUpdates, "subjects")) {
    const subjects = parseStringList(rawUpdates.subjects) ?? [];
    nextMeta.subjects = subjects.length > 0 ? subjects : undefined;
    changedFields.push("subjects");
  }

  if (Object.prototype.hasOwnProperty.call(rawUpdates, "reviews")) {
    const reviews = normalizeMetadataReviews(rawUpdates.reviews, book.meta.reviews || []);
    nextMeta.reviews = reviews && reviews.length > 0 ? reviews : undefined;
    changedFields.push("reviews");
  }

  if (Object.prototype.hasOwnProperty.call(rawUpdates, "tags")) {
    update.tags = parseStringList(rawUpdates.tags) ?? [];
    changedFields.push("tags");
  }

  if (Object.prototype.hasOwnProperty.call(rawUpdates, "groupId")) {
    update.groupId = normalizeOptionalString(rawUpdates.groupId);
    changedFields.push("groupId");
  }

  if (changedFields.some((field) => field !== "tags" && field !== "groupId")) {
    update.meta = nextMeta;
  }

  return { updates: update, changedFields, ignoredFields };
}

/** List all books in the user's library */
export function createListBooksTool(): ToolDefinition {
  return {
    name: "listBooks",
    description:
      "List all books in the user's library, including titles, authors, reading progress, and basic metadata. Use this when the user asks about their books, reading list, or library.",
    parameters: {
      reasoning: {
        type: "string",
        description: "Brief explanation of why you are calling this tool",
        required: true,
      },
      search: {
        type: "string",
        description: "Search keyword to filter by title or author",
      },
      status: {
        type: "string",
        description:
          "Filter by reading status: 'unread' (0%), 'reading' (1-99%), or 'completed' (100%)",
      },
      limit: {
        type: "number",
        description: "Maximum number of books to return (default: 20)",
      },
    },
    execute: async (args) => {
      const limit = (args.limit as number) || 20;
      const searchTerm = (args.search as string)?.toLowerCase();
      const status = args.status as string | undefined;
      let books = await getBooks();

      // Filter by search keyword
      if (searchTerm) {
        books = books.filter(
          (b) =>
            b.meta.title?.toLowerCase().includes(searchTerm) ||
            b.meta.author?.toLowerCase().includes(searchTerm),
        );
      }

      // 进度经唯一账本(reading_progress)读取;books.progress 已废弃(移动端不再更新)
      await useProgressStore.getState().hydrate();
      const progressOf = (b: Book) => getProgressPercent(b.fileHash);

      // Filter by reading status
      if (status === "unread") {
        books = books.filter((b) => !progressOf(b));
      } else if (status === "reading") {
        books = books.filter((b) => progressOf(b) > 0 && progressOf(b) < 1);
      } else if (status === "completed") {
        books = books.filter((b) => progressOf(b) >= 1);
      }

      const result = books.slice(0, limit).map((b) => ({
        id: b.id,
        title: b.meta.title,
        author: b.meta.author,
        format: b.format,
        progress: `${Math.round(progressOf(b) * 100)}%`,
        isVectorized: b.isVectorized,
        addedAt: b.addedAt,
        lastOpenedAt: b.lastOpenedAt,
      }));
      return { total: books.length, showing: result.length, books: result };
    },
  };
}

/** Search highlights across all books */
export function createSearchAllHighlightsTool(): ToolDefinition {
  return {
    name: "searchAllHighlights",
    description:
      "Get the user's recent highlights and annotations across ALL books. Use this when the user asks about their highlights, marked passages, or important notes without specifying a particular book.",
    parameters: {
      reasoning: {
        type: "string",
        description: "Brief explanation of why you are calling this tool",
        required: true,
      },
      days: {
        type: "number",
        description:
          "Only return highlights from the last N days (e.g. 7=last week, 30=last month)",
      },
      limit: {
        type: "number",
        description: "Maximum number of highlights to return (default: 20)",
      },
    },
    execute: async (args) => {
      const limit = (args.limit as number) || 20;
      const days = args.days as number | undefined;
      let highlights = await getAllHighlights(limit * 2); // fetch extra for filtering
      const books = await getBooks();
      const bookMap = new Map(books.map((b) => [b.id, b.meta.title]));

      // Filter by time range
      if (days) {
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        highlights = highlights.filter((h) => h.createdAt >= cutoff);
      }

      highlights = highlights.slice(0, limit);

      return {
        total: highlights.length,
        highlights: highlights.map((h) => ({
          text: h.text,
          note: h.note,
          bookTitle: bookMap.get(h.bookId) || "Unknown",
          chapterTitle: h.chapterTitle,
          color: h.color,
          createdAt: h.createdAt,
        })),
      };
    },
  };
}

/** Search notes across all books */
export function createSearchAllNotesTool(): ToolDefinition {
  return {
    name: "searchAllNotes",
    description:
      "Get the user's notes across ALL books. Use this when the user asks about their notes, thoughts, or writings without specifying a particular book.",
    parameters: {
      reasoning: {
        type: "string",
        description: "Brief explanation of why you are calling this tool",
        required: true,
      },
      days: {
        type: "number",
        description: "Only return notes from the last N days (e.g. 7=last week, 30=last month)",
      },
      bookTitle: {
        type: "string",
        description: "Filter notes by book title (fuzzy match)",
      },
      limit: {
        type: "number",
        description: "Maximum number of notes to return (default: 20)",
      },
    },
    execute: async (args) => {
      const limit = (args.limit as number) || 20;
      const days = args.days as number | undefined;
      const bookTitleSearch = (args.bookTitle as string)?.toLowerCase();

      const notes = await getAllNotes(limit * 2);
      const highlightsWithNotes = await getAllHighlights(limit * 2);
      const highlightNotes = highlightsWithNotes.filter((h) => h.note);

      const books = await getBooks();
      const bookMap = new Map(books.map((b) => [b.id, b.meta.title]));

      let allNotes = [
        ...notes.map((n) => ({
          type: "note" as const,
          title: n.title,
          content: n.content,
          bookId: n.bookId,
          chapterTitle: n.chapterTitle,
          tags: n.tags,
          createdAt: n.createdAt,
        })),
        ...highlightNotes.map((h) => ({
          type: "highlight_note" as const,
          title: h.text.slice(0, 50) + (h.text.length > 50 ? "..." : ""),
          content: h.note || "",
          bookId: h.bookId,
          chapterTitle: h.chapterTitle,
          highlightedText: h.text,
          createdAt: h.createdAt,
        })),
      ];

      if (days) {
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        allNotes = allNotes.filter((n) => n.createdAt >= cutoff);
      }

      if (bookTitleSearch) {
        allNotes = allNotes.filter((n) => {
          const title = bookMap.get(n.bookId)?.toLowerCase() || "";
          return title?.includes(bookTitleSearch);
        });
      }

      allNotes.sort((a, b) => b.createdAt - a.createdAt);
      allNotes = allNotes.slice(0, limit);

      return {
        total: allNotes.length,
        notes: allNotes.map((n) => ({
          type: n.type,
          title: n.title,
          content: n.content,
          bookTitle: bookMap.get(n.bookId) || "Unknown",
          chapterTitle: n.chapterTitle,
          highlightedText: n.type === "highlight_note" ? n.highlightedText : undefined,
          tags: n.type === "note" ? n.tags : undefined,
          createdAt: n.createdAt,
        })),
      };
    },
  };
}

/** Get reading statistics across all books */
export function createReadingStatsTool(): ToolDefinition {
  return {
    name: "getReadingStats",
    description:
      "Get the user's reading statistics, including total books, reading time, and recent activity. Use this when the user asks about their reading habits, statistics, or activity summary.",
    parameters: {
      reasoning: {
        type: "string",
        description: "Brief explanation of why you are calling this tool",
        required: true,
      },
      days: {
        type: "number",
        description: "Number of recent days to include for activity stats (default: 30)",
      },
    },
    execute: async (args) => {
      const days = (args.days as number) || 30;
      const books = await getBooks();
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const sessions = await getReadingSessionsByDateRange(startDate, endDate);

      const totalReadingTimeMs = sessions.reduce((sum, s) => sum + s.totalActiveTime, 0);
      const totalPagesRead = sessions.reduce((sum, s) => sum + s.pagesRead, 0);
      // 进度经唯一账本(reading_progress)读取;books.progress 已废弃
      await useProgressStore.getState().hydrate();
      const progressOf = (b: Book) => getProgressPercent(b.fileHash);
      const booksInProgress = books.filter((b) => progressOf(b) > 0 && progressOf(b) < 1);
      const booksCompleted = books.filter((b) => progressOf(b) >= 1);

      return {
        library: {
          totalBooks: books.length,
          inProgress: booksInProgress.length,
          completed: booksCompleted.length,
        },
        recentActivity: {
          periodDays: days,
          totalSessions: sessions.length,
          totalReadingMinutes: Math.round(totalReadingTimeMs / 60000),
          totalPagesRead,
        },
        recentBooks: books.slice(0, 5).map((b) => ({
          title: b.meta.title,
          author: b.meta.author,
          progress: Math.round(progressOf(b) * 100),
        })),
      };
    },
  };
}

/** Get books info and existing tags for AI classification */
export function createClassifyBooksTool(): ToolDefinition {
  return {
    name: "classifyBooks",
    description:
      "Get book metadata, table of contents, and content samples for classification. MUST be called BEFORE tagBooks to get book IDs and enough context. Without bookId: returns all uncategorized books with their TOC and content samples. With bookId: returns that specific book's full info. Use when the user asks to classify/categorize/tag books. IMPORTANT: Each book should have at most 2 tags — pick the most representative ones.",
    parameters: {
      reasoning: {
        type: "string",
        description: "Brief explanation of why you are calling this tool",
        required: true,
      },
      bookId: {
        type: "string",
        description:
          "Optional. If provided, return info for this specific book instead of all uncategorized books.",
      },
    },
    execute: async (args) => {
      const books = await getBooks();
      const allTags = [...new Set(books.flatMap((b) => b.tags))];
      const targetBookId = args.bookId as string | undefined;

      /** Extract TOC and content samples from chunks for a given book */
      const getBookContentInfo = async (bookId: string) => {
        try {
          const chunks = await getChunks(bookId);
          if (chunks.length === 0) return { toc: [], contentSample: "" };

          // Extract TOC
          const chapters = new Map<number, string>();
          for (const chunk of chunks) {
            if (!chapters.has(chunk.chapterIndex)) {
              chapters.set(chunk.chapterIndex, chunk.chapterTitle);
            }
          }
          const toc = Array.from(chapters.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, title]) => title);

          // Sample first few chunks as content preview (up to ~1500 chars)
          let contentSample = "";
          for (const chunk of chunks.slice(0, 5)) {
            contentSample += `${chunk.content}\n`;
            if (contentSample.length > 1500) break;
          }
          contentSample = contentSample.slice(0, 1500);

          return { toc, contentSample };
        } catch (err) {
          console.warn("[AI] Failed to get book content info:", err);
          return { toc: [], contentSample: "" };
        }
      };

      if (targetBookId) {
        const book = await getBook(targetBookId);
        if (!book) {
          return { success: false, error: "Book not found" };
        }
        const contentInfo = await getBookContentInfo(book.id);
        return {
          existingTags: allTags,
          book: {
            id: book.id,
            title: book.meta.title,
            author: book.meta.author,
            description: book.meta.description,
            subjects: book.meta.subjects,
            language: book.meta.language,
            currentTags: book.tags,
            toc: contentInfo.toc,
            contentSample: contentInfo.contentSample,
          },
          totalBooks: books.length,
        };
      }

      const uncategorized = books.filter((b) => b.tags.length === 0);
      const uncategorizedWithContent = await Promise.all(
        uncategorized.map(async (b) => {
          const contentInfo = await getBookContentInfo(b.id);
          return {
            id: b.id,
            title: b.meta.title,
            author: b.meta.author,
            description: b.meta.description,
            subjects: b.meta.subjects,
            language: b.meta.language,
            toc: contentInfo.toc,
            contentSample: contentInfo.contentSample,
          };
        }),
      );
      return {
        existingTags: allTags,
        uncategorizedBooks: uncategorizedWithContent,
        totalBooks: books.length,
        uncategorizedCount: uncategorized.length,
      };
    },
  };
}

/** Batch-apply tags to books */
export function createTagBooksTool(): ToolDefinition {
  return {
    name: "tagBooks",
    description:
      "Apply tags to books. Can tag multiple books at once. IMPORTANT: You MUST call classifyBooks first to get book IDs and metadata — never guess tags based on title alone. Use the description, subjects, and language from classifyBooks results to suggest accurate tags. RULE: Each book should have at most 2 tags — pick the 1-2 most representative categories. Prefer reusing existing tags over creating new ones.",
    parameters: {
      reasoning: {
        type: "string",
        description: "Brief explanation of why you are calling this tool",
        required: true,
      },
      assignments: {
        type: "string",
        description:
          'JSON array of {bookId, tags: string[]}. Example: [{"bookId":"abc","tags":["科幻","小说"]}]',
        required: true,
      },
    },
    execute: async (args) => {
      const assignments: { bookId: string; tags: string[] }[] = JSON.parse(
        args.assignments as string,
      );
      const results: {
        bookId: string;
        title?: string;
        tags?: string[];
        success: boolean;
        error?: string;
      }[] = [];
      for (const { bookId, tags } of assignments) {
        const book = await getBook(bookId);
        if (!book) {
          results.push({ bookId, success: false, error: "Book not found" });
          continue;
        }
        const merged = [...new Set([...book.tags, ...tags])];
        await updateBook(bookId, { tags: merged });
        results.push({
          bookId,
          title: book.meta.title,
          tags: merged,
          success: true,
        });
      }
      const result = {
        results,
        taggedCount: results.filter((r) => r.success).length,
      };
      emitLibraryChanged();
      return result;
    },
  };
}

/** Update book metadata and placement fields */
export function createUpdateBookMetadataTool(): ToolDefinition {
  return {
    name: "updateBookMetadata",
    description:
      "Update a book's editable metadata: title, author, publisher, language, ISBN, publish date, description, cover URL, rating, subjects, reviews, tags, and groupId. Use listBooks or classifyBooks first if you do not know the bookId. Pass updates as a JSON object. Do not call this for content analysis; only call it when the user asks to edit or organize their library data.",
    parameters: {
      reasoning: {
        type: "string",
        description: "Brief explanation of why you are updating this book metadata",
        required: true,
      },
      bookId: {
        type: "string",
        description: "Book ID to update",
        required: true,
      },
      updates: {
        type: "string",
        description:
          'JSON object with any editable fields. Example: {"title":"New title","author":"Author","tags":["文学"],"rating":4.5,"groupId":"group-id","reviews":["Short review"]}',
        required: true,
      },
    },
    execute: async (args) => {
      const bookId = String(args.bookId || "").trim();
      if (!bookId) return { success: false, error: "bookId is required" };

      const book = await getBook(bookId);
      if (!book) return { success: false, error: "Book not found" };

      let rawUpdates: Record<string, unknown>;
      try {
        rawUpdates = parseJsonObject(args.updates);
      } catch (error) {
        return { success: false, error: `Invalid updates JSON: ${(error as Error).message}` };
      }

      let built: ReturnType<typeof buildMetadataToolUpdate>;
      try {
        built = buildMetadataToolUpdate(book, rawUpdates);
      } catch (error) {
        return { success: false, error: `Invalid metadata update: ${(error as Error).message}` };
      }

      if (built.changedFields.length === 0) {
        return {
          success: false,
          error: "No supported metadata fields were provided",
          ignoredFields: built.ignoredFields,
        };
      }

      if (Object.prototype.hasOwnProperty.call(built.updates, "groupId") && built.updates.groupId) {
        const groups = await getGroups();
        if (!groups.some((group) => group.id === built.updates.groupId)) {
          return { success: false, error: "Group not found" };
        }
      }

      await updateBook(bookId, built.updates);
      emitLibraryChanged();
      return {
        success: true,
        bookId,
        title: built.updates.meta?.title ?? book.meta.title,
        changedFields: built.changedFields,
        ignoredFields: built.ignoredFields,
      };
    },
  };
}

/** Manage book groups and move books between groups */
export function createManageBookGroupsTool(): ToolDefinition {
  return {
    name: "manageBookGroups",
    description:
      "Manage library groups: list groups, create a group, rename a group, delete a group, or move one/multiple books into a group. Use this when the user asks AI to organize books into groups or adjust the group list.",
    parameters: {
      reasoning: {
        type: "string",
        description: "Brief explanation of why you are managing groups",
        required: true,
      },
      action: {
        type: "string",
        description: '"list" | "create" | "rename" | "delete" | "moveBooks"',
        required: true,
      },
      groupId: {
        type: "string",
        description:
          "Group ID for rename/delete/moveBooks. Use empty string to move books to uncategorized.",
      },
      name: {
        type: "string",
        description: "Group name for create/rename",
      },
      bookIds: {
        type: "string",
        description: 'JSON array of book IDs to move. Example: ["book-1","book-2"]',
      },
    },
    execute: async (args) => {
      const action = String(args.action || "").trim();

      if (action === "list") {
        const groups = await getGroups();
        const books = await getBooks();
        return {
          success: true,
          groups: groups.map((group) => ({
            id: group.id,
            name: group.name,
            bookCount: books.filter((book) => book.groupId === group.id).length,
          })),
          uncategorizedCount: books.filter((book) => !book.groupId).length,
        };
      }

      if (action === "create") {
        const name = String(args.name || "").trim();
        if (!name) return { success: false, error: "name is required for create" };
        const existing = (await getGroups()).find((group) => group.name === name);
        if (existing)
          return { success: true, action, group: existing, message: "Group already exists" };
        const group = await insertGroup({ name });
        emitLibraryChanged();
        return { success: true, action, group };
      }

      if (action === "rename") {
        const groupId = String(args.groupId || "").trim();
        const name = String(args.name || "").trim();
        if (!groupId || !name)
          return { success: false, error: "groupId and name are required for rename" };
        const group = (await getGroups()).find((item) => item.id === groupId);
        if (!group) return { success: false, error: "Group not found" };
        await updateGroup(groupId, { name });
        emitLibraryChanged();
        return { success: true, action, groupId, name };
      }

      if (action === "delete") {
        const groupId = String(args.groupId || "").trim();
        if (!groupId) return { success: false, error: "groupId is required for delete" };
        const group = (await getGroups()).find((item) => item.id === groupId);
        if (!group) return { success: false, error: "Group not found" };
        await deleteGroup(groupId);
        emitLibraryChanged();
        return { success: true, action, groupId, name: group.name };
      }

      if (action === "moveBooks") {
        const groupId = String(args.groupId || "").trim() || undefined;
        let bookIds: string[];
        try {
          bookIds = parseStringList(args.bookIds) ?? [];
        } catch (error) {
          return { success: false, error: `Invalid bookIds: ${(error as Error).message}` };
        }
        if (bookIds.length === 0)
          return { success: false, error: "bookIds is required for moveBooks" };
        if (groupId && !(await getGroups()).some((group) => group.id === groupId)) {
          return { success: false, error: "Group not found" };
        }

        const results = [];
        for (const bookId of bookIds) {
          const book = await getBook(bookId);
          if (!book) {
            results.push({ bookId, success: false, error: "Book not found" });
            continue;
          }
          await updateBook(bookId, { groupId });
          results.push({ bookId, title: book.meta.title, success: true });
        }
        emitLibraryChanged();
        return {
          success: true,
          action,
          groupId,
          movedCount: results.filter((result) => result.success).length,
          results,
        };
      }

      return { success: false, error: `Unknown action: ${action}` };
    },
  };
}

/** Manage book tags: create, rename, delete, remove from book, set book tags */
export function createManageBookTagsTool(): ToolDefinition {
  return {
    name: "manageBookTags",
    description:
      "Manage book tags: create new tags (without assigning to books), rename a tag across all books, delete one or more tags from all books, remove specific tags from a book, or replace all tags of a book. Use when the user asks to create, modify, rename, or delete tags. For delete action, you can delete multiple tags at once by passing a JSON array.",
    parameters: {
      reasoning: {
        type: "string",
        description: "Brief explanation of why you are calling this tool",
        required: true,
      },
      action: {
        type: "string",
        description: '"create" | "rename" | "delete" | "removeFromBook" | "setBookTags"',
        required: true,
      },
      tag: {
        type: "string",
        description:
          "The tag to rename (for rename action). For delete action, use 'tags' parameter instead to support batch deletion.",
      },
      newTag: {
        type: "string",
        description: "New tag name (for rename action)",
      },
      bookId: {
        type: "string",
        description: "Book ID (for removeFromBook/setBookTags)",
      },
      tags: {
        type: "string",
        description:
          'JSON array of tags. For create action: tags to create. For delete action: tags to delete. For removeFromBook/setBookTags: tags to remove/set. Example: ["科幻","小说"]',
      },
    },
    execute: async (args) => {
      const action = args.action as string;

      if (action === "create") {
        let tagsToCreate: string[] = [];
        if (args.tags) {
          tagsToCreate = JSON.parse(args.tags as string);
        } else if (args.tag) {
          tagsToCreate = [args.tag as string];
        }
        if (tagsToCreate.length === 0) {
          return { success: false, error: "tag or tags is required for create" };
        }
        // Load existing tags
        const existingTags = (await loadFromFS<string[]>("library-tags")) || [];
        const existingSet = new Set(existingTags);
        const newTags: string[] = [];
        for (const tag of tagsToCreate) {
          if (!existingSet.has(tag)) {
            newTags.push(tag);
            existingSet.add(tag);
          }
        }
        if (newTags.length === 0) {
          return {
            success: true,
            action: "create",
            createdTags: [],
            message: "All tags already exist",
          };
        }
        const allTags = [...existingSet].sort();
        debouncedSave("library-tags", allTags);
        emitLibraryChanged();
        return { success: true, action: "create", createdTags: newTags, totalTags: allTags.length };
      }

      if (action === "rename") {
        const oldTag = args.tag as string;
        const newTag = args.newTag as string;
        if (!oldTag || !newTag) {
          return { success: false, error: "Both tag and newTag are required for rename" };
        }
        const books = await getBooks();
        let affectedCount = 0;
        for (const book of books) {
          if (book.tags?.includes(oldTag)) {
            const updated = book.tags.map((t) => (t === oldTag ? newTag : t));
            const deduped = [...new Set(updated)];
            await updateBook(book.id, { tags: deduped });
            affectedCount++;
          }
        }
        emitLibraryChanged();
        return { success: true, action: "rename", oldTag, newTag, affectedBooks: affectedCount };
      }

      if (action === "delete") {
        // Support both single tag (via 'tag' param) and multiple tags (via 'tags' param)
        let tagsToDelete: string[] = [];
        if (args.tags) {
          tagsToDelete = JSON.parse(args.tags as string);
        } else if (args.tag) {
          tagsToDelete = [args.tag as string];
        }
        if (tagsToDelete.length === 0) {
          return { success: false, error: "tag or tags is required for delete" };
        }
        const books = await getBooks();
        let affectedCount = 0;
        for (const book of books) {
          const hasAnyTag = tagsToDelete.some((tag) => book.tags?.includes(tag));
          if (hasAnyTag) {
            const updated = book.tags?.filter((t) => !tagsToDelete.includes(t)) || [];
            await updateBook(book.id, { tags: updated });
            affectedCount++;
          }
        }
        emitLibraryChanged(tagsToDelete);
        return {
          success: true,
          action: "delete",
          deletedTags: tagsToDelete,
          affectedBooks: affectedCount,
        };
      }

      if (action === "removeFromBook") {
        const bookId = args.bookId as string;
        const tagsToRemove: string[] = JSON.parse(args.tags as string);
        if (!bookId || !tagsToRemove) {
          return { success: false, error: "bookId and tags are required for removeFromBook" };
        }
        const book = await getBook(bookId);
        if (!book) {
          return { success: false, error: "Book not found" };
        }
        const updated = book.tags?.filter((t) => !tagsToRemove.includes(t)) || [];
        await updateBook(bookId, { tags: updated });
        emitLibraryChanged();
        return {
          success: true,
          action: "removeFromBook",
          bookId,
          title: book.meta.title,
          removedTags: tagsToRemove,
          remainingTags: updated,
        };
      }

      if (action === "setBookTags") {
        const bookId = args.bookId as string;
        const newTags: string[] = JSON.parse(args.tags as string);
        if (!bookId || !newTags) {
          return { success: false, error: "bookId and tags are required for setBookTags" };
        }
        const book = await getBook(bookId);
        if (!book) {
          return { success: false, error: "Book not found" };
        }
        const deduped = [...new Set(newTags)];
        await updateBook(bookId, { tags: deduped });
        emitLibraryChanged();
        return {
          success: true,
          action: "setBookTags",
          bookId,
          title: book.meta.title,
          tags: deduped,
        };
      }

      return { success: false, error: `Unknown action: ${action}` };
    },
  };
}
