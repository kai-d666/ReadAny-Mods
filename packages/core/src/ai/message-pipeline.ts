/**
 * Message processing pipeline
 * - Citation reference injection
 * - 8-message sliding window
 * - Context assembly
 */
import type { Message, SemanticContext, Thread } from "../types";
import type { Book, Skill } from "../types";
import { buildSystemPrompt } from "./system-prompt";

interface PipelineConfig {
  slidingWindowSize: number; // default 8
}

interface PipelineContext {
  book: Book | null;
  bookId?: string | null;
  semanticContext: SemanticContext | null;
  enabledSkills: Skill[];
  isVectorized: boolean;
  userLanguage: string;
  memorySummary?: string;
}

export interface ProcessedMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** DeepSeek reasoning_content — needed for multi-turn tool-calling with reasoner models */
  reasoning?: string;
}

interface ProcessedMessages {
  systemPrompt: string;
  messages: ProcessedMessage[];
}

const DEFAULT_CONFIG: PipelineConfig = {
  slidingWindowSize: 8,
};

/** Process a thread into messages ready for AI API call */
export function processMessages(
  thread: Thread,
  context: PipelineContext,
  config: PipelineConfig = DEFAULT_CONFIG,
): ProcessedMessages {
  const systemPrompt = buildSystemPrompt(context);

  // Apply sliding window — keep last N user/assistant messages; system messages
  // (thread's first-turn book info) are pinned and always stay.
  const windowedMessages = applySlidingWindow(thread.messages, config.slidingWindowSize);

  // Process citations in messages, preserving reasoning for DeepSeek multi-turn.
  // System messages carry the static book info — they flow through as-is.
  const processed: ProcessedMessage[] = windowedMessages.map((m) => {
    const msg: ProcessedMessage = {
      role: m.role,
      content: injectCitations(m),
    };
    // Preserve reasoning content for assistant messages (needed by DeepSeek reasoner)
    if (m.role === "assistant" && m.reasoning && m.reasoning.length > 0) {
      msg.reasoning = m.reasoning.map((r) => r.content).join("\n");
    }
    return msg;
  });

  return { systemPrompt, messages: processed };
}

/**
 * Apply sliding window — keep system messages (first-turn book info) at the
 * front + last N user/assistant messages.
 */
function applySlidingWindow(messages: Message[], windowSize: number): Message[] {
  if (messages.length <= windowSize) return messages;
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  return [...system, ...rest.slice(-Math.max(0, windowSize - system.length))];
}

/** Inject citation references into message content */
function injectCitations(message: Message): string {
  if (!message.citations || message.citations.length === 0) {
    return message.content;
  }

  let content = message.content;
  for (const citation of message.citations) {
    // Append citation references at the end
    content += `\n\n> [${citation.chapterTitle}]: "${citation.text}"`;
  }
  return content;
}
