/**
 * Central AI request budgets — one place to tune, and injectable so tests do
 * not need fake timers.
 *
 * Layer map:
 * - `STREAM_*`        → user-facing event watchdog in `ai/streaming.ts`
 * - `AI_HEADERS_*`    → transport guard in `ai/llm-provider.ts` (headers only;
 *                       the response body is deliberately NOT wrapped)
 * - `MEMORY_COMPRESS` → `ai/chat-memory.ts`, which runs before the stream starts
 */

/** First event (token / reasoning / tool) must arrive within this budget. */
export const STREAM_FIRST_EVENT_TIMEOUT_MS = 90_000;
/** Gap allowed between two events once the stream is running. */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;
/** Same as idle, but while a tool call is still pending (longest tool is 60s). */
export const STREAM_TOOL_IDLE_TIMEOUT_MS = 150_000;
/** Transport fallback: response headers must arrive within this budget. */
export const AI_HEADERS_TIMEOUT_MS = 120_000;
/** Thread-memory compression runs before the first token; failure is fail-open. */
export const MEMORY_COMPRESS_TIMEOUT_MS = 25_000;
/**
 * User-triggered, non-streaming calls from the settings screen (endpoint test,
 * model list). Bounds headers AND body — the guard in llm-provider.ts only
 * covers the wait for response headers.
 */
export const AI_TRANSPORT_TIMEOUT_MS = 15_000;

export class StreamTimeoutError extends Error {
  readonly code = "stream_timeout";
  constructor(message: string) {
    super(message);
    this.name = "StreamTimeoutError";
  }
}

export class AIHeadersTimeoutError extends Error {
  readonly code = "ai_request_headers_timeout";
  constructor(message: string) {
    super(message);
    this.name = "AIHeadersTimeoutError";
  }
}

export class AITransportTimeoutError extends Error {
  readonly code = "ai_transport_timeout";
  constructor(message: string) {
    super(message);
    this.name = "AITransportTimeoutError";
  }
}

/**
 * Bound a non-streaming request including its body read. The returned promise
 * always settles: the run gets an AbortSignal for cooperative cancellation,
 * and the budget rejects regardless of whether the transport honours it.
 */
export async function withTransportBudget<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options?: { timeoutMs?: number; label?: string },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? AI_TRANSPORT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new AITransportTimeoutError(
          `${options?.label ?? "AI request"} timed out after ${Math.round(timeoutMs / 1000)}s.`,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
