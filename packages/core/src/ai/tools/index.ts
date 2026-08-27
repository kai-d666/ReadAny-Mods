/**
 * AI Tool registration — conditional tool registration based on book state
 * Full implementation with RAG search pipeline integration
 *
 * Tool Categories:
 * - RAG Tools: ragSearch, ragToc, ragContext
 * - Analysis Tools: summarize, extractEntities, analyzeArguments, findQuotes, compareSections
 * - Annotation Tools: getAnnotations, addCitation
 * - Library Tools: listBooks, searchAllHighlights, searchAllNotes, readingStats, classifyBooks,
 *   tagBooks, manageBookTags, updateBookMetadata, manageBookGroups
 * - Skill Tools: getSkills, skillToTool
 * - Mindmap Tools: mindmap
 * - Context Tools: getSurroundingContext, getSelection, getReadingProgress, getRecentHighlights
 */
import type { Skill } from "../../types";
import {
  createAnalyzeArgumentsTool,
  createCompareSectionsTool,
  createExtractEntitiesTool,
  createFindQuotesTool,
  createSummarizeTool,
} from "./analysis-tools";
import { createAddCitationTool, createGetAnnotationsTool } from "./annotation-tools";
import { getContextTools } from "./context-tools";
import {
  createFallbackChapterContextTool,
  createFallbackResolveChapterReferenceTool,
  createFallbackSearchTool,
  createFallbackTocTool,
} from "./fallback-content-tools";
import {
  createClassifyBooksTool,
  createListBooksTool,
  createManageBookGroupsTool,
  createManageBookTagsTool,
  createReadingStatsTool,
  createSearchAllHighlightsTool,
  createSearchAllNotesTool,
  createTagBooksTool,
  createUpdateBookMetadataTool,
} from "./library-tools";
import { createMindmapTool } from "./mindmap-tools";
import {
  createRagContextTool,
  createRagSearchTool,
  createRagTocTool,
  createResolveChapterReferenceTool,
} from "./rag-tools";
import { createGetSkillsTool, skillToTool } from "./skill-tools";
import type { ToolDefinition } from "./tool-types";

// Re-export types and key functions for external consumers
export type { ToolDefinition, ToolParameter } from "./tool-types";
export { getContextTools } from "./context-tools";

/**
 * Lite-mode default tool whitelist — all tools here are "no vectorization
 * required + millisecond direct read / keyword search":
 *  - Context (5): current reading position
 *  - Fallback (4): keyword search for non-vectorized books
 *  - General (1): mindmap
 * RAG/analysis tools are intentionally excluded (heavy, vectorization-dependent).
 */
export const LITE_DEFAULT_TOOLS = [
  "getSurroundingContext",
  "getSelection",
  "getReadingProgress",
  "getRecentHighlights",
  // Both retrieval families are allowed: the active one depends on isVectorized —
  // vectorized books get rag* (seconds, CFI-carrying), non-vectorized get fallback*.
  "ragSearch",
  "ragToc",
  "ragContext",
  "fallbackSearch",
  "fallbackToc",
  "fallbackChapterContext",
  "resolveChapterReference",
  "mindmap",
];

/**
 * Named tools lite mode must never expose, regardless of user config.
 * Only heavyweight analysis tools — basic retrieval stays available:
 * - Vectorized books: ragSearch/ragToc/ragContext (fast, CFI-carrying, seconds)
 * - Non-vectorized books: fallbackSearch/fallbackToc/fallbackChapterContext
 */
export const LITE_FORBIDDEN_TOOLS = new Set([
  "summarize",
  "extractEntities",
  "analyzeArguments",
  "findQuotes",
  "compareSections",
]);

/** Get general (non-book-specific) tools */
function getGeneralTools(): ToolDefinition[] {
  return [
    createListBooksTool(),
    createSearchAllHighlightsTool(),
    createSearchAllNotesTool(),
    createReadingStatsTool(),
    createGetSkillsTool(),
    createMindmapTool(),
    createClassifyBooksTool(),
    createTagBooksTool(),
    createManageBookTagsTool(),
    createUpdateBookMetadataTool(),
    createManageBookGroupsTool(),
  ];
}

/** Get available tools based on current state */
export function getAvailableTools(options: {
  bookId?: string | null;
  bookLanguage?: string;
  isVectorized: boolean;
  enabledSkills: Skill[];
}): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // General tools are always available (no bookId required)
  tools.push(...getGeneralTools());

  if (options.bookId) {
    // Context tools (always available when book is loaded)
    tools.push(...getContextTools(options.bookId));

    // RAG tools (require vectorization)
    if (options.isVectorized) {
      tools.push(
        createResolveChapterReferenceTool(options.bookId, options.bookLanguage),
        createRagSearchTool(options.bookId, options.bookLanguage),
        createRagTocTool(options.bookId, options.bookLanguage),
        createRagContextTool(options.bookId, options.bookLanguage),
      );

      // Content analysis tools (require chunks from vectorization)
      tools.push(
        createSummarizeTool(options.bookId),
        createExtractEntitiesTool(options.bookId),
        createAnalyzeArgumentsTool(options.bookId),
        createFindQuotesTool(options.bookId),
        createCompareSectionsTool(options.bookId),
      );
    } else {
      tools.push(
        createFallbackResolveChapterReferenceTool(options.bookId, options.bookLanguage),
        createFallbackTocTool(options.bookId, options.bookLanguage),
        createFallbackSearchTool(options.bookId, options.bookLanguage),
        createFallbackChapterContextTool(options.bookId, options.bookLanguage),
      );
    }

    // Citations are available for indexed chunks and for fallback sources that
    // can be validated against concrete reader segments.
    tools.push(createGetAnnotationsTool(options.bookId), createAddCitationTool(options.bookId));
  }

  // Add custom skills
  for (const skill of options.enabledSkills) {
    tools.push(skillToTool(skill));
  }

  return tools;
}
