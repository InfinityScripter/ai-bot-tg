import type { Bot, Context } from "grammy";

import { InlineKeyboard } from "grammy";

import { escapeMarkdown } from "../utils.js";
import { buildDigest } from "../llm/index.js";
import { DIGEST_CALLBACK } from "../consts.js";
import { ackSilently, logEditError } from "./edit.js";
import { fillVerdict, hasVerdictPlaceholder } from "./digestVerdict.js";
import { sendDigest, PublishError, fetchRecentPosts } from "../blog/index.js";

import type { DigestDraft } from "../llm/index.js";
import type { CandidateStore } from "../store/index.js";

/** How many days of posts a digest covers. */
const DIGEST_DAYS = 7;
/** Max chars of the html body shown in the DM preview (Telegram caps at 4096). */
const PREVIEW_CHARS = 1500;

/** The digest review keyboard: send, rebuild, edit the verdict, or cancel. */
function digestKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Отправить", DIGEST_CALLBACK.SEND)
    .text("🔄 Пересобрать", DIGEST_CALLBACK.REBUILD)
    .row()
    .text("✍️ Вердикт", DIGEST_CALLBACK.VERDICT)
    .text("❌ Отмена", DIGEST_CALLBACK.CANCEL);
}

/** Strips HTML tags to a plain-text preview so the DM shows readable copy. */
function htmlToPreview(html: string): string {
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** Renders the DM preview message for a built digest (Markdown-safe). */
function renderPreview(digest: DigestDraft): string {
  return [
    `📬 *Дайджест готов*`,
    `*Тема:* ${escapeMarkdown(digest.subject)}`,
    "",
    escapeMarkdown(htmlToPreview(digest.html)),
    "",
    "_Проверьте и нажмите «Отправить», чтобы разослать подтверждённым подписчикам._",
  ].join("\n");
}

/**
 * The /digest flow: fetch the week's posts, build a digest via the active LLM,
 * preview it in the owner DM, and on ✅ send it to all confirmed subscribers.
 *
 * A single module-scoped `pending` draft is enough for V1 — the bot is
 * owner-locked, so there is one owner and one draft at a time; a rebuild
 * overwrites it. Kept in its own file so createHandlers.ts doesn't grow.
 */
export function createDigestFlow(bot: Bot, store: CandidateStore) {
  // The digest built by /digest (or 🔄 Пересобрать), awaiting the owner's ✅/❌.
  // Null when there is nothing to send (never built, or already sent/cancelled).
  let pending: DigestDraft | null = null;
  // True after ✍️ Вердикт: the NEXT plain owner text is captured as the verdict
  // (fills the {{ВЕРДИКТ}} slot) instead of being ingested as a candidate.
  let awaitingVerdict = false;

  /** True if a callback belongs to the digest flow (routed before onCallback). */
  function isDigestCallback(data: string): boolean {
    return (
      data === DIGEST_CALLBACK.SEND ||
      data === DIGEST_CALLBACK.REBUILD ||
      data === DIGEST_CALLBACK.VERDICT ||
      data === DIGEST_CALLBACK.CANCEL
    );
  }

  /** Fetches + builds a digest and stores it as the pending draft, or replies empty. */
  async function buildAndPreview(ctx: Context): Promise<void> {
    const posts = await fetchRecentPosts(DIGEST_DAYS);
    if (posts.length === 0) {
      pending = null;
      await ctx.reply("За неделю нет постов — дайджест собирать нечего.");
      return;
    }
    const digest = await buildDigest(posts, store);
    pending = digest;
    await ctx.reply(renderPreview(digest), {
      parse_mode: "Markdown",
      reply_markup: digestKeyboard(),
    });
  }

  /** /digest command: kicks off the fetch → build → preview flow. */
  async function runDigest(ctx: Context): Promise<void> {
    await ctx.reply("Собираю дайджест…");
    try {
      await buildAndPreview(ctx);
    } catch (err) {
      await ctx.reply(`Не удалось собрать дайджест: ${String(err)}`);
    }
  }

  /** ✅ Отправить: sends the pending digest, then edits the card with the result. */
  async function handleSend(ctx: Context): Promise<void> {
    if (!pending) {
      await ackSilently(ctx, { text: "Нет готового дайджеста." });
      await ctx.editMessageReplyMarkup().catch(logEditError("digest send no-pending markup"));
      return;
    }
    // Safety gate: an unfilled {{ВЕРДИКТ}} slot must never reach subscribers.
    // Refuse to send and keep the draft so the owner can add the verdict first.
    if (hasVerdictPlaceholder(pending.html)) {
      await ackSilently(ctx, { text: "Сначала добавьте вердикт (✍️ Вердикт)" });
      return;
    }
    const draft = pending;
    // Clear the pending draft up front so a double-tap can't send twice.
    pending = null;
    await ackSilently(ctx, { text: "Отправляю…" });
    await ctx.editMessageReplyMarkup().catch(logEditError("digest send clear markup"));
    try {
      const { sent, failed } = await sendDigest(draft.subject, draft.html);
      await ctx
        .editMessageText(`✅ Отправлено ${sent} подписчикам (${failed} ошибок).`)
        .catch(logEditError("digest send success text"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Restore the draft so the owner can retry — unless the send may have
      // partially gone out (5xx / unreadable 200), where a blind retry could
      // double-send; then warn instead of re-offering send.
      const maybeSent = err instanceof PublishError && err.maybePosted;
      if (maybeSent) {
        await ctx
          .editMessageText(
            `❓ Рассылка не подтверждена: ${message}\n\nЧасть писем МОГЛА уйти — проверьте перед повтором.`,
          )
          .catch(logEditError("digest send maybe-sent text"));
      } else {
        pending = draft;
        await ctx
          .editMessageText(`⚠️ Не удалось отправить: ${message}`, { reply_markup: digestKeyboard() })
          .catch(logEditError("digest send failure text"));
      }
    }
  }

  /** 🔄 Пересобрать: re-fetch + re-build, overwriting the pending draft. */
  async function handleRebuild(ctx: Context): Promise<void> {
    await ackSilently(ctx, { text: "Пересобираю…" });
    await ctx.editMessageReplyMarkup().catch(logEditError("digest rebuild clear markup"));
    try {
      await buildAndPreview(ctx);
    } catch (err) {
      await ctx.reply(`Не удалось пересобрать дайджест: ${String(err)}`);
    }
  }

  /** ✍️ Вердикт: arm the flow to capture the owner's next text as the verdict. */
  async function handleVerdict(ctx: Context): Promise<void> {
    if (!pending) {
      await ackSilently(ctx, { text: "Нет готового дайджеста." });
      return;
    }
    awaitingVerdict = true;
    await ackSilently(ctx, { text: "Пришлите текст вердикта сообщением." });
    await ctx.reply(
      "✍️ Пришлите текст вердикта одним сообщением — он заменит плейсхолдер {{ВЕРДИКТ}} в дайджесте.",
    );
  }

  /** ❌ Отмена: drop the pending draft and mark the card cancelled. */
  async function handleCancel(ctx: Context): Promise<void> {
    pending = null;
    awaitingVerdict = false;
    await ackSilently(ctx, { text: "Отменено." });
    await ctx.editMessageReplyMarkup().catch(logEditError("digest cancel clear markup"));
    await ctx.editMessageText("❌ Отправка отменена.").catch(logEditError("digest cancel text"));
  }

  /** True while the flow is waiting for the owner to send the verdict text. */
  function isAwaitingVerdict(): boolean {
    return awaitingVerdict && pending !== null;
  }

  /**
   * Captures the owner's text as the verdict: fills the {{ВЕРДИКТ}} slot, clears
   * the awaiting flag, and re-renders the preview so the owner sees the result.
   * Routed BEFORE ingestMessage, so this text is never turned into a candidate.
   */
  async function submitVerdict(ctx: Context, text: string): Promise<void> {
    awaitingVerdict = false;
    if (!pending) {
      await ctx.reply("Дайджест больше не ожидает вердикта — соберите заново через /digest.");
      return;
    }
    pending = { subject: pending.subject, html: fillVerdict(pending.html, text) };
    await ctx.reply(renderPreview(pending), {
      parse_mode: "Markdown",
      reply_markup: digestKeyboard(),
    });
  }

  /** Routes a digest callback to the matching handler. */
  async function onDigestCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    if (data === DIGEST_CALLBACK.SEND) {
      await handleSend(ctx);
      return;
    }
    if (data === DIGEST_CALLBACK.REBUILD) {
      await handleRebuild(ctx);
      return;
    }
    if (data === DIGEST_CALLBACK.VERDICT) {
      await handleVerdict(ctx);
      return;
    }
    await handleCancel(ctx);
  }

  return { runDigest, onDigestCallback, isDigestCallback, isAwaitingVerdict, submitVerdict };
}
