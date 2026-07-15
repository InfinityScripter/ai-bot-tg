import { CONFIG } from "../config.js";
import { ProviderName } from "../enums.js";
import { normalizeTags } from "../blog/index.js";
import { truncate, stripHtml } from "../utils.js";
import { completeChatJson } from "./chatCompletion.js";
import { resolveActiveProvider } from "./providers.js";
import { ensureSourceLine } from "./ensureSourceLine.js";
import { RewriteSchema } from "../schemas/rewriteSchema.js";
import { extractHttpUrls, sanitizeMarkdown } from "./sanitizeMarkdown.js";
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
  const rawContent = [
    snippet || "_Полный текст доступен по ссылке на источник._",
    ...(bodyImages.length ? ["", ...bodyImages] : []),
    "",
    `Источник: [${item.feedTitle || "оригинал"}](${item.url})`,
  ].join("\n");
  const content = finalizeContent(rawContent, item);
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

/** Extracts prose-link candidates owned by the input item. */
function sourceUrls(item: FeedItem): string[] {
  return [item.url, ...extractHttpUrls(item.snippet)].filter(Boolean);
}

/** Adds attribution, then sanitizes the complete Markdown including metadata. */
function finalizeContent(content: string, item: FeedItem): string {
  const attributed = ensureSourceLine(content, item.feedTitle, item.url);
  return sanitizeMarkdown(attributed, {
    links: sourceUrls(item),
    images: item.imageUrls.slice(1),
  });
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
  // The complete body is parsed as Markdown only after attribution is added, so
  // feed metadata cannot inject a second link or raw HTML after sanitization.
  const content = finalizeContent(parsed.data.content, item);
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
