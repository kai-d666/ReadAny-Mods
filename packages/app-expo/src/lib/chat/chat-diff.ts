/**
 * chat-diff — RN → WebView 命令计算的纯函数(无 react-native 依赖,可单测)。
 *
 * 策略:RN 每轮把 messages 快照 diff 成最小命令集发送给 webview:
 *  - 首挂/切会话 → clear + 逐条 upsertMessage(避免大 JSON 单次注入,也
 *    符合 webview "逐条插入" 的健壮性;大会话 100 条 ≈ 200KB 分 100 个小包)
 *  - running text/reasoning 文本变长 → streamUpdate(delta 追加)
 *  - part 指纹变化(status/tokens/result/error)→ upsertMessage 整条替换
 *  - step/isStreaming 变化 → setStreaming(与消息 diff 独立)
 */
import type { MessageV2 } from "@readany/core/types/message";

export type StreamingStep = "thinking" | "tool_calling" | "responding" | "idle";

export interface SerializablePart {
  id: string;
  type: string;
  status: string;
  createdAt?: number;
  text?: string;
  tokens?: number | null;
  thinkingType?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  reasoning?: string;
  notice?: string;
  bookId?: string;
  chapterTitle?: string;
  chapterIndex?: number;
  cfi?: string;
  citationIndex?: number;
  source?: string;
  title?: string;
  markdown?: string;
  chart?: string;
  reason?: string;
}

export interface SerializableMessage {
  id: string;
  threadId: string;
  role: string;
  createdAt: number;
  parts: SerializablePart[];
}

export type ChatCommand =
  | { type: "clear" }
  | { type: "renderAll"; messages: SerializableMessage[] }
  | { type: "addBatch"; messages: SerializableMessage[] }
  | { type: "upsertMessage"; message: SerializableMessage }
  | {
      type: "streamUpdate";
      messageId: string;
      partId: string;
      delta: string;
      status: string;
      step: StreamingStep;
    }
  | { type: "setStreaming"; isStreaming: boolean; step: StreamingStep }
  | { type: "setTheme"; vars: Record<string, string> }
  | { type: "setUi"; bottomPad: number }
  | { type: "setLocale"; strings: Record<string, string>; toolLabels: Record<string, string> }
  | { type: "scrollToBottom"; animated?: boolean }
  | { type: "ping" };

export interface DiffPartState {
  fingerprint: string;
  textLen: number;
}

export interface DiffMessageState {
  byPart: Map<string, DiffPartState>;
}

export interface DiffState {
  threadKey: string | null;
  step: StreamingStep;
  isStreaming: boolean;
  byMessage: Map<string, DiffMessageState>;
}

export function createEmptyDiffState(): DiffState {
  return { threadKey: null, step: "idle", isStreaming: false, byMessage: new Map() };
}

/** 根据 next 计算命令并返回新 DiffState(纯函数,不 mutate prev) */
export function computeChatCommands(
  prev: DiffState | null,
  next: { messages: MessageV2[]; isStreaming: boolean; step: StreamingStep },
): { commands: ChatCommand[]; state: DiffState } {
  const commands: ChatCommand[] = [];
  const messages = next.messages;
  const threadKey = messages[0]?.threadId ?? messages[0]?.id ?? null;

  // 空会话 → clear(不保留上一会话渲染)
  if (messages.length === 0) {
    commands.push({ type: "clear" });
    return { commands, state: createEmptyDiffState() };
  }

  // 首挂/切会话 → 先清空,再整批注入(addBatch 单命令跨桥,
  // 避免逐条 postMessage 的 JNI 桥调用(200 条 ≈ 1s 主线程阻塞))
  if (!prev || prev.threadKey !== threadKey) {
    commands.push({ type: "clear" });
    commands.push({ type: "addBatch", messages: messages.map(serializeMessage) });
    return {
      commands,
      state: {
        threadKey,
        step: next.step,
        isStreaming: next.isStreaming,
        byMessage: buildDiffMessages(messages),
      },
    };
  }

  const state: DiffState = {
    threadKey,
    step: prev.step,
    isStreaming: prev.isStreaming,
    byMessage: new Map(),
  };

  for (const m of messages) {
    const prevMsg = prev.byMessage.get(m.id);
    const nextMsgParts = buildDiffParts(m);

    if (!prevMsg) {
      // 新消息 → 整条
      commands.push({ type: "upsertMessage", message: serializeMessage(m) });
    } else {
      let needsUpsert = false;
      for (const [partId, partState] of nextMsgParts.byPart) {
        const prevPart = prevMsg.byPart.get(partId);
        if (!prevPart) {
          needsUpsert = true; // 新 part
          break;
        }
        // 指纹=status+tokens(+工具结果/错误长度):不含文本长度
        // (running 文本变长 = 流式增量,走 streamUpdate 而非重建)
        if (prevPart.fingerprint !== partState.fingerprint) {
          needsUpsert = true;
          break;
        }
      }
      if (!needsUpsert && nextMsgParts.byPart.size !== prevMsg.byPart.size) {
        needsUpsert = true;
      }
      if (needsUpsert) {
        commands.push({ type: "upsertMessage", message: serializeMessage(m) });
      } else {
        // 流式增量:仅当 running text/reasoning 变长 → streamUpdate(delta)
        for (const [partId, partState] of nextMsgParts.byPart) {
          const prevPart = prevMsg.byPart.get(partId);
          if (!prevPart) continue;
          if (
            (partState.partType === "text" || partState.partType === "reasoning") &&
            partState.status === "running" &&
            partState.textLen > prevPart.textLen
          ) {
            const part = m.parts.find((p) => p.id === partId);
            const fullText = (part?.type === "text" || part?.type === "reasoning" ? part.text : "") || "";
            commands.push({
              type: "streamUpdate",
              messageId: m.id,
              partId,
              delta: fullText.slice(prevPart.textLen),
              status: partState.status,
              step: next.step,
            });
            break; // 一条消息一轮至多一条 streamUpdate
          }
        }
      }
      state.byMessage.set(m.id, nextMsgParts);
    }
  }

  // step/isStreaming 独立变化
  if (prev.step !== next.step || prev.isStreaming !== next.isStreaming) {
    commands.push({
      type: "setStreaming",
      isStreaming: next.isStreaming,
      step: next.step,
    });
  }
  state.step = next.step;
  state.isStreaming = next.isStreaming;

  return { commands, state };
}

interface DiffPartsResult {
  byPart: Map<string, DiffPartState & { partType: string; status: string }>;
}

function buildDiffParts(m: MessageV2): DiffPartsResult {
  const byPart = new Map<string, DiffPartState & { partType: string; status: string }>();
  for (const p of m.parts) {
    const base = { partType: p.type, status: p.status };
    if (p.type === "text" || p.type === "reasoning") {
      const text = (p as { text?: string }).text ?? "";
      byPart.set(p.id, {
        ...base,
        fingerprint: `${p.status}|${(p as { tokens?: number | null }).tokens ?? ""}`,
        textLen: text.length,
      });
    } else if (p.type === "tool_call") {
      const tc = p as { status: string; tokens?: number | null; error?: string; result?: unknown; notice?: string };
      let resultLen = 0;
      try {
        resultLen = (JSON.stringify(tc.result) || "").length;
      } catch {
        resultLen = 0;
      }
      byPart.set(p.id, {
        ...base,
        fingerprint: `${p.status}|${tc.tokens ?? ""}|${tc.error?.length ?? 0}|${resultLen}|${tc.notice?.length ?? 0}`,
        textLen: 0,
      });
    } else {
      byPart.set(p.id, { ...base, fingerprint: `${p.status}`, textLen: 0 });
    }
  }
  return { byPart };
}

function buildDiffMessages(messages: MessageV2[]): Map<string, DiffMessageState> {
  const map = new Map<string, DiffMessageState>();
  for (const m of messages) {
    map.set(m.id, buildDiffParts(m) as unknown as DiffMessageState);
  }
  return map;
}

/** MessageV2 → SerialaziableMessage(按 part type 裁剪字段,只发 webview 需要的) */
export function serializeMessage(m: MessageV2): SerializableMessage {
  return {
    id: m.id,
    threadId: m.threadId,
    role: m.role,
    createdAt: m.createdAt,
    parts: m.parts.map(serializePart),
  };
}

function serializePart(p: MessageV2["parts"][number]): SerializablePart {
  const base: SerializablePart = { id: p.id, type: p.type, status: p.status };
  switch (p.type) {
    case "text": {
      const t = p as { text: string; tokens?: number | null };
      return { ...base, text: t.text, tokens: t.tokens ?? null };
    }
    case "reasoning": {
      const r = p as { text: string; thinkingType?: string; tokens?: number | null };
      return { ...base, text: r.text, thinkingType: r.thinkingType, tokens: r.tokens ?? null };
    }
    case "tool_call": {
      const t = p as {
        name: string;
        args: Record<string, unknown>;
        result?: unknown;
        error?: string;
        reasoning?: string;
        notice?: string;
        tokens?: number | null;
      };
      return {
        ...base,
        name: t.name,
        args: t.args,
        result: t.result,
        error: t.error,
        reasoning: t.reasoning,
        notice: t.notice,
        tokens: t.tokens ?? null,
      };
    }
    case "citation": {
      const c = p as {
        bookId: string;
        chapterTitle?: string;
        chapterIndex?: number;
        cfi?: string;
        text?: string;
        citationIndex?: number;
      };
      return {
        ...base,
        bookId: c.bookId,
        chapterTitle: c.chapterTitle,
        chapterIndex: c.chapterIndex,
        cfi: c.cfi,
        text: c.text,
        citationIndex: c.citationIndex,
      };
    }
    case "quote": {
      const q = p as { text: string; source?: string; cfi?: string };
      return { ...base, text: q.text, source: q.source, cfi: q.cfi };
    }
    case "mindmap": {
      const mm = p as { title: string; markdown: string };
      return { ...base, title: mm.title, markdown: mm.markdown };
    }
    case "mermaid": {
      const mm = p as { title?: string; chart: string };
      return { ...base, title: mm.title, chart: mm.chart };
    }
    case "aborted": {
      const a = p as { reason: string };
      return { ...base, reason: a.reason };
    }
    default:
      return base;
  }
}

/** injectJavaScript 安全转义(U+2028/2029 会破坏 JS 字面量) */
export function escapeForInject(s: string): string {
  return s
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}
