import { renderMaterials } from "./renderMaterials.js";
import { escapeHtml, visibleText } from "../feeds/index.js";

import type { IssueItem } from "./types.js";

/** sendMessage takes at most 4096 visible characters after HTML entities are parsed. */
export const TEXT_LIMIT = 4096;

/**
 * The issue as one Telegram HTML message, for when Telegram rejects the rich
 * article: bold headings, the card text and its `#rubric` line, no
 * photos. Whole cards are cut from the end (a cut inside a card would break
 * its tags) until the message fits; null when not even one card fits.
 */
export function buildFallbackText(
  title: string,
  items: IssueItem[],
): { text: string; items: IssueItem[] } | null {
  const head = `<b>${escapeHtml(title)}</b>`;
  const cards = items.map((item) => {
    const materials = renderMaterials(item);
    return `<b>${escapeHtml(item.emoji)} ${escapeHtml(item.title)}</b>\n${item.html}\n${
      materials ? `${materials}\n` : ""
    }#${escapeHtml(item.rubric)}`;
  });
  for (let n = cards.length; n > 0; n -= 1) {
    const text = [head, ...cards.slice(0, n)].join("\n\n");
    if (visibleText(text).length <= TEXT_LIMIT) return { text, items: items.slice(0, n) };
  }
  return null;
}
