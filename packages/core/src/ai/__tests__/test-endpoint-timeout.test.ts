import { afterEach, describe, expect, it, vi } from "vitest";
import type { AIEndpoint } from "../../types";
import { AI_TRANSPORT_TIMEOUT_MS } from "../request-timeouts";

const mocks = vi.hoisted(() => ({
  getEndpointFetch: vi.fn(),
}));

vi.mock("../llm-provider", () => ({
  getEndpointFetch: mocks.getEndpointFetch,
}));

const { testAIEndpoint } = await import("../test-endpoint");

function makeEndpoint(): AIEndpoint {
  return {
    id: "endpoint-1",
    name: "Test",
    provider: "custom",
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    models: ["test-model"],
    modelsFetched: true,
  };
}

afterEach(() => {
  vi.useRealTimers();
  mocks.getEndpointFetch.mockReset();
});

describe("endpoint test budget", () => {
  it("times out when the server sends headers but never the body", async () => {
    // The settings "test connection" button must settle even when the body
    // stalls — the header guard in llm-provider.ts does not cover the body read.
    mocks.getEndpointFetch.mockReturnValue(async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "application/json" },
        text: () => new Promise<string>(() => {}),
      }) as unknown as Response,
    );

    vi.useFakeTimers();
    const pending = testAIEndpoint(makeEndpoint());
    const assertion = expect(pending).rejects.toMatchObject({ code: "ai_transport_timeout" });
    await vi.advanceTimersByTimeAsync(AI_TRANSPORT_TIMEOUT_MS + 1000);
    await assertion;
  });

  it("still returns the request url for a healthy response", async () => {
    mocks.getEndpointFetch.mockReturnValue(async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
      }) as unknown as Response,
    );

    const result = await testAIEndpoint(makeEndpoint());

    expect(result.requestUrl).toContain("chat/completions");
  });

  it("propagates endpoint errors unchanged", async () => {
    mocks.getEndpointFetch.mockReturnValue(async () =>
      ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { get: () => "application/json" },
        text: async () => "invalid api key",
      }) as unknown as Response,
    );

    await expect(testAIEndpoint(makeEndpoint())).rejects.toThrow(/401/);
  });
});
