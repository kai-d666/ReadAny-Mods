import i18n from "i18next";
/**
 * AI Streaming service — handles streaming chat completions
 * Uses LangGraph reading agent for unified model support with tool calling.
 * Supports OpenAI-compatible, Anthropic Claude, and Google Gemini providers.
 */
import type { AIChatMode, AIConfig, Book, Skill, Thread } from "../types";
import { streamReadingAgent } from "./agents/reading-agent";
import {
  STREAM_FIRST_EVENT_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  STREAM_TOOL_IDLE_TIMEOUT_MS,
  StreamTimeoutError,
} from "./request-timeouts";
import { processMessages } from "./message-pipeline";
import { getToolResultError } from "./tool-result";
import type { ToolDefinition } from "./tools/tool-types";

export interface StreamingOptions {
  thread: Thread;
  book: Book | null;
  bookId?: string | null;
  enabledSkills: Skill[];
  isVectorized: boolean;
  aiConfig: AIConfig;
  deepThinking?: boolean;
  spoilerFree?: boolean;
  /** Lite-mode flag: fast direct-chat path (passed through to the reading agent). */
  chatMode?: AIChatMode;
  /** User-enabled choice items per mode (resolveModeTools in ai/tools). */
  toolPrefs?: { lite?: string[]; knowledge?: string[] };
  /** Stream watchdog budgets — tests inject small values instead of fake timers. */
  timeouts?: { firstEventMs?: number; idleMs?: number; toolIdleMs?: number };
  /** Dev flag: stream the answer body live instead of buffering each model turn. */
  liveAnswerStreaming?: boolean;
  /** Injected tool provider */
  getAvailableTools: (options: {
    bookId: string | null;
    isVectorized: boolean;
    enabledSkills: Skill[];
  }) => ToolDefinition[];
  onToken: (token: string) => void;
  /** Emitted per completed LLM call with its total token usage (prompt+completion)
   *  and how many tool calls that call produced (0 = pure reasoning/reply). */
  onLlmUsage?: (totalTokens: number, toolCalls: number) => void;
  onComplete: (
    fullText: string,
    toolCalls?: Array<{
      name: string;
      args: Record<string, unknown>;
      result?: unknown;
      error?: string;
    }>,
  ) => void;
  onAbort?: (
    fullText: string,
    toolCalls?: Array<{
      name: string;
      args: Record<string, unknown>;
      result?: unknown;
      error?: string;
    }>,
  ) => void;
  onError: (error: Error) => void;
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, result: unknown) => void;
  onReasoning?: (
    content: string,
    type?: "thinking" | "planning" | "analyzing" | "deciding",
  ) => void;
  onCitation?: (citation: {
    id: string;
    bookId: string;
    chapterTitle: string;
    chapterIndex: number;
    cfi: string;
    text: string;
    citationIndex?: number;
  }) => void;
}

export class StreamingChat {
  private abortController: AbortController | null = null;

  async stream(options: StreamingOptions): Promise<void> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const messages = processMessages(options.thread, {
      slidingWindowSize: options.aiConfig.slidingWindowSize,
    });

    const userInput = messages[messages.length - 1]?.content || "";
    const history = messages.slice(0, -1).map((m) => ({
      // system messages (first-turn book info) pass through to the agent,
      // which merges them into the system prompt prefix.
      role: m.role,
      content: m.content,
      reasoning: m.reasoning,
    }));

    // Declared before the try so the catch below can still report the partial
    // text / tool calls when a stream error races an abort.
    let fullText = "";
    let firstEventSeen = false;
    const toolCalls: Array<{
      name: string;
      args: Record<string, unknown>;
      result?: unknown;
      error?: string;
    }> = [];
    const firstEventMs = options.timeouts?.firstEventMs ?? STREAM_FIRST_EVENT_TIMEOUT_MS;
    const idleMs = options.timeouts?.idleMs ?? STREAM_IDLE_TIMEOUT_MS;
    const toolIdleMs = options.timeouts?.toolIdleMs ?? STREAM_TOOL_IDLE_TIMEOUT_MS;

    try {
      const stream = streamReadingAgent(
        {
          aiConfig: options.aiConfig,
          book: options.book,
          bookId: options.book?.id || options.bookId || options.thread.bookId || null,
          enabledSkills: options.enabledSkills,
          isVectorized: options.isVectorized,
          deepThinking: options.deepThinking,
          spoilerFree: options.spoilerFree,
          memorySummary: options.thread.memorySummary,
          chatMode: options.chatMode,
          toolPrefs: options.toolPrefs ?? options.aiConfig.toolPrefs,
          getAvailableTools: options.getAvailableTools,
          liveAnswerStreaming: options.liveAnswerStreaming,
          signal,
        },
        userInput,
        history,
      );

      // Helper to race iterator next() against the abort signal AND the idle
      // watchdog. A budget expiry resolves with a sentinel instead of throwing:
      // every `signal.aborted` branch below means "user stopped", and the
      // trailing "tool call incomplete" check means "stream ended" — a thrown
      // timeout would be misreported as one of those.
      type RaceResult = IteratorResult<unknown> & { timedOut?: boolean; budgetMs?: number };
      const raceNext = async (iterator: AsyncIterator<unknown>): Promise<RaceResult> => {
        if (signal.aborted) {
          return { done: true, value: undefined };
        }
        // A pending tool call legitimately silences the stream while it runs
        // (longest tool budget is 60s), so it gets its own allowance.
        const budgetMs = toolCalls.some((tc) => tc.result === undefined)
          ? toolIdleMs
          : firstEventSeen
            ? idleMs
            : firstEventMs;
        let onAbort: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const abortPromise = new Promise<RaceResult>((resolve) => {
          const handler = () => {
            signal.removeEventListener("abort", handler);
            resolve({ done: true, value: undefined });
          };
          onAbort = handler;
          signal.addEventListener("abort", handler);
        });
        const timeoutPromise = new Promise<RaceResult>((resolve) => {
          timer = setTimeout(
            () => resolve({ done: true, value: undefined, timedOut: true, budgetMs }),
            budgetMs,
          );
        });
        try {
          return await Promise.race([iterator.next(), abortPromise, timeoutPromise]);
        } finally {
          // iterator.next() usually wins. Remove its unused abort listener and
          // timer so a long conversation does not accumulate one per event.
          if (timer) clearTimeout(timer);
          if (onAbort) signal.removeEventListener("abort", onAbort);
        }
      };

      const iterator = stream[Symbol.asyncIterator]();
      const reportTimeout = (budgetMs: number): void => {
        // Kill the underlying request first (signal forwarding makes it real),
        // then settle the caller with a localized message.
        this.abortController?.abort();
        void iterator.return?.(undefined).catch(() => {});
        const seconds = Math.round(budgetMs / 1000);
        options.onError(
          new StreamTimeoutError(
            i18n.t("streaming.timeout", {
              seconds,
              defaultValue:
                `The AI request timed out (no response for ${seconds}s). ` +
                "Check your network or the AI endpoint, then send your question again.",
            }),
          ),
        );
      };
      let eventResult = await raceNext(iterator);
      if (eventResult.timedOut) {
        reportTimeout(eventResult.budgetMs ?? firstEventMs);
        return;
      }
      firstEventSeen = true;

      while (!eventResult.done) {
        const event = eventResult.value as any;

        if (signal.aborted) {
          options.onAbort?.(fullText, toolCalls.length > 0 ? toolCalls : undefined);
          return;
        }

        switch (event.type) {
          case "token":
            fullText += event.content;
            options.onToken(event.content);
            break;

          case "llm_usage":
            options.onLlmUsage?.(event.totalTokens, event.toolCalls);
            break;

          case "tool_call":
            options.onToolCall?.(event.name, event.args);
            toolCalls.push({ name: event.name, args: event.args });
            break;

          case "tool_result": {
            options.onToolResult?.(event.name, event.result);
            const existingTc = [...toolCalls]
              .reverse()
              .find((tc) => tc.name === event.name && tc.result === undefined);
            if (existingTc) {
              existingTc.result = event.result;
              existingTc.error = getToolResultError(event.result) || undefined;
            }
            break;
          }

          case "reasoning":
            options.onReasoning?.(event.content, event.stepType);
            break;

          case "citation":
            options.onCitation?.(event.citation);
            break;

          case "error":
            options.onError(new Error(event.error));
            return;
        }

        eventResult = await raceNext(iterator);
        if (eventResult.timedOut) {
          reportTimeout(eventResult.budgetMs ?? idleMs);
          return;
        }
      }

      // If loop exited due to abort, call onAbort
      if (signal.aborted) {
        options.onAbort?.(fullText, toolCalls.length > 0 ? toolCalls : undefined);
      } else {
        const incompleteToolCalls = toolCalls.filter((toolCall) => toolCall.result === undefined);
        if (incompleteToolCalls.length > 0) {
          options.onError(
            new Error(
              "The response stream ended before its tool call completed. Please try again.",
            ),
          );
          return;
        }
        options.onComplete(fullText, toolCalls.length > 0 ? toolCalls : undefined);
      }
    } catch (error) {
      if (signal.aborted) {
        // Defensive: an error surfacing while aborted must still settle the
        // caller. stopStream() only calls abort() and the session is cleared
        // exclusively by these callbacks, so returning silently would leave
        // isStreaming=true and block every later send in this thread.
        options.onAbort?.(fullText, toolCalls.length > 0 ? toolCalls : undefined);
        return;
      }
      console.error("[StreamingChat] Error:", error);
      if (error instanceof Error) {
        console.error("[StreamingChat] Stack:", error.stack);
      }
      options.onError(error as Error);
    }
  }

  abort(): void {
    this.abortController?.abort();
  }
}

export function createMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
