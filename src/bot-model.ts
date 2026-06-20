import { PROVIDERS, isProviderName, providerNames } from './providers.js';
import type { ProviderName } from './providers.js';

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
 */
export const CB = {
  PROVIDER: 'mp_',
  MODEL: 'mm_',
  RESET: 'mreset',
  BACK: 'mback',
} as const;

/** A button: a label and the callback data it carries. */
export interface ButtonSpec {
  text: string;
  data: string;
}

/** Encodes the provider-pick callback data. */
export function encodeProvider(provider: ProviderName): string {
  return `${CB.PROVIDER}${provider}`;
}

/**
 * Encodes a model-pick. Provider and model are joined with '__' — model ids can
 * contain a single '-' or '.', but not '__', so the split is unambiguous.
 */
export function encodeModel(provider: ProviderName, model: string): string {
  return `${CB.MODEL}${provider}__${model}`;
}

export type ParsedCallback =
  | { kind: 'provider'; provider: ProviderName }
  | { kind: 'model'; provider: ProviderName; model: string }
  | { kind: 'reset' }
  | { kind: 'back' }
  | null;

/** Decodes /model callback data, or null if it isn't a /model callback. */
export function parseCallback(data: string): ParsedCallback {
  if (data === CB.RESET) return { kind: 'reset' };
  if (data === CB.BACK) return { kind: 'back' };

  if (data.startsWith(CB.MODEL)) {
    const rest = data.slice(CB.MODEL.length);
    const sep = rest.indexOf('__');
    if (sep === -1) return null;
    const provider = rest.slice(0, sep);
    const model = rest.slice(sep + 2);
    if (!isProviderName(provider) || !model) return null;
    return { kind: 'model', provider, model };
  }

  if (data.startsWith(CB.PROVIDER)) {
    const provider = data.slice(CB.PROVIDER.length);
    if (!isProviderName(provider)) return null;
    return { kind: 'provider', provider };
  }

  return null;
}

/** One row of provider buttons; a 🔑 marks a provider with no API key set. */
export function providerButtons(): ButtonSpec[] {
  return providerNames().map((name) => {
    const spec = PROVIDERS[name];
    const hasKey = spec.kind === 'mock' || Boolean(spec.apiKey());
    return { text: `${spec.label}${hasKey ? '' : ' 🔑'}`, data: encodeProvider(name) };
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
    if (Buffer.byteLength(data, 'utf8') <= MAX_CALLBACK_BYTES) {
      rows.push({ text: m, data });
    }
  }
  rows.push({ text: '← Провайдеры', data: CB.BACK });
  return rows;
}

/** The status line shown by /model: active provider+model and its source. */
export function statusText(active: { provider: ProviderName; model: string }, hasOverride: boolean): string {
  const label = PROVIDERS[active.provider].label;
  const source = hasOverride ? 'override' : 'env';
  return `Текущая модель: ${label} / ${active.model} (источник: ${source})\n\nВыберите провайдера:`;
}
