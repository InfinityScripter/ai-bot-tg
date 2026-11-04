import { createConversationMemory } from "./createConversationMemory.js";

import type { GroupMemory } from "./createConversationMemory.js";
import type { MemoryDeps, MemoryStatus, ConversationMemory } from "./types.js";

/**
 * Memory for every group the bots answer in. Each group keeps its own messages,
 * reflection and /avatar clear: Telegram message ids are per chat, so one shared
 * message table would mix threads. What is shared is the conclusions: every
 * group's context also carries the notes and positions the bots formed in the
 * other groups, so they stay consistent across chats.
 */
export function createSharedMemory(
  deps: Omit<MemoryDeps, "chatId" | "peers">,
  chatIds: number[],
): ConversationMemory {
  const groups = new Map<number, GroupMemory>();
  let closed = false;
  try {
    for (const chatId of new Set(chatIds)) {
      groups.set(
        chatId,
        createConversationMemory({
          ...deps,
          chatId,
          peers: () => [...groups].filter(([id]) => id !== chatId).map(([, group]) => group.repo),
        }),
      );
    }
  } catch (error) {
    // A half-opened set must not keep its first connections alive.
    for (const group of groups.values()) group.close();
    throw error;
  }
  const idle: MemoryStatus = {
    epoch: 0,
    messages: 0,
    notes: 0,
    opinions: 0,
    pending: 0,
    lastError: null,
  };
  return {
    observe: (message) => groups.get(message.chatId)?.observe(message),
    message: (chatId, messageId) => groups.get(chatId)?.message(chatId, messageId) ?? null,
    hasReply: (chatId, side, rootMessageId) =>
      groups.get(chatId)?.hasReply(chatId, side, rootMessageId) ?? false,
    context: (chatId, side, query) => groups.get(chatId)?.context(chatId, side, query) ?? "",
    reflect: (chatId) => groups.get(chatId)?.reflect(chatId) ?? Promise.resolve(),
    clear: (chatId) => groups.get(chatId)?.clear(chatId),
    status: (chatId) => groups.get(chatId)?.status(chatId) ?? { ...idle, epoch: closed ? -1 : 0 },
    drain: async () => {
      await Promise.all([...groups.values()].map((group) => group.drain()));
    },
    close: () => {
      closed = true;
      for (const group of groups.values()) group.close();
    },
  };
}
