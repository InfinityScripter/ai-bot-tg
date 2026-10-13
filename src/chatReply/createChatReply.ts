import type { Bot, Context, NextFunction } from "grammy";

import { CONFIG } from "../config.js";
import { appendTurn } from "./memory.js";
import { chatReplySystem } from "./prompt.js";
import { createRateLimit } from "./rateLimit.js";
import { generateReply } from "./generateReply.js";
import { createHopeSpeaker } from "./debateSpeaker.js";
import { sendConversationReply } from "../debate/index.js";
import { createReplyJob } from "../chatMemory/replyJob.js";
import { captureMessage } from "../chatMemory/captureMessage.js";
import { recordReply, memoryCurrent } from "../chatMemory/replyMemory.js";

import type { CandidateStore } from "../store/index.js";
import type { ReplyJob } from "../chatMemory/replyJob.js";
import type { MemoryWiring } from "../chatMemory/wiring.js";
import type { DebateLine, DebateOpener } from "../debate/index.js";

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

/**
 * The group responder: answers in CHAT_REPLY_CHAT_ID when someone mentions the
 * bot or replies to it, and comments on every new channel post. Its middleware must run BEFORE the owner lock and
 * swallow every update from that group — the owner's own group messages would
 * otherwise reach owner-only handlers (manual ingest turns any text into a
 * post). Answers run one at a time in the background: a Codex turn takes
 * 5–15 s, and awaiting it in the middleware would freeze the owner's commands
 * and buttons, because updates are handled sequentially.
 */
export function createChatReply(bot: Bot, store: CandidateStore, wiring: MemoryWiring = {}) {
  const chatId = CONFIG.CHAT_REPLY_CHAT_ID;
  const paidLimit = createRateLimit(CONFIG.CHAT_REPLY_FALLBACK_PER_HOUR);
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  /** Chats whose id was already logged for setup — one line per chat, not per mention. */
  const loggedStray = new Set<number>();
  let replyListener: DebateOpener | null = null;

  const isEnabled = (): boolean => store.getRawSetting(ENABLED_KEY) !== "0";

  async function answer(job: ReplyJob): Promise<void> {
    const current = () => memoryCurrent(wiring.memory, job.chatId, job.epoch);
    if (!current()) return;
    if (!store.replyAllowance.claim(job.chatId, job.triggerMessageId, "hope")) return;
    let attempted = false;
    const typing = (): void => {
      void bot.api.sendChatAction(job.chatId, "typing").catch(() => {});
    };
    typing();
    const timer = setInterval(typing, TYPING_EVERY_MS);
    try {
      const system = chatReplySystem(bot.botInfo.username);
      const reply = await generateReply(store, system, job.prompt(), () => paidLimit.tryTake());
      if (!current()) return;
      if (!reply) {
        wiring.reportReplyError?.();
        return;
      }
      const text = reply.action === "reply" ? reply.text : "";
      if (text) {
        attempted = true;
        const sent = await sendConversationReply(bot, job.chatId, text, job);
        if (!current()) return;
        recordReply(wiring.memory, bot, job.chatId, sent, text, "hope", job, job.epoch);
        if (store.replyAllowance.isCurrent(job.chatId, job.triggerMessageId)) {
          const line: DebateLine = {
            side: "hope",
            text,
            messageId: sent.message_id,
            authorName: bot.botInfo.first_name,
            authorId: bot.botInfo.id,
          };
          replyListener?.(job.chatId, line, job.post ?? job.turn.text, {
            triggerMessageId: job.triggerMessageId,
            rootMessageId: job.rootMessageId,
            messageThreadId: job.messageThreadId,
          });
        }
      }
      if (!current()) return;
      appendTurn(store, job.chatId, {
        at: Date.now(),
        ...job.turn,
        text: job.turn.text.slice(0, MEMORY_TEXT_CHARS),
        reply: text,
      });
    } catch {
      wiring.reportReplyError?.();
      console.error(`[chatReply] answer to ${job.messageId} failed`);
    } finally {
      clearInterval(timer);
      if (!attempted) store.replyAllowance.release(job.chatId, job.triggerMessageId, "hope");
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
    if (captureMessage(ctx, wiring) === false) return;
    if (!isEnabled()) return;
    const job = createReplyJob(ctx, store, wiring.memory);
    if (!job) return;
    store.replyAllowance.activate(job.chatId, job.triggerMessageId);
    if (pending >= MAX_PENDING) {
      console.warn(`[chatReply] skipped ${job.messageId}: ${pending} answers already queued`);
      return;
    }
    pending += 1;
    chain = chain
      .then(() => answer(job))
      // Claims and unused-claim cleanup can fail outside answer's generation catch.
      // Settle this job so a storage error cannot reject every later queued answer.
      .catch(() => {
        wiring.reportReplyError?.();
        console.error(`[chatReply] answer to ${job.messageId} failed`);
      })
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
    const paid = `${paidLimit.used()} из ${CONFIG.CHAT_REPLY_FALLBACK_PER_HOUR}`;
    await ctx.reply(
      `Ответчик в чате ${enabled ? "включён" : "выключен"}. Платных ответов за час: ${paid}.`,
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

  /** Hope's side for debates with the avatar. */
  const hope = {
    speaker: createHopeSpeaker(
      bot,
      store.replyAllowance,
      isEnabled,
      wiring.memory,
      wiring.reportReplyError,
    ),
    /** A post comment or direct human request may invite the other side once. */
    onReply: (listener: DebateOpener): void => {
      replyListener = listener;
    },
  };

  return { middleware, onToggle, drain, hope };
}
