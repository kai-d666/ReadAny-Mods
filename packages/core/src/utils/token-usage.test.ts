import { describe, expect, it } from "vitest";
import { computeSessionTokenTotals, formatTokenCount, formatTurnAndSessionTokens } from "./token-usage";

describe("computeSessionTokenTotals", () => {
  it("returns a running total, not a per-message value", () => {
    const totals = computeSessionTokenTotals([
      { role: "system" },
      { role: "user" },
      { role: "assistant", totalTokens: 100 },
      { role: "user" },
      { role: "assistant", totalTokens: 50 },
    ]);

    expect(totals).toEqual([0, 0, 100, 100, 150]);
  });

  it("lets the last assistant entry be read as the whole-session total", () => {
    const totals = computeSessionTokenTotals([
      { role: "assistant", totalTokens: 100 },
      { role: "assistant", totalTokens: 50 },
    ]);

    expect(totals[totals.length - 1]).toBe(150);
  });

  it("never counts a non-assistant message, even if it carries the field", () => {
    const totals = computeSessionTokenTotals([
      { role: "system", totalTokens: 999 },
      { role: "assistant", totalTokens: 100 },
    ]);

    expect(totals).toEqual([0, 100]);
  });

  it("treats messages written before the ledger existed as zero, not NaN", () => {
    const totals = computeSessionTokenTotals([
      { role: "assistant" },
      { role: "assistant", totalTokens: 40 },
    ]);

    expect(totals).toEqual([0, 40]);
  });

  it("handles an empty list", () => {
    expect(computeSessionTokenTotals([])).toEqual([]);
  });
});

describe("formatTokenCount", () => {
  it("inserts thousands separators", () => {
    expect(formatTokenCount(1234567)).toBe("1,234,567");
    expect(formatTokenCount(546)).toBe("546");
  });
});

describe("formatTurnAndSessionTokens", () => {
  it("renders this turn over the running session total", () => {
    expect(formatTurnAndSessionTokens(546, 9764)).toBe("+546/9,764sum");
  });
});
