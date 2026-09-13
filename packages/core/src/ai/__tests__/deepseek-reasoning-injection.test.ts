import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AIEndpoint } from "../../types";
import { createChatModelFromEndpoint } from "../llm-provider";

/**
 * Guards the merged DeepSeek subclass (ai/llm-provider.ts::createDeepSeekModel).
 * Its re-injection used to exist as two verbatim copies — one per entry path —
 * so this runs the same assertion through BOTH paths.
 */
const originalFetch = globalThis.fetch;

function makeEndpoint(overrides: Partial<AIEndpoint> = {}): AIEndpoint {
  return {
    id: "ep-deepseek",
    name: "DeepSeek",
    provider: "deepseek",
    apiKey: "test-key",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-reasoner"],
    modelsFetched: true,
    ...overrides,
  };
}

function captureRequestBody(): () => Record<string, any> {
  let captured: Record<string, any> | null = null;
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "deepseek-reasoner",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return () => {
    if (!captured) throw new Error("no request was captured");
    return captured;
  };
}

const messages = [
  new HumanMessage("first question"),
  new AIMessage({ content: "an answer", additional_kwargs: { reasoning_content: "because" } }),
  new HumanMessage("follow-up"),
];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("DeepSeek reasoning_content re-injection", () => {
  it("injects it for the explicit deepseek provider", async () => {
    const body = captureRequestBody();
    const model = await createChatModelFromEndpoint(makeEndpoint(), "deepseek-reasoner", {
      streaming: false,
    });

    await model.invoke(messages);

    const assistant = body().messages.find((message: any) => message.role === "assistant");
    expect(assistant?.reasoning_content).toBe("because");
  });

  it("injects it for the custom-endpoint autodetect path", async () => {
    const body = captureRequestBody();
    const model = await createChatModelFromEndpoint(
      makeEndpoint({
        id: "ep-custom",
        provider: "custom",
        baseUrl: "https://api.deepseek.com/v1",
      }),
      "deepseek-reasoner",
      { streaming: false },
    );

    await model.invoke(messages);

    const assistant = body().messages.find((message: any) => message.role === "assistant");
    expect(assistant?.reasoning_content).toBe("because");
  });
});
