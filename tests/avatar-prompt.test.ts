import { it, expect, describe } from "vitest";

const { avatarTranscript, avatarSystemPrompt } = await import("../src/avatar/avatarPrompt.js");

import type { ChatLine } from "../src/avatar/types.js";

const line = (author: string, text: string, fromAvatar = false): ChatLine => ({
  messageId: 1,
  authorId: 1,
  author,
  text,
  at: 0,
  fromAvatar,
});

const MEMORY = [{ title: "Агенты", url: "https://b/post/1", body: "Агенты экономят часы." }];

describe("avatarSystemPrompt", () => {
  it("contains the profile, numbered excerpts with links and the mode rule", () => {
    const direct = avatarSystemPrompt("ПРОФИЛЬ", MEMORY, true);
    expect(direct).toContain("ПРОФИЛЬ");
    expect(direct).toContain("[1] Агенты — https://b/post/1\nАгенты экономят часы.");
    expect(direct).toContain("Тебя позвали напрямую");
    const unasked = avatarSystemPrompt("", [], false);
    expect(unasked).toContain("Тебя не звали");
    expect(unasked).toContain("(профиль не задан)");
    expect(unasked).toContain("(ничего не нашлось)");
  });

  it("asks for the group responder's reply/silent contract", () => {
    const prompt = avatarSystemPrompt("", [], true);
    expect(prompt).toContain('{"action":"reply","text":"..."}');
    expect(prompt).toContain('{"action":"silent","text":""}');
  });
});

describe("avatarTranscript", () => {
  it("marks the avatar's own lines and drops the oldest lines past the size cap", () => {
    const old = line("Старый", "x".repeat(5990));
    const text = avatarTranscript([old, line("Оля", "привет"), line("", "и тебе", true)]);
    expect(text).toBe("Оля: привет\nТы (аватар): и тебе");
  });
});
