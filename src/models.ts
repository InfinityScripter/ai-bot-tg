import { ProviderKind } from "./enums.js";
import { PROVIDERS } from "./providers.js";

import type { ProviderName, ProviderSpec } from "./providers.js";

/** Result of a model ping probe. */
export type PingResult = { ok: true } | { ok: false; error: string };

interface ModelsListResponse {
  data?: { id?: string }[];
}

interface ChatProbeResponse {
  choices?: { message?: { content?: string } }[];
}

/** The /models URL for an openai-compat provider. */
function modelsUrl(spec: ProviderSpec): string {
  return `${spec.baseUrl}/models`;
}

/** Network timeout for the interactive /model probes — keep under Telegram's
 * ~15s callback-query expiry so the menu always resolves. */
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Cap on how many models the bot lists. Telegram allows ~100 inline buttons and
 * we render one per row plus a back button; a provider that serves hundreds of
 * models would otherwise produce an oversized (rejected) keyboard.
 */
const MAX_MODELS = 50;

/**
 * Lists the models available for a provider. For openai-compat providers with a
 * key, queries GET {baseUrl}/models (OpenAI shape) with a timeout. On any
 * failure — non-OK, empty, timeout, network error, or missing key — returns the
 * provider's static fallback list. Anthropic/mock have no list endpoint, so they
 * return the fallback directly. The result is always non-empty and capped at
 * MAX_MODELS, so the bot always has a renderable set of buttons.
 */
export async function listModels(provider: ProviderName): Promise<string[]> {
  const spec = PROVIDERS[provider];
  if (spec.kind !== ProviderKind.OpenAICompat) {
    return spec.fallbackModels;
  }
  const key = spec.apiKey();
  if (!key) {
    return spec.fallbackModels;
  }

  try {
    const response = await fetch(modelsUrl(spec), {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return spec.fallbackModels;
    const data = (await response.json()) as ModelsListResponse;
    const live = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    // Merge fallback FIRST, then live. The fallback holds the known-good (often
    // free) models — e.g. GLM's free *-flash variants are absent from the live
    // /models list, which returns only paid models. Listing fallback first
    // guarantees those stay one tap away; de-dupe keeps each id once.
    return dedupe([...spec.fallbackModels, ...live]).slice(0, MAX_MODELS);
  } catch {
    return spec.fallbackModels;
  }
}

/** Order-preserving de-duplication. */
function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (!seen.has(it)) {
      seen.add(it);
      out.push(it);
    }
  }
  return out;
}

/**
 * Probes a provider/model before the bot saves the override. mock → always ok.
 * anthropic → key-presence check only (no cheap public probe; the daily run
 * surfaces real errors) so a Claude model can still be selected. openai-compat →
 * a one-token "ok" request with a timeout; ok only on a 2xx whose body has the
 * expected chat shape (a 200 with an error/HTML body is rejected), a labeled
 * error otherwise.
 */
export async function pingModel(provider: ProviderName, model: string): Promise<PingResult> {
  const spec = PROVIDERS[provider];

  if (spec.kind === ProviderKind.Mock) {
    return { ok: true };
  }
  if (spec.kind === ProviderKind.Anthropic) {
    // No cheap probe here; accept as long as a key is configured so Claude is
    // selectable. A genuinely bad model surfaces at the next /fetch.
    return spec.apiKey()
      ? { ok: true }
      : { ok: false, error: `Для ${spec.label} не задан API-ключ.` };
  }

  const key = spec.apiKey();
  if (!key) {
    return { ok: false, error: `Для ${spec.label} не задан API-ключ.` };
  }

  let response: Response;
  try {
    response = await fetch(`${spec.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ответь одним словом: ok" }],
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut
        ? `Таймаут при обращении к ${spec.label}.`
        : `Не удалось связаться с ${spec.label}: ${String(err)}`,
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { ok: false, error: `${spec.label} ответил ${response.status}: ${text.slice(0, 160)}` };
  }

  // Require the OpenAI chat shape: some gateways return 200 with an error/HTML
  // body on a misrouted URL — that must not count as a working model.
  let data: ChatProbeResponse;
  try {
    data = (await response.json()) as ChatProbeResponse;
  } catch {
    return { ok: false, error: `${spec.label} вернул неожиданный ответ (не JSON).` };
  }
  if (!data.choices?.[0]?.message) {
    return { ok: false, error: `${spec.label}: ответ без choices — модель/endpoint не подходит.` };
  }
  return { ok: true };
}
