import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingService } from "./embedding-service";

describe("EmbeddingService endpoint handling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not append embeddings twice when given a complete request URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: [{ index: 0, embedding: [0.1, 0.2] }] }),
    );
    const service = new EmbeddingService({
      model: {
        id: "text-embedding-test",
        name: "test",
        provider: "openai",
        dimensions: 2,
        maxTokens: 8192,
      },
      apiKey: "test-key",
      baseUrl: "https://example.test/api-openai/v1/embeddings",
    });

    await expect(service.embed("query")).resolves.toEqual([0.1, 0.2]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/api-openai/v1/embeddings",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("gives up on a stalled endpoint instead of blocking the search forever", async () => {
    vi.useFakeTimers();
    // A fetch that never settles AND ignores the abort signal — the real failure
    // mode on device, where the stalled embedding burned the entire 30s tool
    // budget and the BM25 half of the hybrid search never even started.
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    const service = new EmbeddingService({
      model: {
        id: "text-embedding-test",
        name: "test",
        provider: "openai",
        dimensions: 2,
        maxTokens: 8192,
      },
      apiKey: "test-key",
      baseUrl: "https://example.test/api-openai/v1/embeddings",
    });

    const pending = service.embed("query");
    const rejection = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(16_000);
    await rejection;
  });
});
