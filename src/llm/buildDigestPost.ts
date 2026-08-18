import { CONFIG } from "../config.js";
import { ProviderName } from "../enums.js";
import { completeChatJson } from "./chatCompletion.js";
import { resolveActiveProvider } from "./providers.js";
import { DigestPostSchema } from "../schemas/digestPostSchema.js";
import { DIGEST_POST_SYSTEM_PROMPT, buildDigestPostUserContent } from "./digestPostPrompt.js";

import type { Candidate } from "../types.js";
import type { CandidateStore } from "../store/index.js";
import type { DigestPost, DigestEntry } from "../schemas/digestPostSchema.js";

/**
 * Builds the digest without an LLM (mock provider): every item becomes a
 * "news" entry from its own title. Exercises the queue → build → preview →
 * publish flow without credits; never the production editorial path.
 */
function mockDigestPost(candidates: Candidate[]): DigestPost {
  return {
    title: `Что нового в мире AI: ${candidates.length} новостей`,
    intro: "Собрали самое важное в одном посте.",
    sections: {
      hot: [],
      news: candidates.map((c) => ({
        url: c.sourceUrl,
        headline: c.sourceTitle || c.sourceUrl,
      })),
      materials: [],
      cases: [],
    },
  };
}

/** Total entry count across all four sections. */
export function countDigestEntries(post: DigestPost): number {
  const { hot, news, materials, cases } = post.sections;
  return hot.length + news.length + materials.length + cases.length;
}

/**
 * Parses + validates the raw LLM JSON into a DigestPost. Entries whose url is
 * not among the source candidates' URLs are DROPPED (the model may only link
 * what it was given — same allow-list policy as finalizeRewrite), and a result
 * with fewer than DIGEST_MIN_ITEMS surviving entries throws, so a degenerate
 * or heavily-hallucinated answer never publishes.
 */
export function finalizeDigestPost(raw: string | null, allowedUrls: Set<string>): DigestPost {
  if (!raw) throw new Error("LLM не вернул JSON в ответе.");
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("LLM вернул невалидный JSON.");
  }
  const parsed = DigestPostSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`Ответ LLM не прошёл валидацию дайджеста: ${parsed.error.message}`);
  }
  const keepAllowed = (entries: DigestEntry[]) =>
    entries.filter((entry) => allowedUrls.has(entry.url));
  const post: DigestPost = {
    ...parsed.data,
    title: parsed.data.title.slice(0, 100),
    sections: {
      hot: keepAllowed(parsed.data.sections.hot),
      news: keepAllowed(parsed.data.sections.news),
      materials: keepAllowed(parsed.data.sections.materials),
      cases: keepAllowed(parsed.data.sections.cases),
    },
  };
  if (countDigestEntries(post) < CONFIG.DIGEST_MIN_ITEMS) {
    throw new Error(
      `После валидации в дайджесте осталось меньше ${CONFIG.DIGEST_MIN_ITEMS} пунктов.`,
    );
  }
  return post;
}

/**
 * Builds the daily digest post from the queued candidates via the active LLM
 * (or the mock). Resolves provider/model at call time (a /model override wins)
 * and dispatches through the same chat core as the rewriter. Throws on
 * refusal/invalid output so the digest flow can surface it to the owner.
 */
export async function buildDigestPost(
  candidates: Candidate[],
  store: CandidateStore,
): Promise<DigestPost> {
  const { provider, model } = resolveActiveProvider(store);
  if (provider === ProviderName.Mock) {
    return mockDigestPost(candidates);
  }
  const raw = await completeChatJson(provider, model, {
    system: DIGEST_POST_SYSTEM_PROMPT,
    user: buildDigestPostUserContent(candidates),
    maxTokens: CONFIG.REWRITE_MAX_TOKENS,
    temperature: CONFIG.REWRITE_TEMPERATURE,
    refusalLabel: "собирать дайджест-пост",
  });
  return finalizeDigestPost(raw, new Set(candidates.map((c) => c.sourceUrl)));
}
