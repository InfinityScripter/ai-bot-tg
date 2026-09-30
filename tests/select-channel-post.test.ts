import { it, expect, describe } from "vitest";

import { CandidateKind } from "../src/enums.js";
import {
  eligiblePosts,
  pickChannelPost,
  channelDedupKey,
  toChannelFeedItem,
} from "../src/server/selectChannelPost.js";

import type { ChannelPost } from "../src/feeds/index.js";
import type { ChannelPage } from "../src/feeds/fetchChannelPages.js";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const HOUR = 3_600_000;
const LONG = "Текст поста про агентов и модели. ".repeat(10);

function p(channel: string, id: number, over: Partial<ChannelPost> = {}): ChannelPost {
  return {
    channel,
    id,
    url: `https://t.me/${channel}/${id}`,
    text: LONG,
    html: LONG,
    links: [],
    imageUrls: [],
    publishedAt: NOW - 4 * HOUR,
    views: 1000,
    forwarded: false,
    ...over,
  };
}

function page(name: string, priority: boolean, posts: ChannelPost[]): ChannelPage {
  return { channel: { name, priority }, posts };
}

describe("eligiblePosts", () => {
  it("drops forwarded, short, ads, too fresh, too old, seen and already-covered posts", () => {
    const posts = [
      p("a", 1),
      p("a", 2, { forwarded: true }),
      p("a", 3, { text: "коротко" }),
      p("a", 4, { text: `${LONG} #реклама` }),
      p("a", 5, { text: `${LONG} erid: 2Vtzqx` }),
      p("a", 6, { publishedAt: NOW - HOUR }),
      p("a", 7, { publishedAt: NOW - 9 * HOUR }),
      p("a", 8),
      p("a", 9, { links: ["https://ex.com/covered"] }),
      p("a", 10, { publishedAt: null }),
    ];
    const kept = eligiblePosts([page("a", false, posts)], {
      now: NOW,
      isSeen: (key) => key === "tg:a/8",
      isSeenSince: () => false,
      isPublishedUrl: (url) => url === "https://ex.com/covered",
    });
    expect(kept.map((x) => x.id)).toEqual([1]);
  });
});

describe("eligiblePosts link dedup", () => {
  it("skips a post whose outbound link another retelling already covered, ignoring t.me links", () => {
    const posts = [
      p("a", 1, { links: ["https://ex.com/story/"] }),
      p("a", 2, { links: ["https://t.me/other/5"] }),
      p("a", 3, { links: ["https://ex.com/fresh"] }),
    ];
    const kept = eligiblePosts([page("a", false, posts)], {
      now: NOW,
      isSeen: () => false,
      isSeenSince: (key, days) =>
        days === 3 && (key === "link:https://ex.com/story" || key === "link:https://t.me/other/5"),
      isPublishedUrl: () => false,
    });
    expect(kept.map((x) => x.id)).toEqual([2, 3]);
  });

  it("ignores host-only links (autolinked file names, self-promo domains)", () => {
    const posts = [p("a", 1, { links: ["http://AGENTS.md", "https://vibecoding.tech/"] })];
    const kept = eligiblePosts([page("a", false, posts)], {
      now: NOW,
      isSeen: (key) => key.startsWith("link:"),
      isSeenSince: (key) => key.startsWith("link:"),
      isPublishedUrl: () => false,
    });
    expect(kept.map((x) => x.id)).toEqual([1]);
  });
});

describe("pickChannelPost", () => {
  it("prefers a priority channel even over a stronger regular post", () => {
    const big = page("big", false, [p("big", 1, { views: 50_000 }), p("big", 2, { views: 1_000 })]);
    const pri = page("pri", true, [p("pri", 1, { views: 900 }), p("pri", 2, { views: 1_000 })]);
    const picked = pickChannelPost([big, pri], [big.posts[0]!, pri.posts[0]!]);
    expect(picked?.channel).toBe("pri");
  });

  it("within a group scores views against the channel's own median", () => {
    // small: median 400, candidate 1200 → 3×; big: median 10k, candidate 15k → 1.5×
    const small = page("small", false, [
      p("small", 1, { views: 1200 }),
      p("small", 2, { views: 400 }),
      p("small", 3, { views: 300 }),
    ]);
    const big = page("big", false, [
      p("big", 1, { views: 15_000 }),
      p("big", 2, { views: 10_000 }),
      p("big", 3, { views: 9_000 }),
    ]);
    expect(pickChannelPost([small, big], [small.posts[0]!, big.posts[0]!])?.channel).toBe("small");
  });

  it("returns null when there is nothing to pick", () => {
    expect(pickChannelPost([], [])).toBeNull();
  });
});

describe("toChannelFeedItem", () => {
  it("maps a post to a channel FeedItem with its dedup key and attribution", () => {
    const post = p("Ai_For_Devs", 184, {
      imageUrls: ["https://cdn/x.jpg", "https://cdn/y.jpg"],
      text: "Заголовок строкой\nтело",
      html: "<b>Заголовок строкой</b>\nтело",
    });
    expect(channelDedupKey(post)).toBe("tg:ai_for_devs/184");
    expect(toChannelFeedItem(post)).toMatchObject({
      dedupKey: "tg:ai_for_devs/184",
      url: "https://t.me/Ai_For_Devs/184",
      title: "Заголовок строкой",
      snippet: "Заголовок строкой\nтело",
      feedTitle: "@Ai_For_Devs",
      html: "<b>Заголовок строкой</b>\nтело",
      imageUrl: "https://cdn/x.jpg",
      imageUrls: ["https://cdn/x.jpg", "https://cdn/y.jpg"],
      kind: CandidateKind.Channel,
    });
  });
});
