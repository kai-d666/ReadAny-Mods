import { describe, expect, it } from "vitest";
import { createReasoningPart, createTextPart, createToolCallPart } from "../../types/message";
import {
  applyToolResultToParts,
  attachTokenUsageToParts,
  markRunningToolCallPartsAsError,
} from "../tool-call-state";

describe("tool call state helpers", () => {
  it("marks a failed tool result as an error instead of leaving it running", () => {
    const part = createToolCallPart("fallbackToc", { bookId: "book-1" });

    const updated = applyToolResultToParts(
      [part],
      "fallbackToc",
      { error: "fallbackToc is not available" },
      456,
    );

    expect(updated).toBe(part);
    expect(part.status).toBe("error");
    expect(part.error).toBe("fallbackToc is not available");
    expect(part.updatedAt).toBe(456);
  });

  it("marks a successful tool result as completed", () => {
    const part = createToolCallPart("fallbackSearch", { query: "confucius" });

    applyToolResultToParts([part], "fallbackSearch", { hits: [] }, 456);

    expect(part.status).toBe("completed");
    expect(part.error).toBeUndefined();
    expect(part.result).toEqual({ hits: [] });
  });

  it("marks running tool calls as failed when the stream errors", () => {
    const runningPart = createToolCallPart("fallbackChapterContext", { chapterIndex: 1 });
    const completedPart = createToolCallPart("fallbackSearch", { query: "AI" });
    completedPart.status = "completed";
    completedPart.result = { hits: [] };

    markRunningToolCallPartsAsError([runningPart, completedPart], "Model stream failed", 789);

    expect(runningPart.status).toBe("error");
    expect(runningPart.error).toBe("Model stream failed");
    expect(runningPart.updatedAt).toBe(789);
    expect(completedPart.status).toBe("completed");
    expect(completedPart.error).toBeUndefined();
  });

  describe("attachTokenUsageToParts", () => {
    it("retro-attaches usage to tool_call and reasoning parts since the boundary, skipping earlier parts", () => {
      // Earlier call's parts must NOT be touched (they already carry their own usage).
      const earlierTool = createToolCallPart("ragSearch", { query: "old" });
      earlierTool.tokens = 1200;
      // Current call: reasoning + 2 tools (streamed BEFORE usage arrives).
      const reasoning = createReasoningPart("thinking about it", "thinking");
      const toolA = createToolCallPart("fallbackToc", { bookId: "b1" });
      const toolB = createToolCallPart("fallbackChapterContext", { href: "ch10" });
      const text = createTextPart("final answer");

      const parts = [earlierTool, reasoning, toolA, toolB, text];
      attachTokenUsageToParts(parts, 1, 5300, 42);

      expect(earlierTool.tokens).toBe(1200); // untouched
      expect(reasoning.tokens).toBe(5300);
      expect(toolA.tokens).toBe(5300);
      expect(toolB.tokens).toBe(5300);
      expect(text).not.toHaveProperty("tokens"); // text parts never get usage
      expect(reasoning.updatedAt).toBe(42);
      expect(toolA.updatedAt).toBe(42);
    });

    it("force-overwrites tokens previously attached via the pending path (previous call's usage)", () => {
      const tool = createToolCallPart("ragContext", { chapterIndex: 3 });
      tool.tokens = 8100; // wrongly assigned from the PREVIOUS call's pending usage

      attachTokenUsageToParts([tool], 0, 9600, 7);

      expect(tool.tokens).toBe(9600);
    });

    it("handles a part list where the boundary equals the length (no current-call parts)", () => {
      const tool = createToolCallPart("ragSearch", { query: "x" });
      tool.tokens = 500;

      attachTokenUsageToParts([tool], 1, 7000, 1);

      expect(tool.tokens).toBe(500);
    });
  });
});
