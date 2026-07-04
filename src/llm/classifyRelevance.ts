import { CONFIG } from "../config.js";
import { ProviderName } from "../enums.js";
import { completeChatJson } from "./chatCompletion.js";
import { resolveActiveProvider } from "./providers.js";
import { RELEVANCE_SYSTEM_PROMPT, buildRelevanceUserContent } from "./prompts.js";

import type { FeedItem } from "../types.js";
import type { CandidateStore } from "../store/index.js";

/** The classify reply is a tiny JSON score — cap the output tokens accordingly. */
const CLASSIFY_MAX_TOKENS = 120;

/** Clamps a parsed score to the valid 0..4 range, or null if not a finite number. */
function clampScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(4, Math.round(value)));
}

/** Parses a raw JSON blob into a clamped 0..4 score, or null if unusable. */
function parseScore(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { score?: unknown };
    return clampScore(parsed.score);
  } catch {
    return null;
  }
}

/**
 * Asks the active provider for a 0–4 relevance score. Resolves provider/model
 * via resolveActiveProvider (a /model override wins over the env default); the
 * model is RELEVANCE_MODEL when set, else the active model. FAILS OPEN: provider
 * 'mock', any error/timeout, or an unparsable response all return null — the
 * orchestrator treats null as KEEP, so the filter can never swallow the queue.
 */
export async function classifyRelevance(
  item: FeedItem,
  store: CandidateStore,
): Promise<number | null> {
  const { provider, model } = resolveActiveProvider(store);
  if (provider === ProviderName.Mock) return null;
  const usedModel = CONFIG.RELEVANCE_MODEL ?? model;
  try {
    const raw = await completeChatJson(provider, usedModel, {
      system: RELEVANCE_SYSTEM_PROMPT,
      user: buildRelevanceUserContent(item),
      maxTokens: CLASSIFY_MAX_TOKENS,
      refusalLabel: "оценивать релевантность",
    });
    return parseScore(raw);
  } catch {
    // Any network/timeout/provider error → fail open (keep).
    return null;
  }
}
