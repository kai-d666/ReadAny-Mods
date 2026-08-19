import { getPlatformService } from "../services/platform";

export interface RemoteEmbeddingModel {
  url: string;
  modelId: string;
  apiKey: string;
}

export type RemoteEmbeddingBatchResult =
  | { ok: true; embeddings: number[][] }
  | { ok: false; status: number; errorText: string };

export type RemoteEmbeddingFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RemoteEmbeddingBatchOptions {
  fetchImpl?: RemoteEmbeddingFetch;
  maxCharsPerInput?: number;
}

interface OpenAIEmbeddingItem {
  embedding: number[];
  index: number;
}

export async function requestRemoteEmbeddingBatch(
  model: RemoteEmbeddingModel,
  inputTexts: string[],
  options: RemoteEmbeddingBatchOptions = {},
): Promise<RemoteEmbeddingBatchResult> {
  const isOllama = isOllamaEmbeddingUrl(model.url);
  const maxCharsPerInput = options.maxCharsPerInput;
  const safeTexts =
    typeof maxCharsPerInput === "number" && maxCharsPerInput > 0
      ? inputTexts.map((text) =>
          text.length > maxCharsPerInput ? text.slice(0, maxCharsPerInput) : text,
        )
      : inputTexts;
  const requestBody = isOllama
    ? { model: model.modelId, input: safeTexts }
    : {
        input: safeTexts,
        model: model.modelId,
        encoding_format: "float",
      };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (model.apiKey.trim()) {
    headers.Authorization = `Bearer ${model.apiKey}`;
  }

  const fetchImpl = options.fetchImpl ?? getRemoteEmbeddingFetch();
  const body = JSON.stringify(requestBody);

  // 网络层错误(status 0 / 连接被重置)重试:免费 embedding API 对连续请求
  // 有限流,服务端直接断连(而不是返回 4xx),瞬时重试即可通过;4xx 由
  // 调用方做逐 chunk 降级,这里只兜网络层
  const MAX_NETWORK_RETRIES = 3;
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetchImpl(model.url, {
        method: "POST",
        headers,
        body,
      });
      if (attempt > 0) {
        console.log(
          `[RemoteEmbedding] recovered after ${attempt + 1} attempt(s)`,
        );
      }
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // warn 而非 error:限流是瞬时的,重试可恢复,不该触发 LogBox 弹窗
      console.warn(
        `[RemoteEmbedding] fetch failed (attempt ${attempt + 1}/${MAX_NETWORK_RETRIES}): ${message}`,
      );
      if (attempt >= MAX_NETWORK_RETRIES) throw err;
      const delay = 800 * (attempt + 1); // 800ms / 1600ms / 2400ms
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    return { ok: false, status: response.status, errorText };
  }

  const json = await response.json();
  return {
    ok: true,
    embeddings: parseRemoteEmbeddingResponse(json, isOllama),
  };
}

export function isOllamaEmbeddingUrl(url: string): boolean {
  return url.replace(/\/$/, "").endsWith("/api/embed");
}

function getRemoteEmbeddingFetch(): RemoteEmbeddingFetch {
  try {
    const platform = getPlatformService();
    return (url, init) => platform.fetch(url, init);
  } catch {
    return (url, init) => globalThis.fetch(url, init);
  }
}

function parseRemoteEmbeddingResponse(json: unknown, isOllama: boolean): number[][] {
  if (isOllama) {
    const embeddings = (json as { embeddings?: number[][] })?.embeddings;
    return Array.isArray(embeddings) ? embeddings : [];
  }

  const data = (json as { data?: OpenAIEmbeddingItem[] })?.data;
  if (!Array.isArray(data)) return [];

  return data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}
