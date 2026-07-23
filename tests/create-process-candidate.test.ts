import { it, vi, expect, describe, afterEach, beforeEach } from "vitest";

import type { AutoPublishFlags } from "../src/blog/index.js";

// Mock only fetchAutoPublishFlags; keep the rest of the blog module real so
// createProcessCandidate's other imports (types) resolve normally.
const fetchAutoPublishFlags = vi.fn<() => Promise<AutoPublishFlags>>();
vi.mock("../src/blog/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/blog/index.js")>();
  return { ...actual, fetchAutoPublishFlags: () => fetchAutoPublishFlags() };
});

const { CandidateKind } = await import("../src/enums.js");
const { CandidateStore } = await import("../src/store/index.js");
const { createProcessCandidate } = await import("../src/server/createProcessCandidate.js");

import type { FeedItem } from "../src/types.js";
import type { CandidateStore as Store } from "../src/store/index.js";

function feedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    dedupKey: "https://ex.com/a",
    url: "https://ex.com/a",
    title: "T",
    snippet: "s",
    feedTitle: "Feed",
    imageUrl: null,
    imageUrls: [],
    publishedAt: null,
    ...overrides,
  };
}

/**
 * Inserts one candidate of the given kind with auto_publish=1 (the collector
 * default). A per-insert counter keeps dedup keys unique so two inserts in one
 * test don't collide (a dedup hit returns null → get(null) would blow up).
 */
let seq = 0;
function insertAuto(store: Store, kind: (typeof CandidateKind)[keyof typeof CandidateKind]) {
  seq += 1;
  const url = `https://ex.com/${seq}`;
  const id = store.insertCollected({ ...feedItem({ dedupKey: url, url }), kind }, true)!;
  return store.get(id)!;
}

let store: Store;

beforeEach(() => {
  store = new CandidateStore(":memory:");
});

afterEach(() => {
  store.close();
  fetchAutoPublishFlags.mockReset();
});

describe("createProcessCandidate — flag-gated auto-vs-divert", () => {
  it("reads the flags exactly once (a run uses one snapshot), not per candidate", async () => {
    fetchAutoPublishFlags.mockResolvedValue({ releases: true, news: true });
    const autoPublish = vi.fn(async () => {});
    const sendRawCard = vi.fn(async () => {});

    const process = await createProcessCandidate(store, { autoPublish, sendRawCard });
    await process(insertAuto(store, CandidateKind.News));
    await process(insertAuto(store, CandidateKind.News));

    expect(fetchAutoPublishFlags).toHaveBeenCalledTimes(1);
  });

  it("news flag ON → auto-publishes, never diverts", async () => {
    fetchAutoPublishFlags.mockResolvedValue({ releases: false, news: true });
    const autoPublish = vi.fn(async () => {});
    const sendRawCard = vi.fn(async () => {});
    const candidate = insertAuto(store, CandidateKind.News);

    const process = await createProcessCandidate(store, { autoPublish, sendRawCard });
    await process(candidate);

    expect(autoPublish).toHaveBeenCalledWith(candidate);
    expect(sendRawCard).not.toHaveBeenCalled();
    // auto_publish stays 1 on the auto path (only divert clears it).
    expect(store.get(candidate.id)!.autoPublish).toBe(true);
  });

  it("news flag OFF → diverts to manual: clears auto_publish AND sends a raw card", async () => {
    fetchAutoPublishFlags.mockResolvedValue({ releases: true, news: false });
    const autoPublish = vi.fn(async () => {});
    const sendRawCard = vi.fn(async () => {});
    const candidate = insertAuto(store, CandidateKind.News);

    const process = await createProcessCandidate(store, { autoPublish, sendRawCard });
    await process(candidate);

    expect(autoPublish).not.toHaveBeenCalled();
    expect(sendRawCard).toHaveBeenCalledWith(candidate);
    // Cleared so crash-recovery (listRecoveredAutomatic: auto_publish=1) won't re-divert.
    expect(store.get(candidate.id)!.autoPublish).toBe(false);
  });

  it("routes on kind independently: releases ON + news OFF publishes a release, diverts news", async () => {
    fetchAutoPublishFlags.mockResolvedValue({ releases: true, news: false });
    const autoPublish = vi.fn(async () => {});
    const sendRawCard = vi.fn(async () => {});
    const release = insertAuto(store, CandidateKind.Release);
    const news = insertAuto(store, CandidateKind.News);

    const process = await createProcessCandidate(store, { autoPublish, sendRawCard });
    await process(release);
    await process(news);

    expect(autoPublish).toHaveBeenCalledTimes(1);
    expect(autoPublish).toHaveBeenCalledWith(release);
    expect(sendRawCard).toHaveBeenCalledTimes(1);
    expect(sendRawCard).toHaveBeenCalledWith(news);
  });

  it("keeps a diverted row recoverable when sendRawCard fails (clears the flag only after the card sends)", async () => {
    // Regression: the flag must be cleared AFTER the card sends. If sendRawCard
    // throws, the row must stay auto_publish=1/collected so listRecoveredAutomatic
    // re-diverts it next run — clearing first would strand it (auto_publish=0 +
    // collected is invisible to every recovery query; dedup key already seen).
    fetchAutoPublishFlags.mockResolvedValue({ releases: false, news: false });
    const autoPublish = vi.fn(async () => {});
    const sendRawCard = vi.fn(async () => {
      throw new Error("Telegram 403");
    });
    const candidate = insertAuto(store, CandidateKind.News);

    const process = await createProcessCandidate(store, { autoPublish, sendRawCard });
    await expect(process(candidate)).rejects.toThrow("Telegram 403");

    // Flag NOT cleared → the row is still picked up by crash-recovery.
    expect(store.get(candidate.id)!.autoPublish).toBe(true);
    expect(store.listRecoveredAutomatic().map((c) => c.id)).toContain(candidate.id);
  });

  it("fail-closed: both flags off (blog outage shape) diverts every kind", async () => {
    fetchAutoPublishFlags.mockResolvedValue({ releases: false, news: false });
    const autoPublish = vi.fn(async () => {});
    const sendRawCard = vi.fn(async () => {});
    const release = insertAuto(store, CandidateKind.Release);
    const news = insertAuto(store, CandidateKind.News);

    const process = await createProcessCandidate(store, { autoPublish, sendRawCard });
    await process(release);
    await process(news);

    expect(autoPublish).not.toHaveBeenCalled();
    expect(sendRawCard).toHaveBeenCalledTimes(2);
    expect(store.get(release.id)!.autoPublish).toBe(false);
    expect(store.get(news.id)!.autoPublish).toBe(false);
  });
});
