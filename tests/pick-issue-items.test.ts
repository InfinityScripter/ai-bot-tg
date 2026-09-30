import { it, expect, describe, afterEach, beforeEach } from "vitest";

import { CandidateKind } from "../src/enums.js";
import { CandidateStore } from "../src/store/index.js";
import { pickIssueItems } from "../src/channelDigest/pickIssueItems.js";

import type { SourceChannel } from "../src/feeds/index.js";

const CHANNELS: SourceChannel[] = [
  { name: "pri", priority: true },
  { name: "reg", priority: false },
  { name: "other", priority: false },
];

let store: CandidateStore;

beforeEach(() => {
  store = new CandidateStore(":memory:");
});

afterEach(() => store.close());

function queue(channel: string, id: number, score: number, html = "Текст поста"): void {
  store.channelQueue.add(
    {
      dedupKey: `tg:${channel.toLowerCase()}/${id}`,
      url: `https://t.me/${channel}/${id}`,
      title: `Пост ${id}`,
      snippet: html,
      html,
      feedTitle: `@${channel}`,
      imageUrl: null,
      imageUrls: [],
      publishedAt: Date.now(),
      kind: CandidateKind.Channel,
    },
    score,
  );
}

const picked = (isCovered: (key: string) => boolean = () => false, max = 7) =>
  pickIssueItems(store.channelQueue.list(), CHANNELS, isCovered, max).map(
    (p) => p.candidate.dedupKey,
  );

describe("pickIssueItems", () => {
  it("puts priority channels first, then the higher view score", () => {
    queue("reg", 1, 9);
    queue("Pri", 1, 0.5);
    queue("other", 1, 3);
    expect(picked()).toEqual(["tg:pri/1", "tg:reg/1", "tg:other/1"]);
  });

  it("takes at most two posts from one channel", () => {
    queue("reg", 1, 4);
    queue("reg", 2, 3);
    queue("reg", 3, 2);
    expect(picked()).toEqual(["tg:reg/1", "tg:reg/2"]);
  });

  it("skips a post that shares an outbound link with a picked one, t.me links aside", () => {
    queue("reg", 1, 5, '<a href="https://ex.com/story">статья</a>');
    queue("other", 1, 3, '<a href="https://ex.com/story/">та же статья</a>');
    queue("other", 2, 2, '<a href="https://t.me/reg/1">пост</a>');
    expect(picked()).toEqual(["tg:reg/1", "tg:other/2"]);
  });

  it("skips a post whose link an earlier issue already covered", () => {
    queue("reg", 1, 5, '<a href="https://ex.com/old">старое</a>');
    queue("reg", 2, 1);
    expect(picked((key) => key === "link:https://ex.com/old")).toEqual(["tg:reg/2"]);
  });

  it("stops at the maximum", () => {
    for (let i = 1; i <= 10; i += 1) queue(`ch${i}`, 1, i);
    expect(picked()).toHaveLength(7);
    expect(picked(() => false, 3)).toEqual(["tg:ch10/1", "tg:ch9/1", "tg:ch8/1"]);
  });
});
