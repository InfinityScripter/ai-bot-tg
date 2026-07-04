import type { InputKind } from "../enums.js";

/**
 * Shared types of the feeds module. Pure declarations only (mirrors
 * health/types.ts). The domain FeedItem lives in src/types.ts — these are the
 * feeds-internal wire shapes.
 */

/** The result of classifying an owner-sent message (manual ingest). */
export type ClassifiedInput =
  | { kind: InputKind.Url; url: string }
  | { kind: InputKind.Text; text: string }
  | { kind: InputKind.Empty };

/** A Media RSS node as rss-parser returns it (attributes under `$`). */
export interface MediaNode {
  $?: { url?: string; medium?: string; type?: string };
}

/** The custom fields the parser captures on top of rss-parser's Item. */
export interface RssItem {
  /** Full article body, where present (Habr, WordPress feeds). */
  contentEncoded?: string;
  enclosure?: { url?: string; type?: string };
  mediaContent?: MediaNode[];
  mediaThumbnail?: MediaNode[];
}
