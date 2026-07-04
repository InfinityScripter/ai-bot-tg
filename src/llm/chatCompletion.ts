import Anthropic from "@anthropic-ai/sdk";

import { CONFIG } from "../config.js";
import { ProviderKind } from "../enums.js";
import { chatUrl, PROVIDERS } from "./providers.js";

import type { ProviderName } from "../enums.js";
import type { ProviderSpec, ChatJsonRequest } from "./types.js";

/**
 * The one provider-agnostic chat-completion core shared by every LLM feature
 * (rewrite, digest, release extraction, relevance classify). Each feature keeps
 * its own prompt, mock and result validation; THIS module owns how a provider is
 * actually called — the Anthropic SDK path and the OpenAI-compatible fetch path,
 * with a single place for auth, sampling params, refusal handling and error
 * labeling. Supporting a new provider kind touches only this file.
 */

// One SDK client for all features (previously duplicated per feature module).
const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

/** Extracts the text from the first text content block of a message response. */
function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

/**
 * Pulls the first balanced-looking JSON object out of a text blob. Exported so
 * the eval harness can mirror the production reply→JSON step on recorded model
 * output (which may carry surrounding prose) instead of duplicating it.
 */
export function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** Calls Claude (Anthropic SDK), with prompt caching on the system block. */
async function completeWithAnthropic(model: string, req: ChatJsonRequest): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: req.maxTokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: req.user }],
  });

  // 'refusal' may not be in this SDK version's StopReason union — compare as a
  // widened string so the guard works regardless of SDK version.
  if ((response.stop_reason as string) === "refusal") {
    throw new Error(`Claude отказался ${req.refusalLabel} (refusal).`);
  }
  return extractText(response);
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Calls any OpenAI-compatible chat-completions endpoint (Gemini, GLM, DeepSeek,
 * OpenRouter). No SDK — a single fetch. response_format=json_object nudges the
 * model toward pure JSON, but callers still extract+validate defensively.
 */
async function completeWithOpenAICompat(
  spec: ProviderSpec,
  model: string,
  req: ChatJsonRequest,
): Promise<string> {
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
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        response_format: { type: "json_object" },
        max_tokens: req.maxTokens,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
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
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * Completes a chat request against a specific provider+model and returns the
 * first JSON object found in the reply, or null when the reply carried none.
 * Throws a readable, provider-labeled Error on refusal / network / non-OK
 * responses. The mock provider never reaches here — each feature builds its own
 * domain mock before dispatching.
 */
export async function completeChatJson(
  provider: ProviderName,
  model: string,
  req: ChatJsonRequest,
): Promise<string | null> {
  const spec = PROVIDERS[provider];
  if (spec.kind === ProviderKind.Mock) {
    throw new Error("Mock-провайдер не имеет chat-endpoint — обрабатывается вызывающим кодом.");
  }
  const text =
    spec.kind === ProviderKind.Anthropic
      ? await completeWithAnthropic(model, req)
      : await completeWithOpenAICompat(spec, model, req);
  return extractJson(text);
}
