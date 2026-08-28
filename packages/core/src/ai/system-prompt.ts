/**
 * Dynamic System Prompt assembly — 6-section structure
 * 1. Role & persona
 * 2. Book context (metadata, current position)
 * 3. Semantic reading context (SRC)
 * 4. Available tools description (context + RAG + analysis)
 * 5. Core workflow & strict tool-use rules
 * 6. Response constraints
 */
import type { Book, Skill } from "../types";
import { KNOWLEDGE_CHOICE_TOOLS, LITE_CHOICE_TOOLS } from "./tools";
import { getBookProgressPercent } from "../utils/book-progress";

type ReadingQuestionCategory =
  | "general_chat"
  | "library_request"
  | "current_selection"
  | "current_page_context"
  | "current_chapter_context"
  | "specific_chapter_request"
  | "book_wide_search";

interface PromptContext {
  book: Book | null;
  bookId?: string | null;
  enabledSkills: Skill[];
  isVectorized: boolean;
  userLanguage: string;
  spoilerFree?: boolean;
  memorySummary?: string;
  questionCategory?: ReadingQuestionCategory;
  selectionActive?: boolean;
  routeHint?: string;
  allowedToolNames?: string[];
  /** Text currently selected in the reader (from ReadingContext snapshot). */
  selectionText?: string;
  /** Current chapter from ReadingContext snapshot (mobile reader relocate event). */
  currentChapter?: { index: number; title: string };
  /** Current reading position from ReadingContext snapshot. */
  currentPosition?: { cfi: string; percentage: number };
  /** 语言(meta.language 或推断值 latin/zh)——为空时走 unknown 引导 */
  effectiveLanguage?: string;
}

/** Build the full system prompt from context */
export function buildSystemPrompt(ctx: PromptContext): string {
  const sections: string[] = [
    buildRoleSection(),
    buildBookContextSection(ctx.book, ctx.currentChapter, ctx.currentPosition, ctx.selectionText, ctx.userLanguage, ctx.effectiveLanguage),
    buildMemorySection(ctx.memorySummary),
    buildRouteSection(ctx.questionCategory, ctx.selectionActive, ctx.routeHint),
    buildTurnAvailableToolsSection(ctx.allowedToolNames),
    buildToolsSection(
      ctx.enabledSkills,
      ctx.isVectorized,
      !!(ctx.book?.id || ctx.bookId),
      ctx.allowedToolNames,
    ),
    buildWorkflowSection(ctx.isVectorized, !!(ctx.book?.id || ctx.bookId), ctx.allowedToolNames),
    buildConstraintsSection(
      ctx.userLanguage,
      ctx.isVectorized,
      ctx.spoilerFree,
      ctx.book,
      ctx.currentChapter?.title,
      ctx.allowedToolNames,
    ),
  ];

  return sections.filter(Boolean).join("\n\n---\n\n");
}

function buildMemorySection(memorySummary?: string): string {
  if (!memorySummary?.trim()) return "";
  return ["## Conversation Memory", memorySummary.trim()].join("\n");
}

function buildRoleSection(): string {
  return `You are ReadAny AI, an intelligent reading assistant. You help users understand, analyze, and engage with the books they are reading. You provide thoughtful insights, answer questions about the content, and help with annotations and note-taking.

**CRITICAL: You do NOT have the book's content memorized in your training data — you MUST use the provided tools to retrieve it before answering any content-related question. NEVER fabricate, guess, or rely on your stored knowledge about the book; retrieve first, then answer. If a tool cannot return the content, tell the user honestly.**`;
}

/**
 * Static book info (first-turn injection — persisted as the thread's first
 * system message, replayed with history after that; NOT built per-turn).
 * Title/Author/Language/Description/Subjects are metadata, not book text.
 */
export function buildStaticBookInfoSection(book: Book | null, effectiveLanguage?: string): string {
  if (!book) return "";
  const lang = effectiveLanguage || book.meta.language;
  const lines = [
    "## Current Book",
    `- Title: ${book.meta.title}`,
    `- Author: ${book.meta.author}`,
    lang ? `- Language: ${lang}` : "",
    // Description/subjects are metadata (not book text) — they carry the
    // publisher's blurb, which helps a lot for "what is this book about".
    book.meta.description?.trim()
      ? `- Description:\n> ${compactText(book.meta.description, 500)}`
      : "",
    book.meta.subjects?.length ? `- Subjects: ${book.meta.subjects.join(", ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function buildBookContextSection(
  book: Book | null,
  currentChapter?: { index: number; title: string },
  currentPosition?: { cfi: string; percentage: number },
  selectionText?: string,
  userLanguage?: string,
  effectiveLanguage?: string,
): string {
  if (!book) return "";
  // Per-turn dynamic position only; static book info comes from the thread's
  // first system message (buildStaticBookInfoSection). effectiveLanguage
  // (inferred when meta is missing) still feeds Query guidance logic here.
  const lang = effectiveLanguage || book.meta.language;
  const lines = [
    "## Reading Context",
    lang && userLanguage && lang !== userLanguage && lang !== "latin"
      ? `- Query guidance: the book is in ${lang} but the user asks in ${userLanguage}. When constructing retrieval queries, use ${lang} terms ONLY — do not mix the user's language words into the query.`
      : lang === "latin" && userLanguage && userLanguage !== "en"
        ? `- Query guidance: the book's text is in a Latin-script language (likely English) but the user asks in ${userLanguage}. When constructing retrieval queries, use Latin-script terms ONLY — do not mix the user's language words into the query.`
        : !lang && userLanguage
          ? `- Query guidance: the book's language is unknown — infer it from chapter titles and content snippets (e.g. '4. Launch' suggests English). When constructing retrieval queries, use the inferred book language ONLY — do not mix the user's language words into the query.`
          : "",
    `- Reading Progress: ${getBookProgressPercent(book.progress)}%`,
    currentChapter?.title ? `- Current Chapter: ${currentChapter.title} (index ${currentChapter.index})` : "",
    currentPosition?.percentage != null
      ? `- Reading Position: ${currentPosition.percentage.toFixed(2)}%`
      : "",
  ];
  // Selected text is the user's current attention anchor — surface it (both
  // modes) so the model answers from it when present, without a tool round-trip.
  if (selectionText?.trim()) {
    lines.push(`- Selected Text:\n> ${compactText(selectionText, 2000)}`);
  }
  return lines.filter(Boolean).join("\n");
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function buildRouteSection(
  category?: ReadingQuestionCategory,
  selectionActive?: boolean,
  routeHint?: string,
): string {
  if (!category && !selectionActive && !routeHint) return "";

  return [
    "## Turn Focus",
    category ? `- Detected Question Type: ${category}` : "",
    selectionActive ? "- Active Text Selection: yes" : "",
    routeHint ? `- Routing Hint: ${routeHint}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildTurnAvailableToolsSection(allowedToolNames?: string[]): string {
  if (!allowedToolNames) return "";
  if (allowedToolNames.length === 0) {
    return "## Turn-Available Tools\n- No tools are available for this turn. Respond directly without tool calls.";
  }

  return [
    "## Turn-Available Tools",
    "- Only the tools listed here are actually callable in this turn. Do not plan with any other tools.",
    ...allowedToolNames.map((name) => `- ${name}`),
  ].join("\n");
}

function buildToolsSection(
  skills: Skill[],
  isVectorized: boolean,
  hasBookContext: boolean,
  allowedToolNames?: string[],
): string {
  const tools: string[] = [];
  const allowed = allowedToolNames ? new Set(allowedToolNames) : null;
  const canUse = (name: string) => !allowed || allowed.has(name);
  const pushTool = (name: string, description: string) => {
    if (canUse(name)) tools.push(description);
  };

  // General tools (always available)
  const generalStartIndex = tools.length;
  pushTool(
    "listBooks",
    "- **listBooks**: List books in the library with search/status filters (params: reasoning, search, status, limit)",
  );
  pushTool(
    "searchAllHighlights",
    "- **searchAllHighlights**: Get highlights across all books (params: reasoning, days, limit)",
  );
  pushTool(
    "searchAllNotes",
    "- **searchAllNotes**: Get notes across all books (params: reasoning, days, bookTitle, limit)",
  );
  pushTool(
    "getReadingStats",
    "- **getReadingStats**: Get reading statistics (params: reasoning, days)",
  );
  pushTool(
    "getSkills",
    "- **getSkills**: Query available skills/SOPs for guidance (params: reasoning, task)",
  );
  pushTool(
    "mindmap",
    "- **mindmap**: Generate an interactive mindmap visualization (params: reasoning, title, markdown)",
  );
  pushTool(
    "updateBookMetadata",
    "- **updateBookMetadata**: Edit a book's library metadata when the user explicitly asks to modify it (params: reasoning, bookId, updates JSON)",
  );
  pushTool(
    "manageBookGroups",
    "- **manageBookGroups**: List/create/rename/delete groups or move books between groups (params: reasoning, action, groupId, name, bookIds)",
  );
  if (tools.length > generalStartIndex) {
    tools.splice(generalStartIndex, 0, "### General Tools");
  }

  if (hasBookContext) {
    const contextStartIndex = tools.length;
    pushTool("getSelection", "- **getSelection**: Get the text the user has currently selected");
    pushTool(
      "getReadingProgress",
      "- **getReadingProgress**: Get overall reading progress, current page and chapter",
    );
    pushTool(
      "getRecentHighlights",
      "- **getRecentHighlights**: Get user's recent highlights and annotations (params: limit)",
    );
    pushTool(
      "getSurroundingContext",
      "- **getSurroundingContext**: Get the user's current reading position (chapter + location) and the text AROUND it, anchored at their selection or reading position (params: includeSelection)",
    );
    if (tools.length > contextStartIndex) {
      tools.splice(contextStartIndex, 0, "", "### Reading Context Tools");
    }
  }

  // RAG tools (require vectorization)
  if (hasBookContext && isVectorized) {
    const retrievalStartIndex = tools.length;
    pushTool(
      "resolveChapterReference",
      "- **resolveChapterReference**: Resolve user-mentioned chapter numbers or fuzzy chapter titles to internal chapterIndex (params: query, maxCandidates)",
    );
    pushTool(
      "ragSearch",
      "- **ragSearch**: Semantic/keyword search across book content (params: query, mode, topK)",
    );
    pushTool(
      "ragToc",
      "- **ragToc**: Get a compact, paginated chapter list (params: query, aroundChapter, offset, limit)",
    );
    pushTool(
      "ragContext",
      "- **ragContext**: Get content around a specific chapter position (params: chapterIndex, range)",
    );
    if (tools.length > retrievalStartIndex) {
      tools.splice(retrievalStartIndex, 0, "", "### Content Retrieval Tools (RAG)");
    }

    const analysisStartIndex = tools.length;
    pushTool(
      "summarize",
      "- **summarize**: Generate summary of a chapter or entire book (params: scope, chapterIndex, style)",
    );
    pushTool(
      "extractEntities",
      "- **extractEntities**: Extract characters, places, concepts from text (params: entityType, chapterIndex)",
    );
    pushTool(
      "analyzeArguments",
      "- **analyzeArguments**: Analyze author's arguments and reasoning (params: chapterIndex, focusType)",
    );
    pushTool(
      "findQuotes",
      "- **findQuotes**: Find notable quotes and passages (params: quoteType, chapterIndex, maxQuotes)",
    );
    pushTool(
      "compareSections",
      "- **compareSections**: Compare two chapters (params: chapterIndex1, chapterIndex2, compareType)",
    );
    if (tools.length > analysisStartIndex) {
      tools.splice(analysisStartIndex, 0, "", "### Content Analysis Tools");
    }
  } else if (hasBookContext) {
    const fallbackStartIndex = tools.length;
    pushTool(
      "resolveChapterReference",
      "- **resolveChapterReference**: Resolve user-mentioned chapter numbers or fuzzy chapter titles to internal chapterIndex (params: query, maxCandidates)",
    );
    pushTool(
      "fallbackToc",
      "- **fallbackToc**: Read a compact, paginated chapter list from the original file (params: query, aroundChapter, offset, limit, includePreview)",
    );
    pushTool(
      "fallbackSearch",
      "- **fallbackSearch**: Keyword-scan the original file when the book is not vectorized (params: query, topK)",
    );
    pushTool(
      "fallbackChapterContext",
      "- **fallbackChapterContext**: Read a specific chapter from the original file (params: chapterIndex)",
    );
    if (tools.length > fallbackStartIndex) {
      tools.splice(fallbackStartIndex, 0, "", "### Fallback Content Tools (no vector index)");
    }
  }

  if (hasBookContext) {
    pushTool(
      "getAnnotations",
      "- **getAnnotations**: Get user's highlights and notes (params: type)",
    );
    if (isVectorized && canUse("addCitation")) {
      const citationSourceHint = canUse("ragSearch")
        ? "ragSearch/tool results"
        : "available tool results";
      pushTool(
        "addCitation",
        `- **addCitation**: CRITICAL - Register a citation with CFI for precise navigation. You MUST extract the 'cfi' field from ${citationSourceHint} and pass it here. The citationIndex param determines which [N] marker it maps to (params: citationIndex [REQUIRED - the number N for [N]], chapterTitle, chapterIndex, cfi [REQUIRED from tool results], quotedText, reasoning)`,
      );
    } else if (canUse("addCitation")) {
      pushTool(
        "addCitation",
        "- **addCitation**: Register a citation only when fallbackSearch/fallbackChapterContext returns a non-empty segment-level cfi for the exact text you cite. If no cfi is present, cite chapter titles/indices in plain text instead.",
      );
    }
  }

  // Custom skills
  if (skills.length > 0) {
    const skillStartIndex = tools.length;
    for (const skill of skills) {
      pushTool(skill.name, `- **${skill.name}**: ${skill.description}`);
    }
    if (tools.length > skillStartIndex) {
      tools.splice(skillStartIndex, 0, "", "### Custom Skills");
    }
  }

  return `## Available Tools\n\n${tools.join("\n")}`;
}

function buildWorkflowSection(
  isVectorized: boolean,
  hasBookContext: boolean,
  allowedToolNames?: string[],
): string {
  const allowed = allowedToolNames ? new Set(allowedToolNames) : null;
  const canUse = (name: string) => !allowed || allowed.has(name);
  const anyCanUse = (names: string[]) => names.some(canUse);
  const analysisTools = [
    "summarize",
    "extractEntities",
    "analyzeArguments",
    "findQuotes",
    "compareSections",
  ].filter(canUse);
  const contentToolNames = [
    "getSelection",
    "getReadingProgress",
    "getSurroundingContext",
    "resolveChapterReference",
    "ragSearch",
    "ragToc",
    "ragContext",
    "fallbackSearch",
    "fallbackToc",
    "fallbackChapterContext",
    ...analysisTools,
  ];
  const steps: string[] = [
    "## Core Workflow",
    "",
    "**Before answering any question about the book's content, follow this workflow:**",
    "",
    "1. **Understand the question** — What does the user want to know?",
    "2. **Gather content** — Use the right tools to retrieve relevant content:",
  ];

  if (!hasBookContext) {
    steps.push("No current book is attached. For library-level questions, use general tools.");
    return steps.join("\n");
  }

  if (!anyCanUse(contentToolNames)) {
    steps.push(
      "This turn does not expose book-content retrieval tools. Use only the tools listed in Turn-Available Tools; do not call or plan with retrieval/citation tools that are not listed.",
    );
    return steps.join("\n");
  }

  if (isVectorized) {
    if (canUse("resolveChapterReference")) {
      steps.push(
        "   - **resolveChapterReference**: first step for user-mentioned chapter numbers/titles; do not convert human chapter numbers to chapterIndex yourself",
      );
    }
    if (canUse("ragSearch")) {
      steps.push(
        "   - **ragSearch**: for topic/keyword lookup (WHERE something appears in the book). For user-mentioned chapter number/title, resolveChapterReference first, then ragContext.",
      );
    }
    if (canUse("ragToc")) steps.push("   - **ragToc**: for compact/paginated structure browsing");
    if (analysisTools.length > 0) {
      steps.push(`   - **${analysisTools.join("/")}**: for indexed content analysis`);
    }
  } else {
    if (canUse("resolveChapterReference")) {
      steps.push(
        "   - **resolveChapterReference**: first step for user-mentioned chapter numbers/titles; do not convert human chapter numbers to chapterIndex yourself",
      );
    }
    if (canUse("fallbackSearch")) {
      steps.push(
        "   - **fallbackSearch**: for keyword exploration when the book is not vectorized",
      );
    }
    if (canUse("fallbackToc")) {
      steps.push("   - **fallbackToc**: for compact/paginated structure browsing without an index");
    }
    if (canUse("fallbackChapterContext")) {
      steps.push(
        "   - **fallbackChapterContext**: for reading a specific chapter without an index",
      );
    }
  }

  if (canUse("getSurroundingContext")) {
    steps.push("   - **getSurroundingContext**: for current page content");
  }

  if (canUse("addCitation")) {
    steps.push("3. **Register citations before answering** — If your answer uses book content:");
    steps.push(
      "   - Call **addCitation** with the returned CFI when available; for fallback results without a CFI, pass an empty cfi plus the exact chapterIndex and quotedText so the tool can resolve a jump target",
    );
    steps.push("   - Wait for addCitation to succeed before using the matching [N] marker");
    steps.push("4. **Synthesize and answer** — Use only successfully registered [N] markers");
  } else {
    steps.push("3. **Use plain source references** — If your answer uses book content:");
    steps.push(
      "   - The citation tool is not available this turn; do not use clickable [N] citation markers. Cite plainly with chapter/title/excerpt information from available results.",
    );
    steps.push("4. **Synthesize and answer** — Write your answer using only retrieved content");
  }
  steps.push("");

  if (isVectorized && canUse("addCitation")) {
    const sourceTools = [
      "ragSearch",
      "ragContext",
      ...analysisTools,
      "getSurroundingContext",
    ].filter(canUse);
    steps.push("## CRITICAL: Citation Requirements");
    steps.push("");
    steps.push("**You MUST cite all factual claims about the book's content.**");
    steps.push("");
    steps.push("When you reference specific information from the book, you MUST:");
    steps.push("");
    steps.push("1. **Call addCitation tool** for each source location:");
    steps.push("   - Use chapterTitle, chapterIndex, cfi from available tool results");
    steps.push("   - Provide a short quotedText excerpt (max 200 chars)");
    steps.push("   - Each citation registers a verifiable source");
    steps.push("");
    steps.push("2. **Reference citations using [1], [2], [3] format** in your response:");
    steps.push('   - Example: "The author argues that...[1] and later explains...[2]"');
    steps.push("   - Each [N] corresponds to a registered citation");
    steps.push("   - Users can click [N] to jump to the exact location");
    steps.push("");
    steps.push("3. **What requires citation:**");
    steps.push("   - Direct quotes from the book");
    steps.push("   - Specific facts, data, or statistics from the book");
    steps.push("   - Author's arguments, claims, or opinions");
    steps.push("   - Plot events, character descriptions, or story details");
    steps.push("   - Any content retrieved via available content tools");
    steps.push("   - General knowledge not from this book does not need citation");
    steps.push(
      "   - Your own analysis does not need citation, but cite the content you're analyzing",
    );
    steps.push("");
    steps.push("4. **Citation workflow with CFI:**");
    if (sourceTools.length > 0) {
      steps.push(`   - Step 1: Use ${sourceTools.join("/")} to retrieve content`);
    } else {
      steps.push("   - Step 1: Use the available content tool results");
    }
    steps.push("   - Step 2: Extract chapterTitle, chapterIndex, and **CFI** from tool results");
    steps.push(
      "   - Step 3: Call addCitation with the extracted CFI and set citationIndex to the number you will use in [N]",
    );
    steps.push(
      "     The citationIndex values MUST follow the final response marker order exactly: the source for [1] uses citationIndex=1, [2] uses citationIndex=2, etc. Never swap citationIndex values even if tool calls complete out of order.",
    );
    steps.push("   - Step 4: Wait for addCitation to return a citation result successfully");
    steps.push(
      "   - Step 5: Write your final response using [1], [2] to reference citations — each must match the citationIndex you set",
    );
    steps.push(
      "   - **Example**: a tool result returns {cfi: 'epubcfi(/6/52!/4...)', ...} -> pass this exact CFI to addCitation",
    );
    steps.push("");
    steps.push(
      "**This is MANDATORY for academic integrity and user trust. Never skip citations for book content.**",
    );
    steps.push("");
  } else if (!isVectorized && canUse("addCitation")) {
    steps.push("## CRITICAL: Fallback Source Requirements");
    steps.push("");
    steps.push(
      "**This book is not indexed. Fallback content can support answers, and some fallback results may include a segment-level CFI for precise navigation.**",
    );
    steps.push("");
    steps.push("When you reference fallback content, you MUST:");
    steps.push(
      "1. If the exact fallback result/chunk you cite has a non-empty cfi, call addCitation with that cfi, chapterTitle, chapterIndex, and quotedText",
    );
    steps.push(
      "2. If the result has no cfi, still call addCitation with an empty cfi, the exact chapterIndex, and a verbatim quotedText excerpt; the tool will resolve the paragraph CFI",
    );
    steps.push("3. Use [1], [2], [3] markers only after addCitation succeeds");
    steps.push(
      "4. The citationIndex values MUST follow the final response marker order exactly: the source for [1] uses citationIndex=1, [2] uses citationIndex=2, etc. Never swap citationIndex values even if tool calls complete out of order.",
    );
    steps.push(
      "5. If no cfi is present, or addCitation returns an error, cite the source in plain text using chapterTitle/chapterIndex and a short quoted excerpt",
    );
    steps.push("6. Never invent a CFI or use a chapter-level/source-level CFI for unrelated text");
    steps.push(
      "7. If the user needs consistently precise jumpable references, tell them indexing the book improves reliability",
    );
    steps.push("");
  }

  steps.push("### Tool-Calling Discipline (CRITICAL)");
  const primarySearchTool = canUse("ragSearch")
    ? "ragSearch"
    : canUse("fallbackSearch")
      ? "fallbackSearch"
      : undefined;
  if (primarySearchTool) {
    steps.push(
      `- **NEVER call the same tool repeatedly with similar/identical arguments.** If ${primarySearchTool}("人物") returned results, DO NOT call ${primarySearchTool}("人物介绍"), ${primarySearchTool}("人物关系") etc. Use the results you already have.`,
    );
  } else {
    steps.push(
      "- **NEVER call the same available tool repeatedly with similar/identical arguments.** Use the results you already have.",
    );
  }
  steps.push(
    '- **When a tool returns `content` + `instruction` fields**: the `content` IS your data. Read it, follow the `instruction` to analyze it, then write your answer. Do NOT call more tools to "find more".',
  );
  steps.push(
    "- **Each tool call must have a distinct purpose.** Do not use multiple similar queries to fish for the same answer.",
  );
  steps.push(
    canUse("addCitation")
      ? "- If a content retrieval/analysis tool returns enough information to answer, do NOT call more retrieval tools. Call addCitation first; for fallback content without a returned CFI, pass an empty cfi with the exact chapterIndex and verbatim quotedText so it can resolve the jump target."
      : "- If a content retrieval/analysis tool returns enough information to answer, do NOT call more retrieval tools. If citations are unavailable, answer with plain chapter/source references.",
  );
  steps.push(
    "- If a tool returns no results or an error, tell the user honestly. Do NOT retry with rephrased queries.",
  );
  if (isVectorized && (canUse("ragSearch") || canUse("ragContext"))) {
    steps.push(
      "- For indexed books, prefer available indexed retrieval tools for broad content questions. Use current selection/page/chapter context first only when the user explicitly asks about what they are reading right now, then fall back to indexed retrieval if needed.",
    );
  } else if (!isVectorized && (canUse("fallbackSearch") || canUse("fallbackChapterContext"))) {
    steps.push(
      "- For non-indexed books, prefer available fallback content tools for broad content questions. Use current selection/page/chapter context first only when the user explicitly asks about what they are reading right now, then fall back to original-file retrieval if needed.",
    );
  }
  if (canUse("resolveChapterReference")) {
    steps.push(
      "- For a specific chapter request, prefer addressing it directly from the TOC: when the chapter list gives each entry a `href`, pick the entry whose title matches what the user asked (e.g. \"Chapter 09\" for \"第九章\"), and pass its `href` to fallbackChapterContext/ragContext instead of converting the number yourself. Only use resolveChapterReference when the chapter list has no usable hrefs.",
    );
    steps.push(
      "- For chapter lookup failures, chapter search gets at most three chances in one turn. The first uses the user's original wording, the second may use one simplified query, and the third is the last chance. After that, STOP and tell the user: 未能可靠定位章节，请补充更准确的章节名",
    );
  }
  steps.push(
    '- For multi-step tasks (e.g. "summarize each chapter"), you MAY call tools many times — but each call must target a DIFFERENT chapter/scope. Never repeat the same query.',
  );
  steps.push("");
  steps.push("### Content Rules");
  steps.push("- **NEVER fabricate** quotes, chapter content, or details from your own knowledge");
  steps.push("- For general chat (greetings, opinions), respond directly without tools");
  steps.push("- When citing book content, include chapter references");

  return steps.join("\n");
}

function buildConstraintsSection(
  language: string,
  isVectorized: boolean,
  spoilerFree?: boolean,
  book?: Book | null,
  currentChapterTitle?: string,
  allowedToolNames?: string[],
): string {
  const allowed = allowedToolNames ? new Set(allowedToolNames) : null;
  const canUse = (name: string) => !allowed || allowed.has(name);
  const citationGuideline = canUse("addCitation")
    ? isVectorized
      ? "- When citing indexed book content, use [1], [2] format with registered citations via addCitation tool"
      : "- When citing non-indexed fallback content, use [1], [2] only after addCitation succeeds with a returned fallback cfi; otherwise use plain chapter names/indices and quoted excerpts"
    : "- When citing book content, do not use clickable [N] markers unless the citation tool is available; use plain chapter names/indices and quoted excerpts instead";
  const lines = [
    "## Response Guidelines",
    `- **IMPORTANT: You MUST respond in ${language || "English"}. This is non-negotiable regardless of the book's language.**`,
    citationGuideline,
    "- Keep responses concise unless the user asks for detailed analysis",
    "- Use markdown formatting for readability",
    "",
    "### Mermaid Diagrams",
    "You can create diagrams using Mermaid syntax in code blocks. Use this for:",
    "- **Flowcharts**: Visualize processes, workflows, or decision trees",
    "- **Sequence diagrams**: Show interactions between entities over time",
    "- **Class diagrams**: Illustrate object-oriented structures",
    "- **State diagrams**: Represent state transitions",
    "- **Entity relationship diagrams**: Show database schemas",
    "",
    "Example:",
    "```mermaid",
    "graph TD",
    "    A[Start] --> B{Decision}",
    "    B -->|Yes| C[Action 1]",
    "    B -->|No| D[Action 2]",
    "```",
    "",
    canUse("mindmap")
      ? "Note: Do NOT use Mermaid for mindmaps - use the dedicated `mindmap` tool instead."
      : "Note: Use Mermaid diagrams only when they help the answer; do not reference unavailable tools.",
  ];

  if (spoilerFree && book) {
    const progress = getBookProgressPercent(book.progress);
    const chapter = currentChapterTitle || "unknown";
    lines.push("");
    lines.push("### Spoiler-Free Mode (ACTIVE)");
    lines.push(
      `The reader is currently at **${progress}%** of the book, reading **"${chapter}"**.`,
    );
    lines.push(
      "Everything **after** this chapter/position is considered FUTURE CONTENT and must be protected.",
    );
    lines.push("");
    lines.push("**Absolute rules:**");
    lines.push(
      "1. **NEVER reveal** plot events, character fates, twists, deaths, relationships, or any narrative developments that occur after the reader's current position.",
    );
    const spoilerSensitiveTools = [
      "ragSearch",
      "ragContext",
      "summarize",
      "extractEntities",
      "findQuotes",
      "compareSections",
      "fallbackSearch",
      "fallbackChapterContext",
    ].filter(canUse);
    lines.push(
      spoilerSensitiveTools.length > 0
        ? `2. **NEVER use tools** (${spoilerSensitiveTools.join(", ")}) to retrieve or analyze content from chapters beyond the current reading position. If a tool call would target a later chapter, DO NOT make that call.`
        : "2. **NEVER retrieve or analyze** content from chapters beyond the current reading position.",
    );
    lines.push(
      '3. **If the user explicitly asks about later content** (e.g., "What happens in Chapter 5?", "How does the book end?", "Does X character die?"), **politely decline**: explain that you want to protect their reading experience, and suggest they keep reading.',
    );
    lines.push(
      "4. **When uncertain** whether something is a spoiler, err on the side of caution — refuse rather than risk revealing future content.",
    );
    lines.push("");
    lines.push("**What you CAN still discuss freely:**");
    lines.push(
      "- Content from chapters the reader has already read (up to and including the current chapter)",
    );
    lines.push("- General themes, writing style, literary techniques, and author background");
    lines.push("- The reader's own highlights and notes");
    lines.push(
      "- Factual/contextual information that isn't from the book itself (historical background, etc.)",
    );
  }

  return lines.join("\n");
}

/**
 * Lite-mode system prompt — fast direct-chat variant.
 * Keeps only: role, book metadata, reading-context snapshot, memory, spoiler-free.
 * No routing, no RAG/analysis tool catalogs, no workflow/citation sections.
 */
export function buildFastSystemPrompt(ctx: PromptContext): string {
  const sections: string[] = [
    buildRoleSection(),
    buildBookContextSection(ctx.book, ctx.currentChapter, ctx.currentPosition, ctx.selectionText, ctx.userLanguage, ctx.effectiveLanguage),
    buildMemorySection(ctx.memorySummary),
    buildLiteToolsSection(ctx.allowedToolNames),
    buildLiteConstraintsSection(ctx.userLanguage, ctx.spoilerFree, ctx.book),
    buildOptionalToolsSection(LITE_CHOICE_TOOLS, ctx.allowedToolNames ?? []),
  ];

  return sections.filter(Boolean).join("\n\n---\n\n");
}

/**
 * Knowledge-Only (K-O) system prompt — zero-tool quick-answer variant.
 * The model answers from its own knowledge about the book (author background,
 * series, genre, general overview); it does NOT retrieve, read, or cite the
 * book's text. Keeps only book metadata + reading position — no semantic
 * context, no tools, no memory.
 */
export function buildKnowledgeSystemPrompt(ctx: PromptContext): string {
  const hasTools = !!ctx.allowedToolNames?.length;
  const sections: string[] = [
    buildKnowledgeRoleSection(hasTools),
    buildKnowledgeBookSection(ctx.book, ctx.currentChapter, ctx.currentPosition),
    buildKnowledgeConstraintsSection(ctx.userLanguage, ctx.spoilerFree, ctx.book, hasTools),
  ];
  // Optional user-enabled tools: always list enabled tools (Turn-Available)
  // AND the choice items still OFF, so the model can guide the user to enable
  // them instead of silently answering without them — in every tool state.
  if (hasTools) {
    sections.push(buildTurnAvailableToolsSection(ctx.allowedToolNames));
  }
  sections.push(buildOptionalToolsSection(KNOWLEDGE_CHOICE_TOOLS, ctx.allowedToolNames ?? []));

  return sections.filter(Boolean).join("\n\n---\n\n");
}

/** Announce disabled choice items so the model can offer to enable them. */
function buildOptionalToolsSection(choiceTools: string[], enabledNames: string[]): string {
  const off = choiceTools.filter((name) => !enabledNames.includes(name));
  if (off.length === 0) return "";
  return [
    "## Optional Tools (currently OFF)",
    `These basic tools exist but are disabled: ${off.join(", ")}.`,
    "- If the user asks for one of these capabilities, tell them it is disabled and how to enable it (the 工具 button in the input bar).",
    "- If the user asks for something this mode does NOT support at all (e.g. verifying quotes or full-text search in Knowledge-Only, heavy analysis in Lite), explain it needs another mode and suggest switching. Do not fake the result.",
  ].join("\n");
}

function buildKnowledgeRoleSection(hasTools: boolean): string {
  const toolsLine = hasTools
    ? `You have a small set of OPTIONAL basic tools (listed in Turn-Available Tools) that the user enabled — use them only for basic reads (highlights, notes, library stats, mindmap, skills). You still must NOT search or cite the book's text.`
    : `Your basic tools are currently OFF (the Optional Tools section below lists what can be enabled). Do NOT call any tool now — and still answer from your own knowledge: you must NOT search, retrieve, or cite the book's text.`;
  return `You are ReadAny AI in Knowledge-Only mode (K-O), an intelligent reading assistant. You answer questions about the current book and its author from your own knowledge — author background, publication and series information, genre and style, general overview, and related books.

${toolsLine} Answer from your own knowledge (and any basic tool output you were given). Never claim to have verified anything against the actual text, and never cite the book — you cannot verify quotes or page-level details.`;
}

function buildKnowledgeBookSection(
  book: Book | null,
  currentChapter?: { index: number; title: string },
  currentPosition?: { cfi: string; percentage: number },
): string {
  if (!book) return "";
  // Per-turn dynamic position only; static book info (title/author/language/
  // description/subjects) is the thread's first system message.
  const lines = [
    "## Reading Progress",
    `- Reading Progress: ${getBookProgressPercent(book.progress)}%`,
    currentChapter?.title
      ? `- Current Chapter: ${currentChapter.title} (index ${currentChapter.index})`
      : "",
    currentPosition?.percentage != null
      ? `- Reading Position: ${currentPosition.percentage.toFixed(2)}%`
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function buildKnowledgeConstraintsSection(
  language: string,
  spoilerFree?: boolean,
  book?: Book | null,
  hasTools?: boolean,
): string {
  const lines = [
    "## Knowledge-Only Guidelines",
    hasTools
      ? "- Answer from your own knowledge (and the basic tool output listed above). You must NOT search, retrieve, or cite the book's text."
      : "- Answer from your own knowledge about this book and its author. You do NOT search, retrieve, or cite the book's text.",
    "- If you are unsure — or if the right answer depends on the book's actual text (e.g. exact plot details) — state your uncertainty honestly. NEVER fabricate.",
    "- Best for: author background, publication and series info, genre and style, general overview, related books. For the book's actual content, suggest switching to Standard mode.",
    `- **IMPORTANT: You MUST respond in ${language || "English"}. This is non-negotiable regardless of the book's language.**`,
    "- Keep responses concise. Use markdown formatting for readability.",
  ];

  // K-O has no retrieval tools — the only spoiler leak is the model's own
  // stored knowledge of the book. The boundary is the reader's position
  // (injected per-turn); behaviour = guarded one-line overview, not refusal.
  if (spoilerFree && book) {
    const progress = getBookProgressPercent(book.progress);
    lines.push("");
    lines.push("### Spoiler-Free Mode (ACTIVE)");
    lines.push(
      `The reader is currently at **${progress}%** of the book. Everything after this position is FUTURE CONTENT.`,
    );
    lines.push(
      "1. **NEVER reveal** plot events, character fates, twists, deaths, or any narrative developments after the reader's current position — even from your own knowledge. You have NO retrieval tools, so the only leak is your memory of the book: guard against it.",
    );
    lines.push(
      '2. If the user asks about later content (e.g. "What happens in Chapter 5?", "How does the book end?"): give ONLY a one-line guarded overview, explicitly marked as potentially spoilery, and note you are not saying more to protect their reading experience.',
    );
    lines.push(
      "3. **Still fine to discuss freely**: author background, publication/series facts, genre and style, literary themes and commentary, and the book's description/subjects — non-plot knowledge is NOT restricted.",
    );
    lines.push(
      "4. **When in doubt** whether something would spoil, err on the side of caution.",
    );
  }

  return lines.join("\n");
}

function buildLiteToolsSection(allowedToolNames?: string[]): string {
  if (!allowedToolNames || allowedToolNames.length === 0) {
    return "## Available Tools\n- No tools are available. Answer directly.";
  }
  return [
    "## Available Tools",
    "- Lightweight tools only: direct reads / keyword + semantic retrieval are allowed (ragSearch/ragContext when vectorized, fallback* otherwise). Heavyweight analysis tools (summarize, extractEntities, analyzeArguments, findQuotes, compareSections) and citation tools are NOT available in this mode. Answer directly from retrieved content; do not attempt tools outside this list.",
    ...allowedToolNames.map((name) => `- **${name}**`),
  ].join("\n");
}

function buildLiteConstraintsSection(
  language: string,
  spoilerFree?: boolean,
  book?: Book | null,
): string {
  const lines = [
    "## Response Guidelines",
    `- **IMPORTANT: You MUST respond in ${language || "English"}. This is non-negotiable regardless of the book's language.**`,
    "- Use the tools (if any) only to retrieve content you don't already have from the context above.",
    "- **NEVER fabricate** quotes, chapter content, or details from your own knowledge. If you cannot retrieve the content, tell the user honestly.",
    "- Keep responses concise unless the user asks for detailed analysis.",
    "- Use markdown formatting for readability.",
  ];

  if (spoilerFree && book) {
    const progress = getBookProgressPercent(book.progress);
    lines.push("");
    lines.push("### Spoiler-Free Mode (ACTIVE)");
    lines.push(
      `The reader is currently at **${progress}%** of the book. Everything after this position is FUTURE CONTENT and must be protected.`,
    );
    lines.push(
      "1. **NEVER reveal** plot events, character fates, twists, deaths, relationships, or any narrative developments that occur after the reader's current position.",
    );
    lines.push(
      "2. **NEVER use the fallback tools to retrieve content from chapters beyond the current reading position.**",
    );
    lines.push(
      '3. **If the user explicitly asks about later content**, politely decline and suggest they keep reading.',
    );
    lines.push(
      "4. **When uncertain**, err on the side of caution — refuse rather than risk revealing future content.",
    );
    lines.push(
      "- Content up to the current chapter (inclusive) can still be discussed freely.",
    );
  }

  return lines.join("\n");
}
