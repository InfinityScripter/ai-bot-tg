import type { Bot } from "grammy";

import { it, vi, expect, describe, afterEach, beforeEach } from "vitest";

import { CandidateStore } from "../src/store/index.js";
import {
  toDigestRewrite,
  buildDigestPost,
  finalizeDigestPost,
  countDigestEntries,
  renderDigestMarkdown,
} from "../src/llm/index.js";

import type { Candidate } from "../src/types.js";
import type { DigestPost } from "../src/schemas/digestPostSchema.js";

const ALLOWED = new Set(["https://ex.com/a", "https://ex.com/b", "https://ex.com/c"]);

function rawDigest(overrides: Partial<DigestPost> = {}): string {
  return JSON.stringify({
    title: "Что нового в мире AI",
    intro: "Собрали самое важное в одном посте.",
    sections: {
      hot: [{ url: "https://ex.com/a", headline: "OpenAI выпустила X", note: "коротко о сути" }],
      news: [{ url: "https://ex.com/b", headline: "Docker запустила Sandboxes" }],
      materials: [{ url: "https://ex.com/c", headline: "Разбор TRACE" }],
      cases: [],
    },
    ...overrides,
  });
}

describe("finalizeDigestPost", () => {
  it("accepts a valid digest and keeps allow-listed entries", () => {
    const post = finalizeDigestPost(rawDigest(), ALLOWED);
    expect(post.title).toBe("Что нового в мире AI");
    expect(countDigestEntries(post)).toBe(3);
  });

  it("drops entries whose url was not among the source items (anti-hallucination)", () => {
    const raw = rawDigest({
      sections: {
        hot: [{ url: "https://evil.example/phish", headline: "Выдуманная ссылка" }],
        news: [
          { url: "https://ex.com/a", headline: "A" },
          { url: "https://ex.com/b", headline: "B" },
          { url: "https://ex.com/c", headline: "C" },
        ],
        materials: [],
        cases: [],
      },
    });
    const post = finalizeDigestPost(raw, ALLOWED);
    expect(post.sections.hot).toHaveLength(0);
    expect(countDigestEntries(post)).toBe(3);
  });

  it("throws when fewer than DIGEST_MIN_ITEMS entries survive validation", () => {
    // Only 1 of 3 urls is allowed → 1 entry < default min 3.
    const raw = rawDigest({
      sections: {
        hot: [{ url: "https://ex.com/a", headline: "A" }],
        news: [{ url: "https://nope.example/x", headline: "X" }],
        materials: [{ url: "https://nope.example/y", headline: "Y" }],
        cases: [],
      },
    });
    expect(() => finalizeDigestPost(raw, ALLOWED)).toThrow(/меньше/);
  });

  it("throws on a null reply and on invalid JSON", () => {
    expect(() => finalizeDigestPost(null, ALLOWED)).toThrow(/не вернул JSON/);
    expect(() => finalizeDigestPost("не json", ALLOWED)).toThrow(/невалидный JSON/);
  });

  it("throws when the shape misses required fields", () => {
    expect(() => finalizeDigestPost(JSON.stringify({ title: "x" }), ALLOWED)).toThrow(/валидацию/);
  });

  it("clamps an over-long title to 100 chars", () => {
    const post = finalizeDigestPost(rawDigest({ title: "д".repeat(150) }), ALLOWED);
    expect(post.title).toHaveLength(100);
  });
});

describe("renderDigestMarkdown / toDigestRewrite", () => {
  const post = finalizeDigestPost(rawDigest(), ALLOWED);

  it("renders intro, only non-empty sections, linked bullets and the footer", () => {
    const md = renderDigestMarkdown(post);
    expect(md).toContain("Собрали самое важное в одном посте.");
    expect(md).toContain("**🔥 Hot:**");
    expect(md).toContain("**➡️ Новости:**");
    expect(md).toContain("**➡️ Полезные материалы:**");
    // Empty section is omitted entirely.
    expect(md).not.toContain("Обсуждения и кейсы");
    expect(md).toContain("🔹 [OpenAI выпустила X](https://ex.com/a): коротко о сути");
    // No note → no dangling dash.
    expect(md).toContain("🔹 [Docker запустила Sandboxes](https://ex.com/b)\n");
    expect(md).toContain("пишите в комментариях");
  });

  it("wraps into the RewriteResult publish shape with the mandatory news tag", () => {
    const rewrite = toDigestRewrite(post);
    expect(rewrite.title).toBe(post.title);
    expect(rewrite.description).toBe(post.intro);
    expect(rewrite.tags).toEqual(["новости"]);
    expect(rewrite.content).toContain("🔹 [Разбор TRACE](https://ex.com/c)");
    expect(rewrite.metaDescription.length).toBeLessThanOrEqual(155);
  });
});

describe("buildDigestPost (mock provider)", () => {
  let store: CandidateStore;

  beforeEach(() => {
    store = new CandidateStore(":memory:");
    store.setMockOverride(true);
  });

  afterEach(() => store.close());

  it("builds a no-LLM digest from candidate titles/urls", async () => {
    const candidates = ["a", "b", "c"].map(
      (s) =>
        ({
          sourceUrl: `https://ex.com/${s}`,
          sourceTitle: `Title ${s}`,
          feedTitle: "Feed",
          snippet: "s",
        }) as Candidate,
    );
    const post = await buildDigestPost(candidates, store);
    expect(post.sections.news).toHaveLength(3);
    expect(post.sections.news[0]!.url).toBe("https://ex.com/a");
    expect(post.title).toContain("3");
  });
});

describe("daily digest announcement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("announces the published section headlines and URLs, leaving out unused queue entries", async () => {
    vi.resetModules();
    vi.stubEnv("TELEGRAM_CHANNEL_ID", "@materials");
    const { CandidateState } = await import("../src/enums.js");
    const { CandidateStore: Store } = await import("../src/store/index.js");
    const { createDigestPostFlow } = await import("../src/bot/digestPostFlow.js");
    const completion = await import("../src/llm/chatCompletion.js");
    vi.spyOn(completion, "completeChatJson").mockResolvedValue(rawDigest());
    const publish = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/api/admin/settings")
        ? new Response(JSON.stringify({ data: { flags: { autoPublishNews: true } } }))
        : new Response(JSON.stringify({ post: { id: "daily-materials" } }), { status: 201 }),
    );
    vi.stubGlobal("fetch", publish);
    const sendPhoto = vi.fn(async (..._args: unknown[]) => ({ message_id: 1 }));
    const sendMessage = vi.fn(async () => ({ message_id: 2 }));
    const bot = { api: { sendPhoto, sendMessage } } as unknown as Bot;
    const store = new Store(":memory:");
    try {
      const ids = ["a", "b", "c", "unused"].map((slug) => {
        const id = store.insertCollected({
          dedupKey: slug,
          url: `https://ex.com/${slug}`,
          title: `Заголовок очереди ${slug}`,
          snippet: "Исходный текст",
          feedTitle: "Лента",
          imageUrl: null,
          imageUrls: [],
          publishedAt: Date.now(),
        })!;
        store.queueForDigest(id);
        return id;
      });
      const flow = createDigestPostFlow(bot, store);
      await flow.runDigestPost();
      for (const id of ids) expect(store.get(id)?.state).toBe(CandidateState.Published);
      expect(sendPhoto).toHaveBeenCalledOnce();
      const [channel, , options] = sendPhoto.mock.calls[0]! as [
        string,
        unknown,
        { caption: string; parse_mode: string },
      ];
      expect(channel).toBe("@materials");
      expect(options.parse_mode).toBe("HTML");
      expect(options.caption).toContain('<a href="https://ex.com/a">OpenAI выпустила X</a>');
      expect(options.caption).toContain(
        '<a href="https://ex.com/b">Docker запустила Sandboxes</a>',
      );
      expect(options.caption).toContain('<a href="https://ex.com/c">Разбор TRACE</a>');
      expect(options.caption).toContain('/post/daily-materials">Читать на сайте →</a>');
      expect(options.caption).not.toContain("unused");
      expect(options.caption).not.toContain("Заголовок очереди");
      await flow.runDigestPost();
      expect(sendPhoto).toHaveBeenCalledOnce();
    } finally {
      store.close();
    }
  });
});
