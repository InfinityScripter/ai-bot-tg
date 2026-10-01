import type { Bot, Context, NextFunction } from "grammy";

import { CONFIG } from "../config.js";
import { createRateLimit } from "./rateLimit.js";
import { generateReply } from "./generateReply.js";
import { loadTurns, appendTurn } from "./memory.js";
import { chatReplyUser, chatReplySystem } from "./prompt.js";

import type { IncomingMessage } from "./types.js";
import type { CandidateStore } from "../store/index.js";

const ENABLED_KEY = "chat_reply_enabled";
/** Mentions waiting behind the one being answered; more are dropped, not queued. */
const MAX_PENDING = 3;
/**
 * A remembered message is cut to this many characters: memory goes into every
 * later prompt, so one 4 096-character message would otherwise inflate a dozen
 * future calls against the shared Codex quota.
 */
const MEMORY_TEXT_CHARS = 1000;
/** Shutdown waits this long for the answer in flight (systemd allows 20 s). */
const DRAIN_MAX_MS = 10_000;
/** Telegram shows "typing…" for ~5 s per call. */
const TYPING_EVERY_MS = 4500;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A group message addressed to the bot (mention or reply to it), or null. */
function toIncoming(ctx: Context): IncomingMessage | null {
  const msg = ctx.message;
  if (!msg?.text || !msg.from || msg.from.is_bot || msg.is_automatic_forward) return null;
  if (msg.text.startsWith("/")) return null;
  const mention = new RegExp(`@${escapeRegExp(ctx.me.username)}\\b`, "gi");
  const reply = msg.reply_to_message;
  const repliedToBot = reply?.from?.id === ctx.me.id ? (reply.text ?? reply.caption ?? "") : null;
  if (!mention.test(msg.text) && repliedToBot === null) return null;
  return {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    userId: msg.from.id,
    name: msg.from.first_name,
    text: msg.text.replace(mention, "").trim() || "(упомянули тебя без текста)",
    repliedToBot,
  };
}

/**
 * The group responder: answers in CHAT_REPLY_CHAT_ID when someone mentions the
 * bot or replies to it. Its middleware must run BEFORE the owner lock and
 * swallow every update from that group — the owner's own group messages would
 * otherwise reach owner-only handlers (manual ingest turns any text into a
 * post). Answers run one at a time in the background: a Codex turn takes
 * 5–15 s, and awaiting it in the middleware would freeze the owner's commands
 * and buttons, because updates are handled sequentially.
 */
export function createChatReply(bot: Bot, store: CandidateStore) {
  const chatId = CONFIG.CHAT_REPLY_CHAT_ID;
  const limit = createRateLimit(CONFIG.CHAT_REPLY_MAX_PER_HOUR);
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  /** Chats whose id was already logged for setup — one line per chat, not per mention. */
  const loggedStray = new Set<number>();

  const isEnabled = (): boolean => store.getRawSetting(ENABLED_KEY) !== "0";

  async function answer(msg: IncomingMessage): Promise<void> {
    const typing = (): void => {
      void bot.api.sendChatAction(msg.chatId, "typing").catch(() => {});
    };
    typing();
    const timer = setInterval(typing, TYPING_EVERY_MS);
    try {
      const system = chatReplySystem(bot.botInfo.username);
      const reply = await generateReply(
        store,
        system,
        chatReplyUser(loadTurns(store, msg.chatId), msg),
      );
      if (!reply) return;
      const text = reply.action === "reply" ? reply.text : "";
      if (text) {
        await bot.api.sendMessage(msg.chatId, text, {
          reply_parameters: { message_id: msg.messageId, allow_sending_without_reply: true },
        });
      }
      appendTurn(store, msg.chatId, {
        at: Date.now(),
        userId: msg.userId,
        name: msg.name,
        text: msg.text.slice(0, MEMORY_TEXT_CHARS),
        reply: text,
      });
    } catch (err) {
      console.error(`[chatReply] answer to ${msg.messageId} failed: ${String(err)}`);
    } finally {
      clearInterval(timer);
    }
  }

  async function middleware(ctx: Context, next: NextFunction): Promise<void> {
    if (chatId === undefined || ctx.chat?.id !== chatId) {
      const text = (ctx.message?.text ?? "").toLowerCase();
      const strayId = ctx.chat?.type === "private" ? undefined : ctx.chat?.id;
      if (
        strayId !== undefined &&
        !loggedStray.has(strayId) &&
        text.includes(`@${ctx.me.username.toLowerCase()}`)
      ) {
        loggedStray.add(strayId);
        console.log(`[chatReply] mention in a chat that is not CHAT_REPLY_CHAT_ID: ${strayId}`);
      }
      await next();
      return;
    }
    if (!isEnabled()) return;
    const msg = toIncoming(ctx);
    if (!msg) return;
    if (pending >= MAX_PENDING || !limit.tryTake()) {
      console.warn(`[chatReply] skipped ${msg.messageId}: queue ${pending}, hour ${limit.used()}`);
      return;
    }
    pending += 1;
    chain = chain
      .then(() => answer(msg))
      .finally(() => {
        pending -= 1;
      });
  }

  async function onToggle(ctx: Context): Promise<void> {
    if (chatId === undefined) {
      await ctx.reply("Ответчик в чате не настроен: задайте CHAT_REPLY_CHAT_ID.");
      return;
    }
    const enabled = !isEnabled();
    store.setRawSetting(ENABLED_KEY, enabled ? "1" : "0");
    const used = `${limit.used()} из ${CONFIG.CHAT_REPLY_MAX_PER_HOUR}`;
    await ctx.reply(
      `Ответчик в чате ${enabled ? "включён" : "выключен"}. Ответов за час: ${used}.`,
    );
  }

  /**
   * Waits for the answer in flight, but at most DRAIN_MAX_MS: systemd kills the
   * unit 20 s after SIGTERM, and a Codex turn may run up to its 90 s timeout.
   * An answer cut off here is simply never sent; queued ones die with the process.
   */
  function drain(): Promise<void> {
    const cap = new Promise<void>((resolve) => {
      setTimeout(resolve, DRAIN_MAX_MS).unref();
    });
    return Promise.race([chain, cap]);
  }

  return { middleware, onToggle, drain };
}
