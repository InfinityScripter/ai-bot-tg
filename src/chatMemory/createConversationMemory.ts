import { runReflection } from "./reflection.js";
import { MemoryRepository } from "./repository.js";
import { conversationContext } from "./context.js";

import type { MemoryDeps, ConversationMemory } from "./types.js";

/** Source writes are synchronous; model work will be detached from this boundary. */
export function createConversationMemory(deps: MemoryDeps): ConversationMemory {
  if (!Number.isSafeInteger(deps.chatId) || deps.chatId === 0)
    throw new Error("Не задана группа памяти.");
  const repo = new MemoryRepository(deps.path, deps.chatId);
  let closed = false;
  let stopping = false;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  const debounce = Number.isFinite(deps.debounceMs) ? Math.max(10, deps.debounceMs!) : 8000;
  const allowed = (chatId: number) => !closed && chatId === deps.chatId;
  const cancelTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = (delay = debounce) => {
    if (closed || stopping || running || failures >= 3) return;
    cancelTimer();
    timer = setTimeout(() => {
      timer = null;
      void reflect(deps.chatId);
    }, delay);
    timer.unref();
  };
  const reflect = (chatId: number): Promise<void> => {
    if (!allowed(chatId) || stopping) return Promise.resolve();
    if (running) return running;
    cancelTimer();
    const { epoch } = repo.state();
    running = runReflection(repo, deps, () => !closed)
      .then(() => {
        failures = 0;
      })
      .catch(() => {
        if (!closed && repo.state().epoch === epoch) {
          failures++;
          repo.setError("Не удалось разобрать память через Codex.");
          console.warn("[chatMemory] reflection failed; sources retained");
        }
      })
      .finally(() => {
        running = null;
        if (!closed && !stopping && repo.status().pending)
          schedule(failures ? Math.max(5000, debounce * 2) : debounce);
      });
    return running;
  };
  const memory: ConversationMemory = {
    observe: (message) => {
      if (!allowed(message.chatId) || stopping) return;
      try {
        if (repo.observe(message)) {
          failures = 0;
          schedule();
        }
      } catch {
        repo.setError("Не удалось сохранить сообщение памяти.");
        throw new Error("Не удалось сохранить сообщение памяти.");
      }
    },
    message: (chatId, messageId) =>
      allowed(chatId) ? (repo.message(messageId)?.message ?? null) : null,
    hasReply: (chatId, side, rootMessageId) =>
      allowed(chatId) && repo.hasReply(side, rootMessageId),
    context: (chatId, side, query) =>
      allowed(chatId) ? conversationContext(repo, side, query, deps) : "",
    reflect,
    clear: (chatId) => {
      if (allowed(chatId)) {
        cancelTimer();
        failures = 0;
        repo.clear();
      }
    },
    status: (chatId) =>
      allowed(chatId)
        ? repo.status()
        : {
            epoch: closed ? -1 : 0,
            messages: 0,
            notes: 0,
            opinions: 0,
            pending: 0,
            lastError: null,
          },
    drain: async () => {
      stopping = true;
      cancelTimer();
      if (!running) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        running,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 2000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    },
    close: () => {
      if (!closed) {
        closed = true;
        stopping = true;
        cancelTimer();
        repo.close();
      }
    },
  };
  if (repo.status().pending) schedule();
  return memory;
}
