import { CONFIG } from "../config.js";

/**
 * Default RSS feeds and the env override that replaces them. Kept apart from
 * the parser (pure config data, mirrors the marker-list modules) so the list
 * is editable without touching parsing logic, and importable by tests.
 */

// Russian-first TECH feeds — dev/IT, hardware, AI/ML. Chosen for delivering
// real article BODY text (not headline-only), measured live with rss-parser;
// bodyLen noted below is from the first item on a sample fetch. Habr exposes
// its body in <content:encoded>, which mapFeed reads.
//
// NOTE: the RSS_FEEDS env var (see .env.example) REPLACES this whole list —
// it's all-or-nothing, not additive; set it to override every default at once.
export const DEFAULT_FEEDS: string[] = [
  // dev / IT
  "https://habr.com/ru/rss/best/daily/?fl=ru", // лучшее на Habr за день, body ~1860
  "https://www.opennet.ru/opennews/opennews_all_utf.rss", // open-source / безопасность, body ~470
  // hardware / гаджеты
  "https://3dnews.ru/news/rss", // железо, body ~210, image
  "https://www.ixbt.com/export/news.rss", // железо/гаджеты, body ~1360
  // AI / ML
  "https://habr.com/ru/rss/hubs/machine_learning/articles/?fl=ru", // ML, body ~1650
  "https://habr.com/ru/rss/hubs/artificial_intelligence/articles/?fl=ru", // ИИ, body ~210
  // EN AI-frontier — all live-verified parseable via rss-parser (see task run).
  "http://export.arxiv.org/rss/cs.AI", // arXiv cs.AI abstracts, body ~1660
  "http://export.arxiv.org/rss/cs.CL", // arXiv cs.CL (NLP/LLM) abstracts, body ~1610
  "https://deepmind.google/blog/rss.xml", // Google DeepMind blog, headline-led
  "https://simonwillison.net/atom/everything/", // Simon Willison — LLM/AI eng, Atom
  "https://hnrss.org/newest?q=AI+OR+LLM", // Hacker News newest matching AI/LLM, body ~400
  // OpenAI news RSS dropped: served gzip that rss-parser can't decode (parse error).
];

/** Resolves the active feed list: RSS_FEEDS override, else the defaults. */
export function resolveFeeds(): string[] {
  if (CONFIG.RSS_FEEDS && CONFIG.RSS_FEEDS.trim()) {
    return CONFIG.RSS_FEEDS.split(",")
      .map((f) => f.trim())
      .filter(Boolean);
  }
  return DEFAULT_FEEDS;
}
