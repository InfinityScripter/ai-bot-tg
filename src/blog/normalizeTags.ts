/**
 * Curated tag whitelist for bot-published posts. (Default cover fallbacks moved
 * to ./defaultCovers.ts — the tags computed here also drive that topical pick.)
 *
 * The blog is AI/tech-focused and files items under a fixed set of news
 * rubrics. Claude is prompted to choose only whitelisted tags, but free-form
 * output still leaks junk, so `normalizeTags` is the hard safety net applied to
 * every rewrite before publish (both the Claude path and the mock path).
 */

/** Backend files a post under /news when this tag is present — always required. */
export const NEWS_TAG = "новости";

/**
 * Allowed topical tags, lowercase. Kept tight (AI/tech focus + news rubrics) so
 * the published `tags`/`metaKeywords` stay clean. `новости` is included because
 * it is always force-added by `normalizeTags`; the rest are the only topical
 * tags a post may carry.
 */
export const TAG_WHITELIST: readonly string[] = [
  NEWS_TAG, // новости
  "технологии",
  "наука",
  "политика",
  "культура",
  "ai",
  "llm",
  "агенты",
  "нейросети",
  "безопасность",
  "разработка",
  "гаджеты",
  "бизнес",
  "наука и техника",
];

const WHITELIST_SET = new Set(TAG_WHITELIST);

/**
 * Maps common synonyms / English variants onto the canonical whitelisted tag.
 * Applied after lowercase+trim, before the whitelist filter, so e.g. an `ии`
 * tag from Claude survives as `ai` instead of being dropped.
 */
const SYNONYMS: Record<string, string> = {
  ии: "ai",
  "искусственный интеллект": "ai",
  "artificial intelligence": "ai",
  tech: "технологии",
  technology: "технологии",
  technologies: "технологии",
  science: "наука",
  politics: "политика",
  culture: "культура",
  security: "безопасность",
  кибербезопасность: "безопасность",
  development: "разработка",
  dev: "разработка",
  программирование: "разработка",
  gadgets: "гаджеты",
  business: "бизнес",
  neural: "нейросети",
  "neural networks": "нейросети",
  нейросеть: "нейросети",
  agents: "агенты",
  agent: "агенты",
  агент: "агенты",
  news: NEWS_TAG,
};

/** Max topical tags kept (including the mandatory `новости`). */
const MAX_TAGS = 4;

/**
 * Normalizes raw rewrite tags into the curated set actually published:
 * lowercases+trims, maps obvious synonyms, keeps only whitelisted entries,
 * dedupes, ALWAYS puts `новости` first, and caps the total at 4. If nothing
 * else matches, returns just `['новости']`.
 */
export function normalizeTags(rawTags: string[]): string[] {
  const out: string[] = [NEWS_TAG];
  const seen = new Set<string>([NEWS_TAG]);

  for (const raw of rawTags) {
    if (out.length >= MAX_TAGS) break;
    const lowered = raw.toLowerCase().trim();
    if (!lowered) continue;
    const mapped = SYNONYMS[lowered] ?? lowered;
    if (!WHITELIST_SET.has(mapped)) continue;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
  }

  return out;
}
