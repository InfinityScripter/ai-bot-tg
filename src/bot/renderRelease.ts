import { truncate, escapeMarkdown } from "../utils.js";

import type { Candidate, ReleaseResult } from "../types.js";

/** Formats a nullable price ($/1M tokens) — "—" when unknown so a null is visible. */
function fmtPrice(value: number | null): string {
  return value === null ? "—" : `$${value}/1M`;
}

/** Formats a nullable context window — "—" when unknown. */
function fmtContext(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("en-US")} ток.`;
}

/**
 * Renders the RELEASE PREVIEW card (an extracted ModelRelease awaiting publish).
 * Price and context are shown PROMINENTLY — and rendered as "—" when null — so
 * the owner can catch a hallucinated (or wrongly-non-null) number before ✅. All
 * interpolated content is escaped so a model/vendor string can't break Markdown.
 */
export function renderReleasePreview(
  candidate: Candidate,
  release: ReleaseResult,
  modelLabel: string,
): string {
  const changes = release.changes.length
    ? release.changes.map((c) => `• ${escapeMarkdown(truncate(c, 160))}`).join("\n")
    : "_(изменения не указаны)_";
  return [
    `🚀 *${escapeMarkdown(`${release.vendor} ${release.model} ${release.version}`)}*`,
    "",
    `📅 Дата: ${escapeMarkdown(release.releasedAt)}`,
    `💲 Цена: in ${escapeMarkdown(fmtPrice(release.priceIn))} · out ${escapeMarkdown(
      fmtPrice(release.priceOut),
    )}`,
    `📏 Контекст: ${escapeMarkdown(fmtContext(release.contextTokens))}`,
    "",
    "*Изменения:*",
    changes,
    "",
    `🤖 Модель: ${escapeMarkdown(modelLabel)}`,
    `Источник: ${escapeMarkdown(release.sourceName ?? candidate.feedTitle ?? "неизвестен")}`,
    escapeMarkdown(candidate.sourceUrl),
  ].join("\n");
}
