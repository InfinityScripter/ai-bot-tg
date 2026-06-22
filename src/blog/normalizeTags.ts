/**
 * Curated tag whitelist + cover fallbacks for bot-published posts.
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

/**
 * Stable remote cover URLs used when a feed item has no image and no og:image.
 * Neutral tech/AI photography from the Unsplash CDN (images.unsplash.com) —
 * direct file URLs (not the redirecting source.unsplash.com), so they are
 * stable and hot-linkable. A themed default keeps bot posts from all falling
 * back to the backend's generic placeholder (the "all mock images" problem).
 */
export const DEFAULT_COVERS: readonly string[] = [
  "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1200&q=80", // circuit board
  "https://images.unsplash.com/photo-1620712943543-bcc4688e7485?auto=format&fit=crop&w=1200&q=80", // AI neural abstract
  "https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?auto=format&fit=crop&w=1200&q=80", // matrix code
  "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?auto=format&fit=crop&w=1200&q=80", // cyber security
  "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1200&q=80", // global network
];

/**
 * Deterministically picks a default cover from `DEFAULT_COVERS` by hashing the
 * post title, so the same post always gets the same cover (idempotent retries)
 * while different posts vary (no "everything looks identical" feel). Uses a
 * small FNV-1a-style hash — no crypto dependency needed.
 */
export function pickDefaultCover(title: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < title.length; i += 1) {
    hash ^= title.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const index = Math.abs(hash) % DEFAULT_COVERS.length;
  // DEFAULT_COVERS is a non-empty literal, so the indexed access is defined;
  // the fallback satisfies noUncheckedIndexedAccess without ever triggering.
  return DEFAULT_COVERS[index] ?? DEFAULT_COVERS[0] ?? "";
}
