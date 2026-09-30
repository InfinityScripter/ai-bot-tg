import { escapeMarkdown } from "../utils.js";
import { visibleText } from "../feeds/index.js";

import type { Candidate, ChannelRetell } from "../types.js";

/** Preview of a retelling: the text as the channel reader sees it, and how many photos go with it. */
export function renderRetellPreview(
  candidate: Candidate,
  retell: ChannelRetell,
  modelLabel: string,
  photoCount: number,
): string {
  const text = visibleText(retell.html);
  return [
    `📣 *Пересказ для канала* (${text.length} симв., фото: ${photoCount})`,
    "",
    escapeMarkdown(text),
    "",
    `🤖 Модель: ${escapeMarkdown(modelLabel)}`,
    `Оригинал: ${escapeMarkdown(candidate.sourceUrl)}`,
  ].join("\n");
}
