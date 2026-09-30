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

afterEach(() => {
  filterRelevant.mockReset();
});

describe("runChannelWatch", () => {
  it("inserts exactly one channel candidate and hands it to processCandidate", async () => {
    const store = new CandidateStore(":memory:");
    filterRelevant.mockImplementation(async (items: FeedItem[]) => ({
      kept: items,
      decisions: [],
    }));
    const processCandidate = vi.fn(async () => {});
    const fetchPages = pages(
      { channel: { name: "pri", priority: true }, posts: [post("pri", 1), post("pri", 2)] },
      {
        channel: { name: "big", priority: false },
        posts: [post("big", 1, 90_000), post("big", 2)],
      },
    );

    const summary = await runChannelWatch(store, processCandidate, { now: NOW, fetchPages });

    expect(processCandidate).toHaveBeenCalledTimes(1);
    const [candidate] = processCandidate.mock.calls[0] as unknown as [
      { kind: string; dedupKey: string; autoPublish: boolean },
    ];
    expect(candidate.kind).toBe(CandidateKind.Channel);
    expect(candidate.dedupKey.startsWith("tg:pri/")).toBe(true);
    expect(candidate.autoPublish).toBe(true);
    expect(summary.picked).toBe(candidate.dedupKey);
    store.close();
  });

  it("only picks among posts the relevance filter kept", async () => {
    const store = new CandidateStore(":memory:");
    filterRelevant.mockImplementation(async (items: FeedItem[]) => ({
      kept: items.filter((i) => i.dedupKey === "tg:reg/2"),
      decisions: [],
    }));
    const processCandidate = vi.fn(async () => {});
    const fetchPages = pages({
      channel: { name: "reg", priority: false },
      posts: [post("reg", 1, 9000), post("reg", 2, 500)],
    });

    await runChannelWatch(store, processCandidate, { now: NOW, fetchPages });

    const [candidate] = processCandidate.mock.calls[0] as unknown as [{ dedupKey: string }];
    expect(candidate.dedupKey).toBe("tg:reg/2");
    store.close();
  });

  it("a post that fails to process does not fail the sweep", async () => {
    const store = new CandidateStore(":memory:");
    filterRelevant.mockImplementation(async (items: FeedItem[]) => ({
      kept: items,
      decisions: [],
    }));
    const processCandidate = vi.fn(async () => {
      throw new Error("Telegram 400");
    });
    const fetchPages = pages({ channel: { name: "pri", priority: true }, posts: [post("pri", 1)] });

    const summary = await runChannelWatch(store, processCandidate, { now: NOW, fetchPages });

    expect(summary.picked).toBe("tg:pri/1");
    expect(summary.processFailed).toBe(true);
    expect(lastChannelWatch()?.error).toBeNull();
    store.close();
  });

  it("does not retell the same story twice when two channels link the same article", async () => {
    const store = new CandidateStore(":memory:");
    filterRelevant.mockImplementation(async (items: FeedItem[]) => ({
      kept: items,
      decisions: [],
    }));
    const processCandidate = vi.fn(async () => {});
    const first = { ...post("pri", 1), links: ["https://ex.com/story", "https://t.me/pri/0"] };
    const second = { ...post("reg", 7), links: ["https://ex.com/story/"] };

    await runChannelWatch(store, processCandidate, {
      now: NOW,
      fetchPages: pages({ channel: { name: "pri", priority: true }, posts: [first] }),
    });
    const summary = await runChannelWatch(store, processCandidate, {
      now: NOW,
      fetchPages: pages({ channel: { name: "reg", priority: false }, posts: [second] }),
    });

    expect(processCandidate).toHaveBeenCalledTimes(1);
    expect(summary.eligible).toBe(0);
    expect(store.isSeen("link:https://t.me/pri/0")).toBe(false);
    store.close();
  });

  it("forgets a link after 3 days", async () => {
    const store = new CandidateStore(":memory:");
    filterRelevant.mockImplementation(async (items: FeedItem[]) => ({
      kept: items,
      decisions: [],
    }));
    // @ts-expect-error reach into the private db for the test
    store.db
      .prepare("INSERT INTO seen_keys (dedup_key, seen_at) VALUES (?, datetime('now','-5 days'))")
      .run("link:https://ex.com/story");
    const processCandidate = vi.fn(async () => {});
    const fetchPages = pages({
      channel: { name: "pri", priority: true },
      posts: [{ ...post("pri", 1), links: ["https://ex.com/story"] }],
    });

    await runChannelWatch(store, processCandidate, { now: NOW, fetchPages });

    expect(processCandidate).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("throws when no channel page could be read", async () => {
    const store = new CandidateStore(":memory:");
    const fetchPages = vi.fn(async () => ({ pages: [] as ChannelPage[], failed: ["a", "b"] }));

    await expect(runChannelWatch(store, vi.fn(), { now: NOW, fetchPages })).rejects.toThrow(
      /ни один канал/,
    );
    expect(store.listByState(CandidateState.Collected)).toHaveLength(0);
    store.close();
  });
});
