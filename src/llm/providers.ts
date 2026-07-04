import { CONFIG } from "../config.js";
import { ProviderKind, ProviderName } from "../enums.js";

import type { ProviderSpec } from "./types.js";
import type { CandidateStore } from "../store/index.js";

/**
 * The provider registry — the single source of truth shared by the rewriter,
 * the /models listing, the ping check, and the /model bot command. URLs and key
 * accessors live here so adding a provider touches exactly one place. (Price
 * hints live in modelPrices.ts; the call mechanics in chatCompletion.ts.)
 */
export const PROVIDERS: Record<ProviderName, ProviderSpec> = {
  [ProviderName.Anthropic]: {
    label: "Claude",
    kind: ProviderKind.Anthropic,
    apiKey: () => CONFIG.ANTHROPIC_API_KEY,
    defaultModel: CONFIG.REWRITE_MODEL,
    fallbackModels: ["claude-haiku-4-5", "claude-sonnet-4-6"],
  },
  [ProviderName.Gemini]: {
    label: "Gemini",
    kind: ProviderKind.OpenAICompat,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: () => CONFIG.GEMINI_API_KEY,
    defaultModel: CONFIG.GEMINI_MODEL,
    // gemini-2.0-flash is no longer served; 2.5-flash is the current free-tier floor.
    fallbackModels: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
  },
  [ProviderName.Glm]: {
    label: "GLM",
    kind: ProviderKind.OpenAICompat,
    // Z.ai's OpenAI-compatible base (paas/v4); chat at {baseUrl}/chat/completions.
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKey: () => CONFIG.GLM_API_KEY,
    defaultModel: CONFIG.GLM_MODEL,
    // The *-flash variants are FREE and verified working, but the live /models
    // list returns only PAID models — so these must be in the fallback to ever
    // appear as buttons. Free ones first.
    fallbackModels: ["glm-4.7-flash", "glm-4.5-flash", "glm-4.6", "glm-4.5-air"],
  },
  [ProviderName.DeepSeek]: {
    label: "DeepSeek",
    kind: ProviderKind.OpenAICompat,
    baseUrl: "https://api.deepseek.com",
    apiKey: () => CONFIG.DEEPSEEK_API_KEY,
    defaultModel: CONFIG.DEEPSEEK_MODEL,
    fallbackModels: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat"],
  },
  [ProviderName.OpenRouter]: {
    label: "OpenRouter",
    kind: ProviderKind.OpenAICompat,
    // OpenRouter's OpenAI-compatible base; chat at {baseUrl}/chat/completions,
    // models at {baseUrl}/models. One key proxies many upstreams, so a single
    // working endpoint dodges per-provider geo/network blocks (e.g. api.z.ai).
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: () => CONFIG.OPENROUTER_API_KEY,
    defaultModel: CONFIG.OPENROUTER_MODEL,
    // Namespaced ids, live-tested for actual rewrite output (not just a 200):
    //   deepseek-chat / gemini-2.5-flash → clean text, finish_reason "stop".
    //   z-ai/glm-4.7-flash → a REASONING model: puts thoughts in `reasoning`,
    //     leaves `content` null until it stops — breaks the rewriter. Excluded.
    //   qwen :free → constant upstream 429s; unreliable. Excluded from default.
    // deepseek-chat is cheap ($0.20/$0.80 за 1M) — ~$4/yr at 15/run, inside the
    // $5 free-tier credit, so it runs without topping up.
    fallbackModels: ["deepseek/deepseek-chat", "google/gemini-2.5-flash"],
  },
  [ProviderName.Mock]: {
    label: "Mock (без LLM)",
    kind: ProviderKind.Mock,
    apiKey: () => "mock",
    defaultModel: "mock",
    fallbackModels: ["mock"],
  },
};

/** All provider names, in registry order. */
export function providerNames(): ProviderName[] {
  return Object.keys(PROVIDERS) as ProviderName[];
}

/** True if a string is a known provider name. */
export function isProviderName(value: string): value is ProviderName {
  return value in PROVIDERS;
}

/**
 * Providers the admin panel's "Провайдер" dropdown may select. anthropic/gemini
 * are excluded (gemini is geo-limited from RU; anthropic's ping is
 * key-presence-only); mock is excluded because the panel has a dedicated mock
 * TOGGLE — listing it as a provider too was redundant. All stay in PROVIDERS so
 * the Telegram /model path keeps working — only the admin dropdown is narrowed.
 */
export const CONTROL_PROVIDERS = [
  ProviderName.Glm,
  ProviderName.DeepSeek,
  ProviderName.OpenRouter,
] as const;

/** A provider name the admin panel is allowed to select. */
export type ControlProviderName = (typeof CONTROL_PROVIDERS)[number];

/** True if a string is an admin-controllable provider name. */
export function isControlProvider(value: string): value is ControlProviderName {
  return (CONTROL_PROVIDERS as readonly string[]).includes(value);
}

/** The chat-completions URL for an openai-compat provider. */
export function chatUrl(spec: ProviderSpec): string {
  return `${spec.baseUrl}/chat/completions`;
}

/** The env-configured default provider (mock if forced), with no override. */
function envDefaultProvider(): ProviderName {
  if (CONFIG.REWRITE_MOCK) return ProviderName.Mock;
  return CONFIG.REWRITE_PROVIDER;
}

/**
 * Resolves the provider/model to use right now: REWRITE_MOCK forces 'mock';
 * otherwise a valid stored override wins; otherwise the env default provider
 * with its default model. An override naming an unknown provider is ignored.
 * Read on every rewrite so a /model switch applies without a restart.
 */
export function resolveActiveProvider(store: CandidateStore): {
  provider: ProviderName;
  model: string;
} {
  // A db mock override is strictly authoritative over the env REWRITE_MOCK, so
  // toggling mock OFF in the admin panel truly disables it even if the env
  // forces it on (and ON works the same way).
  const mockDb = store.getMockOverride();
  const forceMock = mockDb ? mockDb.enabled : CONFIG.REWRITE_MOCK;
  if (forceMock) {
    return { provider: ProviderName.Mock, model: PROVIDERS[ProviderName.Mock].defaultModel };
  }
  const override = store.getModelOverride();
  if (override) {
    if (isProviderName(override.provider)) {
      return { provider: override.provider, model: override.model };
    }
    // Override names a provider that no longer exists — ignore it, use env.
    // eslint-disable-next-line no-console
    console.warn(`[providers] ignoring override for unknown provider "${override.provider}"`);
  }
  const provider = envDefaultProvider();
  return { provider, model: PROVIDERS[provider].defaultModel };
}

/**
 * True only when a *valid, active* override is in effect (not when a stale row
 * names a provider that was removed). The bot uses this for the "источник"
 * label so it never claims "override" while actually running the env default.
 */
export function hasActiveOverride(store: CandidateStore): boolean {
  const mockDb = store.getMockOverride();
  const forceMock = mockDb ? mockDb.enabled : CONFIG.REWRITE_MOCK;
  if (forceMock) return false;
  const override = store.getModelOverride();
  return override !== null && isProviderName(override.provider);
}

/**
 * True when the runtime mock (без LLM) mode is active: a db mock override is
 * strictly authoritative over env REWRITE_MOCK. Used by the bot's /model menu
 * to show the mock toggle in the right state.
 */
export function isMockActive(store: CandidateStore): boolean {
  const mockDb = store.getMockOverride();
  return mockDb ? mockDb.enabled : CONFIG.REWRITE_MOCK;
}
