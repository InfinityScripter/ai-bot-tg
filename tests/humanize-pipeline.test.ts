import { it, vi, expect, describe, afterEach } from "vitest";

// Drive both LLM features without a provider: the chat core returns whatever a
// case queues, and the humanizer pass is a spy.
const completeChatJson = vi.fn();
vi.mock("../src/llm/chatCompletion.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/chatCompletion.js")>();
  return { ...actual, completeChatJson: (...a: unknown[]) => completeChatJson(...a) };
});
const humanizeText = vi.fn();
vi.mock("../src/llm/humanize.js", () => ({
  humanizeText: (...a: unknown[]) => humanizeText(...a),
}));

const { rewriteToPost, buildDigestPost } = await import("../src/llm/index.js");
const { CandidateStore } = await import("../src/store/index.js");

import type { FeedItem, Candidate } from "../src/types.js";

const STORE = new CandidateStore(":memory:");

const ITEM: FeedItem = {
  dedupKey: "k",
  url: "https://example.com/a",
  title: "Source headline",
  snippet: "Source snippet",
  feedTitle: "Feed",
  imageUrl: null,
  imageUrls: [],
  publishedAt: null,
};

const SOURCE_LINE = "Источник: [Feed](https://example.com/a)";

afterEach(() => {
  completeChatJson.mockReset();
  humanizeText.mockReset();
});

describe("rewriteToPost — humanizer pass", () => {
  it("publishes the humanized body", async () => {
    completeChatJson.mockResolvedValueOnce(
      JSON.stringify({
        title: "T",
        description: "D",
        content: "Модель — быстрая.",
        tags: [],
        metaTitle: "T",
        metaDescription: "D",
      }),
    );
    humanizeText.mockImplementationOnce(async () => `Модель быстрая.\n\n${SOURCE_LINE}`);
    const post = await rewriteToPost(ITEM, STORE);
    expect(post.content).toBe(`Модель быстрая.\n\n${SOURCE_LINE}`);
    expect(humanizeText).toHaveBeenCalledWith(`Модель — быстрая.\n\n${SOURCE_LINE}`);
  });

  it("re-applies the link allow-list and source line to the humanized body", async () => {
    completeChatJson.mockResolvedValueOnce(
      JSON.stringify({
        title: "T",
        description: "D",
        content: "Текст.",
        tags: [],
        metaTitle: "T",
        metaDescription: "D",
      }),
    );
    // The humanizer invented a link and reworded the source line away.
    humanizeText.mockImplementationOnce(
      async () => "Текст про [подробности](https://evil.example/x).\n\nВзято из Feed.",
    );
    const post = await rewriteToPost(ITEM, STORE);
    expect(post.content).not.toContain("evil.example");
    expect(post.content.endsWith(SOURCE_LINE)).toBe(true);
  });
});

function candidate(id: number): Candidate {
  return {
    id,
    dedupKey: `k${id}`,
    sourceUrl: `https://ex.com/${id}`,
    sourceTitle: `Title ${id}`,
    feedTitle: "Feed",
    imageUrl: null,
    snippet: "s",
    imageUrls: null,
    kind: "news",
    autoPublish: false,
    state: "digest_queued",
    rewriteJson: null,
    tgMessageId: null,
    blogPostId: null,
    error: null,
    createdAt: "",
    updatedAt: "",
  } as Candidate;
}

const DIGEST = {
  title: "Дайджест",
  intro: "Вступление — главное за день.",
  sections: {
    hot: [{ url: "https://ex.com/1", headline: "H1", note: "Первая заметка." }],
    news: [
      { url: "https://ex.com/2", headline: "H2" },
      { url: "https://ex.com/3", headline: "H3", note: "Третья заметка." },
    ],
    materials: [],
    cases: [],
  },
};

describe("buildDigestPost — humanizer pass", () => {
  const queue = [candidate(1), candidate(2), candidate(3)];

  it("humanizes the intro and every note one line at a time, in place", async () => {
    completeChatJson.mockResolvedValueOnce(JSON.stringify(DIGEST));
    humanizeText.mockImplementation(async (line: string) => `~${line}`);
    const post = await buildDigestPost(queue, STORE);
    expect(humanizeText.mock.calls.map((c) => c[0])).toEqual([
      "Вступление — главное за день.",
      "Первая заметка.",
      "Третья заметка.",
    ]);
    expect(post.intro).toBe("~Вступление — главное за день.");
    expect(post.sections.hot[0]!.note).toBe("~Первая заметка.");
    expect(post.sections.news[0]).toEqual({ url: "https://ex.com/2", headline: "H2" });
    expect(post.sections.news[1]!.note).toBe("~Третья заметка.");
  });

  it("refuses a humanized line that brings a link or HTML", async () => {
    completeChatJson.mockResolvedValueOnce(JSON.stringify(DIGEST));
    humanizeText
      .mockImplementationOnce(async () => "Вступ, см. [тут](https://evil.example).")
      .mockImplementationOnce(async () => "Первая <b>заметка</b>.")
      .mockImplementationOnce(async () => "Третья.");
    const post = await buildDigestPost(queue, STORE);
    expect(post.intro).toBe(DIGEST.intro);
    expect(post.sections.hot[0]!.note).toBe("Первая заметка.");
    expect(post.sections.news[1]!.note).toBe("Третья.");
  });

  it("refuses a line over the schema limit and collapses newlines", async () => {
    completeChatJson.mockResolvedValueOnce(JSON.stringify(DIGEST));
    humanizeText
      .mockImplementationOnce(async () => "а".repeat(501))
      .mockImplementationOnce(async () => "Первая\nзаметка.")
      .mockImplementationOnce(async (line: string) => line);
    const post = await buildDigestPost(queue, STORE);
    expect(post.intro).toBe(DIGEST.intro);
    expect(post.sections.hot[0]!.note).toBe("Первая заметка.");
  });
});
