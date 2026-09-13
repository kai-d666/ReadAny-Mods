import { describe, expect, it, vi } from "vitest";
import type { AIConfig, Message, Thread } from "../../types";
import { getCompressibleMessages, maybeCompressThreadMemory } from "../chat-memory";

vi.mock("../llm-provider", () => ({
  createChatModel: vi.fn(async () => ({
    // Deliberately ignores the abort signal: the budget must hold anyway.
    invoke: vi.fn(() => new Promise(() => {})),
  })),
}));

function message(id: number): Message {
  return {
    id: `msg-${id}`,
    threadId: "thread-1",
    role: id % 2 === 0 ? "assistant" : "user",
    content: `message ${id}`,
    createdAt: id,
  };
}

function thread(messages: Message[], memoryMessageCount = 0): Thread {
  return {
    id: "thread-1",
    title: "Thread",
    messages,
    memoryMessageCount,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("chat memory compression window", () => {
  it("returns only messages outside the sliding window", () => {
    const messages = Array.from({ length: 10 }, (_, index) => message(index + 1));

    const compressible = getCompressibleMessages(thread(messages), 4);

    expect(compressible.map((item) => item.id)).toEqual([
      "msg-1",
      "msg-2",
      "msg-3",
      "msg-4",
      "msg-5",
      "msg-6",
    ]);
  });

  it("does not return messages that were already summarized", () => {
    const messages = Array.from({ length: 10 }, (_, index) => message(index + 1));

    const compressible = getCompressibleMessages(thread(messages, 4), 4);

    expect(compressible.map((item) => item.id)).toEqual(["msg-5", "msg-6"]);
  });
});

describe("chat memory window with a first-turn system message", () => {
  function withSystem(messages: Message[]): Message[] {
    const info: Message = {
      id: "msg-0",
      threadId: "thread-1",
      role: "system",
      content: "book info",
      createdAt: 0,
    };
    return [info, ...messages];
  }

  it("does not re-summarize messages from an earlier compression round", () => {
    const first = Array.from({ length: 6 }, (_, index) => message(index + 1));

    const batchOne = getCompressibleMessages(thread(withSystem(first), 0), 4);
    expect(batchOne.map((item) => item.id)).toEqual(["msg-1", "msg-2", "msg-3"]);

    // Next round: two more turns arrive; batchOne.length is what got persisted
    // as memoryMessageCount.
    const grown = Array.from({ length: 8 }, (_, index) => message(index + 1));
    const batchTwo = getCompressibleMessages(thread(withSystem(grown), batchOne.length), 4);

    expect(batchTwo.map((item) => item.id)).toEqual(["msg-4", "msg-5"]);
    const repeated = batchTwo.filter((item) => batchOne.some((done) => done.id === item.id));
    expect(repeated).toEqual([]);
  });

  it("summarizes exactly the messages that leave the prompt window", () => {
    const messages = Array.from({ length: 10 }, (_, index) => message(index + 1));

    const compressible = getCompressibleMessages(thread(withSystem(messages), 0), 4);
    const summarized = compressible.map((item) => item.id);

    // applySlidingWindow keeps the system message + the last (window − system)
    // messages, i.e. msg-8..msg-10 here.
    expect(summarized).not.toContain("msg-8");
    expect(summarized).not.toContain("msg-9");
    expect(summarized).not.toContain("msg-10");
    expect(summarized.at(-1)).toBe("msg-7");
  });
});

describe("thread memory compression budget", () => {
  it("fails open and warns when the compression call hangs", async () => {
    const messages = Array.from({ length: 12 }, (_, index) => message(index + 1));
    const subject = thread(messages);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await maybeCompressThreadMemory(
      subject,
      { slidingWindowSize: 4 } as unknown as AIConfig,
      { timeoutMs: 30 },
    );

    expect(result).toBe(subject);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
