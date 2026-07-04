import { CONFIG } from "../config.js";
import { ProviderName } from "../enums.js";
import { normalizeTags } from "../blog/index.js";
import { truncate, stripHtml } from "../utils.js";
import { completeChatJson } from "./chatCompletion.js";
import { resolveActiveProvider } from "./providers.js";
import { ensureSourceLine } from "./ensureSourceLine.js";
import { RewriteSchema } from "../schemas/rewriteSchema.js";
import { REWRITE_SYSTEM_PROMPT, buildRewriteUserContent } from "./prompts.js";

import type { CandidateStore } from "../store/index.js";
import type { FeedItem, RewriteResult } from "../types.js";

/**
 * Builds a post from the feed item directly, with NO LLM call. Used when
 * REWRITE_MOCK is on (or REWRITE_PROVIDER=mock), so the collect → approve →
 * publish pipeline can be tested without API credits. Output is a faithful copy
 * of the source, not a rewrite — never enable this in production.
 */
function mockRewrite(item: FeedItem): RewriteResult {
  const snippet = stripHtml(item.snippet).trim();
  // RSS often gives only a title (empty snippet) — fall back to the title as the
  // lede rather than repeating it twice. The real LLM path writes a full body.
  const lede = snippet || item.title;
  // Some feeds (Meduza) ship very long titles — clamp so the post heading stays
  // readable. The page already shows this as the heading, so the body must NOT
  // repeat it (no leading "## title", which rendered larger than the page H1).
  const title = truncate(item.title, 100);
  const description = truncate(lede, 200);
  // Drop the cover (shown by the page already); embed the rest of the images so
  // the mock body isn't a flat wall of text either.
  const bodyImages = item.imageUrls.slice(1, 4).map((u) => `![](${u})`);
  const content = [
    snippet || "_Полный текст доступен по ссылке на источник._",
    ...(bodyImages.length ? ["", ...bodyImages] : []),
    "",
    `Источник: [${item.feedTitle || "оригинал"}](${item.url})`,
  ].join("\n");
  return {
    title,
    description,
    content,
    // normalizeTags force-includes 'новости'; the mock has no topical tags to add.
    tags: normalizeTags([]),
    metaTitle: truncate(item.title, 70),
    metaDescription: truncate(lede, 155),
  };
}

/**
 * Strips any Markdown image whose URL is not in the allow-list. Guards against
 * a model inventing image URLs (or echoing the cover): only images that came
 * from the feed survive. Leaves the surrounding text untouched.
 */
function sanitizeImages(content: string, allowed: string[]): string {
  const allow = new Set(allowed);
  return (
    content
      .replace(/!\[[^\]]*\]\(([^)]+)\)/g, (full, url: string) =>
        allow.has(url.trim()) ? full : "",
      )
      // collapse blank-line runs left behind by removed images
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Parses, validates and post-processes a raw JSON string from any provider.
 * Exported so the eval harness can push a recorded/live model reply through the
 * exact production post-processing (image sanitize + source-line self-heal + tag
 * normalize + title clamp) rather than reimplementing it and drifting.
 */
export function finalizeRewrite(raw: string | null, item: FeedItem): RewriteResult {
  if (!raw) {
    throw new Error("LLM не вернул JSON в ответе.");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("LLM вернул невалидный JSON.");
  }
  const parsed = RewriteSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Ответ LLM не прошёл валидацию: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  // Only allow body images (cover excluded — the page shows it). Defensive
  // clamp on the title keeps the heading readable even if the hint is ignored.
  // normalizeTags is the safety net for the tag list — it forces 'новости'
  // first, drops anything off the whitelist, maps synonyms, and caps at 4, so
  // the published tags/metaKeywords are always the clean curated set. Applied
  // here so EVERY provider path gets it.
  const allowed = item.imageUrls.slice(1);
  // Run source-line self-heal AFTER sanitizeImages so all provider paths land a
  // clean canonical `Источник:` line once (the mock path builds its own).
  const content = ensureSourceLine(
    sanitizeImages(parsed.data.content, allowed),
    item.feedTitle,
    item.url,
  );
  return {
    ...parsed.data,
    title: truncate(parsed.data.title, 100),
    content,
    tags: normalizeTags(parsed.data.tags),
  };
}

/**
 * Rewrites a feed item into a unique blog post. Resolves the active provider +
 * model at call time (a stored /model override wins over the env default), then
 * dispatches through the shared chat core (or the no-LLM mock). Throws on
 * refusal or invalid output — the caller marks the candidate rewrite_failed and
 * surfaces the error in the Telegram DM, so one failure never aborts the batch.
 */
export async function rewriteToPost(item: FeedItem, store: CandidateStore): Promise<RewriteResult> {
  const { provider, model } = resolveActiveProvider(store);
  if (provider === ProviderName.Mock) {
    return mockRewrite(item);
  }
  const raw = await completeChatJson(provider, model, {
    system: REWRITE_SYSTEM_PROMPT,
    user: buildRewriteUserContent(item),
    maxTokens: CONFIG.REWRITE_MAX_TOKENS,
    temperature: CONFIG.REWRITE_TEMPERATURE,
    refusalLabel: "обрабатывать новость",
  });
  return finalizeRewrite(raw, item);
}
