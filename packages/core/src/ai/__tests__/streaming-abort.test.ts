import { describe, expect, it, vi } from "vitest";
import type { AIConfig, Book, Message, Thread } from "../../types";

/**
 * Locks in the abort contract of StreamingChat: stopStream() only calls
 * abort(), so the caller's session is settled exclusively by onAbort/onError.
 * The generator is parked after its first token so the test decides when the
 * stream ends.
 */
const state = vi.hoisted(() => ({
  mode: "park" as "park" | "complete",
}));

vi.mock("../agents/reading-agent", () => ({
  streamReadingAgent: () =>
    (async function* () {
      yield { type: "token", content: "hello" };
      if (state.mode === "complete") return;
      await new Promise<void>(() => {
        /* parked until aborted */
      });
    })(),
}));

const { StreamingChat } = await import("../streaming");

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

function options(events: string[]) {
  return {
    thread: thread(),
    book: book(),
    bookId: "book-1",
    enabledSkills: [],
    isVectorized: false,
    aiConfig: { slidingWindowSize: 8 } as unknown as AIConfig,
    getAvailableTools: () => [],
    onToken: (token: string) => events.push(`token:${token}`),
    onComplete: (text: string) => events.push(`complete:${text}`),
    onAbort: (text: string) => events.push(`abort:${text}`),
    onError: (error: Error) => events.push(`error:${error.message}`),
  };
}

describe("StreamingChat abort handling", () => {
  it("settles through onAbort with the partial text when the user stops", async () => {
    state.mode = "park";
    const events: string[] = [];
    const chat = new StreamingChat();

    const streamed = chat.stream(options(events) as never);
    await waitFor(() => events.includes("token:hello"));
    chat.abort();
    await streamed;

    expect(events).toContain("abort:hello");
    expect(events.some((event) => event.startsWith("error:"))).toBe(false);
    expect(events.some((event) => event.startsWith("complete:"))).toBe(false);
  });

  it("still completes normally when nothing is aborted", async () => {
    state.mode = "complete";
    const events: string[] = [];
    const chat = new StreamingChat();

    await chat.stream(options(events) as never);

    expect(events).toContain("complete:hello");
    expect(events.some((event) => event.startsWith("abort:"))).toBe(false);
    expect(events.some((event) => event.startsWith("error:"))).toBe(false);
  });
});
