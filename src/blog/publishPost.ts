import { CONFIG } from "../config.js";
import { PublishStatus } from "../enums.js";

import type { PublishOutcome } from "./types.js";
import type { BlogPostBody, RewriteResult } from "../types.js";

export const PUBLISH_TIMEOUT_MS = 30_000;

/**
 * A publish failure that also reports whether the POST MAY have reached the
 * blog. `maybePosted` is true when the request was sent but the outcome is
 * unknown (5xx, a non-201 after send, or an unreadable 201 body) — the caller
 * must then NOT silently re-offer Publish (it could duplicate). It is false only
 * when the post definitely did not happen (a clear 4xx).
 */
export class PublishError extends Error {
  readonly maybePosted: boolean;

  constructor(message: string, maybePosted: boolean) {
    super(message);
    this.name = "PublishError";
    this.maybePosted = maybePosted;
  }
}

/**
 * Builds the blog post body from a rewrite result and the article's own image
 * (the feed image or scraped og:image), when it has one.
 *
 * When the source has NO image the field is OMITTED on purpose, and the blog
 * assigns a cover no other post uses (blog-app-mui-backend
 * src/services/cover-assign.ts). The bot used to carry its own stock pool and
 * pick `pool[candidateId % poolSize]` — pure rotation with no memory of what was
 * already taken, so covers repeated as soon as the topical pool (19 images for
 * everything AI-tagged) was smaller than the post count. Only the blog can know
 * which images are free, so only the blog decides.
 * metaKeywords reuse the normalized tags — the clean set.
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
    ...(coverUrl ? { coverUrl } : {}),
    publish: PublishStatus.Published,
  };
}

/**
 * Publishes a rewritten post to the blog via the service-token path. Returns
 * the new blog post id AND the cover the blog stored — for an imageless item
 * that cover is assigned server-side, and the channel card must show the same
 * image as the post. Throws with a readable message otherwise so the caller can
 * surface it in the Telegram DM and mark publish_failed.
 *
 * `idempotencyKey` (the candidate's stable dedup key) is sent as an
 * `Idempotency-Key` header so a future backend can dedupe a retried POST and
 * return the existing post instead of creating a duplicate. Harmless if the
 * backend ignores the header today.
 */
export async function publishToBlog(
  rewrite: RewriteResult,
  coverUrl?: string | null,
  idempotencyKey?: string,
): Promise<PublishOutcome> {
  const url = `${CONFIG.BLOG_API_URL.replace(/\/$/, "")}/api/post/new`;
  const signal = AbortSignal.timeout(PUBLISH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.BOT_API_TOKEN}`,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(toBlogPostBody(rewrite, coverUrl)),
    });
  } catch (err) {
    // Any transport rejection may happen after the server accepted the body
    // (connection reset, timeout, broken response). Never silently retry it.
    throw new PublishError(`Не удалось связаться с блогом: ${String(err)}`, true);
  }

  if (response.status !== 201) {
    const text = await response.text().catch(() => "");
    // A 4xx is a clear client rejection (didn't post); a 5xx may have committed
    // the post before failing — treat as maybe-posted.
    const maybePosted = response.status >= 500;
    throw new PublishError(`Блог ответил ${response.status}: ${text.slice(0, 200)}`, maybePosted);
  }

  // 201 received: the post WAS created. If we then can't read the id, the post
  // is live but we don't have its id — maybe-posted, never silently re-publish.
  let data: { post?: { id?: string; _id?: string; coverUrl?: string } };
  try {
    data = (await response.json()) as typeof data;
  } catch {
    throw new PublishError("Блог вернул 201, но тело ответа нечитаемо.", true);
  }
  const postId = data.post?.id ?? data.post?._id;
  if (!postId) {
    throw new PublishError("Блог вернул 201 без id поста.", true);
  }
  return { postId, coverUrl: data.post?.coverUrl ?? null };
}
