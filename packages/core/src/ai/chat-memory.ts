import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { updateThreadMemory } from "../db/database";
import type { AIConfig, Message, Thread } from "../types";
import { createChatModel } from "./llm-provider";
import { MEMORY_COMPRESS_TIMEOUT_MS } from "./request-timeouts";

const MIN_COMPRESSIBLE_MESSAGES = 4;
const MAX_SOURCE_CHARS = 12000;
const MAX_SUMMARY_CHARS = 2400;

function messageToLine(message: Message): string {
  const role =
    message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "System";
  const content = (message.content || "").replace(/\s+/g, " ").trim().slice(0, 1600);
  return `${role}: ${content}`;
}

function buildSource(previousSummary: string | undefined, messages: Message[]): string {
  const parts: string[] = [];
  if (previousSummary?.trim()) {
    parts.push(`Existing memory:\n${previousSummary.trim()}`);
  }
  parts.push(`New older conversation:\n${messages.map(messageToLine).join("\n")}`);
  return parts.join("\n\n").slice(0, MAX_SOURCE_CHARS);
}

export function getCompressibleMessages(thread: Thread, slidingWindowSize: number): Message[] {
  const safeWindow = Math.max(2, slidingWindowSize || 8);
  // memoryMessageCount counts only user/assistant messages, so the window
  // boundary must be computed in that same space: indexing the full array
  // (which also holds the first-turn system message) shifted the slice by one
  // per system message and re-summarized messages that were already compressed.
  const rest = thread.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const systemCount = thread.messages.length - rest.length;
  // Mirror applySlidingWindow (message-pipeline.ts): system messages count
  // against the window, so only messages that really leave the prompt get
  // summarized.
  const keepFrom = Math.max(0, rest.length - Math.max(0, safeWindow - systemCount));
  const alreadySummarized = thread.memoryMessageCount || 0;
  if (keepFrom <= alreadySummarized) return [];
  return rest.slice(alreadySummarized, keepFrom);
}

export async function maybeCompressThreadMemory(
  thread: Thread,
  aiConfig: AIConfig,
  options?: { timeoutMs?: number },
): Promise<Thread> {
  const slidingWindowSize = aiConfig.slidingWindowSize || 8;
  const compressible = getCompressibleMessages(thread, slidingWindowSize);
  if (compressible.length < MIN_COMPRESSIBLE_MESSAGES) return thread;

  try {
    const model = await createChatModel(aiConfig, {
      temperature: 0.2,
      maxTokens: 700,
      streaming: false,
    });

    const source = buildSource(thread.memorySummary, compressible);
    // Compression runs BEFORE the stream starts, so the streaming watchdog
    // cannot cover it — a hung request here leaves the UI "thinking" with
    // nothing to watch. Failing is fail-open (this round simply loses its
    // memory update), so a short budget is the safe trade.
    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? MEMORY_COMPRESS_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Race rather than rely on the abort alone, so the budget holds even if the
    // transport ignores the signal; abort() runs alongside as cleanup.
    const budget = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Thread memory compression exceeded ${timeoutMs}ms`));
      }, timeoutMs);
    });
    let summary: string;
    try {
      const response = await Promise.race([
        model.invoke(
          [
            new SystemMessage(
              [
                "You compress chat history for a reading assistant.",
                "Produce durable memory only: user preferences, decisions, book-specific facts already established, unresolved tasks, and useful context for future replies.",
                "Do not include filler conversation. Keep it concise, neutral, and in the user's language when clear.",
              ].join("\n"),
            ),
            new HumanMessage(source),
          ],
          { signal: controller.signal },
        ),
        budget,
      ]);

      const content =
        typeof response.content === "string"
          ? response.content
          : Array.isArray(response.content)
            ? response.content
                .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
                .join("\n")
            : "";
      summary = content.trim().slice(0, MAX_SUMMARY_CHARS);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!summary) return thread;

    const memoryMessageCount = (thread.memoryMessageCount || 0) + compressible.length;
    await updateThreadMemory(thread.id, summary, memoryMessageCount);
    return {
      ...thread,
      memorySummary: summary,
      memoryUpdatedAt: Date.now(),
      memoryMessageCount,
    };
  } catch (error) {
    console.warn("[chat-memory] Failed to compress thread memory:", error);
    return thread;
  }
}
