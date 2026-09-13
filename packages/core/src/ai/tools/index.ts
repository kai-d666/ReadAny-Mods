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
 * - Context Tools: getSurroundingContext, getSelection, getRecentHighlights
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
 * Lite-mode default tool whitelist — the 6 always-on tools per the three-mode
 * decision table (docs/三模式-工具与注入总表.md, lite 列 1 必开):
 *  - getSurroundingContext: current page/selection context (millisecond direct read)
 *  - Retrieval family: rag* for vectorized books, fallback* for non-vectorized ones
 *  - resolveChapterReference: "第N章" → internal index (both families)
 * Choice items (getSelection/getRecentHighlights/ragToc/fallbackToc/
 * mindmap) are OFF by default in lite; user toggles arrive in batch 3
 * (see docs/三模式-选项决策.md「选择项机制」).
 */
export const LITE_DEFAULT_TOOLS = [
  "getSurroundingContext",
  // Both retrieval families are allowed: the active one depends on isVectorized —
  // vectorized books get rag* (seconds, CFI-carrying), non-vectorized get fallback*.
  "ragSearch",
  "ragContext",
  "fallbackSearch",
  "fallbackChapterContext",
  "resolveChapterReference",
];

/**
 * Named tools lite mode must never expose, regardless of user config.
 * Only heavyweight analysis tools — the whitelist above (LITE_DEFAULT_TOOLS or
 * user-enabled choice items) controls what stays available.
 */
export const LITE_FORBIDDEN_TOOLS = new Set([
  "summarize",
  "extractEntities",
  "analyzeArguments",
  "findQuotes",
  "compareSections",
  "getSelection",
  "addCitation",
]);

/**
 * Choice items (3 = default off) per mode — mirrors 三模式-工具与注入总表.md.
 * These are the ONLY tools a user can enable via toolPrefs; always-on and
 * forbidden tools never appear in the settings UI list.
 */
export const LITE_CHOICE_TOOLS = [
  "getRecentHighlights",
  "ragToc",
  "fallbackToc",
  "getAnnotations",
  "listBooks",
  "searchAllHighlights",
  "searchAllNotes",
  "getReadingStats",
  "mindmap",
  "getSkills",
  "tagBooks",
  "manageBookTags",
  "updateBookMetadata",
  "manageBookGroups",
  "classifyBooks",
];

export const KNOWLEDGE_CHOICE_TOOLS = [
  "getRecentHighlights",
  "getAnnotations",
  "listBooks",
  "searchAllHighlights",
  "searchAllNotes",
  "getReadingStats",
  "mindmap",
  "getSkills",
];

/** Tools Knowledge-Only must never expose — search/citation/analysis families
 *  and library-write tools (knowledge mode allows basic reads only). */
export const KNOWLEDGE_FORBIDDEN_TOOLS = new Set([
  "ragSearch",
  "ragContext",
  "ragToc",
  "fallbackSearch",
  "fallbackChapterContext",
  "fallbackToc",
  "resolveChapterReference",
  "addCitation",
  "getSelection",
  "getSurroundingContext",
  "summarize",
  "extractEntities",
  "analyzeArguments",
  "findQuotes",
  "compareSections",
  "tagBooks",
  "manageBookTags",
  "updateBookMetadata",
  "manageBookGroups",
  "classifyBooks",
]);

/** Choice-item list for a mode (settings UI source). */
export function getModeChoiceTools(mode: "lite" | "knowledge"): string[] {
  return mode === "lite" ? LITE_CHOICE_TOOLS : KNOWLEDGE_CHOICE_TOOLS;
}

/**
 * Resolve the final tool set for a mode:
 *   lite      = (always-on ∪ userEnabled) − forbidden, ∩ candidates
 *   knowledge = (userEnabled − forbidden) ∩ candidates ∪ skillTools
 * skillToolNames pass through when the user enabled getSkills (K-O may then
 * run skills like standard mode).
 */
export function resolveModeTools(
  mode: "lite" | "knowledge",
  userEnabled: string[],
  candidateNames: string[],
  skillToolNames: string[],
): Set<string> {
  const candidates = new Set(candidateNames);
  const enabled = new Set(userEnabled);
  const result = new Set<string>();

  if (mode === "lite") {
    for (const name of [...LITE_DEFAULT_TOOLS, ...enabled]) {
      if (!LITE_FORBIDDEN_TOOLS.has(name) && candidates.has(name)) result.add(name);
    }
  } else {
    for (const name of enabled) {
      if (!KNOWLEDGE_FORBIDDEN_TOOLS.has(name) && candidates.has(name)) result.add(name);
    }
  }

  // getSkills enabled → skill tools (one per enabled skill) pass through.
  if (enabled.has("getSkills")) {
    for (const name of skillToolNames) {
      if (candidates.has(name)) result.add(name);
    }
  }
  return result;
}

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
