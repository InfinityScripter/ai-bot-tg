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

const CREDIT = (id: number) =>
  `\n\nИсточник: <a href="https://t.me/ai_for_devs/${id}">@ai_for_devs</a>`;
const BODY_HTML =
  "Пересказ поста: <b>команда выпустила новую модель</b> и объяснила, что в ней изменилось.";
const TEXT = `${BODY_HTML}${CREDIT(184)}`;

function item(key = "tg:ai_for_devs/184", imageUrl: string | null = null): FeedItem {
  return {
    dedupKey: key,
    url: `https://t.me/${key.slice(3)}`,
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

const IMG_A = "https://cdn4.telesco.pe/file/a.jpg";
const IMG_B = "https://cdn4.telesco.pe/file/b.jpg";

function image(type = "image/jpeg", bytes = 3): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type } });
}

/** Routes Bot API calls to `telegram`, every other URL (a photo download) to `download`. */
function route(
  telegram: (method: string, init: RequestInit) => Response | Promise<Response>,
  download: (url: string) => Response | Promise<Response> = () => image(),
) {
  return vi.fn(async (url: string, init: RequestInit = {}) =>
    String(url).includes("api.telegram.org")
      ? telegram(String(url).split("/").pop() ?? "", init)
      : download(String(url)),
  );
}

const telegramCalls = (fetchMock: ReturnType<typeof route>) =>
  fetchMock.mock.calls
    .filter(([u]) => String(u).includes("api.telegram.org"))
    .map(([u, init]) => ({ method: String(u).split("/").pop(), body: init?.body }));

describe("publishToChannel", () => {
  it("downloads the photo and uploads it with the HTML caption", async () => {
    const fetchMock = route(() => tgOk(77));
    vi.stubGlobal("fetch", fetchMock);

    const out = await publishToChannel(TEXT, [IMG_A]);

    expect(out).toEqual({ postId: "tg:77" });
    const [call] = telegramCalls(fetchMock);
    expect(call?.method).toBe("sendPhoto");
    const form = call?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("chat_id")).toBe("@ai_first_news");
    expect(form.get("caption")).toBe(TEXT);
    expect(form.get("parse_mode")).toBe("HTML");
    expect(form.get("photo")).toBeInstanceOf(Blob);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(IMG_A);
  });

  it("sends an album as one media group with the caption on the first photo", async () => {
    const fetchMock = route(
      () =>
        new Response(
          JSON.stringify({ ok: true, result: [{ message_id: 81 }, { message_id: 82 }] }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishToChannel(TEXT, [IMG_A, IMG_B])).resolves.toEqual({ postId: "tg:81" });

    const [call] = telegramCalls(fetchMock);
    expect(call?.method).toBe("sendMediaGroup");
    const form = call?.body as FormData;
    expect(JSON.parse(String(form.get("media")))).toEqual([
      { type: "photo", media: "attach://p0", caption: TEXT, parse_mode: "HTML" },
      { type: "photo", media: "attach://p1" },
    ]);
    expect(form.get("p0")).toBeInstanceOf(Blob);
    expect(form.get("p1")).toBeInstanceOf(Blob);
  });

  it("skips photos that fail to download, are not images or are too big", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = route(
      () => tgOk(79),
      (url) => {
        if (url.endsWith("404.jpg")) return new Response("", { status: 404 });
        if (url.endsWith("html.jpg")) return image("text/html");
        if (url.endsWith("huge.jpg")) return image("image/jpeg", 10 * 1024 * 1024 + 1);
        if (url.endsWith("net.jpg")) throw new TypeError("fetch failed");
        return image();
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await publishToChannel(TEXT, [
      "https://cdn/404.jpg",
      "https://cdn/html.jpg",
      "https://cdn/huge.jpg",
      "https://cdn/net.jpg",
      "ftp://cdn/x.jpg",
      IMG_A,
    ]);

    expect(telegramCalls(fetchMock).map((c) => c.method)).toEqual(["sendPhoto"]);
    expect(fetchMock.mock.calls.map(([u]) => String(u))).not.toContain("ftp://cdn/x.jpg");
    expect(warn.mock.calls.filter(([m]) => String(m).startsWith("[channels]"))).toHaveLength(5);
  });

  it("sends an HTML text message without a preview when no photo is usable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = route(
      () => tgOk(80),
      () => new Response("", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishToChannel(TEXT, [IMG_A])).resolves.toEqual({ postId: "tg:80" });
    await publishToChannel(TEXT, []);

    const calls = telegramCalls(fetchMock);
    expect(calls.map((c) => c.method)).toEqual(["sendMessage", "sendMessage"]);
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      chat_id: "@ai_first_news",
      text: TEXT,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  it("falls back to a text message when Telegram rejects the photo", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = route((method) =>
      method === "sendPhoto"
        ? new Response(JSON.stringify({ ok: false, description: "wrong file" }), { status: 400 })
        : tgOk(78),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishToChannel(TEXT, [IMG_A])).resolves.toEqual({ postId: "tg:78" });
    expect(telegramCalls(fetchMock).map((c) => c.method)).toEqual(["sendPhoto", "sendMessage"]);
  });

  it("marks a network failure as maybe-posted and a 4xx as not posted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(publishToChannel(TEXT, [])).rejects.toMatchObject({ maybePosted: true });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
            status: 400,
          }),
      ),
    );
    await expect(publishToChannel(TEXT, [])).rejects.toMatchObject({ maybePosted: false });
  });

  it("does not fall back to text after an ambiguous photo failure", async () => {
    const fetchMock = route(() => new Response("oops", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishToChannel(TEXT, [IMG_A, IMG_B])).rejects.toMatchObject({
      maybePosted: true,
    });
    expect(telegramCalls(fetchMock).map((c) => c.method)).toEqual(["sendMediaGroup"]);
  });

  it("does not fall back to text after a photo network error and hides the token", async () => {
    const fetchMock = route(() => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const err = (await publishToChannel(TEXT, [IMG_A]).catch((e: unknown) => e)) as Error;

    expect(err).toMatchObject({ maybePosted: true });
    expect(err.message).not.toContain("test:telegram-token");
    expect(telegramCalls(fetchMock)).toHaveLength(1);
  });

  it("never puts the bot token into an error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 502 })),
    );
    const err = (await publishToChannel(TEXT, []).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("test:telegram-token");
  });
});

describe("assertRetellPublishable", () => {
  const retell = (body: string) => ({ html: `${body}${CREDIT(184)}` });
  const BODY = "Команда выпустила новую модель и подробно объяснила, что в ней поменялось";
  const LINK = "https://openai.com/index/new-model";
  const SOURCE = {
    url: "https://t.me/ai_for_devs/184",
    snippet: "Пост: OpenAI выложила модель, детали на OpenAI.com, автор @sama_alt",
    html: `Пост: OpenAI выложила <a href="${LINK}">модель</a>, детали на OpenAI.com, автор @sama_alt`,
    feedTitle: "@ai_for_devs",
  };

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

  it("accepts the source channel's own handle even when the post text lacks it", () => {
    expect(() =>
      assertRetellPublishable(retell(`Канал @AI_for_devs пишет: ${BODY}`), SOURCE),
    ).not.toThrow();
  });

  it("rejects an @handle the source post never mentioned", () => {
    expect(() => assertRetellPublishable(retell(`${BODY}, пишите @scam`), SOURCE)).toThrow(
      GateFailure,
    );
  });

  it("measures the caption on visible text, not on markup", () => {
    const long = `${LINK}?${"q".repeat(600)}`;
    const source = { ...SOURCE, html: `<a href="${long}">модель</a>` };
    const body = `<b>${"Слово ".repeat(120)}</b><a href="${long}">модель</a>`;
    expect(retell(body).html.length).toBeGreaterThan(1024);
    expect(() => assertRetellPublishable(retell(body), source)).not.toThrow();
    expect(() => assertRetellPublishable(retell(`<b>${"д".repeat(1010)}</b>`), source)).toThrow(
      /1024/,
    );
  });

  it("requires the code-built credit line linking the exact post", () => {
    expect(() =>
      assertRetellPublishable(
        { html: `${BODY}\n\nИсточник: @ai_for_devs — https://t.me/ai_for_devs/184` },
        SOURCE,
      ),
    ).toThrow(/Источник/);
  });

  it("rejects a body under 50 visible characters", () => {
    expect(() =>
      assertRetellPublishable(retell(`<b><a href="${LINK}">Смотрите</a></b>`), SOURCE),
    ).toThrow(/пустой/);
  });

  it("accepts a link to the source's own target and rejects any other", () => {
    expect(() =>
      assertRetellPublishable(retell(`${BODY} <a href="${LINK}/">тут</a>`), SOURCE),
    ).not.toThrow();
    expect(() =>
      assertRetellPublishable(retell(`${BODY} <a href="https://evil.com/x">тут</a>`), SOURCE),
    ).toThrow(GateFailure);
  });
});

describe("automatic channel retelling", () => {
  it("retells, posts to the channel only and never calls the blog", async () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(item(), true)!;
    retellChannelPost.mockResolvedValue({ html: TEXT });
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
    expect(texts.at(-1)).not.toContain("<b>");
    store.close();
  });

  it("publishes every photo of the source post as one album", async () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(
      { ...item(), imageUrl: IMG_A, imageUrls: [IMG_A, IMG_B] },
      true,
    )!;
    retellChannelPost.mockResolvedValue({ html: TEXT });
    const fetchMock = route(
      () =>
        new Response(JSON.stringify({ ok: true, result: [{ message_id: 96 }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { autoPublishCandidate } = makeBot(store);

    await autoPublishCandidate(store.get(id)!);

    expect(store.get(id)!.blogPostId).toBe("tg:96");
    expect(telegramCalls(fetchMock).map((c) => c.method)).toEqual(["sendMediaGroup"]);
    store.close();
  });

  it("tells the owner to check the channel, not the blog, after an unconfirmed channel publish", async () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(item("tg:ai_for_devs/187"), true)!;
    retellChannelPost.mockResolvedValue({ html: `${BODY_HTML}${CREDIT(187)}` });
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
    retellChannelPost.mockResolvedValue({ html: "д".repeat(1100) });
    const fetchMock = vi.fn(async () => tgOk(91));
    vi.stubGlobal("fetch", fetchMock);
    const { autoPublishCandidate } = makeBot(store);

    await autoPublishCandidate(store.get(id)!).catch(() => {});

    expect(store.get(id)!.state).toBe(CandidateState.PendingReview);
    expect(fetchMock).not.toHaveBeenCalled();
    store.close();
  });

  it("lets a retelling name the source channel's own handle", async () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(item("tg:ai_for_devs/191"), true)!;
    retellChannelPost.mockResolvedValue({
      html: `Канал @ai_for_devs пишет, что команда выпустила новую модель и объяснила изменения.${CREDIT(191)}`,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tgOk(94)),
    );
    const { autoPublishCandidate } = makeBot(store);

    await autoPublishCandidate(store.get(id)!);

    expect(store.get(id)!.state).toBe(CandidateState.Published);
    store.close();
  });

  it("sends a retelling with a link the source post never had to the owner", async () => {
    const store = new CandidateStore(":memory:");
    const id = store.insertCollected(item("tg:ai_for_devs/189"), true)!;
    retellChannelPost.mockResolvedValue({
      html: `Команда выпустила новую модель, все подробности и скидки на evil.com прямо сейчас.${CREDIT(189)}`,
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
      html: `Смотрите.${CREDIT(186)}`,
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
    retellChannelPost.mockResolvedValue({ html: TEXT });
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
