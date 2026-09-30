import { it, vi, expect, describe, afterEach } from "vitest";

const retellChannelPost = vi.fn();
vi.mock("../src/llm/retellChannelPost.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/retellChannelPost.js")>();
  return { ...actual, retellChannelPost: (...a: unknown[]) => retellChannelPost(...a) };
});

vi.stubEnv("TELEGRAM_CHANNEL_ID", "@ai_first_news");
const { createBot } = await import("../src/bot/index.js");
const { CandidateStore } = await import("../src/store/index.js");
const { publishToChannel } = await import("../src/blog/index.js");
const { GateFailure } = await import("../src/llm/index.js");
const { assertRetellPublishable } = await import("../src/bot/channelExtraction.js");
import type { Update } from "grammy/types";

import { CandidateKind, CandidateState } from "../src/enums.js";

import type { FeedItem } from "../src/types.js";

const TEXT =
  "Пересказ поста: команда выпустила новую модель и объяснила, что в ней изменилось.\n\nИсточник: @ai_for_devs — https://t.me/ai_for_devs/184";

function item(key = "tg:ai_for_devs/184", imageUrl: string | null = null): FeedItem {
  return {
    dedupKey: key,
    url: "https://t.me/ai_for_devs/184",
    title: "Первая строка",
    snippet: "Текст поста. ".repeat(30),
    feedTitle: "@ai_for_devs",
    imageUrl,
    imageUrls: imageUrl ? [imageUrl] : [],
    publishedAt: null,
    kind: CandidateKind.Channel,
  };
}

function tgOk(messageId: number): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
    status: 200,
  });
}

function makeBot(store: InstanceType<typeof CandidateStore>) {
  const bundle = createBot(store, async () => {});
  const texts: string[] = [];
  const botCalls: string[] = [];
  bundle.bot.api.config.use((_prev, method, payload) => {
    botCalls.push(method);
    const { text } = payload as { text?: string };
    if (text) texts.push(text);
    return Promise.resolve({
      ok: true,
      result: method === "sendMessage" ? { message_id: 42 } : true,
    } as never);
  });
  return { ...bundle, texts, botCalls };
}

function tap(data: string): Update {
  return {
    update_id: 1,
    callback_query: {
      id: "cbq-1",
      from: { id: 123456789, is_bot: false, first_name: "Owner" },
      chat_instance: "ci",
      data,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 123456789, type: "private", first_name: "Owner" },
      },
    },
  } as Update;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("publishToChannel", () => {
  it("sends a photo with the caption and returns tg:<message_id>", async () => {
    const fetchMock = vi.fn(async () => tgOk(77));
    vi.stubGlobal("fetch", fetchMock);

    const out = await publishToChannel(TEXT, "https://cdn4.telesco.pe/file/a.jpg");

    expect(out).toEqual({ postId: "tg:77" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/sendPhoto$/);
    expect(JSON.parse(String(init.body))).toMatchObject({
      chat_id: "@ai_first_news",
      photo: "https://cdn4.telesco.pe/file/a.jpg",
      caption: TEXT,
    });
  });

  it("falls back to a text message when Telegram rejects the photo", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, description: "wrong file" }), { status: 400 }),
      )
      .mockResolvedValueOnce(tgOk(78));
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishToChannel(TEXT, "https://cdn/x.jpg")).resolves.toEqual({ postId: "tg:78" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/\/sendMessage$/);
  });

  it("marks a network failure as maybe-posted and a 4xx as not posted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(publishToChannel(TEXT, null)).rejects.toMatchObject({ maybePosted: true });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
            status: 400,
          }),
      ),
    );
    await expect(publishToChannel(TEXT, null)).rejects.toMatchObject({ maybePosted: false });
  });

  it("does not fall back to text after an ambiguous photo failure", async () => {
    const fetchMock = vi.fn(async () => new Response("oops", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishToChannel(TEXT, "https://cdn/x.jpg")).rejects.toMatchObject({
      maybePosted: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to text after a photo network error and hides the token", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const err = (await publishToChannel(TEXT, "https://cdn/x.jpg").catch(
      (e: unknown) => e,
    )) as Error;

    expect(err).toMatchObject({ maybePosted: true });
    expect(err.message).not.toContain("test:telegram-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never puts the bot token into an error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 502 })),
    );
    const err = (await publishToChannel(TEXT, null).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("test:telegram-token");
  });
});

describe("assertRetellPublishable allow-list", () => {
  const retell = (body: string) => ({
    text: `${body}\n\nИсточник: @ai_for_devs — https://t.me/ai_for_devs/184`,
  });
  const BODY = "Команда выпустила новую модель и подробно объяснила, что в ней поменялось";
  const SOURCE = "Пост: OpenAI выложила модель, детали на OpenAI.com, автор @sama_alt";

  it("rejects a domain the source post never mentioned", () => {
    expect(() => assertRetellPublishable(retell(`${BODY}, подробнее на evil.com`), SOURCE)).toThrow(
      GateFailure,
    );
  });

  it("accepts a domain and a handle that are in the source post", () => {
    expect(() =>
      assertRetellPublishable(retell(`${BODY}, детали на openai.com от @Sama_alt`), SOURCE),
    ).not.toThrow();
  });

  it("rejects an @handle the source post never mentioned", () => {
    expect(() => assertRetellPublishable(retell(`${BODY}, пишите @scam`), SOURCE)).toThrow(
      GateFailure,
    );
  });
});

describe("automatic channel retelling", () => {
  it("retells, posts to the channel only and never calls the blog", async () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(item(), true)!;
    retellChannelPost.mockResolvedValue({ text: TEXT });
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("api.telegram.org") ? tgOk(90) : new Response("", { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { autoPublishCandidate, texts } = makeBot(store);

    await autoPublishCandidate(store.get(id)!);

    const row = store.get(id)!;
    expect(row.state).toBe(CandidateState.Published);
    expect(row.blogPostId).toBe("tg:90");
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.filter((u) => u.includes("/api/post/new"))).toEqual([]);
    expect(urls.filter((u) => u.includes("api.telegram.org"))).toHaveLength(1);
    expect(texts.at(-1)).toContain("Автоопубликовано");
    store.close();
  });

  it("tells the owner to check the channel, not the blog, after an unconfirmed channel publish", async () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(item("tg:ai_for_devs/187"), true)!;
    retellChannelPost.mockResolvedValue({ text: TEXT });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { autoPublishCandidate, texts } = makeBot(store);

    await autoPublishCandidate(store.get(id)!).catch(() => {});

    expect(store.get(id)!.state).toBe(CandidateState.NeedsVerification);
    expect(texts.at(-1)).toContain("канал");
    expect(texts.at(-1)).not.toContain("блог");
    store.close();
  });

  it("the startup needs-verification card for a channel row points at the channel", async () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(item("tg:ai_for_devs/188"), true)!;
    store.setState(id, CandidateState.NeedsVerification);
    const { notifyNeedsVerification, texts } = makeBot(store);

    await notifyNeedsVerification();

    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("канал");
    expect(texts[0]).not.toContain("блог");
    expect(texts[0]).not.toContain("сайте");
    store.close();
  });

  it("sends a retelling over the caption limit to the owner instead of the channel", async () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(item("tg:ai_for_devs/185"), true)!;
    retellChannelPost.mockResolvedValue({ text: "д".repeat(1100) });
    const fetchMock = vi.fn(async () => tgOk(91));
    vi.stubGlobal("fetch", fetchMock);
    const { autoPublishCandidate } = makeBot(store);

    await autoPublishCandidate(store.get(id)!).catch(() => {});

    expect(store.get(id)!.state).toBe(CandidateState.PendingReview);
    expect(fetchMock).not.toHaveBeenCalled();
    store.close();
  });

  it("sends a retelling with a link the source post never had to the owner", async () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(item("tg:ai_for_devs/189"), true)!;
    retellChannelPost.mockResolvedValue({
      text: `Команда выпустила новую модель, все подробности и скидки на evil.com прямо сейчас.\n\nИсточник: @ai_for_devs — https://t.me/ai_for_devs/189`,
    });
    const fetchMock = vi.fn(async () => tgOk(93));
    vi.stubGlobal("fetch", fetchMock);
    const { autoPublishCandidate } = makeBot(store);

    await autoPublishCandidate(store.get(id)!).catch(() => {});

    expect(store.get(id)!.state).toBe(CandidateState.PendingReview);
    expect(fetchMock).not.toHaveBeenCalled();
    store.close();
  });

  it("sends a retelling with an empty body to the owner instead of the channel", async () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(item("tg:ai_for_devs/186"), true)!;
    retellChannelPost.mockResolvedValue({
      text: "Смотрите.\n\nИсточник: @ai_for_devs — https://t.me/ai_for_devs/186",
    });
    const fetchMock = vi.fn(async () => tgOk(92));
    vi.stubGlobal("fetch", fetchMock);
    const { autoPublishCandidate } = makeBot(store);

    await autoPublishCandidate(store.get(id)!).catch(() => {});

    expect(store.get(id)!.state).toBe(CandidateState.PendingReview);
    expect(fetchMock).not.toHaveBeenCalled();
    store.close();
  });
});

describe("manual channel retelling", () => {
  it("🔄 then ✅ posts to the channel once, never to the blog, without scraping t.me", async () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(item("tg:ai_for_devs/190"), false)!;
    retellChannelPost.mockResolvedValue({ text: TEXT });
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("api.telegram.org") ? tgOk(95) : new Response("", { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { bot } = makeBot(store);
    bot.botInfo = { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as typeof bot.botInfo;

    await bot.handleUpdate(tap(`rewrite_${id}`));
    expect(store.get(id)!.state).toBe(CandidateState.PendingReview);
    await bot.handleUpdate(tap(`approve_${id}`));

    const row = store.get(id)!;
    expect(row.state).toBe(CandidateState.Published);
    expect(row.blogPostId).toBe("tg:95");
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.filter((u) => u.includes("api.telegram.org"))).toHaveLength(1);
    expect(urls.filter((u) => u.includes("/api/post/new"))).toEqual([]);
    expect(urls.filter((u) => u.startsWith("https://t.me/"))).toEqual([]);
    store.close();
  });
});
