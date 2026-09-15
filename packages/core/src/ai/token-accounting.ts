/**
 * Token accounting for the assistant's three-layer ledger.
 *
 * Layer ① is the badge on a thinking card — it must describe the THINKING
 * ITSELF, which is a different quantity from the whole LLM call (prompt +
 * completion; in a book chat the prompt is the overwhelming majority). Layer ②
 * (per-answer total) and ③ (per-conversation total) live on the message and are
 * carried by `callUsages` in `use-streaming-chat` — not here.
 *
 * NOTE: `estimateTextTokens` is deliberately NOT `rag/chunker.ts`'s
 * `estimateTokens` (plain `length / 4`). That one sizes chunking and budget
 * decisions and is calibrated against a dozen call sites; this one counts
 * tokens for display and must not under-count CJK by roughly 4x. The two
 * estimators stay separate on purpose.
 */

/** CJK Extension A, CJK Unified, CJK Compatibility, kana, hangul. */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\u1100-\u11ff]/;

/** Everything else: Latin, digits, punctuation — roughly 4 characters per token. */
const CHARS_PER_TOKEN = 4;

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | undefined {
  return typeof value === "object" && value !== null ? (value as AnyRecord) : undefined;
}

/**
 * A field is only a usable count when it is a positive finite number.
 *
 * Shape checks are NOT enough here: `@langchain/openai` builds
 * `output_token_details` with `details?.x !== null`, which is true when
 * `details` is undefined — so a response that carried no reasoning still
 * arrives as `{ reasoning: undefined }`.
 */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Estimate a text's token count: CJK 1 token/char, everything else 4 chars per
 * token. Empty text is 0 so callers can skip an empty badge.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;

  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_RE.test(char)) cjk += 1;
    else other += 1;
  }

  return cjk + Math.ceil(other / CHARS_PER_TOKEN);
}

/**
 * Provider-reported reasoning ("thinking") tokens for one LLM call.
 *
 * Reading chain, most-normalised first:
 *  1. `output.usage_metadata.output_token_details.reasoning` — LangChain's
 *     normalised form; populated for OpenAI-compatible providers (DeepSeek
 *     included, it subclasses ChatOpenAI).
 *  2. `resolvedUsage.completion_tokens_details.reasoning_tokens` — the raw
 *     OpenAI-compatible field, still present inside `response_metadata.usage`.
 *  3. `output.response_metadata.usage.completion_tokens_details.reasoning_tokens`
 *     — same as 2, for callers that did not pre-resolve the usage object.
 *
 * Returns undefined when the provider does not report one (Anthropic and Google
 * GenAI never populate it); the caller estimates from the text instead. Falling
 * back to the whole call's total would be worse than an estimate — it silently
 * changes what the number means.
 */
export function readReasoningTokens(output: unknown, resolvedUsage?: unknown): number | undefined {
  const out = asRecord(output);

  const details = asRecord(asRecord(out?.usage_metadata)?.output_token_details);
  const normalised = positiveNumber(details?.reasoning);
  if (normalised != null) return normalised;

  const resolved = positiveNumber(
    asRecord(asRecord(resolvedUsage)?.completion_tokens_details)?.reasoning_tokens,
  );
  if (resolved != null) return resolved;

  const rawUsage = asRecord(asRecord(out?.response_metadata)?.usage);
  return positiveNumber(asRecord(rawUsage?.completion_tokens_details)?.reasoning_tokens);
}

/**
 * Split one call's reported reasoning tokens across the reasoning parts it
 * produced (a single call can emit several).
 *
 * Shares are allocated in proportion to estimated length, with the rounding
 * remainder given to the longest part, so they always sum back to exactly
 * `reported` — no tokens invented, none lost. Empty parts get 0 and the caller
 * skips their badge.
 *
 * With no reported total, each part falls back to its own estimate: same
 * meaning, lower precision.
 */
export function allocateReasoningTokens(reported: number | undefined, texts: string[]): number[] {
  const estimates = texts.map((text) => estimateTextTokens(text));
  if (reported == null || reported <= 0) return estimates;

  const total = estimates.reduce((sum, n) => sum + n, 0);
  if (total === 0) return estimates;

  const shares = estimates.map((n) =>
    n === 0 ? 0 : Math.max(1, Math.floor((reported * n) / total)),
  );

  const drift = reported - shares.reduce((sum, n) => sum + n, 0);
  if (drift !== 0) {
    let biggest = -1;
    for (let i = 0; i < estimates.length; i++) {
      if (estimates[i] > 0 && (biggest < 0 || estimates[i] > estimates[biggest])) biggest = i;
    }
    if (biggest >= 0) shares[biggest] = Math.max(1, shares[biggest] + drift);
  }

  return shares;
}
