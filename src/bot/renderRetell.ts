import { escapeMarkdown } from "../utils.js";

import type { Candidate, ChannelRetell } from "../types.js";

/** Preview of a retelling exactly as it will appear in the channel. */
export function renderRetellPreview(
  candidate: Candidate,
  retell: ChannelRetell,
  modelLabel: string,
): string {
  return [
    `📣 *Пересказ для канала* (${retell.text.length} симв.)`,
    "",
    escapeMarkdown(retell.text),
    "",
    `🤖 Модель: ${escapeMarkdown(modelLabel)}`,
    `Оригинал: ${escapeMarkdown(candidate.sourceUrl)}`,
  ].join("\n");
}
