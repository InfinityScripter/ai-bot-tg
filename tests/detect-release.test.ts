import { it, vi, expect, describe, afterEach } from "vitest";

const completeChatJson = vi.fn();
vi.mock("../src/llm/chatCompletion.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/chatCompletion.js")>();
  return { ...actual, completeChatJson: (...a: unknown[]) => completeChatJson(...a) };
});

const { detectKind, confirmRelease } = await import("../src/llm/index.js");
const { CandidateStore } = await import("../src/store/index.js");
import { CandidateKind } from "../src/enums.js";

import type { FeedItem } from "../src/types.js";

const STORE = new CandidateStore(":memory:");

function item(title: string): FeedItem {
  return {
    dedupKey: title,
    url: "https://ex.com/a",
    title,
    snippet: "",
    feedTitle: "Feed",
    imageUrl: null,
    imageUrls: [],
    publishedAt: null,
  };
}

const RELEASE = item("OpenAI launches GPT-6.1 Sol");

afterEach(() => {
  completeChatJson.mockReset();
  STORE.clearMockOverride();
});

describe("detectKind", () => {
  it("is news without a model call when the markers do not hit", async () => {
    expect(await detectKind(item("Why agents fail in production"), STORE)).toBe(CandidateKind.News);
    expect(completeChatJson).not.toHaveBeenCalled();
  });

  it("is a release when the markers hit and the model confirms", async () => {
    completeChatJson.mockResolvedValueOnce('{"release": true}');
    expect(await detectKind(RELEASE, STORE)).toBe(CandidateKind.Release);
  });

  it("is news when the model says a marker hit is not a release", async () => {
    completeChatJson.mockResolvedValueOnce('{"release": false}');
    expect(await detectKind(item("OpenAI-HuggingFace: a release of alignment tests"), STORE)).toBe(
      CandidateKind.News,
    );
    expect(completeChatJson).toHaveBeenCalledTimes(1);
  });

  it("is news when the check fails, so the item still reaches the digest", async () => {
    completeChatJson.mockRejectedValueOnce(new Error("OpenRouter ответил 503"));
    expect(await detectKind(RELEASE, STORE)).toBe(CandidateKind.News);
  });
});

describe("confirmRelease", () => {
  it("answers null (could not tell) on an unreadable reply", async () => {
    completeChatJson.mockResolvedValueOnce('{"release": "maybe"}');
    expect(await confirmRelease(RELEASE, STORE)).toBeNull();
    completeChatJson.mockResolvedValueOnce(null);
    expect(await confirmRelease(RELEASE, STORE)).toBeNull();
  });

  it("answers true without a call on the mock provider (no-credit pipeline)", async () => {
    STORE.setMockOverride(true);
    expect(await confirmRelease(RELEASE, STORE)).toBe(true);
    expect(completeChatJson).not.toHaveBeenCalled();
  });
});
