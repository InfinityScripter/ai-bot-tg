import type { FeedItem } from "../types.js";
import type { CandidateStore } from "../store/index.js";
import type { ProviderKind, RelevanceMode, RelevanceStage } from "../enums.js";

/**
 * Shared types of the llm module. Pure declarations only — the provider
 * registry, chat core and feature logic live in their own modules (mirrors
 * health/types.ts).
 */

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

/** What a feature asks a model for: prompts + sampling caps + refusal label. */
export interface ChatJsonRequest {
  system: string;
  user: string;
  /** Max output tokens (required — the Anthropic API demands an explicit cap). */
  maxTokens: number;
  /** Sampling temperature; omitted → the provider default. */
  temperature?: number;
  /**
   * Verb phrase for the Anthropic refusal error, e.g. "обрабатывать новость" →
   * "Claude отказался обрабатывать новость (refusal).".
   */
  refusalLabel: string;
}

/** Result of a model ping probe. */
export type PingResult = { ok: true } | { ok: false; error: string };

/** The digest email the model returns: an email subject + plain email HTML. */
export interface DigestDraft {
  subject: string;
  html: string;
}

/** What the filter decided for one item (used for the shadow-mode audit log). */
export interface RelevanceDecision {
  url: string;
  title: string;
  /** What WOULD happen: true = keep, false = drop. */
  kept: boolean;
  /** Which path decided it. */
  stage: RelevanceStage;
  /** The LLM score (0–4), or null when no LLM call was made/usable. */
  score: number | null;
  reason: string;
}

/** Injected classifier — defaults to the real classifyRelevance; tests pass a stub. */
export type ClassifyFn = (item: FeedItem, store: CandidateStore) => Promise<number | null>;

export interface FilterOptions {
  /** Inject a fake classifier so tests never hit the network. */
  classify?: ClassifyFn;
  /** Override the env RELEVANCE_MODE. */
  mode?: RelevanceMode;
  /** Override the env RELEVANCE_THRESHOLD (keep if score >= threshold). */
  threshold?: number;
}
