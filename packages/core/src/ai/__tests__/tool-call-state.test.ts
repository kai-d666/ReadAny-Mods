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
      attachTokenUsageToParts(parts, 1, 5300, { now: 42 });

      expect(earlierTool.tokens).toBe(1200); // untouched
      // A reasoning card shows the thinking itself. With no reported count the
      // provider gave none, so it falls back to the text's own estimate
      // ("thinking about it" → ceil(17 / 4)) — NOT the 5300 call total.
      expect(reasoning.tokens).toBe(5);
      expect(toolA.tokens).toBe(5300);
      expect(toolB.tokens).toBe(5300);
      expect(text.tokens).toBe(5300);
      expect(reasoning.updatedAt).toBe(42);
      expect(toolA.updatedAt).toBe(42);
    });

    it("keeps the thinking's own tokens off a tool card's total", () => {
      // The regression this guards: a single call emits reasoning + a tool, and
      // the reasoning was given the call's total too — so any consumer summing
      // the badges reported twice what the call cost.
      const reasoning = createReasoningPart("weighing the options", "thinking");
      const tool = createToolCallPart("ragSearch", { query: "主角" });

      attachTokenUsageToParts([reasoning, tool], 0, 5000, { reasoningTokens: 800 });

      expect(tool.tokens).toBe(5000);
      expect(reasoning.tokens).toBe(800);
      // Both used to read 5000, so anything summing the badges reported 10000
      // for a call that cost 5000.
      expect(reasoning.tokens).not.toBe(tool.tokens);
    });

    it("splits one call's reported thinking across the reasoning parts it produced", () => {
      const first = createReasoningPart("第一段思考", "thinking");
      const second = createReasoningPart("第二段", "thinking");

      attachTokenUsageToParts([first, second], 0, 5000, { reasoningTokens: 100 });

      expect((first.tokens ?? 0) + (second.tokens ?? 0)).toBe(100);
      expect(first.tokens).toBeLessThan(5000);
    });

    it("leaves an empty reasoning part unbadged rather than printing a fake count", () => {
      const reasoning = createReasoningPart("", "thinking");

      attachTokenUsageToParts([reasoning], 0, 5000, {});

      expect(reasoning.tokens).toBeUndefined();
    });

    it("force-overwrites tokens previously attached via the pending path (previous call's usage)", () => {
      const tool = createToolCallPart("ragContext", { chapterIndex: 3 });
      tool.tokens = 8100; // wrongly assigned from the PREVIOUS call's pending usage

      attachTokenUsageToParts([tool], 0, 9600, { now: 7 });

      expect(tool.tokens).toBe(9600);
    });

    it("handles a part list where the boundary equals the length (no current-call parts)", () => {
      const tool = createToolCallPart("ragSearch", { query: "x" });
      tool.tokens = 500;

      attachTokenUsageToParts([tool], 1, 7000, { now: 1 });

      expect(tool.tokens).toBe(500);
    });
  });
});
