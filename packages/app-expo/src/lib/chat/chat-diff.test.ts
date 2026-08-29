import { describe, expect, it } from "vitest";
import type { MessageV2, Part } from "@readany/core/types/message";
import {
  computeChatCommands,
  createEmptyDiffState,
  escapeForInject,
  serializeMessage,
} from "./chat-diff";

function textPart(id: string, text: string, status: Part["status"] = "completed", tokens?: number): Part {
  return {
    id,
    type: "text",
    status,
    text,
    createdAt: 1,
    ...(tokens != null ? { tokens } : {}),
  } as Part;
}

function msg(id: string, parts: Part[], roleMessage: MessageV2["role"] = "assistant"): MessageV2 {
  return { id, threadId: "t1", role: roleMessage, parts, createdAt: 1 } as MessageV2;
}

describe("computeChatCommands", () => {
  it("① 首挂 → clear + addBatch(整批一条命令)", () => {
    const msgs = [msg("m1", [textPart("p1", "hi")]), msg("m2", [textPart("p2", "你好")])];
    const { commands, state } = computeChatCommands(null, {
      messages: msgs,
      isStreaming: false,
      step: "idle",
    });
    expect(commands.map((c) => c.type)).toEqual(["clear", "addBatch"]);
    if (commands[1]?.type === "addBatch") {
      expect(commands[1].messages.length).toBe(2);
    }
    expect(state.threadKey).toBe("t1");
    expect(state.byMessage.size).toBe(2);
  });

  it("② 流式两批 append → 各发一条 streamUpdate,delta 拼接=全文无重漏", () => {
    const m = msg("m1", [textPart("p1", "正在输出123", "running")]);
    const r1 = computeChatCommands(null, { messages: [m], isStreaming: true, step: "responding" });
    const updated = msg("m1", [textPart("p1", "正在输出12345678", "running")]);
    const r2 = computeChatCommands(r1.state, {
      messages: [updated],
      isStreaming: true,
      step: "responding",
    });
    const stream = r2.commands.filter((c) => c.type === "streamUpdate");
    expect(stream).toHaveLength(1);
    if (stream[0]?.type === "streamUpdate") {
      expect(stream[0].delta).toBe("45678");
    }
    // 再一批
    const updated2 = msg("m1", [textPart("p1", "正在输出1234567890", "running")]);
    const r3 = computeChatCommands(r2.state, {
      messages: [updated2],
      isStreaming: true,
      step: "responding",
    });
    const stream2 = r3.commands.filter((c) => c.type === "streamUpdate");
    if (stream2[0]?.type === "streamUpdate") {
      expect(stream2[0].delta).toBe("90");
    }
    // 无 upsert(纯增量)
    expect(r3.commands.filter((c) => c.type === "upsertMessage")).toHaveLength(0);
  });

  it("③ 新 part 出现 → upsert 整条", () => {
    const m1 = msg("m1", [textPart("p1", "思考中", "running")]);
    const r1 = computeChatCommands(null, { messages: [m1], isStreaming: true, step: "thinking" });
    const m2 = msg("m1", [
      textPart("p1", "思考中", "running"),
      { id: "p2", type: "tool_call", status: "pending", name: "ragSearch", args: {}, createdAt: 1 } as Part,
    ]);
    const r2 = computeChatCommands(r1.state, {
      messages: [m2],
      isStreaming: true,
      step: "tool_calling",
    });
    expect(r2.commands.filter((c) => c.type === "upsertMessage")).toHaveLength(1);
    expect(r2.commands.filter((c) => c.type === "streamUpdate")).toHaveLength(0);
  });

  it("④ status 变(completed)→ upsert", () => {
    const m1 = msg("m1", [textPart("p1", "完成", "running")]);
    const r1 = computeChatCommands(null, { messages: [m1], isStreaming: true, step: "responding" });
    const m2 = msg("m1", [textPart("p1", "完成", "completed")]);
    const r2 = computeChatCommands(r1.state, {
      messages: [m2],
      isStreaming: false,
      step: "idle",
    });
    expect(r2.commands.filter((c) => c.type === "upsertMessage")).toHaveLength(1);
  });

  it("⑤ token 后到 → upsert", () => {
    const m1 = msg("m1", [textPart("p1", "ok", "completed")]);
    const r1 = computeChatCommands(null, { messages: [m1], isStreaming: false, step: "idle" });
    const m2 = msg("m1", [textPart("p1", "ok", "completed", 42)]);
    const r2 = computeChatCommands(r1.state, {
      messages: [m2],
      isStreaming: false,
      step: "idle",
    });
    expect(r2.commands.filter((c) => c.type === "upsertMessage")).toHaveLength(1);
  });

  it("⑥ 切会话(threadKey 变)→ clear + 重建", () => {
    const r1 = computeChatCommands(null, {
      messages: [msg("m1", [textPart("p1", "a")])],
      isStreaming: false,
      step: "idle",
    });
    const otherThread = msg("mX", [textPart("pX", "b")]);
    const other = {
      ...otherThread,
      threadId: "t2",
    } as MessageV2;
    const r2 = computeChatCommands(r1.state, {
      messages: [other],
      isStreaming: false,
      step: "idle",
    });
    expect(r2.commands.map((c) => c.type)).toEqual(["clear", "addBatch"]);
  });

  it("⑦ 纯 step 变化 → 只 setStreaming", () => {
    const m = msg("m1", [textPart("p1", "hi")]);
    const r1 = computeChatCommands(null, { messages: [m], isStreaming: false, step: "idle" });
    const r2 = computeChatCommands(r1.state, {
      messages: [m],
      isStreaming: true,
      step: "thinking",
    });
    expect(r2.commands).toEqual([{ type: "setStreaming", isStreaming: true, step: "thinking" }]);
  });

  it("⑧ 空消息 → clear", () => {
    const r = computeChatCommands(createEmptyDiffState(), {
      messages: [],
      isStreaming: false,
      step: "idle",
    });
    expect(r.commands).toEqual([{ type: "clear" }]);
  });

  it("⑨ 会话无变化 → 零命令", () => {
    const m = msg("m1", [textPart("p1", "hi", "completed", 7)]);
    const r1 = computeChatCommands(null, { messages: [m], isStreaming: false, step: "idle" });
    const r2 = computeChatCommands(r1.state, { messages: [m], isStreaming: false, step: "idle" });
    expect(r2.commands).toHaveLength(0);
  });
});

describe("serializeMessage", () => {
  it("⑩ 按 part 类型裁剪字段", () => {
    const m = msg("m1", [
      textPart("p1", "文本", "completed", 12),
      { id: "c1", type: "citation", status: "completed", bookId: "b1", cfi: "cfi", text: "引文", citationIndex: 1 } as Part,
      { id: "q1", type: "quote", status: "completed", text: "引", source: "s", cfi: "qcfi" } as Part,
      { id: "ab1", type: "aborted", status: "completed", reason: "停止" } as Part,
    ]);
    const sv = serializeMessage(m);
    expect(sv.parts[0]).toMatchObject({ text: "文本", tokens: 12 });
    expect(sv.parts[1]).not.toHaveProperty("error");
    expect(sv.parts[1]).toMatchObject({ bookId: "b1" });
    expect(sv.parts[2]).toMatchObject({ source: "s", cfi: "qcfi" });
    expect(sv.parts[3]).toMatchObject({ reason: "停止" });
    expect(sv).not.toHaveProperty("updatedAt");
  });
});

describe("escapeForInject", () => {
  it("⑨ U+2028/2029 被转义", () => {
    const src = "a b c";
    const out = escapeForInject(src);
    expect(out).toBe("a\\u2028b\\u2029c");
    expect(out.includes(" ")).toBe(false);
  });
});
