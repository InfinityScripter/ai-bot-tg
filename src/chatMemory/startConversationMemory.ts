import { CONFIG } from "../config.js";
import { createConversationMemory } from "./index.js";
import { AvatarStore } from "../avatar/avatarStore.js";
import { chatReplySystem } from "../chatReply/prompt.js";
import { refreshBlogIndex } from "../avatar/indexBlog.js";
import { SKEPTIC_ROLE, PRACTITIONER_ROLE } from "../debate/debatePrompt.js";

import type { IndexDeps } from "../avatar/indexBlog.js";
import type { MemoryDeps, ConversationMemory } from "./types.js";

export interface MemoryStartupDeps {
  path?: string;
  chatId?: number;
  indexDeps?: IndexDeps;
  generate?: MemoryDeps["generate"];
  debounceMs?: number;
}

/** One lifetime for the shared corpus and its independent blog-reader connection. */
export function startConversationMemory(deps: MemoryStartupDeps = {}) {
  const chatId = deps.chatId ?? CONFIG.CHAT_REPLY_CHAT_ID;
  if (chatId === undefined) return null;
  const path = deps.path ?? CONFIG.AVATAR_SQLITE_PATH;
  let materials!: AvatarStore;
  let memory: ConversationMemory;
  try {
    materials = new AvatarStore(path);
    memory = createConversationMemory({
      path,
      chatId,
      generate: deps.generate,
      debounceMs: deps.debounceMs,
      materials: (query, limit) => materials.search(query, limit),
      persona: (side) =>
        side === "hope"
          ? chatReplySystem("Hope") + SKEPTIC_ROLE
          : materials.getProfile() + PRACTITIONER_ROLE,
    });
  } catch {
    // Memory is optional; a failed second connection must not retain the first.
    try {
      materials?.close();
    } catch {
      console.warn("[chatMemory] startup cleanup failed");
    }
    console.warn("[chatMemory] startup failed; conversation memory disabled");
    return null;
  }
  let stopped = false;
  let readerClosed = false;
  let requested = false;
  let refreshing: Promise<void> | null = null;
  let lastError: string | null = null;
  let replyError: string | null = null;
  const closeReader = (): void => {
    if (readerClosed) return;
    readerClosed = true;
    materials.close();
  };

  /** New posts coalesce into one follow-up when a crawl already holds the slot. */
  function refreshMaterials(): void {
    if (stopped) return;
    requested = true;
    if (refreshing) return;
    refreshing = (async () => {
      while (requested && !stopped) {
        requested = false;
        try {
          const summary = await refreshBlogIndex(materials, deps.indexDeps);
          lastError = summary.failed
            ? "Не все новые статьи блога загрузились; старый индекс сохранён."
            : null;
        } catch {
          lastError = "Не удалось обновить блог; старый индекс сохранён.";
          console.warn("[chatMemory] material refresh failed; existing index retained");
        }
      }
    })().finally(() => {
      refreshing = null;
      if (stopped) closeReader();
    });
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    requested = false;
    memory.close();
    // fetchAllPosts has no timeout: retain this connection until its late write settles.
    if (!refreshing) closeReader();
  }
  async function drain(): Promise<void> {
    stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.all([
      memory.drain(),
      Promise.race([
        refreshing,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]),
    ]);
    if (timer) clearTimeout(timer);
  }
  refreshMaterials();
  return {
    memory,
    refreshMaterials,
    memoryError: () => replyError ?? lastError,
    reportReplyError: () => {
      replyError = "Не удалось подготовить или отправить реплику. Исходные сообщения сохранены.";
    },
    stop,
    drain,
  };
}
