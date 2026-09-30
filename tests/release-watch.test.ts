import { it, vi, expect, describe, afterEach } from "vitest";

import type { FeedItem, Candidate } from "../src/types.js";

const fetchAllFeeds = vi.fn<() => Promise<FeedItem[]>>();
vi.mock("../src/feeds/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/feeds/index.js")>();
  return { ...actual, fetchAllFeeds: () => fetchAllFeeds() };
});
const confirmRelease = vi.fn();
vi.mock("../src/llm/detectRelease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/detectRelease.js")>();
  return { ...actual, confirmRelease: (...a: unknown[]) => confirmRelease(...a) };
});

const { runReleaseWatch } = await import("../src/server/index.js");
const { CandidateStore } = await import("../src/store/index.js");
import { CandidateKind } from "../src/enums.js";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function feedItem(key: string, title: string, ageHours: number | null = 1): FeedItem {
  return {
    dedupKey: key,
    url: `https://ex.com/${key}`,
    title,
    snippet: "",
    feedTitle: "Feed",
    imageUrl: null,
    imageUrls: [],
    publishedAt: ageHours === null ? null : NOW - ageHours * HOUR,
  };
}

const LAUNCH = feedItem("launch", "Anthropic launches Claude 6");
const PAPER = feedItem("paper", "A release of OpenAI eval traces for alignment research");

afterEach(() => {
  fetchAllFeeds.mockReset();
  confirmRelease.mockReset();
});

describe("runReleaseWatch", () => {
  it("publishes a confirmed fresh release through processCandidate as kind=release", async () => {
    const store = new CandidateStore(":memory:");
    const process = vi.fn(async (_candidate: Candidate) => {});
    fetchAllFeeds.mockResolvedValueOnce([LAUNCH, feedItem("news", "Why agents fail")]);
    confirmRelease.mockResolvedValueOnce(true);

    const summary = await runReleaseWatch(store, process, new Set(), NOW);

    expect(confirmRelease).toHaveBeenCalledTimes(1);
    expect(process).toHaveBeenCalledTimes(1);
    const inserted = process.mock.calls[0]![0];
    expect(inserted.kind).toBe(CandidateKind.Release);
    expect(inserted.autoPublish).toBe(true);
    expect(store.isSeen("news")).toBe(false);
    expect(summary).toMatchObject({ checked: 1, releases: 1, failed: 0 });
  });

  it("leaves a rejected item unseen for the daily digest and never re-asks about it", async () => {
    const store = new CandidateStore(":memory:");
    const process = vi.fn(async () => {});
    const rejected = new Set<string>();
    fetchAllFeeds.mockResolvedValue([PAPER]);
    confirmRelease.mockResolvedValueOnce(false);

    await runReleaseWatch(store, process, rejected, NOW);
    await runReleaseWatch(store, process, rejected, NOW);

    expect(confirmRelease).toHaveBeenCalledTimes(1);
    expect(process).not.toHaveBeenCalled();
    expect(store.isSeen("paper")).toBe(false);
  });

  it("fails a sweep where every check could not tell, and asks again next time", async () => {
    const store = new CandidateStore(":memory:");
    const rejected = new Set<string>();
    fetchAllFeeds.mockResolvedValue([LAUNCH]);
    confirmRelease.mockResolvedValue(null);

    await expect(runReleaseWatch(store, vi.fn(), rejected, NOW)).rejects.toThrow(/не ответила/);
    await expect(runReleaseWatch(store, vi.fn(), rejected, NOW)).rejects.toThrow(/не ответила/);

    expect(confirmRelease).toHaveBeenCalledTimes(2);
    expect(store.isSeen("launch")).toBe(false);
  });

  it("stops after three unknown answers in a row, after processing what it confirmed", async () => {
    const store = new CandidateStore(":memory:");
    const process = vi.fn(async () => {});
    fetchAllFeeds.mockResolvedValueOnce([
      LAUNCH,
      ...[1, 2, 3, 4].map((n) => feedItem(`u${n}`, `OpenAI launches GPT-${n}`)),
    ]);
    confirmRelease.mockResolvedValueOnce(true).mockResolvedValue(null);

    await expect(runReleaseWatch(store, process, new Set(), NOW)).rejects.toThrow(/3 из 4/);
    expect(confirmRelease).toHaveBeenCalledTimes(4);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("stops asking once the service is shutting down", async () => {
    const store = new CandidateStore(":memory:");
    fetchAllFeeds.mockResolvedValueOnce([LAUNCH, feedItem("second", "Google unveils Gemini 4")]);
    confirmRelease.mockResolvedValue(false);

    await runReleaseWatch(
      store,
      vi.fn(),
      new Set(),
      NOW,
      () => confirmRelease.mock.calls.length > 0,
    );

    expect(confirmRelease).toHaveBeenCalledTimes(1);
  });

  it("ignores items older than a day, without a date, or already seen", async () => {
    const store = new CandidateStore(":memory:");
    store.insertCollected(feedItem("seen", "OpenAI launches GPT-7"));
    fetchAllFeeds.mockResolvedValueOnce([
      feedItem("old", "OpenAI launches GPT-6", 25),
      feedItem("nodate", "Google launches Gemini 4", null),
      feedItem("seen", "OpenAI launches GPT-7"),
    ]);

    const summary = await runReleaseWatch(store, vi.fn(), new Set(), NOW);

    expect(confirmRelease).not.toHaveBeenCalled();
    expect(summary.checked).toBe(0);
  });

  it("keeps sweeping when one release fails to process", async () => {
    const store = new CandidateStore(":memory:");
    const process = vi
      .fn()
      .mockRejectedValueOnce(new Error("blog down"))
      .mockResolvedValueOnce(undefined);
    fetchAllFeeds.mockResolvedValueOnce([LAUNCH, feedItem("second", "Google unveils Gemini 4")]);
    confirmRelease.mockResolvedValue(true);

    const summary = await runReleaseWatch(store, process, new Set(), NOW);

    expect(process).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ releases: 2, failed: 1 });
  });
});
