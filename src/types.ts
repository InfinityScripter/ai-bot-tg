import { z } from 'zod';

/** A normalized item pulled from an RSS/Atom feed. */
export interface FeedItem {
  /** Stable dedup key: lowercased, tracking-stripped guid|link. */
  dedupKey: string;
  /** The original article URL (best-effort). */
  url: string;
  title: string;
  /** HTML-stripped snippet or content, used as rewrite input. */
  snippet: string;
  /** Title of the source feed, for attribution. */
  feedTitle: string;
  /** Cover image URL from the feed (enclosure / media:*), if any. */
  imageUrl: string | null;
  /**
   * All usable image URLs for the article: cover first, then every <img> in the
   * body, de-duplicated. Handed to the rewriter so it can illustrate the post.
   */
  imageUrls: string[];
}

/**
 * Lifecycle of a candidate:
 *   collected → rewriting → pending_review → publishing → published
 *                  │              │                 └→ publish_failed
 *                  └→ rewrite_failed   └→ skipped
 */
export type CandidateState =
  | 'collected'
  | 'rewriting'
  | 'rewrite_failed'
  | 'pending_review'
  | 'skipped'
  | 'publishing'
  | 'published'
  | 'publish_failed';

/** A row in the candidates table. */
export interface Candidate {
  id: number;
  dedupKey: string;
  sourceUrl: string;
  sourceTitle: string | null;
  feedTitle: string | null;
  imageUrl: string | null;
  state: CandidateState;
  rewriteJson: string | null;
  tgMessageId: number | null;
  blogPostId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Structured output of the Claude rewrite. Validated with this schema; the
 * blog publish body is derived directly from these fields.
 */
export const RewriteSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).max(8),
  metaTitle: z.string(),
  metaDescription: z.string(),
});

export type RewriteResult = z.infer<typeof RewriteSchema>;

/** The exact body POSTed to the blog's /api/post/new. */
export interface BlogPostBody {
  title: string;
  description: string;
  content: string;
  tags: string[];
  metaTitle: string;
  metaDescription: string;
  metaKeywords: string[];
  /** Cover image URL; omitted → backend applies its default cover. */
  coverUrl?: string;
  publish: 'draft' | 'published';
}
