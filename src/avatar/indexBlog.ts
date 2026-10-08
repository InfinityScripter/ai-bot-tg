import { CONFIG } from "../config.js";
import { chunkPost } from "./chunkPost.js";
import { fetchAllPosts } from "../blog/index.js";

import type { MemoryChunk } from "./types.js";
import type { RecentPost } from "../blog/types.js";
import type { AvatarStore } from "./avatarStore.js";

/** The details endpoint allows 60 requests/min per IP, and the news bot shares the IP. */
const PAUSE_MS = 1500;

export interface IndexDeps {
  listPosts: () => Promise<RecentPost[]>;
  fetchBody: (id: string) => Promise<string>;
  pause: (ms: number) => Promise<void>;
}

export interface IndexSummary {
  posts: number;
  chunks: number;
  failed: number;
}

/** The list endpoint strips `content`, so every body costs one details request. */
export async function fetchPostBody(id: string): Promise<string> {
  const base = CONFIG.BLOG_API_URL.replace(/\/$/, "");
  const res = await fetch(`${base}/api/post/details?id=${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Blog details responded ${res.status} for ${id}`);
  const data = (await res.json()) as { post?: { content?: string } };
  return data.post?.content ?? "";
}

const DEFAULT_DEPS: IndexDeps = {
  listPosts: fetchAllPosts,
  fetchBody: fetchPostBody,
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Share of failed posts above which a crawl may not replace an existing index. */
const MAX_FAILED_SHARE = 0.2;

/**
 * Rebuilds the avatar's blog index from every published post, one body
 * request at a time. A failed or empty body is skipped and counted. The old
 * index stays when the crawl came back empty, or when more than a fifth of the
 * posts failed: a blog restart or a run of 429s must not shrink the memory.
 */
export async function indexBlog(
  store: AvatarStore,
  deps: IndexDeps = DEFAULT_DEPS,
): Promise<IndexSummary> {
  const posts = await deps.listPosts();
  const base = CONFIG.BLOG_PUBLIC_URL.replace(/\/$/, "");
  const chunks: MemoryChunk[] = [];
  let failed = 0;
  for (const [i, post] of posts.entries()) {
    const id = post.id ?? post._id;
    if (i > 0) await deps.pause(PAUSE_MS);
    try {
      if (!id) throw new Error("post has no id");
      const content = await deps.fetchBody(id);
      if (!content.trim()) throw new Error("empty body");
      const text = `${post.description ?? ""}\n\n${content}`;
      chunks.push(...chunkPost({ title: post.title, url: `${base}/post/${id}`, content: text }));
    } catch (err) {
      failed++;
      console.warn(`[avatar] index: skipped post ${id ?? post.title}: ${String(err)}`);
    }
  }
  if (chunks.length === 0) {
    throw new Error(`Индекс получился пустым (постов ${posts.length}, ошибок ${failed}).`);
  }
  if (store.chunkCount() > 0 && failed > posts.length * MAX_FAILED_SHARE) {
    throw new Error(
      `Не загрузились ${failed} из ${posts.length} постов, старый индекс оставлен как есть.`,
    );
  }
  store.replaceChunks(chunks);
  return { posts: posts.length, chunks: chunks.length, failed };
}
