import { it, vi, expect, describe, afterEach } from "vitest";

const filterRelevant = vi.fn();
vi.mock("../src/llm/filterRelevant.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/filterRelevant.js")>();
  return { ...actual, filterRelevant: (...a: unknown[]) => filterRelevant(...a) };
});

const { runChannelWatch, CHANNEL_DAILY_LIMIT } = await import("../src/server/runChannelWatch.js");
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
    imageUrl: null,
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

  it("does nothing once the rolling daily limit is reached", async () => {
    const store = new CandidateStore(":memory:");
    for (let i = 0; i < CHANNEL_DAILY_LIMIT; i += 1) {
      const id = store.insertCollected(
        {
          dedupKey: `tg:x/${i}`,
          url: `https://t.me/x/${i}`,
          title: "t",
          snippet: "s",
          feedTitle: "@x",
          imageUrl: null,
          imageUrls: [],
          publishedAt: null,
          kind: CandidateKind.Channel,
        },
        true,
      )!;
      store.setPublished(id, `tg:${i}`);
    }
    const fetchPages = pages({ channel: { name: "pri", priority: true }, posts: [post("pri", 1)] });
    const processCandidate = vi.fn(async () => {});

    const summary = await runChannelWatch(store, processCandidate, { now: NOW, fetchPages });

    expect(summary.skipped).toBe("limit");
    expect(fetchPages).not.toHaveBeenCalled();
    expect(processCandidate).not.toHaveBeenCalled();
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
