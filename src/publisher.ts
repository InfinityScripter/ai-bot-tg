import { CONFIG } from './config.js';
import type { BlogPostBody, RewriteResult } from './types.js';

/**
 * Builds the blog post body from a rewrite result and an optional cover image
 * URL (taken from the source feed, not the rewrite). Omitting coverUrl lets the
 * backend apply its default cover.
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
    publish: 'published',
  };
}

/**
 * Publishes a rewritten post to the blog via the service-token path. Returns
 * the new blog post id on success; throws with a readable message otherwise so
 * the caller can surface it in the Telegram DM and mark publish_failed.
 */
export async function publishToBlog(rewrite: RewriteResult, coverUrl?: string | null): Promise<string> {
  const url = `${CONFIG.BLOG_API_URL.replace(/\/$/, '')}/api/post/new`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.BOT_API_TOKEN}`,
      },
      body: JSON.stringify(toBlogPostBody(rewrite, coverUrl)),
    });
  } catch (err) {
    throw new Error(`Не удалось связаться с блогом: ${String(err)}`);
  }

  if (response.status !== 201) {
    const text = await response.text().catch(() => '');
    throw new Error(`Блог ответил ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as { post?: { id?: string; _id?: string } };
  const postId = data.post?.id ?? data.post?._id;
  if (!postId) {
    throw new Error('Блог не вернул id поста в ответе.');
  }
  return postId;
}
