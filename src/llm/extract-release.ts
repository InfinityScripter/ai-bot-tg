import Anthropic from "@anthropic-ai/sdk";

import { CONFIG } from "../config.js";
import { ReleaseSchema } from "../types.js";
import { chatUrl, PROVIDERS, resolveActiveProvider } from "./providers.js";
import { ProviderKind, ProviderName as ProviderNameEnum } from "../enums.js";
import {
  buildReleaseUserContent as buildUserContent,
  EXTRACT_RELEASE_SYSTEM_PROMPT as SYSTEM_PROMPT,
} from "./prompts.js";

import type { CandidateStore } from "../store/index.js";
import type { FeedItem, ReleaseResult } from "../types.js";
import type { ProviderName, ProviderSpec } from "./providers.js";

const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

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

/** Extracts the text from the first text content block of a message response. */
function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

/** Pulls the first balanced-looking JSON object out of a text blob. */
function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** Parses, validates and normalizes a raw JSON string from either provider. */
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

/** Extracts via Claude (Anthropic) with the given model. */
async function extractWithAnthropic(item: FeedItem, model: string): Promise<ReleaseResult> {
  const response = await client.messages.create({
    model,
    max_tokens: CONFIG.REWRITE_MAX_TOKENS,
    temperature: CONFIG.REWRITE_TEMPERATURE,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserContent(item) }],
  });

  // 'refusal' may not be in this SDK version's StopReason union — compare as a
  // widened string so the guard works regardless of SDK version.
  if ((response.stop_reason as string) === "refusal") {
    throw new Error("Claude отказался обрабатывать релиз (refusal).");
  }
  return finalizeRelease(extractJson(extractText(response)), item);
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Extracts via any OpenAI-compatible chat-completions endpoint (Gemini, GLM,
 * DeepSeek, OpenRouter). No SDK — a single fetch. response_format=json_object
 * nudges the model toward pure JSON, but we still extract+validate defensively.
 */
async function extractWithOpenAICompat(
  item: FeedItem,
  spec: ProviderSpec,
  model: string,
): Promise<ReleaseResult> {
  let response: Response;
  try {
    response = await fetch(chatUrl(spec), {
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
        max_tokens: CONFIG.REWRITE_MAX_TOKENS,
        temperature: CONFIG.REWRITE_TEMPERATURE,
      }),
    });
  } catch (err) {
    throw new Error(`Не удалось связаться с ${spec.label}: ${String(err)}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${spec.label} ответил ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as OpenAIChatResponse;
  const text = data.choices?.[0]?.message?.content ?? "";
  return finalizeRelease(extractJson(text), item);
}

/**
 * Extracts a structured ModelRelease from a feed item. Resolves the active
 * provider + model at call time (a stored /model override wins over the env
 * default), then dispatches to Claude / an OpenAI-compatible endpoint / mock.
 * Throws on refusal or invalid output — the caller marks the candidate
 * rewrite_failed and surfaces the error, so one failure never aborts the batch.
 */
export async function extractRelease(
  item: FeedItem,
  store: CandidateStore,
): Promise<ReleaseResult> {
  const { provider, model } = resolveActiveProvider(store);
  return extractWith(item, provider, model);
}

/** Dispatches an extraction to a specific provider+model. */
async function extractWith(
  item: FeedItem,
  provider: ProviderName,
  model: string,
): Promise<ReleaseResult> {
  if (provider === ProviderNameEnum.Mock) {
    return mockRelease(item);
  }
  const spec = PROVIDERS[provider];
  if (spec.kind === ProviderKind.Anthropic) {
    return extractWithAnthropic(item, model);
  }
  return extractWithOpenAICompat(item, spec, model);
}
