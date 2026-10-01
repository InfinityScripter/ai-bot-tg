import { escapeHtml } from "../feeds/index.js";

import type { IssueItem } from "./types.js";

/** sendMessage takes at most 4096 characters. */
export const TEXT_LIMIT = 4096;

/**
 * The issue as one Telegram HTML message, for when Telegram rejects the rich
 * article: bold headings, the card text and its `#rubric` line, no
 * photos. Whole cards are cut from the end (a cut inside a card would break
 * its tags) until the message fits; throws when not even one card fits.
 */
export function buildFallbackText(title: string, items: IssueItem[]): string {
  const head = `<b>${escapeHtml(title)}</b>`;
  const cards = items.map(
    (item) =>
      `<b>${escapeHtml(item.emoji)} ${escapeHtml(item.title)}</b>\n${item.html}\n` +
      `#${escapeHtml(item.rubric)}`,
  );
  for (let n = cards.length; n > 0; n -= 1) {
    const text = [head, ...cards.slice(0, n)].join("\n\n");
    if (text.length <= TEXT_LIMIT) return text;
  }
  throw new Error("выпуск не влезает в 4096 символов даже с одной новостью");
}
