import Anthropic from "@anthropic-ai/sdk";

import { CONFIG } from "../config.js";
import { chatUrl, PROVIDERS, resolveActiveProvider } from "./providers.js";
import { ProviderKind, ProviderName as ProviderNameEnum } from "../enums.js";
import {
  DIGEST_SYSTEM_PROMPT as SYSTEM_PROMPT,
  buildDigestUserContent as buildUserContent,
} from "./prompts.js";

import type { CandidateStore } from "../store/index.js";
import type { RecentPost } from "../blog/fetchRecentPosts.js";
import type { ProviderName, ProviderSpec } from "./providers.js";

const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

/** The digest email the model returns: an email subject + plain email HTML. */
export interface DigestDraft {
  subject: string;
  html: string;
}

/**
 * Builds a digest directly from the week's posts with NO LLM call. Used when the
 * active provider is mock, so the /digest → preview → send flow can be exercised
 * without API credits. Output is a bare title list, not an edited digest — never
 * the production path. The {{ВЕРДИКТ}} slot is still emitted so the send path is
 * identical to the real one.
 */
function mockDigest(posts: RecentPost[]): DigestDraft {
  const items = posts
    .map((post) => `<li>${post.title}</li>`)
    .join("");
  return {
    subject: `AI-дайджест: ${posts.length} постов за неделю`,
    html: `<h2>Дайджест недели</h2><ul>${items}</ul><p>{{ВЕРДИКТ}}</p>`,
  };
}

/** Extracts the text from the first text content block of a message response. */
function extractText(response: Anthropic.Message): string {
  const block = response.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : "";
}

/** Pulls the first balanced-looking JSON object out of a text blob. */
function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** Parses and validates a raw JSON string into a DigestDraft. */
function finalizeDigest(raw: string | null): DigestDraft {
  if (!raw) {
    throw new Error("LLM не вернул JSON в ответе.");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("LLM вернул невалидный JSON.");
  }
  const obj = candidate as { subject?: unknown; html?: unknown };
  const subject = typeof obj.subject === "string" ? obj.subject.trim() : "";
  const html = typeof obj.html === "string" ? obj.html.trim() : "";
  if (!subject || !html) {
    throw new Error("Ответ LLM не прошёл валидацию: отсутствует subject или html.");
  }
  return { subject, html };
}

/** Builds the digest via Claude (Anthropic) with the given model. */
async function buildWithAnthropic(posts: RecentPost[], model: string): Promise<DigestDraft> {
  const response = await client.messages.create({
    model,
    max_tokens: CONFIG.REWRITE_MAX_TOKENS,
    temperature: CONFIG.REWRITE_TEMPERATURE,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserContent(posts) }],
  });

  // 'refusal' may not be in this SDK version's StopReason union — compare as a
  // widened string so the guard works regardless of SDK version.
  if ((response.stop_reason as string) === "refusal") {
    throw new Error("Claude отказался собирать дайджест (refusal).");
  }
  return finalizeDigest(extractJson(extractText(response)));
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Builds the digest via any OpenAI-compatible chat-completions endpoint (Gemini,
 * GLM, DeepSeek, OpenRouter). No SDK — a single fetch. response_format=json_object
 * nudges the model toward pure JSON, but we still extract+validate defensively.
 */
async function buildWithOpenAICompat(
  posts: RecentPost[],
  spec: ProviderSpec,
  model: string,
): Promise<DigestDraft> {
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
          { role: "user", content: buildUserContent(posts) },
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
  return finalizeDigest(extractJson(text));
}

/**
 * Builds a weekly digest email from the week's posts. Resolves the active
 * provider + model at call time (a stored /model override wins over the env
 * default), then dispatches to Claude / an OpenAI-compatible endpoint / mock —
 * the SAME dispatch the rewriter and release extractor use. Throws on refusal or
 * invalid output so the /digest flow surfaces the error in the owner DM.
 */
export async function buildDigest(posts: RecentPost[], store: CandidateStore): Promise<DigestDraft> {
  const { provider, model } = resolveActiveProvider(store);
  return buildWith(posts, provider, model);
}

/** Dispatches a digest build to a specific provider+model. */
async function buildWith(
  posts: RecentPost[],
  provider: ProviderName,
  model: string,
): Promise<DigestDraft> {
  if (provider === ProviderNameEnum.Mock) {
    return mockDigest(posts);
  }
  const spec = PROVIDERS[provider];
  if (spec.kind === ProviderKind.Anthropic) {
    return buildWithAnthropic(posts, model);
  }
  return buildWithOpenAICompat(posts, spec, model);
}
