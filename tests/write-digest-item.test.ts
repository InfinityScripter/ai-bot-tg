import { it, vi, expect, describe, afterEach } from "vitest";

const completeChatJson = vi.fn();
vi.mock("../src/llm/chatCompletion.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/chatCompletion.js")>();
  return { ...actual, completeChatJson: (...a: unknown[]) => completeChatJson(...a) };
});
const humanizeText = vi.fn(async (t: string) => t);
vi.mock("../src/llm/humanize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/humanize.js")>();
  return { ...actual, humanizeText: (t: string) => humanizeText(t) };
});

const { writeDigestItem, finalizeDigestItem, inlineItemHtml } =
  await import("../src/llm/writeDigestItem.js");
const { RUBRIC_GUIDE, DRESS_SYSTEM_PROMPT } = await import("../src/llm/dressPrompt.js");
const { CandidateStore } = await import("../src/store/index.js");
import { CandidateKind, ChannelRubric } from "../src/enums.js";

import type { FeedItem } from "../src/types.js";

const LINK = "https://ex.com/article";
const ITEM: FeedItem = {
  dedupKey: "tg:ai_for_devs/640",
  url: "https://t.me/ai_for_devs/640",
  title: "Anthropic опубликовали рекламу GLM",
  snippet: "Anthropic проверили GLM-5.3: доля отказов упала с 95% до 6%. Эксплойт в 12% попыток.",
  html: `Anthropic <a href="${LINK}">проверили GLM-5.3</a>: доля отказов упала с 95% до 6%. Эксплойт в 12% попыток.`,
  feedTitle: "@ai_for_devs",
  imageUrl: null,
  imageUrls: [],
  publishedAt: null,
  kind: CandidateKind.Channel,
};
const MODEL_HTML = `Anthropic <a href="${LINK}">проверили GLM-5.3</a>: отказов стало 6% вместо 95%.`;
const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    skip: false,
    emoji: "🔥",
    rubric: "модель",
    title: "Anthropic сняли ограничения с GLM-5.3",
    html: MODEL_HTML,
    ...over,
  });

afterEach(() => {
  completeChatJson.mockReset();
  humanizeText.mockReset();
  humanizeText.mockImplementation(async (t: string) => t);
});

describe("finalizeDigestItem", () => {
  it("returns null when the model says the post is not news", () => {
    expect(finalizeDigestItem(JSON.stringify({ skip: true }))).toBeNull();
  });

  it("keeps one emoji and replaces anything else with 📌", () => {
    expect(finalizeDigestItem(reply({ emoji: "👨‍💻" }))?.emoji).toBe("👨‍💻");
    expect(finalizeDigestItem(reply({ emoji: "🔥🔥" }))?.emoji).toBe("📌");
    expect(finalizeDigestItem(reply({ emoji: "огонь" }))?.emoji).toBe("📌");
  });

  it("cuts the title to 80 characters", () => {
    expect(
      finalizeDigestItem(reply({ title: "слово ".repeat(30) }))!.title.length,
    ).toBeLessThanOrEqual(80);
  });

  it.each([
    [null],
    ["not json"],
    [JSON.stringify({ skip: false, emoji: "🔥", rubric: "модель", title: "", html: "x" })],
    [reply({ rubric: "новости" })],
    [reply({ rubric: ChannelRubric.Digest })],
  ])("rejects %s", (raw) => {
    expect(() => finalizeDigestItem(raw)).toThrow();
  });
});

describe("inlineItemHtml", () => {
  it("keeps inline tags and source links only, in one paragraph", () => {
    const html = `<blockquote>Цитата</blockquote>\n<b>Жирный</b> и <a href="https://evil.example/x">чужая</a> <a href="${LINK}">своя</a>\n\nИсточник: @ai_for_devs`;
    expect(inlineItemHtml(html, ITEM)).toBe(
      `Цитата <b>Жирный</b> и чужая <a href="${LINK}">своя</a>`,
    );
  });
});

describe("writeDigestItem", () => {
  it("writes a card with the active model and keeps the humanized text when it holds", async () => {
    const humanized = `Anthropic <a href="${LINK}">проверили GLM-5.3</a>: отказов теперь 6%, а было 95%.`;
    completeChatJson.mockResolvedValueOnce(reply());
    humanizeText.mockResolvedValueOnce(humanized);
    const store = new CandidateStore(":memory:");

    const card = await writeDigestItem(ITEM, store);

    expect(card).toEqual({
      emoji: "🔥",
      rubric: ChannelRubric.Model,
      title: "Anthropic сняли ограничения с GLM-5.3",
      html: humanized,
    });
    const [, , req] = completeChatJson.mock.calls[0] as [
      unknown,
      unknown,
      { system: string; user: string; maxTokens: number },
    ];
    expect(req.system).toContain(RUBRIC_GUIDE);
    expect(req.system).toContain('"skip"');
    expect(req.user).toContain("GLM-5.3");
    expect(req.maxTokens).toBe(1200);
    store.close();
  });

  it("returns null for a post the model marks as not news", async () => {
    completeChatJson.mockResolvedValueOnce(JSON.stringify({ skip: true }));
    const store = new CandidateStore(":memory:");
    expect(await writeDigestItem(ITEM, store)).toBeNull();
    expect(humanizeText).not.toHaveBeenCalled();
    store.close();
  });

  it("asks once to shorten a card over 450 characters and keeps the other fields", async () => {
    completeChatJson
      .mockResolvedValueOnce(reply({ html: `Anthropic проверили GLM-5.3. ${"д".repeat(460)}` }))
      .mockResolvedValueOnce(
        reply({ title: "Другой заголовок", html: "Anthropic проверили GLM-5.3 коротко." }),
      );
    const store = new CandidateStore(":memory:");

    const card = await writeDigestItem(ITEM, store);

    expect(completeChatJson).toHaveBeenCalledTimes(2);
    const [, , req] = completeChatJson.mock.calls[1] as [unknown, unknown, { user: string }];
    expect(req.user).toContain("<draft_json>");
    expect(req.user).toContain("450");
    expect(card).toMatchObject({
      title: "Anthropic сняли ограничения с GLM-5.3",
      html: "Anthropic проверили GLM-5.3 коротко.",
    });
    store.close();
  });

  it("throws when the card is still over the cap after the shorten call", async () => {
    const long = reply({ html: `Текст ${"д".repeat(460)}` });
    completeChatJson.mockResolvedValueOnce(long).mockResolvedValueOnce(long);
    const store = new CandidateStore(":memory:");
    await expect(writeDigestItem(ITEM, store)).rejects.toThrow(/длиннее 450/);
    store.close();
  });

  it("throws on a number the post does not have", async () => {
    completeChatJson.mockResolvedValueOnce(reply({ html: "Отказов стало 7%." }));
    const store = new CandidateStore(":memory:");
    await expect(writeDigestItem(ITEM, store)).rejects.toThrow(/число 7/);
    store.close();
  });

  it("throws on a domain or handle the post does not have", async () => {
    completeChatJson.mockResolvedValueOnce(
      reply({ html: "Подробности на glm.example и у @someone_else." }),
    );
    const store = new CandidateStore(":memory:");
    await expect(writeDigestItem(ITEM, store)).rejects.toThrow(/glm\.example/);
    store.close();
  });

  it("keeps the model HTML when the humanizer drops a link or adds a number", async () => {
    completeChatJson.mockResolvedValue(reply());
    const store = new CandidateStore(":memory:");
    humanizeText.mockResolvedValueOnce("Anthropic проверили GLM-5.3: отказов 6% вместо 95%.");
    expect((await writeDigestItem(ITEM, store))?.html).toBe(MODEL_HTML);
    humanizeText.mockResolvedValueOnce(
      `Anthropic <a href="${LINK}">проверили GLM-5.3</a>: отказов 6% вместо 95%, а было 99%.`,
    );
    expect((await writeDigestItem(ITEM, store))?.html).toBe(MODEL_HTML);
    store.close();
  });

  it("builds a card without the model in mock mode", async () => {
    const store = new CandidateStore(":memory:");
    store.setMockOverride(true);
    expect(await writeDigestItem(ITEM, store)).toMatchObject({
      emoji: "📌",
      rubric: ChannelRubric.Opinion,
      title: ITEM.title,
    });
    expect(completeChatJson).not.toHaveBeenCalled();
    store.close();
  });
});

describe("RUBRIC_GUIDE", () => {
  it("is spliced into the dress prompt at the same place as before", () => {
    expect(DRESS_SYSTEM_PROMPT).toContain(
      `Прочитай пост и верни четыре поля.\n\n${RUBRIC_GUIDE}\n\nwhy:`,
    );
  });
});
