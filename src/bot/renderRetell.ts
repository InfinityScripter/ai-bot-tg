import { escapeMarkdown } from "../utils.js";
import { visibleText } from "../feeds/index.js";
import { CAPTION_LIMIT } from "../blog/index.js";

import type { Candidate, ChannelRetell } from "../types.js";

/** Preview of a retelling: the text as the channel reader sees it, and what its cover will say. */
export function renderRetellPreview(
  candidate: Candidate,
  retell: ChannelRetell,
  modelLabel: string,
): string {
  const text = visibleText(retell.html);
  const coverTitle = retell.dress ? escapeMarkdown(retell.dress.coverTitle) : "первая строка поста";
  return [
    `📣 *Пересказ для канала* (${text.length} симв.)`,
    ...(text.length > CAPTION_LIMIT
      ? [`⚠️ Пересказ длиннее ${CAPTION_LIMIT} — уйдёт без обложки`]
      : []),
    "",
    escapeMarkdown(text),
    "",
    `🖼 Обложка: ${coverTitle}`,
    `🤖 Модель: ${escapeMarkdown(modelLabel)}`,
    `Оригинал: ${escapeMarkdown(candidate.sourceUrl)}`,
  ].join("\n");
}
