import { afterEach, describe, expect, it, vi } from "vitest";
import type { AIConfig, Book, Message, Thread } from "../../types";

/**
 * The agent module is mocked so each test can decide exactly how the stream
 * behaves. Budgets are injected through `timeouts` instead of fake timers, so
 * the tests stay deterministic and fast.
 */
const state = vi.hoisted(() => ({
  mode: "parkBeforeFirst" as "parkBeforeFirst" | "parkAfterToken" | "healthy" | "toolPending" | "toolHang" | "instant",
}));

vi.mock("../agents/reading-agent", () => ({
  streamReadingAgent: () =>
    (async function* () {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      switch (state.mode) {
        case "parkBeforeFirst":
          await new Promise<void>(() => {});
          return;
        case "parkAfterToken":
          yield { type: "token", content: "hello" };
          await new Promise<void>(() => {});
          return;
        case "healthy":
          for (let index = 0; index < 5; index++) {
            await sleep(20);
            yield { type: "token", content: `t${index}` };
          }
          return;
        case "instant":
          for (let index = 0; index < 5; index++) {
            await Promise.resolve();
            yield { type: "token", content: `t${index}` };
          }
          return;
        case "toolPending":
          yield { type: "tool_call", name: "demo", args: {} };
          await sleep(90);
          yield { type: "tool_result", name: "demo", result: { ok: true } };
          yield { type: "token", content: "done" };
          return;
        case "toolHang":
          yield { type: "tool_call", name: "demo", args: {} };
          await new Promise<void>(() => {});
          return;
      }
    })(),
}));

const { StreamingChat } = await import("../streaming");

function thread(): Thread {
  const message: Message = {
    id: "msg-1",
    threadId: "thread-1",
    role: "user",
    content: "question",
    createdAt: 1,
  };
  return { id: "thread-1", title: "Thread", messages: [message], createdAt: 1, updatedAt: 1 };
}

function book(): Book {
  return {
    id: "book-1",
    filePath: "book.epub",
    format: "epub",
    meta: { title: "Test Book", author: "Test Author", language: "en" },
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

interface Event {
  kind: string;
  detail?: string;
}

function options(
  events: Event[],
  timeouts: { firstEventMs?: number; idleMs?: number; toolIdleMs?: number },
) {
  return {
    thread: thread(),
    book: book(),
    bookId: "book-1",
    enabledSkills: [],
    isVectorized: false,
    aiConfig: { slidingWindowSize: 8 } as unknown as AIConfig,
    getAvailableTools: () => [],
    timeouts,
    onToken: (token: string) => events.push({ kind: "token", detail: token }),
    onComplete: () => events.push({ kind: "complete" }),
    onAbort: () => events.push({ kind: "abort" }),
    onToolCall: (name: string) => events.push({ kind: "tool_call", detail: name }),
    onToolResult: () => events.push({ kind: "tool_result" }),
    onError: (error: Error & { code?: string }) =>
      events.push({ kind: "error", detail: `${error.code ?? "no-code"}|${error.message}` }),
  };
}

const errors = (events: Event[]) => events.filter((event) => event.kind === "error");

describe("StreamingChat watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out the first event and reports a timeout code", async () => {
    state.mode = "parkBeforeFirst";
    const events: Event[] = [];

    await new StreamingChat().stream(
      options(events, { firstEventMs: 40, idleMs: 80, toolIdleMs: 200 }) as never,
    );

    expect(errors(events)).toHaveLength(1);
    expect(errors(events)[0].detail).toContain("stream_timeout");
    expect(events.some((event) => event.kind === "complete")).toBe(false);
    // A timeout is NOT a user stop — the session must not be reported as aborted.
    expect(events.some((event) => event.kind === "abort")).toBe(false);
  });

  it("times out the gap after a token has arrived", async () => {
    state.mode = "parkAfterToken";
    const events: Event[] = [];

    await new StreamingChat().stream(
      options(events, { firstEventMs: 500, idleMs: 40, toolIdleMs: 200 }) as never,
    );

    expect(events.some((event) => event.kind === "token")).toBe(true);
    expect(errors(events)).toHaveLength(1);
    expect(errors(events)[0].detail).toContain("stream_timeout");
    expect(events.some((event) => event.kind === "complete")).toBe(false);
  });

  it("does not fire on a healthy stream", async () => {
    state.mode = "healthy";
    const events: Event[] = [];

    await new StreamingChat().stream(
      options(events, { firstEventMs: 200, idleMs: 200, toolIdleMs: 400 }) as never,
    );

    expect(errors(events)).toHaveLength(0);
    expect(events.filter((event) => event.kind === "token")).toHaveLength(5);
    expect(events.some((event) => event.kind === "complete")).toBe(true);
  });

  it("grants the longer budget while a tool call is pending", async () => {
    state.mode = "toolPending";
    const events: Event[] = [];

    // 90ms of silence: longer than idleMs, shorter than toolIdleMs.
    await new StreamingChat().stream(
      options(events, { firstEventMs: 200, idleMs: 50, toolIdleMs: 300 }) as never,
    );

    expect(errors(events)).toHaveLength(0);
    expect(events.some((event) => event.kind === "complete")).toBe(true);
  });

  it("still times out a tool call that never returns, without blaming the tool", async () => {
    state.mode = "toolHang";
    const events: Event[] = [];

    await new StreamingChat().stream(
      options(events, { firstEventMs: 200, idleMs: 50, toolIdleMs: 60 }) as never,
    );

    expect(errors(events)).toHaveLength(1);
    expect(errors(events)[0].detail).toContain("stream_timeout");
    // Must not surface the (wrong) "tool call incomplete" diagnosis.
    expect(errors(events)[0].detail).not.toContain("before its tool call completed");
  });

  it("leaves no timers behind after a completed stream", async () => {
    state.mode = "instant";
    vi.useFakeTimers();
    const events: Event[] = [];

    await new StreamingChat().stream(
      options(events, { firstEventMs: 500, idleMs: 500, toolIdleMs: 500 }) as never,
    );

    expect(events.some((event) => event.kind === "complete")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
