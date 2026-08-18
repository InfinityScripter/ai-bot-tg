import type { Bot, Context } from "grammy";

import { InlineKeyboard } from "grammy";

import { CONFIG } from "../config.js";
import { CandidateState } from "../enums.js";
import { DIGEST_POST_CALLBACK } from "../consts.js";
import { ackSilently, logEditError } from "./edit.js";
import { truncate, escapeMarkdown } from "../utils.js";
import { buildDigestPost } from "../llm/buildDigestPost.js";
import {
  toDigestRewrite,
  digestSummaryLine,
  renderDigestMarkdown,
} from "../llm/renderDigestPost.js";
import {
  PublishError,
  publishToBlog,
  crossPostToChannel,
  fetchAutoPublishFlags,
} from "../blog/index.js";

import type { CandidateStore } from "../store/index.js";
import type { DigestPost } from "../schemas/digestPostSchema.js";

/** Queued items older than this never enter a digest (stale news) — expired to skipped. */
const DIGEST_WINDOW_HOURS = 48;
/** Max chars of the Markdown body shown in the DM preview (Telegram caps at 4096). */
const PREVIEW_CHARS = 1500;

/** Today as YYYY-MM-DD in the bot's cron timezone (the daily-guard key). */
function todayInTz(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CONFIG.CRON_TZ }).format(new Date());
}

function digestPostKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Опубликовать", DIGEST_POST_CALLBACK.PUBLISH)
    .text("🔄 Пересобрать", DIGEST_POST_CALLBACK.REBUILD)
    .row()
    .text("❌ Отмена", DIGEST_POST_CALLBACK.CANCEL);
}

/**
 * The daily digest post flow (DIGEST_POSTS=on): once a day, assemble the
 * queued news candidates into ONE digest post. The blog's autoPublishNews
 * master switch (read fail-closed) decides auto-publish vs an owner preview
 * card; ❌ keeps items queued for tomorrow. A settings row with the last
 * publish date makes the run idempotent per day. Single module-scoped pending
 * draft — the bot is owner-locked, one owner, one draft (as digestFlow.ts).
 */
export function createDigestPostFlow(bot: Bot, store: CandidateStore) {
  let pending: { post: DigestPost; ids: number[] } | null = null;

  async function notify(text: string, keyboard?: InlineKeyboard): Promise<void> {
    await bot.api
      .sendMessage(CONFIG.OWNER_TELEGRAM_ID, text, keyboard ? { reply_markup: keyboard } : {})
      .catch(logEditError("digest-post notify"));
  }

  function isDigestPostCallback(data: string): boolean {
    return (
      data === DIGEST_POST_CALLBACK.PUBLISH ||
      data === DIGEST_POST_CALLBACK.REBUILD ||
      data === DIGEST_POST_CALLBACK.CANCEL
    );
  }

  /** Publishes a built digest: claim the batch, POST, mark rows, cross-post. */
  async function publishDigest(post: DigestPost, ids: number[]): Promise<void> {
    const claimed = store.claimDigestBatch(ids);
    if (claimed !== ids.length) {
      // Someone touched a row since the build (skip/manual action) — never
      // publish a digest whose items no longer match the queue. Release what
      // WAS claimed and let the owner rebuild from the fresh queue.
      store.requeueDigestBatch(ids);
      await notify("⚠️ Очередь дайджеста изменилась во время сборки — пересоберите (/digestpost).");
      return;
    }
    const today = todayInTz();
    try {
      const { postId, coverUrl } = await publishToBlog(
        toDigestRewrite(post),
        null,
        `digest-${today}`,
      );
      for (const id of ids) store.setPublished(id, postId);
      store.setDigestLastDate(today);
      await notify(`✅ Дайджест опубликован: ${post.title}`);
      try {
        // The blog may assign a site-relative cover; Telegram needs absolute.
        const cover = coverUrl?.startsWith("/")
          ? `${CONFIG.BLOG_API_URL.replace(/\/$/, "")}${coverUrl}`
          : coverUrl;
        await crossPostToChannel(
          bot.api,
          {
            title: post.title,
            description: post.intro,
            coverUrl: cover ?? null,
            linkFor: (id) => `${CONFIG.BLOG_PUBLIC_URL.replace(/\/$/, "")}/post/${id}`,
          },
          postId,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await notify(`⚠️ Дайджест опубликован, но не запостился в канал: ${message}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof PublishError && err.maybePosted) {
        // The POST may have landed — same duplicate-safety as per-item publish:
        // park the rows so nothing re-publishes until the owner checks the blog.
        for (const id of ids) store.setState(id, CandidateState.NeedsVerification, message);
        await notify(
          `❓ Публикация дайджеста не подтверждена: ${message}\n\nПост МОГ появиться — проверьте блог перед повтором.`,
        );
        return;
      }
      // Clear 4xx: nothing was created — items return to the queue for a retry.
      store.requeueDigestBatch(ids);
      await notify(`⚠️ Не удалось опубликовать дайджест: ${message}`);
    }
  }

  async function sendPreview(post: DigestPost, ids: number[]): Promise<void> {
    pending = { post, ids };
    const body = escapeMarkdown(truncate(renderDigestMarkdown(post), PREVIEW_CHARS));
    const text = [
      `📰 *Дайджест дня готов* (${digestSummaryLine(post)})`,
      `*${escapeMarkdown(post.title)}*`,
      "",
      body,
      "",
      "_Автопубликация новостей выключена — проверьте и нажмите «Опубликовать»._",
    ].join("\n");
    await bot.api
      .sendMessage(CONFIG.OWNER_TELEGRAM_ID, text, {
        parse_mode: "Markdown",
        reply_markup: digestPostKeyboard(),
      })
      .catch(logEditError("digest-post preview"));
  }

  /**
   * One digest attempt: guard the daily limit, expire stale queue rows, build
   * from the freshest DIGEST_MAX_ITEMS, then auto-publish or preview per the
   * blog flag. `manual` only makes the skip reasons audible (the cron run
   * stays quiet on a normal "nothing to do" day).
   */
  async function runDigestPost(manual = false): Promise<void> {
    if (store.getDigestLastDate() === todayInTz()) {
      if (manual) await notify("Дайджест сегодня уже публиковался.");
      return;
    }
    const expired = store.expireDigestQueue(DIGEST_WINDOW_HOURS);
    // eslint-disable-next-line no-console
    if (expired > 0) console.log(`[digest-post] expired ${expired} stale queued items`);
    const queue = store.listDigestQueue();
    if (queue.length < CONFIG.DIGEST_MIN_ITEMS) {
      if (manual)
        await notify(
          `В очереди ${queue.length} новостей — для дайджеста нужно ≥ ${CONFIG.DIGEST_MIN_ITEMS}.`,
        );
      return;
    }
    const batch = queue.slice(0, CONFIG.DIGEST_MAX_ITEMS);
    let post: DigestPost;
    try {
      post = await buildDigestPost(batch, store);
    } catch (err) {
      await notify(`⚠️ Не удалось собрать дайджест: ${String(err)}`);
      return;
    }
    const ids = batch.map((c) => c.id);
    // Fail-closed: a flag-read error means manual preview, never auto-publish.
    const flags = await fetchAutoPublishFlags();
    if (flags.news) {
      await publishDigest(post, ids);
    } else {
      await sendPreview(post, ids);
    }
  }

  async function onDigestPostCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    if (data === DIGEST_POST_CALLBACK.CANCEL) {
      pending = null;
      await ackSilently(ctx, { text: "Отменено." });
      await ctx.editMessageReplyMarkup().catch(logEditError("digest-post cancel markup"));
      await ctx
        .editMessageText("❌ Дайджест отменён — пункты остались в очереди на завтра.")
        .catch(logEditError("digest-post cancel text"));
      return;
    }
    if (data === DIGEST_POST_CALLBACK.REBUILD) {
      await ackSilently(ctx, { text: "Пересобираю…" });
      pending = null;
      await ctx.editMessageReplyMarkup().catch(logEditError("digest-post rebuild markup"));
      const queue = store.listDigestQueue().slice(0, CONFIG.DIGEST_MAX_ITEMS);
      try {
        const post = await buildDigestPost(queue, store);
        await sendPreview(
          post,
          queue.map((c) => c.id),
        );
      } catch (err) {
        await notify(`⚠️ Не удалось пересобрать дайджест: ${String(err)}`);
      }
      return;
    }
    // PUBLISH. Clear pending up front so a double-tap can't publish twice
    // (claimDigestBatch is the second, DB-level guard).
    if (!pending) {
      await ackSilently(ctx, { text: "Нет готового дайджеста." });
      return;
    }
    const draft = pending;
    pending = null;
    await ackSilently(ctx, { text: "Публикую…" });
    await ctx.editMessageReplyMarkup().catch(logEditError("digest-post publish markup"));
    await publishDigest(draft.post, draft.ids);
  }

  return { runDigestPost, onDigestPostCallback, isDigestPostCallback };
}
