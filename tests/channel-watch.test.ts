import { it, vi, expect, describe, afterEach } from "vitest";

const filterRelevant = vi.fn();
vi.mock("../src/llm/filterRelevant.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/filterRelevant.js")>();
  return { ...actual, filterRelevant: (...a: unknown[]) => filterRelevant(...a) };
});

const { runChannelWatch, lastChannelWatch } = await import("../src/server/runChannelWatch.js");
const { CandidateStore } = await import("../src/store/index.js");
import { CandidateKind, CandidateState } from "../src/enums.js";

import type { FeedItem } from "../src/types.js";
import type { ChannelPost, ChannelPage } from "../src/feeds/index.js";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const LONG = "Текст поста про агентов и модели. ".repeat(10);

function post(channel: string, id: number, views = 1000): ChannelPost {
  return {
    channel,
    id,
    url: `https://t.me/${channel}/${id}`,
    text: LONG,
    links: [],
    html: LONG,
    imageUrls: [],
    publishedAt: NOW - 4 * 3_600_000,
    views,
    forwarded: false,
  };
}

function pages(...list: ChannelPage[]) {
  return vi.fn(async () => ({ pages: list, failed: [] as string[] }));
}

const keepAll = async (items: FeedItem[]) => ({ kept: items, decisions: [] });

afterEach(() => {
  filterRelevant.mockReset();
});

describe("runChannelWatch", () => {
  it("queues every kept post for the digest and publishes nothing", async () => {
    const store = new CandidateStore(":memory:");
    filterRelevant.mockImplementation(keepAll);
    const fetchPages = pages(
      {
        channel: { name: "pri", priority: true },
        posts: [post("pri", 1, 2000), post("pri", 2, 1000)],
      },
      { channel: { name: "big", priority: false }, posts: [post("big", 1, 90_000)] },
    );

    const summary = await runChannelWatch(store, { now: NOW, fetchPages });

    expect(summary).toMatchObject({ pages: 2, eligible: 3, kept: 3, queued: 3, refreshed: 0 });
    const queued = store.channelQueue.list();
    expect(queued.map((p) => p.candidate.dedupKey).sort()).toEqual([
      "tg:big/1",
      "tg:pri/1",
      "tg:pri/2",
    ]);
    expect(
      queued.every((p) => p.candidate.kind === CandidateKind.Channel && !p.candidate.autoPublish),
    ).toBe(true);
    // pri page: 2000 and 1000 views, median 1500
    expect(queued.find((p) => p.candidate.dedupKey === "tg:pri/1")?.viewScore).toBeCloseTo(4 / 3);
    expect(store.listByState(CandidateState.Collected)).toHaveLength(0);
    expect(lastChannelWatch()?.error).toBeNull();
    store.close();
  });

  it("refreshes the view score of a post that is already queued", async () => {
    const store = new CandidateStore(":memory:");
    filterRelevant.mockImplementation(keepAll);
    const channel = { name: "a", priority: false };
    await runChannelWatch(store, {
      now: NOW,
      fetchPages: pages({ channel, posts: [post("a", 1, 100), post("a", 2, 100)] }),
    });

    const summary = await runChannelWatch(store, {
      now: NOW,
      fetchPages: pages({ channel, posts: [post("a", 1, 300), post("a", 2, 100)] }),
    });

    expect(summary).toMatchObject({ eligible: 0, queued: 0, refreshed: 2 });
    // median of 300 and 100 is 200
    const first = store.channelQueue.list().find((p) => p.candidate.dedupKey === "tg:a/1");
    expect(first?.viewScore).toBe(1.5);
    store.close();
  });

  it("queues only what the relevance filter kept and does not ask about the rest again", async () => {
    const store = new CandidateStore(":memory:");
    filterRelevant.mockImplementation(async (items: FeedItem[]) => ({
      kept: items.filter((i) => i.dedupKey === "tg:reg/2"),
      decisions: [],
    }));
    const fetchPages = pages({
      channel: { name: "reg", priority: false },
      posts: [post("reg", 1), post("reg", 2)],
    });

    const summary = await runChannelWatch(store, { now: NOW, fetchPages });

    expect(summary).toMatchObject({ eligible: 2, kept: 1, queued: 1 });
    expect(store.channelQueue.list().map((p) => p.candidate.dedupKey)).toEqual(["tg:reg/2"]);
    expect(store.isSeen("tg:reg/1")).toBe(true);
    filterRelevant.mockClear();
    await runChannelWatch(store, { now: NOW, fetchPages });
    expect(filterRelevant).toHaveBeenCalledWith([], store);
    store.close();
  });

  it("skips a post whose link a published story already covered", async () => {
    const store = new CandidateStore(":memory:");
    filterRelevant.mockImplementation(keepAll);
    store.markSeenKeys(["link:https://ex.com/story"]);
    const fetchPages = pages({
      channel: { name: "reg", priority: false },
      posts: [{ ...post("reg", 7), links: ["https://ex.com/story/"] }],
    });

    const summary = await runChannelWatch(store, { now: NOW, fetchPages });

    expect(summary.eligible).toBe(0);
    expect(store.channelQueue.list()).toHaveLength(0);
    store.close();
  });

  it("throws when no channel page could be read", async () => {
    const store = new CandidateStore(":memory:");
    const fetchPages = vi.fn(async () => ({ pages: [] as ChannelPage[], failed: ["a", "b"] }));

    await expect(runChannelWatch(store, { now: NOW, fetchPages })).rejects.toThrow(/ни один канал/);
    expect(store.channelQueue.list()).toHaveLength(0);
    store.close();
  });
});
