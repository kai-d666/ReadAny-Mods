import { describe, expect, it } from "vitest";
import type { Book } from "../../types";
import {
  buildFastSystemPrompt,
  buildKnowledgeSystemPrompt,
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
      semanticContext: null,
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
      semanticContext: null,
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
      semanticContext: null,
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
      semanticContext: null,
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
      semanticContext: null,
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
      semanticContext: null,
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
      semanticContext: null,
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
      semanticContext: null,
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
      semanticContext: null,
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
      semanticContext: null,
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "zh",
    });

    expect(prompt).toContain("- Language: en");
    expect(prompt).toContain("Query guidance: the book is in en but the user asks in zh");
  });

  it("omits query guidance when book and user languages match", () => {
    const prompt = buildSystemPrompt({
      book: makeBook({ language: "en" }),
      semanticContext: null,
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
    });

    expect(prompt).toContain("- Language: en");
    expect(prompt).not.toContain("Query guidance:");
  });

  it("injects unknown-language guidance when book language is missing", () => {
    const prompt = buildSystemPrompt({
      book: makeBook({ language: undefined }),
      semanticContext: null,
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
      semanticContext: null,
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "zh",
      currentChapter: { index: 9, title: "4. Launch" },
      currentPosition: { cfi: "epubcfi(/6/20!/4/26)", percentage: 12.12 },
    });

    expect(prompt).toContain("Knowledge-Only");
    expect(prompt).toContain("- Title: Test Book");
    expect(prompt).toContain("- Author: Test Author");
    expect(prompt).toContain("- Language: en");
    expect(prompt).toContain("- Description:");
    expect(prompt).toContain("A sci-fi classic about a boy trained for war.");
    expect(prompt).toContain("- Subjects: Science Fiction, War");
    expect(prompt).toContain("- Reading Progress:");
    expect(prompt).toContain("- Current Chapter: 4. Launch (index 9)");
    expect(prompt).toContain("- Reading Position: 12.12%");
  });

  it("never mentions retrieval tools or semantic reading content", () => {
    const prompt = buildKnowledgeSystemPrompt({
      book: makeBook({ description: "desc" }),
      semanticContext: {
        currentChapter: "4. Launch",
        currentPosition: "12%",
        surroundingText: "Some surrounding text from the book",
        recentHighlights: ["a highlight"],
        operationType: "reading",
      },
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

  it("omits description/subjects lines when absent and stays usable without a book", () => {
    const noDesc = buildKnowledgeSystemPrompt({
      book: makeBook(),
      semanticContext: null,
      enabledSkills: [],
      isVectorized: false,
      userLanguage: "en",
    });
    expect(noDesc).not.toContain("- Description:");
    expect(noDesc).not.toContain("- Subjects:");

    const noBook = buildKnowledgeSystemPrompt({
      book: null,
      semanticContext: null,
      enabledSkills: [],
      isVectorized: false,
      userLanguage: "en",
    });
    expect(noBook).toContain("Knowledge-Only");
    expect(noBook).not.toContain("## Current Book");
  });

  it("forces the response language to the user's language", () => {
    const prompt = buildKnowledgeSystemPrompt({
      book: makeBook(),
      semanticContext: null,
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
    });
    expect(prompt).toContain("You MUST respond in en");
  });

  it("injects the spoiler-free boundary when enabled", () => {
    const prompt = buildKnowledgeSystemPrompt({
      book: makeBook(),
      semanticContext: null,
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
      semanticContext: null,
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
    });
    expect(off).not.toContain("Spoiler-Free");

    const noBook = buildKnowledgeSystemPrompt({
      book: null,
      semanticContext: null,
      enabledSkills: [],
      isVectorized: true,
      userLanguage: "en",
      spoilerFree: true,
    });
    expect(noBook).not.toContain("Spoiler-Free");
  });
});
