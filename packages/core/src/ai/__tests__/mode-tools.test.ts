import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_CHOICE_TOOLS,
  LITE_CHOICE_TOOLS,
  LITE_DEFAULT_TOOLS,
  resolveModeTools,
} from "../tools";

const CANDIDATES = [
  ...LITE_DEFAULT_TOOLS,
  ...LITE_CHOICE_TOOLS,
  ...KNOWLEDGE_CHOICE_TOOLS,
  "summarize",
  "addCitation",
  "getSelection",
  "getSurroundingContext",
  "ragSearch",
  "my-skill",
];

describe("resolveModeTools", () => {
  it("lite default = the 6 always-on tools", () => {
    const result = resolveModeTools("lite", [], CANDIDATES, []);
    expect([...result].sort()).toEqual([...LITE_DEFAULT_TOOLS].sort());
  });

  it("lite allows enabling a choice item (ragToc) alongside always-on", () => {
    const result = resolveModeTools("lite", ["ragToc"], CANDIDATES, []);
    expect(result.has("ragToc")).toBe(true);
    expect(result.has("getSurroundingContext")).toBe(true);
  });

  it("lite rejects forbidden items even when enabled (getSelection/addCitation)", () => {
    const result = resolveModeTools("lite", ["getSelection", "addCitation"], CANDIDATES, []);
    expect(result.has("getSelection")).toBe(false);
    expect(result.has("addCitation")).toBe(false);
  });

  it("knowledge with no prefs = empty set", () => {
    expect(resolveModeTools("knowledge", [], CANDIDATES, []).size).toBe(0);
  });

  it("knowledge enables choice items (mindmap/getAnnotations)", () => {
    const result = resolveModeTools("knowledge", ["mindmap", "getAnnotations"], CANDIDATES, []);
    expect(result.has("mindmap")).toBe(true);
    expect(result.has("getAnnotations")).toBe(true);
  });

  it("knowledge rejects search/citation families even when enabled", () => {
    const result = resolveModeTools(
      "knowledge",
      ["ragSearch", "ragToc", "addCitation", "summarize", "getSurroundingContext"],
      CANDIDATES,
      [],
    );
    expect(result.size).toBe(0);
  });

  it("getSkills enabled → skill tool names pass through (both modes)", () => {
    const lite = resolveModeTools("lite", ["getSkills"], CANDIDATES, ["my-skill"]);
    expect(lite.has("my-skill")).toBe(true);

    const knowledge = resolveModeTools("knowledge", ["getSkills"], CANDIDATES, ["my-skill"]);
    expect(knowledge.has("my-skill")).toBe(true);
  });

  it("candidateNames bounds the result (unregistered tools never leak)", () => {
    const result = resolveModeTools("lite", ["ragToc"], ["getSurroundingContext"], []);
    expect(result.has("ragToc")).toBe(false);
    expect(result.has("getSurroundingContext")).toBe(true);
  });
});
