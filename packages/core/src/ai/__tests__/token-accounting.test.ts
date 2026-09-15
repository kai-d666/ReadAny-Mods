import { describe, expect, it } from "vitest";
import {
  allocateReasoningTokens,
  estimateTextTokens,
  readReasoningTokens,
} from "../token-accounting";

describe("estimateTextTokens", () => {
  it("counts a CJK character as a whole token", () => {
    // length / 4 would say 1 — that is the bug this estimator exists to avoid.
    expect(estimateTextTokens("你好世界")).toBe(4);
  });

  it("counts four latin characters as a token", () => {
    expect(estimateTextTokens("hello world")).toBe(3);
  });

  it("mixes the two rules", () => {
    expect(estimateTextTokens("你好hello")).toBe(4); // 2 + ceil(5 / 4)
  });

  it("returns 0 for empty text so callers can skip the badge", () => {
    expect(estimateTextTokens("")).toBe(0);
  });
});

describe("readReasoningTokens", () => {
  it("prefers LangChain's normalised field", () => {
    expect(
      readReasoningTokens({ usage_metadata: { output_token_details: { reasoning: 768 } } }),
    ).toBe(768);
  });

  it("falls back to the raw OpenAI-compatible usage the caller resolved", () => {
    expect(readReasoningTokens(undefined, { completion_tokens_details: { reasoning_tokens: 512 } })).toBe(
      512,
    );
  });

  it("falls back to the raw usage still nested in response_metadata", () => {
    expect(
      readReasoningTokens({
        response_metadata: { usage: { completion_tokens_details: { reasoning_tokens: 333 } } },
      }),
    ).toBe(333);
  });

  it("prefers the normalised field when both are present", () => {
    expect(
      readReasoningTokens(
        { usage_metadata: { output_token_details: { reasoning: 768 } } },
        { completion_tokens_details: { reasoning_tokens: 512 } },
      ),
    ).toBe(768);
  });

  it("ignores a present-but-undefined details object", () => {
    // @langchain/openai builds this with `details?.x !== null`, which is true
    // when details is undefined — so a response with NO reasoning still arrives
    // shaped like this. Any `in` / object-level null check reads it as a count.
    expect(
      readReasoningTokens({
        usage_metadata: { output_token_details: { reasoning: undefined, audio: undefined } },
      }),
    ).toBeUndefined();
  });

  it("ignores a zero count", () => {
    expect(readReasoningTokens({ usage_metadata: { output_token_details: { reasoning: 0 } } })).toBe(
      undefined,
    );
  });

  it("returns undefined for providers that never report one (Anthropic shape)", () => {
    expect(
      readReasoningTokens({
        usage_metadata: {
          input_tokens: 100,
          output_tokens: 50,
          input_token_details: { cache_read: 0 },
        },
      }),
    ).toBeUndefined();
  });
});

describe("allocateReasoningTokens", () => {
  it("gives the reported total to the only reasoning part", () => {
    expect(allocateReasoningTokens(768, ["x"])).toEqual([768]);
  });

  it("estimates each part when the provider reported nothing", () => {
    expect(allocateReasoningTokens(undefined, ["你好世界", "hello world"])).toEqual([4, 3]);
  });

  it("splits the reported total so the shares still add up to it", () => {
    const shares = allocateReasoningTokens(100, ["aaaa", "bbbb"]);
    expect(shares.reduce((sum, n) => sum + n, 0)).toBe(100);
  });

  it("hands the rounding remainder to the longest part", () => {
    const shares = allocateReasoningTokens(7, ["aaaa", "bbbb", "cccc"]);
    expect(shares.reduce((sum, n) => sum + n, 0)).toBe(7);
  });

  it("keeps empty parts at zero instead of inventing a badge", () => {
    expect(allocateReasoningTokens(100, ["", "aaaa"])).toEqual([0, 100]);
    expect(allocateReasoningTokens(undefined, [""])).toEqual([0]);
  });
});
