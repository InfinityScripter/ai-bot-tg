import { CONFIG } from "../config.js";
import { ProviderName } from "../enums.js";
import { completeChatJson } from "./chatCompletion.js";
import { resolveActiveProvider } from "./providers.js";
import { ReleaseSchema } from "../schemas/releaseSchema.js";
import { buildReleaseUserContent, EXTRACT_RELEASE_SYSTEM_PROMPT } from "./prompts.js";

import type { CandidateStore } from "../store/index.js";
import type { FeedItem, ReleaseResult } from "../types.js";

/**
 * Builds a release directly from the feed item with NO LLM call. Used when the
 * active provider is mock, so the collect → approve → publish pipeline can be
 * exercised without API credits. All prices/context stay null (never invented) —
 * the mock only echoes the source metadata it can see.
 */
function mockRelease(item: FeedItem): ReleaseResult {
  return {
    vendor: item.feedTitle || "unknown",
    model: item.title,
    version: "mock",
    releasedAt: new Date().toISOString(),
    sourceUrl: item.url,
    contextTokens: null,
    priceIn: null,
    priceOut: null,
    changes: [],
    sourceName: item.feedTitle || null,
  };
}

/** Parses, validates and normalizes a raw JSON string from any provider. */
function finalizeRelease(raw: string | null, item: FeedItem): ReleaseResult {
  if (!raw) {
    throw new Error("LLM не вернул JSON в ответе.");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("LLM вернул невалидный JSON.");
  }
  const parsed = ReleaseSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Ответ LLM не прошёл валидацию: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  // Force the source URL to the canonical feed URL — the model must never
  // rewrite it (a hallucinated link would break the changelog source).
  return { ...parsed.data, sourceUrl: item.url };
}

/**
 * Extracts a structured ModelRelease from a feed item. Resolves the active
 * provider + model at call time (a stored /model override wins over the env
 * default), then dispatches through the shared chat core (or the no-LLM mock).
 * Throws on refusal or invalid output — the caller marks the candidate
 * rewrite_failed and surfaces the error, so one failure never aborts the batch.
 */
export async function extractRelease(
  item: FeedItem,
  store: CandidateStore,
): Promise<ReleaseResult> {
  const { provider, model } = resolveActiveProvider(store);
  if (provider === ProviderName.Mock) {
    return mockRelease(item);
  }
  const raw = await completeChatJson(provider, model, {
    system: EXTRACT_RELEASE_SYSTEM_PROMPT,
    user: buildReleaseUserContent(item),
    maxTokens: CONFIG.REWRITE_MAX_TOKENS,
    temperature: CONFIG.REWRITE_TEMPERATURE,
    refusalLabel: "обрабатывать релиз",
  });
  return finalizeRelease(raw, item);
}
