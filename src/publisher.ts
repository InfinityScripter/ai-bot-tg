import { CONFIG } from './config.js';
import { pickDefaultCover } from './tags.js';
import type { BlogPostBody, RewriteResult } from './types.js';

/**
 * A publish failure that also reports whether the POST MAY have reached the
 * blog. `maybePosted` is true when the request was sent but the outcome is
 * unknown (5xx, a non-201 after send, or an unreadable 201 body) — the caller
 * must then NOT silently re-offer Publish (it could duplicate). It is false only
 * when the post definitely did not happen (could not connect, or a clear 4xx).
 */
export class PublishError extends Error {
  readonly maybePosted: boolean;
  constructor(message: string, maybePosted: boolean) {
    super(message);
    this.name = 'PublishError';
    this.maybePosted = maybePosted;
  }
}

/**
 * Builds the blog post body from a rewrite result and an optional cover image
 * URL (the feed image or scraped og:image). We ALWAYS send a coverUrl now: when
 * the source had no image we pick a deterministic themed default keyed off the
 * title, so bot posts never fall back to the backend's generic placeholder (the
 * "all bot posts look mock" problem). metaKeywords reuse the already-normalized
 * tags, so they're the clean curated set too.
 */
export function toBlogPostBody(rewrite: RewriteResult, coverUrl?: string | null): BlogPostBody {
  return {
    title: rewrite.title,
    description: rewrite.description,
    content: rewrite.content,
    tags: rewrite.tags,
    metaTitle: rewrite.metaTitle,
    metaDescription: rewrite.metaDescription,
    metaKeywords: rewrite.tags,
    coverUrl: coverUrl || pickDefaultCover(rewrite.title),
    publish: 'published',
  };
}

/**
 * Publishes a rewritten post to the blog via the service-token path. Returns
 * the new blog post id on success; throws with a readable message otherwise so
 * the caller can surface it in the Telegram DM and mark publish_failed.
 *
 * `idempotencyKey` (the candidate's stable dedup key) is sent as an
 * `Idempotency-Key` header so a future backend can dedupe a retried POST and
 * return the existing post instead of creating a duplicate. Harmless if the
 * backend ignores the header today.
 */
export async function publishToBlog(
  rewrite: RewriteResult,
  coverUrl?: string | null,
  idempotencyKey?: string
): Promise<string> {
  const url = `${CONFIG.BLOG_API_URL.replace(/\/$/, '')}/api/post/new`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.BOT_API_TOKEN}`,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(toBlogPostBody(rewrite, coverUrl)),
    });
  } catch (err) {
    // Could not even send the request → the post definitely did not happen.
    throw new PublishError(`Не удалось связаться с блогом: ${String(err)}`, false);
  }

  if (response.status !== 201) {
    const text = await response.text().catch(() => '');
    // A 4xx is a clear client rejection (didn't post); a 5xx may have committed
    // the post before failing — treat as maybe-posted.
    const maybePosted = response.status >= 500;
    throw new PublishError(`Блог ответил ${response.status}: ${text.slice(0, 200)}`, maybePosted);
  }

  // 201 received: the post WAS created. If we then can't read the id, the post
  // is live but we don't have its id — maybe-posted, never silently re-publish.
  let data: { post?: { id?: string; _id?: string } };
  try {
    data = (await response.json()) as { post?: { id?: string; _id?: string } };
  } catch {
    throw new PublishError('Блог вернул 201, но тело ответа нечитаемо.', true);
  }
  const postId = data.post?.id ?? data.post?._id;
  if (!postId) {
    throw new PublishError('Блог вернул 201 без id поста.', true);
  }
  return postId;
}
