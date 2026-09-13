import { describe, expect, it, vi } from "vitest";
import { withTransportBudget } from "../request-timeouts";

describe("withTransportBudget", () => {
  it("resolves normally when the work finishes in time", async () => {
    const result = await withTransportBudget(async () => "ok", { timeoutMs: 50 });

    expect(result).toBe("ok");
  });

  it("rejects with a transport timeout code when the work never settles", async () => {
    await expect(
      withTransportBudget(() => new Promise(() => {}), { timeoutMs: 30, label: "Model list" }),
    ).rejects.toMatchObject({ code: "ai_transport_timeout" });
  });

  it("aborts the signal it hands to the work", async () => {
    let observed: AbortSignal | undefined;

    await withTransportBudget(
      (signal) => {
        observed = signal;
        return new Promise(() => {});
      },
      { timeoutMs: 30 },
    ).catch(() => undefined);

    expect(observed?.aborted).toBe(true);
  });

  it("propagates the work's own failure instead of masking it as a timeout", async () => {
    await expect(
      withTransportBudget(async () => {
        throw new Error("401 Unauthorized");
      }, { timeoutMs: 50 }),
    ).rejects.toThrow("401 Unauthorized");
  });

  it("leaves no pending timer behind", async () => {
    vi.useFakeTimers();
    try {
      await withTransportBudget(async () => "done", { timeoutMs: 500 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
