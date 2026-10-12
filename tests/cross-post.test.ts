import type { Api } from "grammy";

import { it, vi, expect, describe, afterEach, beforeEach } from "vitest";

import { ChannelRubric } from "../src/enums.js";
import { buildCrossPostCaption } from "../src/blog/crossPost.js";
import { hrefsOf, visibleText, sanitizeTelegramHtml } from "../src/feeds/telegramHtml.js";

import type { CrossPostContent } from "../src/bot/types.js";

const NEWS: CrossPostContent = {
  title: "GPT-5 вышел",
  description: "Короткое описание поста для канала.",
  coverUrl: "https://cdn.example.com/cover.jpg",
  linkFor: (id) => `https://aifirst.us.com/post/${id}`,
};
const DRESS = {
  rubric: ChannelRubric.Model,
  why: "Обнови SDK до 2_0",
  coverTitle: "Вышел GPT-5",
  coverFact: "",
};

describe("buildCrossPostCaption", () => {
  it("renders the title, description, at most three unique external materials and a Читать link", () => {
    const caption = buildCrossPostCaption(
      {
        ...NEWS,
        sourceLinks: [
          { url: "https://docs.example.com/guide", label: "Документация" },
          { url: "https://docs.example.com/guide", label: "Повтор" },
          { url: "https://t.me/channel/1", label: "Канал" },
          { url: "https://www.telegram.me/channel", label: "Канал-превью" },
          { url: "ftp://example.com/file", label: "Недопустимая схема" },
          { url: "https://user:pass@example.com/private", label: "Недопустимый адрес" },
          { url: "https://research.example.com/paper", label: "Исследование" },
          { url: "https://code.example.com/project", label: "Код" },
          { url: "https://extra.example.com/story", label: "Остальное на сайте" },
        ],
      },
      "https://aifirst.us.com/post/42",
    );
    expect(caption).toContain("<b>GPT-5 вышел</b>");
    expect(caption).toContain("Короткое описание");
    expect(caption).toContain('<a href="https://aifirst.us.com/post/42">Читать на сайте →</a>');
    expect(caption).toContain('">Документация</a>');
    expect(caption).toContain('">Исследование</a>');
    expect(caption).toContain('">Код</a>');
    expect(hrefsOf(caption)).toEqual([
      "https://docs.example.com/guide",
      "https://research.example.com/paper",
      "https://code.example.com/project",
      "https://aifirst.us.com/post/42",
    ]);
  });

  it("escapes HTML-special chars in title and description (no injection)", () => {
    const caption = buildCrossPostCaption(
      { ...NEWS, title: 'A & <B> "C"', description: 'see <a href="https://evil.com">here</a>' },
      "https://x/y",
    );
    expect(caption).toContain("A &amp; &lt;B&gt; &quot;C&quot;");
    expect(caption).toContain("&lt;a href=&quot;https://evil.com&quot;&gt;here&lt;/a&gt;");
    expect(hrefsOf(caption)).toEqual(["https://x/y"]);
  });

  it("omits the description line when it is empty", () => {
    const caption = buildCrossPostCaption(
      {
        ...NEWS,
        description: "",
        sourceLinks: [{ url: "https://t.me/channel/1", label: "Канал" }],
      },
      "https://aifirst.us.com/post/1",
    );
    // Title and link only → exactly one blank-line separator between them.
    expect(caption.split("\n\n")).toHaveLength(2);
    expect(caption).not.toContain("Материалы");
    expect(hrefsOf(caption)).toEqual(["https://aifirst.us.com/post/1"]);
  });

  it("puts the why line and the rubric hashtag between the description and the link", () => {
    const caption = buildCrossPostCaption(NEWS, "https://aifirst.us.com/post/42", DRESS);
    expect(caption.split("\n\n")).toEqual([
      "<b>GPT-5 вышел</b>",
      "Короткое описание поста для канала.",
      "💡 <b>Зачем тебе это:</b> Обнови SDK до 2_0",
      "#модель",
      '<a href="https://aifirst.us.com/post/42">Читать на сайте →</a>',
    ]);
  });

  it("keeps the hashtag and leaves out an empty why line", () => {
    const caption = buildCrossPostCaption(NEWS, "https://x/y", { ...DRESS, why: "" });
    expect(caption).not.toContain("Зачем");
    expect(caption).toContain("#модель");
  });

  it("caps the caption under Telegram's photo-caption limit", () => {
    const long = "słowo ".repeat(500);
    const caption = buildCrossPostCaption({ ...NEWS, description: long }, "https://x/y");
    expect(visibleText(caption).length).toBeLessThanOrEqual(1000);
  });

  it("retains a long href when its material label fits the visible caption budget", () => {
    const sourceUrl = `https://lab.example/research?query=${"x".repeat(1200)}`;
    const blogUrl = "https://aifirst.us.com/post/42";
    const caption = buildCrossPostCaption(
      { ...NEWS, sourceLinks: [{ url: sourceUrl, label: "Статья лаборатории" }] },
      blogUrl,
    );
    expect(hrefsOf(caption)).toEqual([sourceUrl, blogUrl]);
    expect(caption).toContain(`<a href="${sourceUrl}">Статья лаборатории</a>`);
    expect(visibleText(caption).length).toBeLessThanOrEqual(1000);
    expect(caption.length).toBeGreaterThan(1000);
    expect(sanitizeTelegramHtml(caption)).toBe(caption);
  });

  it.each([
    ["keeps a whole emoji", `${"<".repeat(197)}😀xx`, `${"<".repeat(197)}😀…`],
    ["omits an emoji that cannot fit whole", `${"<".repeat(198)}😀x`, `${"<".repeat(198)}…`],
  ])("budgets original text before HTML escaping and %s", (_, title, expected) => {
    const caption = buildCrossPostCaption({ ...NEWS, title }, "https://aifirst.us.com/post/42");
    expect(visibleText(caption.split("\n\n")[0]!)).toBe(expected);
    expect(sanitizeTelegramHtml(caption)).toBe(caption);
  });

  it("trims prose before three complete materials, keeping HTML entities and query URLs intact", () => {
    const sourceLinks = [
      { url: 'https://docs.example.com/guide(v2)?lang=ru&tag="sdk"', label: 'API & <SDK> "guide"' },
      { url: "https://research.example.com/paper?q=one&v=two", label: "Исследование" },
      { url: "https://code.example.com/project", label: "Код" },
    ];
    const blogUrl = "https://aifirst.us.com/post/42?full=yes&lang=ru";
    const caption = buildCrossPostCaption(
      { ...NEWS, title: '😀<&" '.repeat(200), description: '😀<&" '.repeat(400), sourceLinks },
      blogUrl,
      { ...DRESS, why: '😀<&" '.repeat(200) },
    );
    expect(visibleText(caption).length).toBeLessThanOrEqual(1000);
    expect(sanitizeTelegramHtml(caption)).toBe(caption);
    expect(hrefsOf(caption)).toEqual([...sourceLinks.map(({ url }) => url), blogUrl]);
    expect(visibleText(caption)).toContain('API & <SDK> "guide"');
    expect(caption).toContain('tag=&quot;sdk&quot;">API &amp; &lt;SDK&gt; &quot;guide&quot;</a>');
    expect(caption.endsWith('">Читать на сайте →</a>')).toBe(true);
  });
});

describe("crossPostToChannel", () => {
  const sendPhoto = vi.fn(async (..._a: unknown[]) => ({ message_id: 1 }));
  const sendMessage = vi.fn(async (..._a: unknown[]) => ({ message_id: 2 }));
  const api = { sendPhoto, sendMessage } as unknown as Api;

  beforeEach(() => {
    vi.resetModules();
    sendPhoto.mockClear();
    sendMessage.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("../src/blog/renderCover.js");
  });

  it("is a no-op (returns false, sends nothing) when no channel is configured", async () => {
    // setup.ts leaves TELEGRAM_CHANNEL_ID unset → cross-posting disabled.
    const { crossPostToChannel } = await import("../src/blog/crossPost.js");
    const sent = await crossPostToChannel(api, NEWS, "42");
    expect(sent).toBe(false);
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("uploads the branded cover even when the blog has a cover of its own", async () => {
    vi.stubEnv("TELEGRAM_CHANNEL_ID", "@sh0ny");
    const { InputFile } = await import("grammy");
    const { crossPostToChannel } = await import("../src/blog/crossPost.js");
    const sent = await crossPostToChannel(api, NEWS, "42");
    expect(sent).toBe(true);
    expect(sendPhoto).toHaveBeenCalledOnce();
    const [chat, photo, options] = sendPhoto.mock.calls[0]!;
    expect(chat).toBe("@sh0ny");
    expect(photo).toBeInstanceOf(InputFile);
    expect(options).toEqual(
      expect.objectContaining({
        caption: expect.stringContaining(
          '<a href="https://aifirst.us.com/post/42">Читать на сайте →</a>',
        ),
        parse_mode: "HTML",
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("dresses the caption, then starts the Telegram timeout", async () => {
    vi.stubEnv("TELEGRAM_CHANNEL_ID", "@sh0ny");
    const order: string[] = [];
    const dress = vi.fn(async () => {
      order.push("dress");
      return DRESS;
    });
    const signal = vi.fn(() => {
      order.push("signal");
      return AbortSignal.timeout(5000) as unknown as Parameters<Api["sendMessage"]>[3];
    });
    const { crossPostToChannel } = await import("../src/blog/crossPost.js");
    await crossPostToChannel(api, { ...NEWS, dress }, "42", signal);
    expect(order).toEqual(["dress", "signal"]);
    const [, , options, passedSignal] = sendPhoto.mock.calls[0]!;
    expect((options as { caption: string }).caption).toContain("#модель");
    expect(passedSignal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to text when Telegram rejects the cover — never drops the post", async () => {
    vi.stubEnv("TELEGRAM_CHANNEL_ID", "@sh0ny");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sendPhoto.mockRejectedValueOnce(new Error("400: Bad Request: IMAGE_PROCESS_FAILED"));
    const signal = vi.fn(
      () => AbortSignal.timeout(5000) as unknown as Parameters<Api["sendMessage"]>[3],
    );
    const { crossPostToChannel } = await import("../src/blog/crossPost.js");
    const sourceUrl = `https://docs.example.com/guide?query=${"x".repeat(1200)}&v=2`;
    const sent = await crossPostToChannel(
      api,
      {
        ...NEWS,
        sourceLinks: [{ url: sourceUrl, label: "API & SDK" }],
      },
      "5",
      signal,
    );
    expect(sent).toBe(true);
    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(signal).toHaveBeenCalledTimes(2);
    const photoOptions = sendPhoto.mock.calls[0]![2] as { caption: string; parse_mode: string };
    const [, text, textOptions] = sendMessage.mock.calls[0]!;
    expect(text).toBe(photoOptions.caption);
    expect(photoOptions.parse_mode).toBe("HTML");
    expect(textOptions).toMatchObject({ parse_mode: "HTML" });
    expect(hrefsOf(String(text))).toEqual([sourceUrl, "https://aifirst.us.com/post/5"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("IMAGE_PROCESS_FAILED"));
    warn.mockRestore();
  });

  describe("when the cover cannot be rendered", () => {
    beforeEach(() => {
      vi.doMock("../src/blog/renderCover.js", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../src/blog/renderCover.js")>()),
        tryRenderCover: () => null,
      }));
    });

    it("sends the blog's own cover", async () => {
      vi.stubEnv("TELEGRAM_CHANNEL_ID", "@sh0ny");
      const { crossPostToChannel } = await import("../src/blog/crossPost.js");
      await crossPostToChannel(api, NEWS, "42");
      expect(sendPhoto).toHaveBeenCalledWith(
        "@sh0ny",
        "https://cdn.example.com/cover.jpg",
        expect.objectContaining({ parse_mode: "HTML" }),
      );
    });

    it.each([
      ["no cover", null],
      ["a relative cover, which Telegram would 400", "/assets/x.jpg"],
    ])("sends text for %s", async (_, coverUrl) => {
      vi.stubEnv("TELEGRAM_CHANNEL_ID", "-1001234567890");
      const { crossPostToChannel } = await import("../src/blog/crossPost.js");
      expect(await crossPostToChannel(api, { ...NEWS, coverUrl }, "7")).toBe(true);
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendPhoto).not.toHaveBeenCalled();
    });
  });
});
