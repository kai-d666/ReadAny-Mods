import type { Message } from "../types";
import { getDB, getDeviceId, nextSyncVersion, parseJSON } from "./db-core";

export async function getMessages(threadId: string): Promise<Message[]> {
  const database = await getDB();
  const rows = await database.select<{
    id: string;
    thread_id: string;
    role: string;
    content: string;
    citations: string | null;
    tool_calls: string | null;
    reasoning: string | null;
    parts_order: string | null;
    total_tokens: number | null;
    created_at: number;
  }>("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC", [threadId]);
  return rows.map((r) => ({
    id: r.id,
    threadId: r.thread_id,
    role: r.role as Message["role"],
    content: r.content,
    citations: parseJSON(r.citations, undefined),
    toolCalls: parseJSON(r.tool_calls, undefined),
    reasoning: parseJSON(r.reasoning, undefined),
    partsOrder: parseJSON(r.parts_order, undefined),
    totalTokens: r.total_tokens ?? undefined,
    createdAt: r.created_at,
  }));
}

export async function insertMessage(message: Message): Promise<void> {
  const database = await getDB();
  const deviceId = await getDeviceId();
  const syncVersion = await nextSyncVersion(database, "messages");
  await database.execute(
    "INSERT INTO messages (id, thread_id, role, content, citations, tool_calls, reasoning, parts_order, total_tokens, created_at, sync_version, last_modified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      message.id,
      message.threadId,
      message.role,
      message.content,
      message.citations ? JSON.stringify(message.citations) : null,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.reasoning ? JSON.stringify(message.reasoning) : null,
      (message as any).partsOrder ? JSON.stringify((message as any).partsOrder) : null,
      message.totalTokens ?? null,
      message.createdAt,
      syncVersion,
      deviceId,
    ],
  );
}
