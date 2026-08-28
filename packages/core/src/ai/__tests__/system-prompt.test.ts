import { describe, expect, it } from "vitest";
import type { Book } from "../../types";
import {
  buildFastSystemPrompt,
  buildKnowledgeSystemPrompt,
  buildStaticBookInfoSection,
  buildSystemPrompt,
} from "../system-prompt";

function makeBook(metaOverride?: Partial<Book["meta"]>): Book {
  return {
    id: "book-1",
    filePath: "book.epub",
    format: "epub",
    meta: {
      title: "Test Book",
      author: "Test Author",
      description: "",
      subjects: [],
      language: "en",
      ...metaOverride,
    },
    progress: 0,
    isVectorized: false,
    vectorizeProgress: 0,
    tags: [],
    addedAt: 1,
    lastOpenedAt: 1,
    updatedAt: 1,
    syncStatus: "local",
  };
}

describe("buildSystemPrompt citations", () => {
  it("allows fallback citations only when a returned CFI can be validated", () => {
    const prompt = buildSystemPrompt({
      book: makeBook(),
      enabledSkills: [],
      isVectorized: false,
      userLanguage: "en",
    });

    expect(prompt).toContain("Fallback Source Requirements");
    expect(prompt).toContain("If the exact fallback result/chunk you cite has a non-empty cfi");
    expect(prompt).toContain("If the result has no cfi, still call addCitation with an empty cfi");
    expect(prompt).toContain("resolve the paragraph CFI");
    expect(prompt).toContain("Use [1], [2], [3] markers only after addCitation succeeds");
    expect(prompt).toContain("Never invent a CFI");
    expect(prompt).toContain("addCitation");
  });

  it("keeps clickable citation instructions for indexed content", () => {
    const prompt = buildSystemPrompt({
      book: makeBook(),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
    });

    expect(prompt).toContain("Citation Requirements");
    expect(prompt).toContain("addCitation");
    expect(prompt).toContain("Wait for addCitation to return a citation result successfully");
    expect(prompt).toContain("Users can click [N]");
  });

  it("includes turn-focus routing hints when provided", () => {
    const prompt = buildSystemPrompt({
      book: makeBook(),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
      questionCategory: "current_selection",
      selectionActive: true,
      routeHint:
        "The user already has an active selection. Prefer the selected text and surrounding context before any chapter-wide or book-wide retrieval.",
    });

    expect(prompt).toContain("## Turn Focus");
    expect(prompt).toContain("Detected Question Type: current_selection");
    expect(prompt).toContain("Active Text Selection: yes");
    expect(prompt).toContain("Prefer the selected text and surrounding context");
  });

  it("lists the actually allowed tools for the current turn when provided", () => {
    const prompt = buildSystemPrompt({
      book: makeBook(),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
      allowedToolNames: ["getSurroundingContext", "getReadingProgress", "addCitation"],
    });

    expect(prompt).toContain("## Turn-Available Tools");
    expect(prompt).toContain("- getSurroundingContext");
    expect(prompt).toContain("- getReadingProgress");
    expect(prompt).toContain("- addCitation");
  });

  it("does not describe tools that are unavailable in the current turn", () => {
    const prompt = buildSystemPrompt({
      book: makeBook(),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
      allowedToolNames: ["getSurroundingContext", "addCitation"],
    });

    expect(prompt).toContain("- getSurroundingContext");
    expect(prompt).toContain("- addCitation");
    expect(prompt).not.toContain("- getReadingProgress");
    expect(prompt).not.toContain("Get overall reading progress");
    expect(prompt).not.toContain("ragSearch");
    expect(prompt).not.toContain("ragContext");
    expect(prompt).not.toContain("fallbackSearch");
    expect(prompt).not.toContain("Semantic/keyword search across book content");
  });

  it("keeps workflow instructions aligned with library-only tools", () => {
    const prompt = buildSystemPrompt({
      book: makeBook(),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
      questionCategory: "library_request",
      allowedToolNames: ["listBooks", "getReadingStats"],
    });

    expect(prompt).toContain("- listBooks");
    expect(prompt).toContain("- getReadingStats");
    expect(prompt).toContain("This turn does not expose book-content retrieval tools");
    expect(prompt).not.toContain("ragSearch");
    expect(prompt).not.toContain("fallbackSearch");
    expect(prompt).not.toContain("addCitation");
    expect(prompt).not.toContain("mindmap");
  });

  it("injects current chapter and reading position into the standard prompt", () => {
    const prompt = buildSystemPrompt({
      book: makeBook(),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
      currentChapter: { index: 9, title: "4. Launch" },
      currentPosition: { cfi: "epubcfi(/6/20!/4/26)", percentage: 12.12 },
    });

    expect(prompt).toContain("Current Chapter: 4. Launch (index 9)");
    expect(prompt).toContain("Reading Position: 12.12%");
  });

  it("injects current chapter and reading position into the lite prompt", () => {
    const prompt = buildFastSystemPrompt({
      book: makeBook(),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
      currentChapter: { index: 9, title: "4. Launch" },
      currentPosition: { cfi: "epubcfi(/6/20!/4/26)", percentage: 12.12 },
    });

    expect(prompt).toContain("Current Chapter: 4. Launch (index 9)");
    expect(prompt).toContain("Reading Position: 12.12%");
  });

  it("omits position lines when no reading snapshot is available", () => {
    const prompt = buildSystemPrompt({
      book: makeBook(),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
    });

    expect(prompt).not.toContain("Current Chapter:");
    expect(prompt).not.toContain("Reading Position:");
  });

  it("injects query guidance when book language differs from user language", () => {
    const prompt = buildSystemPrompt({
      book: makeBook({ language: "en" }),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "zh",
    });

    expect(prompt).toContain("Query guidance: the book is in en but the user asks in zh");
  });

  it("omits query guidance when book and user languages match", () => {
    const prompt = buildSystemPrompt({
      book: makeBook({ language: "en" }),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
    });

    // Static book info (title/language) moved out of the per-turn prompt —
    // only query guidance (language pairing) remains, and only when languages differ.
    expect(prompt).not.toContain("- Language:");
    expect(prompt).not.toContain("Query guidance:");
  });

  it("injects unknown-language guidance when book language is missing", () => {
    const prompt = buildSystemPrompt({
      book: makeBook({ language: undefined }),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "zh",
    });

    expect(prompt).not.toContain("- Language:");
    expect(prompt).toContain("Query guidance");
    expect(prompt).toContain("language is unknown");
  });
});

describe("buildKnowledgeSystemPrompt", () => {
  it("injects book metadata, description, subjects and reading position", () => {
    const prompt = buildKnowledgeSystemPrompt({
      book: makeBook({
        description: "A sci-fi classic about a boy trained for war.",
        subjects: ["Science Fiction", "War"],
      }),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "zh",
      currentChapter: { index: 9, title: "4. Launch" },
      currentPosition: { cfi: "epubcfi(/6/20!/4/26)", percentage: 12.12 },
    });

    expect(prompt).toContain("Knowledge-Only");
    // Static book info (title/author/language/description/subjects) moved to
    // the first-turn system message (buildStaticBookInfoSection) — the per-turn
    // prompt keeps only dynamic reading position.
    expect(prompt).not.toContain("- Title: Test Book");
    expect(prompt).not.toContain("- Author: Test Author");
    expect(prompt).not.toContain("- Description:");
    expect(prompt).toContain("## Reading Progress");
    expect(prompt).toContain("- Reading Progress:");
    expect(prompt).toContain("- Current Chapter: 4. Launch (index 9)");
    expect(prompt).toContain("- Reading Position: 12.12%");
  });

  it("never mentions retrieval tools or semantic reading content", () => {
    const prompt = buildKnowledgeSystemPrompt({
      book: makeBook({ description: "desc" }),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
    });

    expect(prompt).not.toContain("ragSearch");
    expect(prompt).not.toContain("fallbackSearch");
    expect(prompt).not.toContain("getSurroundingContext");
    expect(prompt).not.toContain("## Reading Context");
    expect(prompt).not.toContain("Surrounding Text");
    expect(prompt).not.toContain("Query guidance");
    expect(prompt).not.toContain("## Available Tools");
  });

  it("stays usable without a book", () => {
    const noBook = buildKnowledgeSystemPrompt({
      book: null,
      enabledSkills: [],
      isVectorized: false,
      userLanguage: "en",
    });
    expect(noBook).toContain("Knowledge-Only");
    expect(noBook).not.toContain("## Current Book");
  });

  it("announces disabled optional tools so the model can guide the user", () => {
    const prompt = buildKnowledgeSystemPrompt({
      book: makeBook(),
      enabledSkills: [],
      isVectorized: false,
      userLanguage: "en",
    });
    expect(prompt).toContain("## Optional Tools (currently OFF)");
    expect(prompt).toContain("mindmap");
    expect(prompt).toContain("disabled");
    expect(prompt).not.toContain("ragSearch");
  });

  it("lists enabled tools AND the still-off choice items when some are on", () => {
    const prompt = buildKnowledgeSystemPrompt({
      book: makeBook(),
      enabledSkills: [],
      isVectorized: false,
      userLanguage: "en",
      allowedToolNames: ["mindmap"],
    });
    expect(prompt).toContain("## Turn-Available Tools");
    expect(prompt).toContain("- mindmap");
    // Off list excludes the enabled one but keeps the others visible
    expect(prompt).toContain("## Optional Tools (currently OFF)");
    expect(prompt).not.toContain("These basic tools exist but are disabled: mindmap");
    expect(prompt).toContain("getAnnotations");
  });

  it("forces the response language to the user's language", () => {
    const prompt = buildKnowledgeSystemPrompt({
      book: makeBook(),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
    });
    expect(prompt).toContain("You MUST respond in en");
  });

  it("injects the spoiler-free boundary when enabled", () => {
    const prompt = buildKnowledgeSystemPrompt({
      book: makeBook(),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "zh",
      spoilerFree: true,
      currentPosition: { cfi: "epubcfi(/6/20!/4/26)", percentage: 12.12 },
    });

    expect(prompt).toContain("Spoiler-Free Mode (ACTIVE)");
    expect(prompt).toContain("guard against it");
    expect(prompt).toContain("one-line guarded overview");
    expect(prompt).toContain("Still fine to discuss freely");
  });

  it("omits the spoiler block when disabled or without a book", () => {
    const off = buildKnowledgeSystemPrompt({
      book: makeBook(),
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
    });
    expect(off).not.toContain("Spoiler-Free");

    const noBook = buildKnowledgeSystemPrompt({
      book: null,
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
      spoilerFree: true,
    });
    expect(noBook).not.toContain("Spoiler-Free");
  });
});

describe("buildStaticBookInfoSection", () => {
  it("includes title/author/language/description/subjects when present", () => {
    const info = buildStaticBookInfoSection(
      makeBook({
        description: "A sci-fi classic about a boy trained for war.",
        subjects: ["Science Fiction", "War"],
      }),
    );
    expect(info).toContain("## Current Book");
    expect(info).toContain("- Title: Test Book");
    expect(info).toContain("- Author: Test Author");
    expect(info).toContain("- Language: en");
    expect(info).toContain("- Description:");
    expect(info).toContain("A sci-fi classic about a boy trained for war.");
    expect(info).toContain("- Subjects: Science Fiction, War");
  });

  it("omits description/subjects lines when absent and returns empty without a book", () => {
    const noDesc = buildStaticBookInfoSection(makeBook());
    expect(noDesc).not.toContain("- Description:");
    expect(noDesc).not.toContain("- Subjects:");

    expect(buildStaticBookInfoSection(null)).toBe("");
  });
});
