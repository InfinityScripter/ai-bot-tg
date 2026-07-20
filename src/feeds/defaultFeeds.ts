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
// AI-focused by design: the topic-relevance filter (RELEVANCE_MODE=on) is the
// safety net, but sourcing from AI/ML feeds keeps signal high and saves classify
// calls. Generic RU firehoses (Habr daily-best, 3dnews, ixbt) were removed — they
// were the source of the fashion/celebrity items that leaked to the live feed.
export const DEFAULT_FEEDS: string[] = [
  // RU AI / ML
  "https://habr.com/ru/rss/hubs/machine_learning/articles/?fl=ru", // ML, body ~1650
  "https://habr.com/ru/rss/hubs/artificial_intelligence/articles/?fl=ru", // ИИ, body ~210
  "https://www.opennet.ru/opennews/opennews_all_utf.rss", // open-source / безопасность, body ~470
  // EN AI-frontier — all live-verified parseable via rss-parser.
  "https://export.arxiv.org/rss/cs.AI", // arXiv cs.AI abstracts, body ~1660
  "https://export.arxiv.org/rss/cs.CL", // arXiv cs.CL (NLP/LLM) abstracts, body ~1610
  "https://deepmind.google/blog/rss.xml", // Google DeepMind blog, headline-led
  "https://blog.google/technology/ai/rss/", // Google AI blog, ~20 items, body ~260
  "https://huggingface.co/blog/feed.xml", // Hugging Face blog, headline-led
  "https://www.microsoft.com/en-us/research/feed/", // Microsoft Research, body ~26k
  "https://simonwillison.net/atom/everything/", // Simon Willison — LLM/AI eng, Atom
  "https://hnrss.org/newest?q=AI+OR+LLM", // Hacker News newest matching AI/LLM, body ~400
  // OpenAI news RSS dropped: serves gzip that rss-parser can't decode (parse error).
  // Anthropic (anthropic.com/rss.xml) and Meta (ai.meta.com/blog/rss/) return HTML, not RSS.
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
