import type { Api } from "grammy";

import { it, vi, expect, describe, afterEach, beforeEach } from "vitest";

import { buildCrossPostCaption } from "../src/blog/crossPost.js";

import type { CrossPostContent } from "../src/bot/types.js";

const NEWS: CrossPostContent = {
  title: "GPT-5 вышел",
  description: "Короткое описание поста для канала.",
  coverUrl: "https://cdn.example.com/cover.jpg",
  linkFor: (id) => `https://aifirst.us.com/post/${id}`,
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

  it("caps the caption under Telegram's photo-caption limit", () => {
    const long = "słowo ".repeat(500);
    const caption = buildCrossPostCaption({ ...NEWS, description: long }, "https://x/y");
    expect(caption.length).toBeLessThanOrEqual(1000);
  });
});

describe("crossPostToChannel", () => {
  const sendPhoto = vi.fn(async () => ({ message_id: 1 }));
  const sendMessage = vi.fn(async () => ({ message_id: 2 }));
  const api = { sendPhoto, sendMessage } as unknown as Api;

  beforeEach(() => {
    vi.resetModules();
    sendPhoto.mockClear();
    sendMessage.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is a no-op (returns false, sends nothing) when no channel is configured", async () => {
    // setup.ts leaves TELEGRAM_CHANNEL_ID unset → cross-posting disabled.
    const { crossPostToChannel } = await import("../src/blog/crossPost.js");
    const sent = await crossPostToChannel(api, NEWS, "42");
    expect(sent).toBe(false);
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends a photo card with the cover when a channel is configured", async () => {
    vi.stubEnv("TELEGRAM_CHANNEL_ID", "@sh0ny");
    const { crossPostToChannel } = await import("../src/blog/crossPost.js");
    const sent = await crossPostToChannel(api, NEWS, "42");
    expect(sent).toBe(true);
    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendPhoto).toHaveBeenCalledWith(
      "@sh0ny",
      "https://cdn.example.com/cover.jpg",
      expect.objectContaining({
        caption: expect.stringContaining("[Читать на сайте →](https://aifirst.us.com/post/42)"),
        parse_mode: "Markdown",
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to a text message (og-preview) when there is no cover", async () => {
    vi.stubEnv("TELEGRAM_CHANNEL_ID", "-1001234567890");
    const { crossPostToChannel } = await import("../src/blog/crossPost.js");
    const sent = await crossPostToChannel(api, { ...NEWS, coverUrl: null }, "7");
    expect(sent).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendPhoto).not.toHaveBeenCalled();
  });

  it("skips sendPhoto for a relative/host-empty coverUrl (would 400) and sends text", async () => {
    vi.stubEnv("TELEGRAM_CHANNEL_ID", "@sh0ny");
    const { crossPostToChannel } = await import("../src/blog/crossPost.js");
    // A relative path like "/assets/x.jpg" has an empty host → invalid photo URL.
    const sent = await crossPostToChannel(api, { ...NEWS, coverUrl: "/assets/x.jpg" }, "9");
    expect(sent).toBe(true);
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("falls back to text when sendPhoto fails (non-image URL / 404) — never drops the post", async () => {
    vi.stubEnv("TELEGRAM_CHANNEL_ID", "@sh0ny");
    sendPhoto.mockRejectedValueOnce(new Error("400: Bad Request: wrong file identifier"));
    const { crossPostToChannel } = await import("../src/blog/crossPost.js");
    // Shaped like a URL (passes the check) but not a real image → sendPhoto 400s.
    const sent = await crossPostToChannel(
      api,
      { ...NEWS, coverUrl: "https://habr.com/share/publication/1/abc/" },
      "5",
    );
    expect(sent).toBe(true);
    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});
