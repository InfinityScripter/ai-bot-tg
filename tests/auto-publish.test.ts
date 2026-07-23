import { it, vi, expect, describe, afterEach } from "vitest";

import type { FeedItem } from "../src/types.js";

const fetchAllFeeds = vi.fn<() => Promise<FeedItem[]>>();
vi.mock("../src/feeds/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/feeds/index.js")>();
  return { ...actual, fetchAllFeeds: () => fetchAllFeeds() };
});

const rewriteToPost = vi.fn();
vi.mock("../src/llm/rewriteToPost.js", () => ({
  rewriteToPost: (...args: unknown[]) => rewriteToPost(...args),
}));

vi.mock("../src/llm/filterRelevant.js", () => ({
  filterRelevant: (items: FeedItem[]) => Promise.resolve({ kept: items, decisions: [] }),
}));

const { createBot } = await import("../src/bot/index.js");
const { runCollection } = await import("../src/server/index.js");
const { CandidateStore } = await import("../src/store/index.js");
const { CandidateState } = await import("../src/enums.js");

const REWRITE = {
  title: "Готовый пост",
  description: "Краткое описание",
  // Body must clear the auto-publish quality gate's min-length floor (≥ 400
  // chars); a realistic rewritten post is well above it. A too-short body is
  // exercised separately in the gate-divert test below.
  content: "Развёрнутый текст публикации с деталями и контекстом. ".repeat(10),
  tags: ["новости"],
  metaTitle: "Готовый пост",
  metaDescription: "Краткое описание",
};

function feedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    dedupKey: "https://example.com/news",
    url: "https://example.com/news",
    title: "Исходная новость",
    snippet: "Подробный исходный текст. ".repeat(30),
    feedTitle: "Источник",
    imageUrl: null,
    imageUrls: ["https://example.com/source-image.jpg"],
    publishedAt: Date.now(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeBot(store: InstanceType<typeof CandidateStore>) {
  const bundle = createBot(store, async () => {});
  const apiCalls: Array<{ method: string; payload: unknown }> = [];
  bundle.bot.api.config.use((_prev, method, payload) => {
    apiCalls.push({ method, payload });
    const result = method === "sendMessage" ? { message_id: 42 } : true;
    return Promise.resolve({ ok: true, result } as never);
  });
  return { ...bundle, apiCalls };
}

afterEach(() => {
  fetchAllFeeds.mockReset();
  rewriteToPost.mockReset();
  vi.unstubAllGlobals();
});

describe("automatic collection publishing", () => {
  it("rewrites and publishes each fresh item without approval, preferring a source image", async () => {
    fetchAllFeeds.mockResolvedValue([feedItem()]);
    rewriteToPost.mockResolvedValue(REWRITE);
    const publish = vi.fn(
      async () =>
        new Response(JSON.stringify({ post: { id: "post-1" } }), {
          status: 201,
        }),
    );
    vi.stubGlobal("fetch", publish);
    const store = new CandidateStore(":memory:");
    const { apiCalls, autoPublishCandidate } = makeBot(store);

    const summary = await runCollection(store, autoPublishCandidate, 0);

    expect(summary.published).toBe(1);
    expect(summary.failed).toBe(0);
    expect(store.listByState(CandidateState.Published)).toHaveLength(1);
    const progress = apiCalls.find(({ method }) => method === "sendMessage");
    expect(progress?.payload).not.toHaveProperty("reply_markup");
    const [, request] = publish.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({
      coverUrl: "https://example.com/source-image.jpg",
      publish: "published",
    });
    store.close();
  });

  it("never retries an uncertain publish and leaves it for verification", async () => {
    fetchAllFeeds.mockResolvedValue([feedItem()]);
    rewriteToPost.mockResolvedValue(REWRITE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream failed", { status: 503 })),
    );
    const store = new CandidateStore(":memory:");
    const { autoPublishCandidate } = makeBot(store);

    const summary = await runCollection(store, autoPublishCandidate, 0);

    expect(summary.published).toBe(0);
    expect(summary.failed).toBe(1);
    expect(store.listByState(CandidateState.NeedsVerification)).toHaveLength(1);
    store.close();
  });

  it("resumes only automatic collected rows recovered after a crash", async () => {
    fetchAllFeeds.mockResolvedValue([]);
    rewriteToPost.mockResolvedValue(REWRITE);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ post: { id: "post-recovered" } }), { status: 201 }),
      ),
    );
    const store = new CandidateStore(":memory:");
    const automaticId = store.insertCollected(feedItem(), true)!;
    const manualId = store.insertCollected(
      feedItem({ dedupKey: "manual", url: "https://example.com/manual" }),
    )!;
    const { autoPublishCandidate } = makeBot(store);

    const summary = await runCollection(store, autoPublishCandidate, 0);

    expect(summary.published).toBe(1);
    expect(store.get(automaticId)?.state).toBe(CandidateState.Published);
    expect(store.get(manualId)?.state).toBe(CandidateState.Collected);
    store.close();
  });

  it("replays a recovery card for an automatic failure on startup", async () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(feedItem(), true)!;
    store.setState(id, CandidateState.RewriteFailed, "LLM unavailable");
    const { apiCalls, notifyAutomaticFailures } = makeBot(store);

    await notifyAutomaticFailures();

    expect(apiCalls).toContainEqual({
      method: "sendMessage",
      payload: expect.objectContaining({
        text: expect.stringContaining("LLM unavailable"),
        reply_markup: expect.any(Object),
      }),
    });
    expect(store.get(id)?.tgMessageId).toBe(42);
    store.close();
  });

  it("diverts a gate-failing item to manual review instead of auto-publishing", async () => {
    // A too-short rewrite fails the quality gate: no blog POST fires, the
    // candidate is left on its preview card (state pending_review) for the owner
    // to publish (or discard) manually, and the run counts it as a failure.
    fetchAllFeeds.mockResolvedValue([feedItem()]);
    rewriteToPost.mockResolvedValue({ ...REWRITE, content: "слишком коротко" });
    const publish = vi.fn(
      async () => new Response(JSON.stringify({ post: { id: "x" } }), { status: 201 }),
    );
    vi.stubGlobal("fetch", publish);
    const store = new CandidateStore(":memory:");
    const { apiCalls, autoPublishCandidate } = makeBot(store);

    const summary = await runCollection(store, autoPublishCandidate, 0);

    expect(publish).not.toHaveBeenCalled(); // gate blocked the publish
    expect(summary.published).toBe(0);
    expect(summary.failed).toBe(1);
    expect(store.listByState(CandidateState.Published)).toHaveLength(0);
    expect(store.listByState(CandidateState.PendingReview)).toHaveLength(1);
    // The owner still gets a card (with buttons) — the failure is surfaced, not lost.
    const failureCard = apiCalls.find(
      ({ method, payload }) =>
        method === "editMessageText" &&
        typeof (payload as { text?: unknown }).text === "string" &&
        /короткий/.test((payload as { text: string }).text),
    );
    expect(failureCard).toBeDefined();
    store.close();
  });

  it("drains jobs that the same running batch starts after the current job", async () => {
    fetchAllFeeds.mockResolvedValue([
      feedItem({ dedupKey: "first", url: "https://example.com/first" }),
      feedItem({ dedupKey: "second", url: "https://example.com/second" }),
    ]);
    rewriteToPost.mockResolvedValue(REWRITE);
    const first = deferred<Response>();
    const second = deferred<Response>();
    const publish = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    vi.stubGlobal("fetch", publish);
    const store = new CandidateStore(":memory:");
    const { drain, autoPublishCandidate } = makeBot(store);

    const run = runCollection(store, autoPublishCandidate, 0);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    let drained = false;
    const draining = drain().then(() => {
      drained = true;
    });

    first.resolve(new Response(JSON.stringify({ post: { id: "post-1" } }), { status: 201 }));
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    expect(drained).toBe(false);

    second.resolve(new Response(JSON.stringify({ post: { id: "post-2" } }), { status: 201 }));
    await run;
    await draining;
    expect(drained).toBe(true);
    store.close();
  });
});
