import { it, vi, expect, describe, afterEach } from "vitest";

import type { FeedItem, RewriteResult, ReleaseResult } from "../src/types.js";

// Release extraction and blog publishing, driven without network or LLM.
const rewriteToPost = vi.fn();
const extractRelease = vi.fn();
vi.mock("../src/llm/rewriteToPost.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/rewriteToPost.js")>();
  return { ...actual, rewriteToPost: (...a: unknown[]) => rewriteToPost(...a) };
});
vi.mock("../src/llm/extractRelease.js", () => ({
  extractRelease: (...a: unknown[]) => extractRelease(...a),
}));
const publishToBlog = vi.fn();
const publishRelease = vi.fn();
vi.mock("../src/blog/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/blog/index.js")>();
  return {
    ...actual,
    publishToBlog: (...a: unknown[]) => publishToBlog(...a),
    publishRelease: (...a: unknown[]) => publishRelease(...a),
  };
});

const { runExtraction, publishClaimedCandidate } = await import("../src/bot/candidateActions.js");
const { CandidateStore } = await import("../src/store/index.js");
import { CandidateKind, CandidateState } from "../src/enums.js";

const ITEM: FeedItem = {
  dedupKey: "https://openai.com/sol",
  url: "https://openai.com/sol",
  title: "OpenAI launches GPT-6.1 Sol",
  snippet: "GPT-6.1 Sol is twice as fast.",
  feedTitle: "OpenAI",
  imageUrl: null,
  imageUrls: [],
  publishedAt: null,
  kind: CandidateKind.Release,
};

const POST: RewriteResult = {
  title: "GPT-6.1 Sol вдвое быстрее",
  description: "Что изменилось",
  content: "Тело поста.",
  tags: ["новости"],
  metaTitle: "GPT-6.1 Sol",
  metaDescription: "Что изменилось",
};

const CARD: ReleaseResult = {
  vendor: "OpenAI",
  model: "GPT",
  version: "6.1 Sol",
  releasedAt: "2026-09-30",
  sourceUrl: ITEM.url,
  contextTokens: null,
  priceIn: null,
  priceOut: null,
  changes: ["Вдвое быстрее"],
  sourceName: "OpenAI",
};

function extracted(store: InstanceType<typeof CandidateStore>) {
  const id = store.insertCollected(ITEM, true)!;
  return { id, candidate: store.get(id)! };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("release extraction", () => {
  it("stores the post together with its changelog card", async () => {
    const store = new CandidateStore(":memory:");
    const { id, candidate } = extracted(store);
    rewriteToPost.mockResolvedValueOnce(POST);
    extractRelease.mockResolvedValueOnce(CARD);

    const preview = await runExtraction(store, id, ITEM, candidate, "OpenRouter / luna");

    expect(store.getRelease(store.get(id)!)).toEqual({ post: POST, release: CARD });
    expect(preview).toContain("вдвое быстрее");
    expect(preview).toContain("6.1 Sol");
  });

  it("keeps the post when changelog extraction fails", async () => {
    const store = new CandidateStore(":memory:");
    const { id, candidate } = extracted(store);
    rewriteToPost.mockResolvedValueOnce(POST);
    extractRelease.mockRejectedValueOnce(new Error("Ответ LLM не прошёл валидацию"));

    const preview = await runExtraction(store, id, ITEM, candidate, "OpenRouter / luna");

    expect(store.getRelease(store.get(id)!)).toEqual({ post: POST, release: null });
    expect(preview).toContain("Карточка changelog не извлечена");
  });
});

describe("release publish", () => {
  async function publishWith(release: ReleaseResult | null) {
    const store = new CandidateStore(":memory:");
    const { id } = extracted(store);
    store.attachRelease(id, { post: POST, release });
    store.claimForPublishing(id);
    publishToBlog.mockResolvedValueOnce({ postId: "p1", coverUrl: null });
    const result = await publishClaimedCandidate(store, store.get(id)!);
    return { store, id, result };
  }

  it("publishes the post, then the changelog card under its own idempotency key", async () => {
    publishRelease.mockResolvedValueOnce("r1");
    const { store, id, result } = await publishWith(CARD);

    expect(publishToBlog).toHaveBeenCalledWith(POST, null, ITEM.dedupKey);
    expect(publishRelease).toHaveBeenCalledWith(CARD, `${ITEM.dedupKey}#changelog`);
    expect(result.warning).toBeUndefined();
    expect(result.extracted.crossPost.linkFor("p1")).toMatch(/\/post\/p1$/);
    expect(store.get(id)!.state).toBe(CandidateState.Published);
  });

  it("stays published with a warning when the changelog card fails", async () => {
    publishRelease.mockRejectedValueOnce(new Error("Блог ответил 500"));
    const { store, id, result } = await publishWith(CARD);

    expect(store.get(id)!.state).toBe(CandidateState.Published);
    expect(result.warning).toContain("Блог ответил 500");
  });

  it("publishes the post alone with a warning when there is no card", async () => {
    const { result } = await publishWith(null);

    expect(publishRelease).not.toHaveBeenCalled();
    expect(result.warning).toContain("не извлечена");
  });
});
