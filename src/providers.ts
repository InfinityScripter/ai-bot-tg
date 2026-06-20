import { CONFIG } from './config.js';
import type { CandidateStore } from './store.js';

/** All rewrite backends the bot can use. */
export type ProviderName = 'anthropic' | 'gemini' | 'glm' | 'deepseek' | 'mock';

/** How a provider is called. */
export type ProviderKind = 'anthropic' | 'openai-compat' | 'mock';

/** Static + lazy description of one provider. */
export interface ProviderSpec {
  /** Human label for buttons and error messages. */
  label: string;
  kind: ProviderKind;
  /** Chat-completions base URL — openai-compat only. */
  baseUrl?: string;
  /** Reads the API key from CONFIG lazily (so test re-imports pick up stubs). */
  apiKey: () => string | undefined;
  /** Default model when no explicit override is set. */
  defaultModel: string;
  /** Static model list used when the live /models lookup is unavailable. */
  fallbackModels: string[];
}

/**
 * The provider registry — the single source of truth shared by the rewriter,
 * the /models listing, the ping check, and the /model bot command. URLs and key
 * accessors live here so adding a provider touches exactly one place.
 */
export const PROVIDERS: Record<ProviderName, ProviderSpec> = {
  anthropic: {
    label: 'Claude',
    kind: 'anthropic',
    apiKey: () => CONFIG.ANTHROPIC_API_KEY,
    defaultModel: CONFIG.REWRITE_MODEL,
    fallbackModels: ['claude-haiku-4-5', 'claude-sonnet-4-6'],
  },
  gemini: {
    label: 'Gemini',
    kind: 'openai-compat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: () => CONFIG.GEMINI_API_KEY,
    defaultModel: CONFIG.GEMINI_MODEL,
    fallbackModels: ['gemini-2.0-flash', 'gemini-2.5-flash'],
  },
  glm: {
    label: 'GLM',
    kind: 'openai-compat',
    // Z.ai's OpenAI-compatible base (paas/v4); chat at {baseUrl}/chat/completions.
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiKey: () => CONFIG.GLM_API_KEY,
    defaultModel: CONFIG.GLM_MODEL,
    // The *-flash variants are FREE and verified working, but the live /models
    // list returns only PAID models — so these must be in the fallback to ever
    // appear as buttons. Free ones first.
    fallbackModels: ['glm-4.7-flash', 'glm-4.5-flash', 'glm-4.6', 'glm-4.5-air'],
  },
  deepseek: {
    label: 'DeepSeek',
    kind: 'openai-compat',
    baseUrl: 'https://api.deepseek.com',
    apiKey: () => CONFIG.DEEPSEEK_API_KEY,
    defaultModel: CONFIG.DEEPSEEK_MODEL,
    fallbackModels: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat'],
  },
  mock: {
    label: 'Mock (без LLM)',
    kind: 'mock',
    apiKey: () => 'mock',
    defaultModel: 'mock',
    fallbackModels: ['mock'],
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

/** The chat-completions URL for an openai-compat provider. */
export function chatUrl(spec: ProviderSpec): string {
  return `${spec.baseUrl}/chat/completions`;
}

/** The env-configured default provider (mock if forced), with no override. */
function envDefaultProvider(): ProviderName {
  if (CONFIG.REWRITE_MOCK) return 'mock';
  return CONFIG.REWRITE_PROVIDER as ProviderName;
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
  if (CONFIG.REWRITE_MOCK) {
    return { provider: 'mock', model: PROVIDERS.mock.defaultModel };
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
  if (CONFIG.REWRITE_MOCK) return false;
  const override = store.getModelOverride();
  return override !== null && isProviderName(override.provider);
}
