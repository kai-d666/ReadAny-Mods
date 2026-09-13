import { describe, expect, it } from "vitest";
import type { Message, Thread } from "../../types";
import { processMessages } from "../message-pipeline";

function message(id: number, role: Message["role"] = id % 2 === 0 ? "assistant" : "user"): Message {
  return {
    id: `msg-${id}`,
    threadId: "thread-1",
    role,
    content: `message ${id}`,
    createdAt: id,
  };
}

function thread(messages: Message[]): Thread {
  return {
    id: "thread-1",
    title: "Thread",
    messages,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("message pipeline with first-turn system messages", () => {
  it("keeps system messages through the sliding window (first-turn book info never drops)", () => {
    const info = message(0, "system");
    const rest = Array.from({ length: 12 }, (_, index) => message(index + 1));
    const messages = processMessages(thread([info, ...rest]), {
      slidingWindowSize: 8,
    });

    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toBe("message 0");
    // Last 7 non-system messages survive (window 8 − 1 system)
    expect(messages.some((m) => m.content === "message 5")).toBe(false);
    expect(messages.some((m) => m.content === "message 12")).toBe(true);
  });

  it("passes system role through without mapping it to user/assistant", () => {
    const info = message(0, "system");
    const messages = processMessages(thread([info, message(1), message(2)]), {
      slidingWindowSize: 8,
    });

    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });
});
