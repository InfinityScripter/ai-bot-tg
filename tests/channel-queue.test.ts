import { it, expect, describe, afterEach, beforeEach } from "vitest";

import { CandidateStore } from "../src/store/index.js";
import { CandidateKind, CandidateState } from "../src/enums.js";

import type { FeedItem } from "../src/types.js";

const NOW = Date.parse("2026-10-01T08:00:00Z");
const HOUR = 3_600_000;

function post(channel: string, id: number, publishedAt: number | null = NOW - 3 * HOUR): FeedItem {
  return {
    dedupKey: `tg:${channel}/${id}`,
    url: `https://t.me/${channel}/${id}`,
    title: `Пост ${id}`,
    snippet: `Текст поста ${id}`,
    html: `Текст поста ${id}`,
    feedTitle: `@${channel}`,
    imageUrl: null,
    imageUrls: [],
    publishedAt,
    kind: CandidateKind.Channel,
  };
}

let store: CandidateStore;

beforeEach(() => {
  store = new CandidateStore(":memory:");
});

afterEach(() => store.close());

describe("ChannelQueue", () => {
  it("queues a post as a channel row in digest_queued with its view score", () => {
    const id = store.channelQueue.add(post("a", 1), 2.5)!;
    const row = store.get(id)!;
    expect(row).toMatchObject({
      kind: CandidateKind.Channel,
      state: CandidateState.DigestQueued,
      autoPublish: false,
      sourceHtml: "Текст поста 1",
    });
    expect(store.channelQueue.list()).toEqual([{ candidate: row, viewScore: 2.5 }]);
  });

  it("returns null for a key it already has or one kept in seen_keys", () => {
    store.channelQueue.add(post("a", 1), 1);
    expect(store.channelQueue.add(post("a", 1), 1)).toBeNull();
    store.markSeenKeys(["tg:a/2"]);
    expect(store.channelQueue.add(post("a", 2), 1)).toBeNull();
  });

  it("refreshes the score of a queued post only", () => {
    const id = store.channelQueue.add(post("a", 1), 1)!;
    expect(store.channelQueue.refreshScore("tg:a/1", 4)).toBe(true);
    expect(store.channelQueue.list()[0]?.viewScore).toBe(4);
    store.setState(id, CandidateState.Published);
    expect(store.channelQueue.refreshScore("tg:a/1", 9)).toBe(false);
    expect(store.channelQueue.refreshScore("tg:a/404", 9)).toBe(false);
  });

  it("expires posts published more than the window before now", () => {
    const old = store.channelQueue.add(post("a", 1, NOW - 25 * HOUR), 1)!;
    const fresh = store.channelQueue.add(post("a", 2, NOW - 23 * HOUR), 1)!;
    expect(store.channelQueue.expire(NOW, 24 * HOUR)).toBe(1);
    expect(store.get(old)!.state).toBe(CandidateState.Skipped);
    expect(store.get(fresh)!.state).toBe(CandidateState.DigestQueued);
  });

  it("skips a queued row, with the reason; a claimed or published row is left alone", () => {
    const queued = store.channelQueue.add(post("a", 1), 1)!;
    const claimed = store.channelQueue.add(post("a", 2), 1)!;
    const published = store.channelQueue.add(post("a", 3), 1)!;
    store.channelQueue.claim([claimed, published]);
    store.setPublished(published, "tg:1");

    expect(store.channelQueue.skipQueued(queued, "не новость")).toBe(true);
    expect(store.channelQueue.skipQueued(claimed, "не новость")).toBe(false);
    expect(store.channelQueue.skipQueued(published, "не новость")).toBe(false);

    expect(store.get(queued)).toMatchObject({ state: CandidateState.Skipped });
    expect(store.get(claimed)!.state).toBe(CandidateState.Publishing);
    expect(store.get(published)!.state).toBe(CandidateState.Published);
  });

  it("claims queued channel rows atomically and returns them on requeue", () => {
    const a = store.channelQueue.add(post("a", 1), 1)!;
    const b = store.channelQueue.add(post("a", 2), 1)!;
    expect(store.channelQueue.claim([a, b])).toBe(2);
    expect(store.get(a)!.state).toBe(CandidateState.Publishing);
    store.channelQueue.requeue([a, b]);
    expect(store.get(a)!.state).toBe(CandidateState.DigestQueued);
    expect(store.get(b)!.state).toBe(CandidateState.DigestQueued);
    expect(store.channelQueue.claim([])).toBe(0);
  });

  it("a partial claim changes no row", () => {
    const a = store.channelQueue.add(post("a", 1), 1)!;
    const b = store.channelQueue.add(post("a", 2), 1)!;
    const c = store.channelQueue.add(post("a", 3), 1)!;
    expect(store.channelQueue.claim([b])).toBe(1);
    expect(store.channelQueue.claim([a, b, c])).toBe(0);
    expect(store.get(a)!.state).toBe(CandidateState.DigestQueued);
    expect(store.get(b)!.state).toBe(CandidateState.Publishing);
    expect(store.get(c)!.state).toBe(CandidateState.DigestQueued);
  });

  it("remembers the last issue slot", () => {
    expect(store.channelQueue.lastSlot()).toBeNull();
    store.channelQueue.setLastSlot("2026-10-01/morning");
    expect(store.channelQueue.lastSlot()).toBe("2026-10-01/morning");
  });

  it("keeps the RSS digest queue and the channel queue apart", () => {
    const channel = store.channelQueue.add(post("a", 1), 1)!;
    const news = store.insertCollected(
      {
        ...post("n", 1),
        dedupKey: "https://ex.com/n",
        url: "https://ex.com/n",
        kind: CandidateKind.News,
      },
      true,
    )!;
    store.queueForDigest(news);
    expect(store.listDigestQueue().map((c) => c.id)).toEqual([news]);
    expect(store.channelQueue.list().map((p) => p.candidate.id)).toEqual([channel]);
    // @ts-expect-error reach into the private db for the test
    store.db.prepare("UPDATE candidates SET updated_at = datetime('now', '-3 days')").run();
    expect(store.expireDigestQueue(48)).toBe(1);
    expect(store.get(channel)!.state).toBe(CandidateState.DigestQueued);
  });
});
