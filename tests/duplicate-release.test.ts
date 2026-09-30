import { it, vi, expect, describe, afterEach } from "vitest";

import type { FeedItem, RewriteResult, ReleaseResult } from "../src/types.js";

const rewriteToPost = vi.fn();
vi.mock("../src/llm/rewriteToPost.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/rewriteToPost.js")>();
  return { ...actual, rewriteToPost: (...a: unknown[]) => rewriteToPost(...a) };
});
const extractRelease = vi.fn();
vi.mock("../src/llm/extractRelease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/extractRelease.js")>();
  return { ...actual, extractRelease: (...a: unknown[]) => extractRelease(...a) };
});

const { createBot } = await import("../src/bot/index.js");
const { releaseKey, NoModelInSourceError } = await import("../src/llm/index.js");
const { CandidateStore } = await import("../src/store/index.js");
import { CandidateKind, CandidateState } from "../src/enums.js";

const POST: RewriteResult = {
  title: "GPT-6.1 Sol стоит пятую часть Astra",
  description: "Описание",
  content: "Развёрнутый текст поста о новой модели с деталями. ".repeat(12),
  tags: ["новости"],
  metaTitle: "GPT-6.1 Sol",
  metaDescription: "Описание",
};

function card(model: string, version: string): ReleaseResult {
  return {
    vendor: "OpenAI",
    model,
    version,
    releasedAt: "2026-09-29",
    sourceUrl: "https://example.com",
    contextTokens: null,
    priceIn: null,
    priceOut: null,
    changes: ["Дешевле"],
    sourceName: null,
  };
}

function item(key: string): FeedItem {
  return {
    dedupKey: key,
    url: `https://${key}.example/sol`,
    title: "dots, GPT-6.1 Sol и тариф $500",
    snippet: "Подробный текст. ".repeat(20),
    feedTitle: key,
    imageUrl: null,
    imageUrls: [],
    publishedAt: Date.now(),
    kind: CandidateKind.Release,
  };
}

/** A store where TechCrunch's GPT-6.1 Sol post is already published. */
function storeWithPublishedSol() {
  const store = new CandidateStore(":memory:");
  const id = store.insertCollected(item("techcrunch"), true)!;
  store.attachRelease(id, { post: POST, release: card("GPT", "6.1 Sol") });
  store.setPublished(id, "post-1");
  return store;
}

function makeBot(store: InstanceType<typeof CandidateStore>) {
  const bundle = createBot(store, async () => {});
  const texts: string[] = [];
  bundle.bot.api.config.use((_prev, method, payload) => {
    const { text } = payload as { text?: string };
    if (text) texts.push(text);
    return Promise.resolve({
      ok: true,
      result: method === "sendMessage" ? { message_id: 42 } : true,
    } as never);
  });
  return { ...bundle, texts };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("releaseKey", () => {
  it("is the same however an outlet splits the model name", () => {
    expect(releaseKey(card("GPT", "6.1 Sol"))).toBe(releaseKey(card("GPT-6.1", "Sol")));
    expect(releaseKey({ ...card("GPT", "6.1 Sol"), vendor: "Open AI" })).toBe(
      releaseKey(card("GPT", "6.1 Sol")),
    );
  });

  it("differs for another version", () => {
    expect(releaseKey(card("GPT", "6.1 Sol"))).not.toBe(releaseKey(card("GPT", "6 Sol")));
  });
});

describe("automatic release publish — duplicates", () => {
  it("does not publish a model the bot already published; the article leaves the release lane", async () => {
    const store = storeWithPublishedSol();
    const id = store.insertCollected(item("habr"), true)!;
    rewriteToPost.mockResolvedValue(POST);
    extractRelease.mockResolvedValue(card("GPT-6.1", "Sol"));
    const blog = vi.fn();
    vi.stubGlobal("fetch", blog);
    const { autoPublishCandidate, texts } = makeBot(store);

    await autoPublishCandidate(store.get(id)!);

    // The only request is the article-body fetch before the rewrite; nothing hits the blog API.
    expect(blog.mock.calls.map(([url]) => String(url)).filter((u) => u.includes("/api/"))).toEqual(
      [],
    );
    const row = store.get(id)!;
    expect(row.kind).toBe(CandidateKind.News);
    // DIGEST_POSTS is off in tests → skipped; with the digest on it is queued.
    expect(row.state).toBe(CandidateState.Skipped);
    expect(row.autoPublish).toBe(false);
    expect(store.listAutomaticFailures()).toHaveLength(0);
    expect(texts.at(-1)).toContain("уже опубликован");
    store.close();
  });

  it("publishes a release of another model", async () => {
    const store = storeWithPublishedSol();
    const id = store.insertCollected(item("verge"), true)!;
    rewriteToPost.mockResolvedValue(POST);
    extractRelease.mockResolvedValue(card("GPT", "6.2 Terra"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/api/post/new")
          ? new Response(JSON.stringify({ post: { id: "post-2" } }), { status: 201 })
          : new Response(JSON.stringify({ data: { release: { id: "rel-2" } } }), { status: 201 }),
      ),
    );
    const { autoPublishCandidate } = makeBot(store);

    await autoPublishCandidate(store.get(id)!);

    expect(store.get(id)!.state).toBe(CandidateState.Published);
    store.close();
  });
});

describe("automatic release publish — no model in the source", () => {
  function blogApi() {
    return vi.fn(async (url: string) =>
      String(url).includes("/api/post/new")
        ? new Response(JSON.stringify({ post: { id: "post-2" } }), { status: 201 })
        : new Response("<html></html>", { status: 200 }),
    );
  }

  it("sends a newsletter the model took for a release to the news lane, not a post", async () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(item("latentspace"), true)!;
    rewriteToPost.mockResolvedValue(POST);
    extractRelease.mockRejectedValue(new NoModelInSourceError("нет модели"));
    const blog = blogApi();
    vi.stubGlobal("fetch", blog);
    const { autoPublishCandidate, texts } = makeBot(store);

    await autoPublishCandidate(store.get(id)!);

    expect(blog.mock.calls.map(([url]) => String(url)).filter((u) => u.includes("/api/"))).toEqual(
      [],
    );
    const row = store.get(id)!;
    expect(row.kind).toBe(CandidateKind.News);
    expect(row.state).toBe(CandidateState.Skipped);
    expect(store.listAutomaticFailures()).toHaveLength(0);
    expect(texts.at(-1)).toContain("не релиз");
    store.close();
  });

  it("still publishes the post alone when the card failed for another reason", async () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(item("techcrunch"), true)!;
    rewriteToPost.mockResolvedValue(POST);
    extractRelease.mockRejectedValue(new Error("The operation was aborted due to timeout"));
    vi.stubGlobal("fetch", blogApi());
    const { autoPublishCandidate } = makeBot(store);

    await autoPublishCandidate(store.get(id)!);

    expect(store.get(id)!.state).toBe(CandidateState.Published);
    store.close();
  });
});

describe("divertReleaseToNews", () => {
  it("queues the row as news for the digest and drops the stored bundle", () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(item("habr"), true)!;
    store.attachRelease(id, { post: POST, release: card("GPT", "6.1 Sol") });

    store.divertReleaseToNews(id, CandidateState.DigestQueued);

    expect(store.listDigestQueue().map((c) => c.id)).toEqual([id]);
    expect(store.get(id)).toMatchObject({ kind: CandidateKind.News, rewriteJson: null });
    store.close();
  });
});
