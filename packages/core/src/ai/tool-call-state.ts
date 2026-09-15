import type { Part, ReasoningPart, ToolCallPart } from "../types/message";
import { allocateReasoningTokens } from "./token-accounting";
import { getToolResultError } from "./tool-result";

export function toolCallPartToMessageToolCall(part: ToolCallPart) {
  return {
    id: part.id,
    name: part.name,
    args: part.args,
    result: part.result,
    status: part.status,
    error: part.error,
    notice: part.notice,
  };
}

export function applyToolResultToParts(
  parts: Part[],
  name: string,
  result: unknown,
  now = Date.now(),
): ToolCallPart | null {
  const part = [...parts]
    .reverse()
    .find(
      (p) =>
        p.type === "tool_call" &&
        (p as ToolCallPart).name === name &&
        (p as ToolCallPart).result === undefined,
    ) as ToolCallPart | undefined;

  if (!part) return null;

  part.result = result;
  const notice =
    result && typeof result === "object"
      ? ((result as Record<string, unknown>).attemptLimitReached
          ? (result as Record<string, unknown>).notice
          : undefined)
      : undefined;
  if (typeof notice === "string" && notice.trim()) {
    part.status = "completed";
    part.error = undefined;
    part.notice = notice;
    part.updatedAt = now;
    return part;
  }

  const toolError = getToolResultError(result);
  if (toolError) {
    part.status = "error";
    part.error = toolError;
    part.notice = undefined;
  } else {
    part.status = "completed";
    part.error = undefined;
    part.notice = undefined;
  }
  part.updatedAt = now;

  return part;
}

export function markRunningToolCallPartsAsError(
  parts: Part[],
  errorMessage: string,
  now = Date.now(),
) {
  for (const part of parts) {
    if (part.type !== "tool_call" || part.status !== "running") continue;
    part.status = "error";
    (part as ToolCallPart).error = errorMessage;
    part.updatedAt = now;
  }
}

export interface AttachTokenUsageOptions {
  /**
   * Provider-reported reasoning tokens for THIS call, if it reported any. Each
   * reasoning part gets its share of it instead of the call total; when absent
   * the parts fall back to a length estimate.
   */
  reasoningTokens?: number;
  now?: number;
}

/**
 * Retro-attach the token usage of a just-finished LLM call to the tool_call,
 * reasoning and text parts it produced.
 *
 * Ordering differs by model: streaming providers (openai/deepseek/gemini) emit
 * `tool_call` events DURING the stream, BEFORE the usage event arrives at
 * `on_chat_model_end` — so by the time usage lands, those parts already exist.
 * Non-streaming providers emit tool calls AFTER usage, which the caller handles
 * with a pending value. This helper covers the streaming ordering only.
 *
 * Force-assign (rather than skip when tokens already set): a tool part created
 * by the PREVIOUS call may have received that call's usage via the pending path;
 * once the next usage arrives it must be corrected to its own call's total.
 *
 * The three part types get DIFFERENT numbers on purpose — see `BasePart.tokens`:
 * a reasoning card shows the thinking itself, a tool card shows what the round
 * trip cost. That is why the per-answer footer reads the message's own
 * `totalTokens` rather than summing these badges.
 *
 * @param fromIndex Parts before this index belong to earlier LLM calls — untouched.
 */
export function attachTokenUsageToParts(
  parts: Part[],
  fromIndex: number,
  tokens: number,
  options: AttachTokenUsageOptions = {},
) {
  const { reasoningTokens, now = Date.now() } = options;

  const reasonings: ReasoningPart[] = [];
  for (let i = fromIndex; i < parts.length; i++) {
    if (parts[i].type === "reasoning") reasonings.push(parts[i] as ReasoningPart);
  }
  const reasoningShares = allocateReasoningTokens(
    reasoningTokens,
    reasonings.map((part) => part.text ?? ""),
  );

  let shareIndex = 0;
  for (let i = fromIndex; i < parts.length; i++) {
    const part = parts[i];
    if (part.type === "reasoning") {
      const share = reasoningShares[shareIndex++] ?? 0;
      if (share > 0) {
        part.tokens = share;
        part.updatedAt = now;
      }
    } else if (part.type === "tool_call" || part.type === "text") {
      // Text parts keep the call total because the desktop app's footer sums
      // parts — dropping it would zero out their plain-text-only turns.
      part.tokens = tokens;
      part.updatedAt = now;
    }
  }
}
