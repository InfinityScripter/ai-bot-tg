import type { Bot } from "grammy";

import { CONFIG } from "../config.js";
import { replyGate } from "./replyGate.js";
import { ChatHistory } from "./chatHistory.js";
import { QuietTimers } from "./quietTimers.js";
import { buildSearchQuery } from "./searchQuery.js";
import { avatarTranscript, avatarSystemPrompt } from "./avatarPrompt.js";

import type { AvatarStore } from "./avatarStore.js";
import type { ChatReply } from "../schemas/chatReplySchema.js";

/** One model turn: (system, user) → a reply, or null when every model failed. */
export type GenerateFn = (system: string, user: string) => Promise<ChatReply | null>;

/** A group text message, as the avatar takes it in. */
export interface IncomingText {
  messageId: number;
  authorId: number;
  author: string;
  text: string;
  /** Telegram's date, unix seconds. */
  date: number;
  /** Mentions the bot or replies to it. */
  direct: boolean;
}

/** One pasted log must not eat the whole transcript. */
const LINE_CHARS = 1000;
/** Blog excerpts per turn. */
const MEMORY_HITS = 5;
/** The latest messages that drive the blog search. */
const SEARCH_LINES = 5;
/** Shutdown waits this long for a turn in flight (systemd allows 20 s). */
const DRAIN_MAX_MS = 10_000;

const dayKey = (now: number): string => new Date(now).toISOString().slice(0, 10);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The avatar's turns in its groups: remember every text message (RAM), answer
 * a mention now, consider an unasked reply after a pause. A turn runs detached
 * from grammY's update loop (a Codex turn takes 5–15 s), one per chat; a
 * mention that arrives meanwhile runs right after. A turn never throws: this
 * process is the news bot, and an unhandled rejection restarts it.
 */
export function createGroupTurns(bot: Bot, store: AvatarStore, generate: GenerateFn) {
  const history = new ChatHistory();
  const timers = new QuietTimers(CONFIG.AVATAR_QUIET_MS);
  const inFlight = new Set<number>();
  const pendingDirect = new Map<number, number>();
  const running = new Set<Promise<void>>();
  let lastError: { at: number; text: string } | null = null;

  async function answer(chatId: number, direct: boolean, replyTo?: number): Promise<void> {
    const now = Date.now();
    const day = dayKey(now);
    const verdict = replyGate({
      direct,
      now,
      callsToday: store.callsOn(chatId, day),
      lastAvatarAt: history.lastAt(chatId, "avatar"),
      lastUnaskedAt: history.lastAt(chatId, "unasked"),
      lastOwnerAt: history.lastAt(chatId, "owner"),
      limits: { dailyCalls: CONFIG.AVATAR_DAILY_CALLS, cooldownMs: CONFIG.AVATAR_COOLDOWN_MS },
    });
    const mode = direct ? "mention" : "unasked";
    if (!verdict.call) {
      console.log(`[avatar] ${chatId}: no ${mode} turn (${verdict.reason})`);
      return;
    }
    if (!direct) history.stamp(chatId, "unasked", now);
    const lines = history.recent(chatId);
    const memory = store.search(
      buildSearchQuery(lines.slice(-SEARCH_LINES).map((l) => l.text)),
      MEMORY_HITS,
    );
    const reply = await generate(
      avatarSystemPrompt(store.getProfile(), memory, direct),
      avatarTranscript(lines),
    );
    if (!reply) {
      lastError = { at: Date.now(), text: "Codex и запасная модель не ответили" };
      console.warn(`[avatar] ${chatId}: no ${mode} answer, every model failed`);
      return;
    }
    store.countCall(chatId, day);
    if (reply.action !== "reply" || !reply.text) {
      console.log(`[avatar] ${chatId}: ${mode} turn, chose silence (memory ${memory.length})`);
      return;
    }
    const sent = await bot.api.sendMessage(
      chatId,
      reply.text,
      replyTo
        ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
        : {},
    );
    history.push(chatId, {
      messageId: sent.message_id,
      authorId: bot.botInfo.id,
      author: "аватар",
      text: reply.text,
      at: Date.now(),
      fromAvatar: true,
    });
    history.stamp(chatId, "avatar", Date.now());
    console.log(
      `[avatar] ${chatId}: ${mode} reply, ${reply.text.length} chars (memory ${memory.length})`,
    );
  }

  async function turn(chatId: number, direct: boolean, replyTo?: number): Promise<void> {
    if (inFlight.has(chatId)) {
      if (direct && replyTo !== undefined) pendingDirect.set(chatId, replyTo);
      return;
    }
    inFlight.add(chatId);
    try {
      if (store.isAllowed(chatId) && store.isEnabled()) await answer(chatId, direct, replyTo);
    } catch (err) {
      lastError = { at: Date.now(), text: errorText(err) };
      console.error(`[avatar] ${chatId}: turn failed: ${errorText(err)}`);
    } finally {
      inFlight.delete(chatId);
    }
    const next = pendingDirect.get(chatId);
    if (next !== undefined) {
      pendingDirect.delete(chatId);
      start(chatId, true, next);
    }
  }

  function start(chatId: number, direct: boolean, replyTo?: number): void {
    const run = turn(chatId, direct, replyTo);
    running.add(run);
    void run.finally(() => running.delete(run));
  }

  function onText(chatId: number, message: IncomingText): void {
    history.push(chatId, {
      messageId: message.messageId,
      authorId: message.authorId,
      author: message.author,
      text: message.text.slice(0, LINE_CHARS),
      at: message.date * 1000,
      fromAvatar: false,
    });
    if (message.authorId === CONFIG.OWNER_TELEGRAM_ID) {
      history.stamp(chatId, "owner", message.date * 1000);
    }
    if (message.direct) {
      timers.cancel(chatId);
      start(chatId, true, message.messageId);
      return;
    }
    timers.bump(chatId, () => start(chatId, false));
  }

  /** Drops everything the avatar holds about a chat it left: timer, lines, a queued mention. */
  function forget(chatId: number): void {
    timers.cancel(chatId);
    history.forget(chatId);
    pendingDirect.delete(chatId);
  }

  function drain(): Promise<void> {
    timers.stopAll();
    const cap = new Promise<void>((resolve) => {
      setTimeout(resolve, DRAIN_MAX_MS).unref();
    });
    return Promise.race([Promise.allSettled([...running]).then(() => undefined), cap]);
  }

  return { onText, forget, drain, lastError: () => lastError };
}
