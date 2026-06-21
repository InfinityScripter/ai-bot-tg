import { InlineKeyboard } from "grammy";

import { CARD_CALLBACK } from "./consts.js";

import type { ButtonSpec } from "./bot-model.js";

/** Keyboard for a RAW card: rewrite (with the active model) or skip. */
export function rawKeyboard(candidateId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Переработать", `${CARD_CALLBACK.REWRITE}${candidateId}`)
    .text("❌ Пропустить", `${CARD_CALLBACK.SKIP}${candidateId}`);
}

/** Keyboard for a PREVIEW card: regenerate, publish, or skip. */
export function previewKeyboard(candidateId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Заново", `${CARD_CALLBACK.REWRITE}${candidateId}`)
    .text("✅ Опубликовать", `${CARD_CALLBACK.APPROVE}${candidateId}`)
    .row()
    .text("❌ Пропустить", `${CARD_CALLBACK.SKIP}${candidateId}`);
}

/** Turns pure ButtonSpecs into a one-button-per-row inline keyboard. */
export function keyboardFrom(buttons: ButtonSpec[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const b of buttons) kb.text(b.text, b.data).row();
  return kb;
}
