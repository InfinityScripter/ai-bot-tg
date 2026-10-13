import type { Bot, Context, NextFunction } from "grammy";

import { CONFIG } from "../config.js";
import { isDirect } from "./isDirect.js";
import { indexBlog } from "./indexBlog.js";
import { AvatarStore } from "./avatarStore.js";
import { ChatHistory } from "./chatHistory.js";
import { createGroupTurns } from "./groupTurns.js";
import { messageText } from "../telegram/messageText.js";
import { createAvatarSpeaker } from "./debateSpeaker.js";
import { codexReply } from "../chatReply/generateReply.js";
import { onMigrated, onMemberUpdate } from "./memberGuard.js";
import { captureMessage, conversationRoot } from "../chatMemory/captureMessage.js";

import type { GuardDeps } from "./memberGuard.js";
import type { GenerateFn } from "./groupTurns.js";
import type { IndexSummary } from "./indexBlog.js";
import type { CandidateStore } from "../store/index.js";
import type { MemoryWiring } from "../chatMemory/wiring.js";

export interface AvatarOptions extends MemoryWiring {
  /** Defaults to a store on AVATAR_SQLITE_PATH. */
  avatarStore?: AvatarStore;
  /** Test seam for every model turn. All avatar turns default to Codex only. */
  generate?: GenerateFn;
  /** Where owner notices go; defaults to this bot's DM with the owner. */
  notifyOwner?: (text: string) => Promise<unknown>;
  /** Test seam for the blog crawl. */
  index?: (store: AvatarStore) => Promise<IndexSummary>;
}

/** The last blog crawl, for /avatar. */
export type IndexStatus = { at: number; summary: IndexSummary } | { at: number; error: string };

/**
 * The owner's avatar on its own bot: it speaks in every group the owner added
 * that bot to, and argues with Hope as the practitioner. Its middleware stops
 * every group update, so only private updates reach the bot's owner lock.
 */
export function createAvatar(bot: Bot, _store: CandidateStore, options: AvatarOptions = {}) {
  const avatarStore = options.avatarStore ?? new AvatarStore();
  const generate = options.generate ?? codexReply;
  const crawl = options.index ?? indexBlog;
  const history = new ChatHistory();
  let stopping = false;
  const turns = createGroupTurns(
    bot,
    avatarStore,
    generate,
    history,
    options.memory,
    options.reportReplyError,
    _store.replyAllowance,
  );
  const speaker = createAvatarSpeaker(
    bot,
    avatarStore,
    history,
    generate,
    (text) => {
      turns.noteError(text);
      options.reportReplyError?.();
    },
    options.memory,
    () => !stopping,
    _store.replyAllowance,
  );
  const strayLogged = new Set<number>();
  let indexing: Promise<IndexSummary> | null = null;
  let lastIndex: IndexStatus | null = null;
  let firstIndexTried = false;

  const notifyOwner =
    options.notifyOwner ??
    ((text: string): Promise<unknown> =>
      bot.api
        .sendMessage(CONFIG.OWNER_TELEGRAM_ID, text)
        .catch((err) => console.warn(`[avatar] owner DM failed: ${String(err)}`)));

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
    if (options.refreshMaterials) return;
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
    if (stopping) return;
    const { chat } = ctx;
    if (chat?.type !== "group" && chat?.type !== "supergroup") {
      await next();
      return;
    }
    if (captureMessage(ctx, options) === false) return;
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
    const text = messageText(msg);
    if (!msg || !text || !msg.from || msg.from.is_bot || text.startsWith("/")) return;
    if (!avatarStore.isEnabled()) return;
    ensureIndexed();
    const quoted = msg.reply_to_message;
    const quotedText = quoted?.rich_message ? messageText(quoted) : undefined;
    const quotedAuthor = quoted?.sender_chat ?? quoted?.from;
    if (quoted && quotedText && quotedAuthor) {
      history.push(chat.id, {
        ...conversationRoot(quoted, options.memory),
        messageId: quoted.message_id,
        authorId: quotedAuthor.id,
        author:
          "type" in quotedAuthor ? (quotedAuthor.title ?? "сообщество") : quotedAuthor.first_name,
        text: quotedText.slice(0, 1000),
        at: quoted.date * 1000,
        fromAvatar: quoted.from?.id === ctx.me.id,
      });
    }
    turns.onText(chat.id, {
      ...conversationRoot(
        msg,
        options.memory,
        (id) => history.recent(chat.id).find((line) => line.messageId === id)?.rootMessageId,
      ),
      messageId: msg.message_id,
      triggerMessageId: msg.message_id,
      authorId: msg.from.id,
      author: msg.from.first_name,
      chatUsername: chat.type === "supergroup" ? chat.username : undefined,
      text,
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

  /**
   * Waits for a turn in flight (capped) and for `alsoWait` (the debates, which
   * also write here), then closes the avatar's SQLite file.
   */
  async function drainAndClose(alsoWait: Promise<unknown> = Promise.resolve()): Promise<void> {
    stopping = true;
    await Promise.all([turns.drain(), alsoWait]);
    if (indexing) void indexing.catch(() => undefined).finally(() => avatarStore.close());
    else avatarStore.close();
  }

  function clearMemory(): boolean {
    const chatId = CONFIG.CHAT_REPLY_CHAT_ID;
    if (!options.memory || chatId === undefined) return false;
    options.memory.clear(chatId);
    turns.forget(chatId);
    _store.setRawSetting(`chat_reply_memory:${chatId}`, "[]");
    return true;
  }

  function memoryStatus() {
    const chatId = CONFIG.CHAT_REPLY_CHAT_ID;
    if (!options.memory || chatId === undefined) return null;
    const status = options.memory.status(chatId);
    return { ...status, lastError: status.lastError ?? options.memoryError?.() ?? null };
  }

  return {
    middleware,
    speaker,
    onReply: turns.onReply,
    store: avatarStore,
    reindex,
    isIndexing: () => indexing !== null,
    lastIndex: () => lastIndex,
    lastError: turns.lastError,
    leave,
    drainAndClose,
    clearMemory,
    memoryStatus,
  };
}

export type Avatar = ReturnType<typeof createAvatar>;
