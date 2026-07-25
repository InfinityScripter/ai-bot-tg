import { it, vi, expect, describe, afterEach } from "vitest";

import { CandidateStore } from "../src/store/index.js";
import { publishClaimedCandidate } from "../src/bot/candidateActions.js";

import type { FeedItem, RewriteResult } from "../src/types.js";

// Covers stopped being the bot's business: an imageless item is published with
// NO coverUrl and the blog assigns one nobody used before. These cases pin the
// two halves of that contract — what leaves the bot, and what comes back.

const REWRITE: RewriteResult = {
  title: "Пост без картинки",
  description: "Описание",
  content: "Тело поста. ".repeat(40),
  tags: ["новости", "ai"],
  metaTitle: "Пост без картинки",
  metaDescription: "Описание",
};

function feedItem(imageUrls: string[] = []): FeedItem {
  return {
    dedupKey: "https://example.com/no-image",
    url: "https://example.com/no-image",
    title: "Исходная новость",
    snippet: "Исходный текст. ".repeat(20),
    feedTitle: "Источник",
    imageUrl: null,
    imageUrls,
    publishedAt: Date.now(),
  };
}

function publishedResponse(post: Record<string, unknown>) {
  return vi.fn(async () => new Response(JSON.stringify({ post }), { status: 201 }));
}

/** A candidate parked in pending_review with a stored rewrite, ready to publish. */
function readyCandidate(store: CandidateStore, item: FeedItem) {
  const id = store.insertCollected(item)!;
  store.attachRewrite(id, REWRITE);
  return store.get(id)!;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publishClaimedCandidate cover handling", () => {
  it("sends no coverUrl for an imageless item, letting the blog assign one", async () => {
    const fetchMock = publishedResponse({ id: "post-1", coverUrl: "https://cdn/assigned.jpg" });
    vi.stubGlobal("fetch", fetchMock);
    const store = new CandidateStore(":memory:");

    await publishClaimedCandidate(store, readyCandidate(store, feedItem()));

    const [, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request.body))).not.toHaveProperty("coverUrl");
    store.close();
  });

  it("still sends the article's own image when the source had one", async () => {
    const fetchMock = publishedResponse({ id: "post-2", coverUrl: "https://cdn/source.jpg" });
    vi.stubGlobal("fetch", fetchMock);
    const store = new CandidateStore(":memory:");

    await publishClaimedCandidate(
      store,
      readyCandidate(store, feedItem(["https://cdn/source.jpg"])),
    );

    const [, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request.body)).coverUrl).toBe("https://cdn/source.jpg");
    store.close();
  });

  it("puts the cover the blog stored on the channel card", async () => {
    vi.stubGlobal("fetch", publishedResponse({ id: "post-3", coverUrl: "https://cdn/blog.jpg" }));
    const store = new CandidateStore(":memory:");

    const { extracted } = await publishClaimedCandidate(store, readyCandidate(store, feedItem()));

    expect(extracted.crossPost.coverUrl).toBe("https://cdn/blog.jpg");
    store.close();
  });

  it("absolutizes a site-relative cover — Telegram rejects relative URLs", async () => {
    vi.stubGlobal(
      "fetch",
      publishedResponse({ id: "post-4", coverUrl: "/assets/images/cover/cover-7.webp" }),
    );
    const store = new CandidateStore(":memory:");

    const { extracted } = await publishClaimedCandidate(store, readyCandidate(store, feedItem()));

    expect(extracted.crossPost.coverUrl).toBe(
      "http://localhost:7272/assets/images/cover/cover-7.webp",
    );
    store.close();
  });

  it("leaves the card coverless when the blog reports no cover", async () => {
    vi.stubGlobal("fetch", publishedResponse({ id: "post-5" }));
    const store = new CandidateStore(":memory:");

    const { extracted } = await publishClaimedCandidate(store, readyCandidate(store, feedItem()));

    expect(extracted.crossPost.coverUrl).toBeNull();
    store.close();
  });
});
