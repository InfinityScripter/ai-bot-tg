import type { Bot, Context, NextFunction } from "grammy";

import { CONFIG } from "../config.js";
import { isDirect } from "./isDirect.js";
import { indexBlog } from "./indexBlog.js";
import { AvatarStore } from "./avatarStore.js";
import { createGroupTurns } from "./groupTurns.js";
import { createRateLimit } from "../chatReply/rateLimit.js";
import { onMigrated, onMemberUpdate } from "./memberGuard.js";
import { generateReply } from "../chatReply/generateReply.js";

import type { GuardDeps } from "./memberGuard.js";
import type { GenerateFn } from "./groupTurns.js";
import type { IndexSummary } from "./indexBlog.js";
import type { CandidateStore } from "../store/index.js";

export interface AvatarOptions {
  /** Defaults to a store on AVATAR_SQLITE_PATH. */
  avatarStore?: AvatarStore;
  /** Test seam; defaults to the responder's Codex-first turn with the capped paid fallback. */
  generate?: GenerateFn;
  /** Test seam for the blog crawl. */
  index?: (store: AvatarStore) => Promise<IndexSummary>;
}

/** The last blog crawl, for /avatar. */
export type IndexStatus = { at: number; summary: IndexSummary } | { at: number; error: string };

/**
 * The owner's avatar: the bot's mode in every group the owner added it to
 * (the channel's discussion group stays with the group responder, whose
 * middleware runs first). Its middleware must run BEFORE the owner lock and
 * stop every group update: the owner's own group text would otherwise reach
 * manual ingest and become a post card.
 */
export function createAvatar(bot: Bot, store: CandidateStore, options: AvatarOptions = {}) {
  const avatarStore = options.avatarStore ?? new AvatarStore();
  const paidLimit = createRateLimit(CONFIG.CHAT_REPLY_FALLBACK_PER_HOUR);
  const generate: GenerateFn =
    options.generate ??
    ((system, user) => generateReply(store, system, user, () => paidLimit.tryTake()));
  const crawl = options.index ?? indexBlog;
  const turns = createGroupTurns(bot, avatarStore, generate);
  const strayLogged = new Set<number>();
  let indexing: Promise<IndexSummary> | null = null;
  let lastIndex: IndexStatus | null = null;
  let firstIndexTried = false;

  const notifyOwner = (text: string): Promise<unknown> =>
    bot.api
      .sendMessage(CONFIG.OWNER_TELEGRAM_ID, text)
      .catch((err) => console.warn(`[avatar] owner DM failed: ${String(err)}`));

  /** One crawl at a time: the blog allows 60 requests a minute per IP. */
  function reindex(): Promise<IndexSummary> {
    indexing ??= crawl(avatarStore)
      .then((summary) => {
        lastIndex = { at: Date.now(), summary };
        console.log(`[avatar] blog index: ${JSON.stringify(summary)}`);
        return summary;
      })
      .catch((err: unknown) => {
        lastIndex = { at: Date.now(), error: String(err) };
        console.warn(`[avatar] blog index failed: ${String(err)}`);
        throw err;
      })
      .finally(() => {
        indexing = null;
      });
    return indexing;
  }

  /** The first group message with no blog memory starts a crawl, once per process. */
  function ensureIndexed(): void {
    if (firstIndexTried || avatarStore.chunkCount() > 0) return;
    firstIndexTried = true;
    void reindex().catch((err) =>
      notifyOwner(`Аватар не смог прочитать блог: ${String(err)}. Повтори /reindex.`),
    );
  }

  const guardDeps = (ctx: Context): GuardDeps => ({
    store: avatarStore,
    api: ctx.api,
    forget: turns.forget,
    notifyOwner,
    readsAllMessages: ctx.me.can_read_all_group_messages,
  });

  async function middleware(ctx: Context, next: NextFunction): Promise<void> {
    const { chat } = ctx;
    if (chat?.type !== "group" && chat?.type !== "supergroup") {
      await next();
      return;
    }
    if (ctx.myChatMember) {
      await onMemberUpdate(ctx.myChatMember, chat.title, guardDeps(ctx));
      return;
    }
    const msg = ctx.message;
    if (msg?.migrate_from_chat_id !== undefined) {
      onMigrated(msg.migrate_from_chat_id, chat.id, chat.title, guardDeps(ctx));
      return;
    }
    if (!avatarStore.isAllowed(chat.id)) {
      if (msg && !strayLogged.has(chat.id)) {
        strayLogged.add(chat.id);
        console.log(`[avatar] ${chat.id} «${chat.title}» is not an avatar group; re-add the bot`);
      }
      return;
    }
    if (!msg?.text || !msg.from || msg.from.is_bot || msg.text.startsWith("/")) return;
    if (!avatarStore.isEnabled()) return;
    ensureIndexed();
    turns.onText(chat.id, {
      messageId: msg.message_id,
      authorId: msg.from.id,
      author: msg.from.first_name,
      text: msg.text,
      date: msg.date,
      direct: isDirect(msg, ctx.me),
    });
  }

  /** Leaves a group on the owner's command; null on success, the error text otherwise. */
  async function leave(chatId: number): Promise<string | null> {
    try {
      await bot.api.leaveChat(chatId);
    } catch (err) {
      return String(err);
    }
    avatarStore.forgetChat(chatId);
    turns.forget(chatId);
    return null;
  }

  /** Waits for a turn in flight (capped), then closes the avatar's SQLite file. */
  async function drainAndClose(): Promise<void> {
    await turns.drain();
    avatarStore.close();
  }

  return {
    middleware,
    store: avatarStore,
    reindex,
    isIndexing: () => indexing !== null,
    lastIndex: () => lastIndex,
    lastError: turns.lastError,
    leave,
    drainAndClose,
  };
}

export type Avatar = ReturnType<typeof createAvatar>;
