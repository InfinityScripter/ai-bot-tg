import type { Bot } from "grammy";

import { CONFIG } from "../config.js";
import { replyGate } from "./replyGate.js";
import { QuietTimers } from "./quietTimers.js";
import { buildSearchQuery } from "./searchQuery.js";
import { sendConversationReply } from "../debate/index.js";
import { ChatHistory, HOPE_AUTHOR_ID } from "./chatHistory.js";
import { avatarTranscript, avatarSystemPrompt } from "./avatarPrompt.js";
import { withMemory, recordReply, memoryEpoch, memoryCurrent } from "../chatMemory/replyMemory.js";

import type { AvatarStore } from "./avatarStore.js";
import type { DebateOpener } from "../debate/index.js";
import type { GenerateFn, IncomingText } from "./types.js";
import type { ConversationMemory } from "../chatMemory/index.js";

export type { GenerateFn, IncomingText } from "./types.js";

/** One pasted log must not eat the whole transcript. */
const LINE_CHARS = 1000;
/** Blog excerpts per turn. */
const MEMORY_HITS = 5;
/** The latest messages that drive the blog search. */
const SEARCH_LINES = 5;
/** Shutdown waits this long for a turn in flight (systemd allows 20 s). */
const DRAIN_MAX_MS = 10_000;

/** The UTC day the call counters use. */
export const dayKey = (now: number): string => new Date(now).toISOString().slice(0, 10);

/**
 * The avatar's turns in its groups: remember every text message (RAM), answer
 * a mention now, consider an unasked reply after a pause. A turn runs detached
 * from grammY's update loop (a Codex turn takes 5–15 s), one per chat; a
 * mention that arrives meanwhile runs right after. A turn never throws: the
 * news bot runs in the same process, and an unhandled rejection restarts it.
 */
export function createGroupTurns(
  bot: Bot,
  store: AvatarStore,
  generate: GenerateFn,
  /** Shared with the avatar's debate side, so both see the same lines. */
  history: ChatHistory = new ChatHistory(),
  conversation: ConversationMemory | undefined = undefined,
  reportError: (() => void) | undefined = undefined,
) {
  const timers = new QuietTimers(CONFIG.AVATAR_QUIET_MS);
  const inFlight = new Set<number>();
  const pendingDirect = new Map<number, IncomingText>();
  const running = new Set<Promise<void>>();
  let lastError: { at: number; text: string } | null = null;
  let replyListener: DebateOpener | null = null;
  let stopped = false;

  async function answer(chatId: number, direct: boolean, target?: IncomingText): Promise<void> {
    const epoch = memoryEpoch(conversation, chatId);
    const current = () => !stopped && memoryCurrent(conversation, chatId, epoch);
    if (!current()) return;
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
    const lines = history.recent(chatId).map((line) => {
      const source = conversation?.message(chatId, line.messageId);
      return source
        ? { ...line, text: source.text.slice(0, LINE_CHARS), author: source.authorName }
        : line;
    });
    const texts = lines.slice(-SEARCH_LINES).map((line) => line.text);
    const memory = store.search(buildSearchQuery(texts), MEMORY_HITS);
    const reply = await generate(
      avatarSystemPrompt(store.getProfile(), memory, direct),
      withMemory(avatarTranscript(lines), conversation, chatId, "avatar", texts.join("\n")),
    );
    if (!current()) return;
    if (!reply) {
      lastError = { at: Date.now(), text: "Codex не ответил" };
      reportError?.();
      console.warn(`[avatar] ${chatId}: no ${mode} answer, Codex failed`);
      return;
    }
    store.countCall(chatId, day);
    if (reply.action !== "reply" || !reply.text) {
      console.log(`[avatar] ${chatId}: ${mode} turn, chose silence (memory ${memory.length})`);
      return;
    }
    const sent = await sendConversationReply(bot, chatId, reply.text, {
      rootMessageId: target?.rootMessageId,
      messageThreadId: target?.messageThreadId,
      messageId: target?.messageId,
      authorName: target?.author,
      chatUsername: target?.chatUsername,
    });
    if (!current()) return;
    recordReply(conversation, bot, chatId, sent, reply.text, "avatar", { ...target }, epoch);
    history.push(chatId, {
      rootMessageId: target?.rootMessageId ?? target?.messageId,
      messageThreadId: target?.messageThreadId,
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
    if (!direct) return;
    // The person's message it answered; Hope's lines are never the topic.
    const topic =
      target?.text.slice(0, LINE_CHARS) ??
      lines.filter((l) => !l.fromAvatar && l.authorId !== HOPE_AUTHOR_ID).at(-1)?.text ??
      "";
    replyListener?.(
      chatId,
      {
        side: "avatar",
        text: reply.text,
        messageId: sent.message_id,
        authorName: bot.botInfo.first_name,
        authorId: bot.botInfo.id,
      },
      topic,
      {
        rootMessageId: target?.rootMessageId ?? target?.messageId,
        messageThreadId: target?.messageThreadId,
      },
    );
  }

  async function turn(chatId: number, direct: boolean, target?: IncomingText): Promise<void> {
    if (inFlight.has(chatId)) {
      if (direct && target !== undefined) pendingDirect.set(chatId, target);
      return;
    }
    inFlight.add(chatId);
    try {
      if (store.isAllowed(chatId) && store.isEnabled()) await answer(chatId, direct, target);
    } catch {
      lastError = { at: Date.now(), text: "Не удалось подготовить или отправить ответ аватара" };
      reportError?.();
      console.error(`[avatar] ${chatId}: turn failed`);
    } finally {
      inFlight.delete(chatId);
    }
    const next = pendingDirect.get(chatId);
    if (next !== undefined) {
      pendingDirect.delete(chatId);
      start(chatId, true, next);
    }
  }

  function start(chatId: number, direct: boolean, target?: IncomingText): void {
    if (stopped) return;
    const run = turn(chatId, direct, target);
    running.add(run);
    void run.finally(() => running.delete(run));
  }

  function onText(chatId: number, message: IncomingText): void {
    history.push(chatId, {
      rootMessageId: message.rootMessageId,
      messageThreadId: message.messageThreadId,
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
      start(chatId, true, message);
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
    stopped = true;
    pendingDirect.clear();
    timers.stopAll();
    const cap = new Promise<void>((resolve) => {
      setTimeout(resolve, DRAIN_MAX_MS).unref();
    });
    return Promise.race([Promise.allSettled([...running]).then(() => undefined), cap]);
  }

  /** Records a failure from outside the turns (a debate reply), for /avatar. */
  function noteError(text: string): void {
    lastError = { at: Date.now(), text };
  }

  /** Only answers to a person's mention or reply may open a debate with Hope. */
  function onReply(listener: DebateOpener): void {
    replyListener = listener;
  }

  return { onText, forget, drain, noteError, onReply, lastError: () => lastError };
}
