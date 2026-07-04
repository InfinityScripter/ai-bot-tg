import { it, expect, describe } from "vitest";

import { ensureSourceLine } from "../src/llm/ensureSourceLine.js";

const URL = "https://ex.com/article";
const FEED = "Example Feed";

describe("ensureSourceLine", () => {
  it("appends the canonical source line when the model output has none", () => {
    const content = "Заголовок абзаца.\n\nТело поста без ссылки на источник.";
    const out = ensureSourceLine(content, FEED, URL);
    // Original body is preserved and the canonical line is now the ending.
    expect(out.startsWith(content)).toBe(true);
    expect(out.endsWith(`Источник: [${FEED}](${URL})`)).toBe(true);
    // Exactly one source line in the result.
    expect(out.match(/^Источник:/gm)?.length).toBe(1);
  });

  it("normalizes a malformed/stale 'Источник:' line to the canonical one", () => {
    const content = "Тело поста.\n\nИсточник: [старый заголовок](https://old.example/stale)";
    const out = ensureSourceLine(content, FEED, URL);
    expect(out.endsWith(`Источник: [${FEED}](${URL})`)).toBe(true);
    // The stale label/url is gone — only the canonical line remains.
    expect(out).not.toContain("https://old.example/stale");
    expect(out.match(/^Источник:/gm)?.length).toBe(1);
    expect(out).toContain("Тело поста.");
  });

  it("falls back to 'оригинал' as the label when the feed title is empty", () => {
    const out = ensureSourceLine("Тело.", "", URL);
    expect(out.endsWith(`Источник: [оригинал](${URL})`)).toBe(true);
  });
});
