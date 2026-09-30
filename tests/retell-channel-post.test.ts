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

const { retellChannelPost, finalizeRetell, withSourceLine } =
  await import("../src/llm/retellChannelPost.js");
const { CandidateStore } = await import("../src/store/index.js");
import { CandidateKind } from "../src/enums.js";

import type { FeedItem } from "../src/types.js";

const ITEM: FeedItem = {
  dedupKey: "tg:ai_for_devs/184",
  url: "https://t.me/ai_for_devs/184",
  title: "Первая строка",
  snippet: "Первая строка\nТекст поста. ".repeat(10),
  feedTitle: "@ai_for_devs",
  imageUrl: null,
  imageUrls: [],
  publishedAt: null,
  kind: CandidateKind.Channel,
};

afterEach(() => {
  completeChatJson.mockReset();
  humanizeText.mockClear();
});

describe("finalizeRetell", () => {
  it("accepts {text} and trims it", () => {
    expect(finalizeRetell(JSON.stringify({ text: "  Пересказ.  " }))).toEqual({
      text: "Пересказ.",
    });
  });
  it.each([
    [null],
    ["not json"],
    [JSON.stringify({ text: "" })],
    [JSON.stringify({ text: "x".repeat(1300) })],
  ])("rejects %s", (raw) => {
    expect(() => finalizeRetell(raw)).toThrow();
  });
});

describe("withSourceLine", () => {
  it("appends the channel and the post link once", () => {
    expect(withSourceLine("Пересказ.", ITEM)).toBe(
      "Пересказ.\n\nИсточник: @ai_for_devs — https://t.me/ai_for_devs/184",
    );
  });
});

describe("retellChannelPost", () => {
  it("retells with the active model, humanizes, then adds the source line", async () => {
    completeChatJson.mockResolvedValue(JSON.stringify({ text: "Пересказ поста." }));
    humanizeText.mockResolvedValueOnce("Живой пересказ поста.");
    const store = new CandidateStore(":memory:");

    const result = await retellChannelPost(ITEM, store);

    expect(humanizeText).toHaveBeenCalledWith("Пересказ поста.");
    expect(result.text).toBe(
      "Живой пересказ поста.\n\nИсточник: @ai_for_devs — https://t.me/ai_for_devs/184",
    );
    const [, , req] = completeChatJson.mock.calls[0] as [
      unknown,
      unknown,
      { user: string; system: string },
    ];
    expect(req.user).toContain("Текст поста.");
    store.close();
  });

  it("keeps the model text when the humanizer makes it longer than the cap", async () => {
    completeChatJson.mockResolvedValue(JSON.stringify({ text: "Коротко." }));
    humanizeText.mockResolvedValueOnce("д".repeat(950));
    const store = new CandidateStore(":memory:");

    const result = await retellChannelPost(ITEM, store);

    expect(result.text.startsWith("Коротко.")).toBe(true);
    store.close();
  });
});
