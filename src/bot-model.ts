import { CallbackKind, ProviderKind } from "./enums.js";
import { MODEL_CALLBACK, MODEL_CALLBACK_SEP } from "./consts.js";
import { PROVIDERS, providerNames, isProviderName, modelPriceLabel } from "./llm/index.js";

import type { ProviderName } from "./llm/index.js";

/**
 * Pure helpers for the /model command — callback-data encode/decode, button
 * specs, and the status text. Kept free of grammy so they're unit-testable, and
 * so bot.ts only wires them to the Telegram API.
 *
 * Callback data layout (Telegram caps data at 64 bytes; all of these fit):
 *   mp_<provider>            choose a provider → show its models
 *   mm_<provider>__<model>   choose a model (provider + '__' + model)
 *   mreset                   clear the override, back to env default
 *   mback                    back to the provider list
 *   mmock_on / mmock_off     turn the runtime mock (без LLM) override on/off
 */

/** A button: a label and the callback data it carries. */
export interface ButtonSpec {
  text: string;
  data: string;
}

/** Encodes the provider-pick callback data. */
export function encodeProvider(provider: ProviderName): string {
  return `${MODEL_CALLBACK.PROVIDER}${provider}`;
}

/**
 * Encodes a model-pick. Provider and model are joined with '__' — model ids can
 * contain a single '-' or '.', but not '__', so the split is unambiguous.
 */
export function encodeModel(provider: ProviderName, model: string): string {
  return `${MODEL_CALLBACK.MODEL}${provider}${MODEL_CALLBACK_SEP}${model}`;
}

export type ParsedCallback =
  | { kind: CallbackKind.Provider; provider: ProviderName }
  | { kind: CallbackKind.Model; provider: ProviderName; model: string }
  | { kind: CallbackKind.Reset }
  | { kind: CallbackKind.Back }
  | { kind: CallbackKind.MockOn }
  | { kind: CallbackKind.MockOff }
  | null;

/** Decodes /model callback data, or null if it isn't a /model callback. */
export function parseCallback(data: string): ParsedCallback {
  if (data === MODEL_CALLBACK.RESET) return { kind: CallbackKind.Reset };
  if (data === MODEL_CALLBACK.BACK) return { kind: CallbackKind.Back };
  if (data === MODEL_CALLBACK.MOCK_ON) return { kind: CallbackKind.MockOn };
  if (data === MODEL_CALLBACK.MOCK_OFF) return { kind: CallbackKind.MockOff };

  if (data.startsWith(MODEL_CALLBACK.MODEL)) {
    const rest = data.slice(MODEL_CALLBACK.MODEL.length);
    const sep = rest.indexOf(MODEL_CALLBACK_SEP);
    if (sep === -1) return null;
    const provider = rest.slice(0, sep);
    const model = rest.slice(sep + MODEL_CALLBACK_SEP.length);
    if (!isProviderName(provider) || !model) return null;
    return { kind: CallbackKind.Model, provider, model };
  }

  if (data.startsWith(MODEL_CALLBACK.PROVIDER)) {
    const provider = data.slice(MODEL_CALLBACK.PROVIDER.length);
    if (!isProviderName(provider)) return null;
    return { kind: CallbackKind.Provider, provider };
  }

  return null;
}

/** One row of provider buttons; a 🔑 marks a provider with no API key set. */
export function providerButtons(): ButtonSpec[] {
  return providerNames().map((name) => {
    const spec = PROVIDERS[name];
    const hasKey = spec.kind === ProviderKind.Mock || Boolean(spec.apiKey());
    return { text: `${spec.label}${hasKey ? "" : " 🔑"}`, data: encodeProvider(name) };
  });
}

/** Telegram hard-caps callback_data at 64 UTF-8 bytes; a single over-long
 * button makes the WHOLE keyboard fail to render, so we drop offenders. */
const MAX_CALLBACK_BYTES = 64;

/**
 * Model buttons for a provider, plus a "back" button. Any model whose encoded
 * callback_data would exceed Telegram's 64-byte limit is dropped (a live
 * /models id can be arbitrarily long) so one bad id can't break the keyboard.
 */
export function modelButtons(provider: ProviderName, models: string[]): ButtonSpec[] {
  const rows: ButtonSpec[] = [];
  for (const m of models) {
    const data = encodeModel(provider, m);
    if (Buffer.byteLength(data, "utf8") <= MAX_CALLBACK_BYTES) {
      // Append a free/paid price hint when we know one (callback data is
      // unaffected — the label is display-only and stays well under 64 bytes).
      const price = modelPriceLabel(m);
      rows.push({ text: price ? `${m} — ${price}` : m, data });
    }
  }
  rows.push({ text: "← Провайдеры", data: MODEL_CALLBACK.BACK });
  return rows;
}

/**
 * A toggle button for the runtime mock (без LLM) mode. The label reflects the
 * current state and the callback flips it: mock ON → offer "выключить"; mock OFF
 * → offer "включить".
 */
export function mockToggleButton(mockActive: boolean): ButtonSpec {
  return mockActive
    ? { text: "🧪 Mock ВКЛ → выключить", data: MODEL_CALLBACK.MOCK_OFF }
    : { text: "🧪 Mock ВЫКЛ → включить", data: MODEL_CALLBACK.MOCK_ON };
}

/**
 * The status line shown by /model: active provider+model and its source, plus a
 * mock-mode notice when the runtime mock override is on (the post is a copy of
 * the source, no LLM rewrite).
 */
export function statusText(
  active: { provider: ProviderName; model: string },
  hasOverride: boolean,
  mockActive = false,
): string {
  if (mockActive) {
    return "Режим Mock ВКЛ — пост публикуется как копия источника, без LLM.\n\nВыберите провайдера или выключите Mock:";
  }
  const { label } = PROVIDERS[active.provider];
  const source = hasOverride ? "override" : "env";
  return `Текущая модель: ${label} / ${active.model} (источник: ${source})\n\nВыберите провайдера:`;
}
