import { truncate, escapeMarkdown } from "./utils.js";

import type { Candidate, RewriteResult } from "./types.js";

/**
 * Renders the RAW card (the source as collected, before any rewrite). All
 * interpolated content is escaped — feed text must not break or hijack the
 * Markdown (e.g. a title containing '*' or '[').
 */
export function renderRaw(candidate: Candidate): string {
  return [
    `📥 *${escapeMarkdown(candidate.sourceTitle ?? candidate.sourceUrl)}*`,
    "",
    escapeMarkdown(truncate(candidate.snippet ?? "", 600)) ||
      "_(нет текста — будет переработан заголовок)_",
    "",
    `Источник: ${escapeMarkdown(candidate.feedTitle ?? "неизвестен")}`,
    escapeMarkdown(candidate.sourceUrl),
    "",
    "_Нажмите «Переработать» — текст перепишет активная модель (см. /model)._",
  ].join("\n");
}

/**
 * Renders the PREVIEW card (the rewritten post awaiting publish), noting which
 * provider/model produced it. All interpolated content is escaped.
 */
export function renderPreview(
  candidate: Candidate,
  rewrite: RewriteResult,
  modelLabel: string,
): string {
  const tags = rewrite.tags.length ? `\n🏷 ${escapeMarkdown(rewrite.tags.join(", "))}` : "";
  // Show the start of the actual body so the owner sees what will be published.
  // Drop Markdown image lines (![](url)) — they publish to the blog but render
  // as ugly raw syntax in a Telegram preview. Collapse blank runs, then clamp.
  const bodyText = rewrite.content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const bodyBlock = bodyText ? ["", "— — —", escapeMarkdown(truncate(bodyText, 500))] : [];
  return [
    `📝 *${escapeMarkdown(rewrite.title)}*`,
    "",
    escapeMarkdown(truncate(rewrite.description, 400)),
    tags,
    ...bodyBlock,
    "",
    `🤖 Модель: ${escapeMarkdown(modelLabel)}`,
    `Источник: ${escapeMarkdown(candidate.feedTitle ?? "неизвестен")}`,
    escapeMarkdown(candidate.sourceUrl),
  ].join("\n");
}

/** The "in progress" placeholder shown while a rewrite runs. */
export function renderRewriting(candidate: Candidate, modelLabel: string): string {
  return [
    `⏳ *Перерабатываю…*`,
    "",
    escapeMarkdown(candidate.sourceTitle ?? candidate.sourceUrl),
    "",
    `🤖 Модель: ${escapeMarkdown(modelLabel)}`,
  ].join("\n");
}

/**
 * Heuristic: does this rewrite error look like the provider rejecting the model
 * id (not a transient rate-limit/network issue)? Matches a 4xx whose text
 * mentions the model — used to auto-clear a stale /model override.
 */
export function isModelNotFound(message: string): boolean {
  const is4xx = /\b(400|404)\b/.test(message);
  const mentionsModel = /model/i.test(message) || /модел/i.test(message);
  return is4xx && mentionsModel;
}
