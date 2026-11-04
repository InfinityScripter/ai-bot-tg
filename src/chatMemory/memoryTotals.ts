import type { ConversationMemory } from "./types.js";

/** /memory totals over every connected group; the first group error wins. Null when off. */
export function memoryTotals(memory: ConversationMemory | undefined, chatIds: number[]) {
  if (!memory || chatIds.length === 0) return null;
  const statuses = chatIds.map((chatId) => memory.status(chatId));
  const sum = (key: "messages" | "notes" | "opinions" | "pending") =>
    statuses.reduce((total, status) => total + status[key], 0);
  return {
    groups: chatIds.length,
    messages: sum("messages"),
    notes: sum("notes"),
    opinions: sum("opinions"),
    pending: sum("pending"),
    lastError: statuses.find((status) => status.lastError)?.lastError ?? null,
  };
}
