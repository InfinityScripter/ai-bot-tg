import Anthropic from "@anthropic-ai/sdk";

import { CONFIG } from "../config.js";
import { ProviderKind, ProviderName } from "../enums.js";
import { chatUrl, PROVIDERS, resolveActiveProvider } from "./providers.js";
import {
  RELEVANCE_SYSTEM_PROMPT as SYSTEM_PROMPT,
  buildRelevanceUserContent as buildUserContent,
} from "./prompts.js";

import type { FeedItem } from "../types.js";
import type { ProviderSpec } from "./providers.js";
import type { CandidateStore } from "../store/index.js";

const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

/** Pulls the first balanced-looking JSON object out of a text blob. */
function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** Clamps a parsed score to the valid 0..4 range, or null if not a finite number. */
function clampScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(4, Math.round(value)));
}

interface ScoreResponse {
  score?: unknown;
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string } }[];
}

/** Parses a raw JSON blob into a clamped 0..4 score, or null if unusable. */
function parseScore(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ScoreResponse;
    return clampScore(parsed.score);
  } catch {
    return null;
  }
}

/** Extracts the text from the first text content block of a message response. */
function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

/** Classifies via Claude (Anthropic). max_tokens is tiny — only a JSON score. */
async function classifyWithAnthropic(item: FeedItem, model: string): Promise<number | null> {
  const response = await client.messages.create({
    model,
    max_tokens: 120,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserContent(item) }],
  });
  return parseScore(extractJson(extractText(response)));
}

/** Classifies via any OpenAI-compatible endpoint (Gemini, GLM, DeepSeek). */
async function classifyWithOpenAICompat(
  item: FeedItem,
  spec: ProviderSpec,
  model: string,
): Promise<number | null> {
  const response = await fetch(chatUrl(spec), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${spec.apiKey()}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserContent(item) },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as OpenAIChatResponse;
  const text = data.choices?.[0]?.message?.content ?? "";
  return parseScore(extractJson(text));
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
  const spec = PROVIDERS[provider];
  try {
    if (spec.kind === ProviderKind.Anthropic) {
      return await classifyWithAnthropic(item, usedModel);
    }
    return await classifyWithOpenAICompat(item, spec, usedModel);
  } catch {
    // Any network/timeout/SDK error → fail open (keep).
    return null;
  }
}
