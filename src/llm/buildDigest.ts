import { CONFIG } from "../config.js";
import { ProviderName } from "../enums.js";
import { completeChatJson } from "./chatCompletion.js";
import { resolveActiveProvider } from "./providers.js";
import { DIGEST_SYSTEM_PROMPT, buildDigestUserContent } from "./prompts.js";

import type { CandidateStore } from "../store/index.js";
import type { RecentPost } from "../blog/fetchRecentPosts.js";

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
  const items = posts.map((post) => `<li>${post.title}</li>`).join("");
  return {
    subject: `AI-дайджест: ${posts.length} постов за неделю`,
    html: `<h2>Дайджест недели</h2><ul>${items}</ul><p>{{ВЕРДИКТ}}</p>`,
  };
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

/**
 * Builds a weekly digest email from the week's posts. Resolves the active
 * provider + model at call time (a stored /model override wins over the env
 * default), then dispatches through the shared chat core (or the no-LLM mock) —
 * the SAME core the rewriter and release extractor use. Throws on refusal or
 * invalid output so the /digest flow surfaces the error in the owner DM.
 */
export async function buildDigest(posts: RecentPost[], store: CandidateStore): Promise<DigestDraft> {
  const { provider, model } = resolveActiveProvider(store);
  if (provider === ProviderName.Mock) {
    return mockDigest(posts);
  }
  const raw = await completeChatJson(provider, model, {
    system: DIGEST_SYSTEM_PROMPT,
    user: buildDigestUserContent(posts),
    maxTokens: CONFIG.REWRITE_MAX_TOKENS,
    temperature: CONFIG.REWRITE_TEMPERATURE,
    refusalLabel: "собирать дайджест",
  });
  return finalizeDigest(raw);
}
