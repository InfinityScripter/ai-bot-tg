import type { Api } from "grammy";

import { it, vi, expect, describe, afterEach, beforeEach } from "vitest";

import { ChannelRubric } from "../src/enums.js";
import { buildCrossPostCaption } from "../src/blog/crossPost.js";

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
  it("renders bold title, description and a Читать link", () => {
    const caption = buildCrossPostCaption(NEWS, "https://aifirst.us.com/post/42");
    // Hyphen is not a legacy-Markdown special, so it stays raw; title is bolded.
    expect(caption).toContain("*GPT-5 вышел*");
    expect(caption).toContain("Короткое описание");
    expect(caption).toContain("[Читать на сайте →](https://aifirst.us.com/post/42)");
  });

  it("escapes Markdown-special chars in title and description (no injection)", () => {
    const caption = buildCrossPostCaption(
      { ...NEWS, title: "A_B*C", description: "see [here](x) `code`" },
      "https://x/y",
    );
    // The backslash-escaped forms must be present; raw specials must not slip through.
    expect(caption).toContain("A\\_B\\*C");
    expect(caption).toContain("\\[here\\]");
    expect(caption).toContain("\\`code\\`");
  });

  it("omits the description line when it is empty", () => {
    const caption = buildCrossPostCaption(
      { ...NEWS, description: "" },
      "https://aifirst.us.com/post/1",
    );
    // Title and link only → exactly one blank-line separator between them.
    expect(caption.split("\n\n")).toHaveLength(2);
  });

  it("puts the why line and the rubric hashtag between the description and the link", () => {
    const caption = buildCrossPostCaption(NEWS, "https://aifirst.us.com/post/42", DRESS);
    expect(caption.split("\n\n")).toEqual([
      "*GPT-5 вышел*",
      "Короткое описание поста для канала.",
      "💡 *Зачем тебе это:* Обнови SDK до 2\\_0",
      "#модель",
      "[Читать на сайте →](https://aifirst.us.com/post/42)",
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
    expect(caption.length).toBeLessThanOrEqual(1000);
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
        caption: expect.stringContaining("[Читать на сайте →](https://aifirst.us.com/post/42)"),
        parse_mode: "Markdown",
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
    const sent = await crossPostToChannel(api, NEWS, "5", signal);
    expect(sent).toBe(true);
    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(signal).toHaveBeenCalledTimes(2);
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
        expect.objectContaining({ parse_mode: "Markdown" }),
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
