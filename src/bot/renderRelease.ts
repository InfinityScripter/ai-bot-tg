import { renderPreview } from "./render.js";
import { truncate, escapeMarkdown } from "../utils.js";

import type { Candidate, ReleaseBundle, ReleaseResult } from "../types.js";

/** Formats a nullable price ($/1M tokens) — "—" when unknown so a null is visible. */
function fmtPrice(value: number | null): string {
  return value === null ? "—" : `$${value}/1M`;
}

/** Formats a nullable context window — "—" when unknown. */
function fmtContext(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("en-US")} ток.`;
}

/**
 * Renders the changelog card part of a release preview. Price and context are
 * shown PROMINENTLY — and rendered as "—" when null — so the owner can catch a
 * hallucinated (or wrongly-non-null) number before ✅. All interpolated content
 * is escaped so a model/vendor string can't break Markdown.
 */
function renderReleaseCard(candidate: Candidate, release: ReleaseResult): string {
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
    `Источник: ${escapeMarkdown(release.sourceName ?? candidate.feedTitle ?? "неизвестен")}`,
  ].join("\n");
}

/**
 * Renders the RELEASE PREVIEW card: the blog post that will publish (same view
 * as a news preview), then the changelog card that follows it, or a note that
 * there is none.
 */
export function renderReleasePreview(
  candidate: Candidate,
  bundle: ReleaseBundle,
  modelLabel: string,
): string {
  const card = bundle.release
    ? renderReleaseCard(candidate, bundle.release)
    : "_Карточка changelog не извлечена: пост уйдёт без неё._";
  return [renderPreview(candidate, bundle.post, modelLabel), "", "*Changelog:*", card].join("\n");
}
