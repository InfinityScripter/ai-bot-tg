import { it, expect, describe } from "vitest";

import { truncate, stripHtml, dedupKeyFor, escapeMarkdown, canonicalizeUrl } from "../src/utils.js";

describe("canonicalizeUrl", () => {
  it("lowercases and strips a trailing slash", () => {
    expect(canonicalizeUrl("https://Example.com/News/")).toBe("https://example.com/news");
  });

  it("drops tracking params but keeps real ones", () => {
    expect(canonicalizeUrl("https://example.com/a?id=5&utm_source=tg&fbclid=xx")).toBe(
      "https://example.com/a?id=5",
    );
  });

  it("drops the fragment", () => {
    expect(canonicalizeUrl("https://example.com/a#section")).toBe("https://example.com/a");
  });

  it("collapses two URLs that differ only by tracking to the same key", () => {
    const a = canonicalizeUrl("https://example.com/post?utm_source=rss");
    const b = canonicalizeUrl("https://example.com/post?utm_campaign=daily");
    expect(a).toBe(b);
  });

  it("collapses URLs whose real query params differ only in order", () => {
    const a = canonicalizeUrl("https://example.com/post?a=1&b=2");
    const b = canonicalizeUrl("https://example.com/post?b=2&a=1");
    expect(a).toBe(b);
    expect(a).toBe("https://example.com/post?a=1&b=2");
  });

  it("falls back to a lowercased trim for non-URL guids", () => {
    expect(canonicalizeUrl("  TAG:Example,2026:Item-42 ")).toBe("tag:example,2026:item-42");
  });

  it("returns empty for empty input", () => {
    expect(canonicalizeUrl("")).toBe("");
  });

  it("does not throw on a non-string input (some feeds put objects in link/guid)", () => {
    // rss-parser can hand back a non-string link/guid; canonicalizeUrl must
    // degrade to "" rather than crash the whole collection run.
    const asAny = canonicalizeUrl as unknown as (v: unknown) => string;
    expect(asAny({ href: "https://x/y" })).toBe("");
    expect(asAny(["https://x/y"])).toBe("");
    expect(asAny(42)).toBe("");
    expect(asAny(null)).toBe("");
    expect(asAny(undefined)).toBe("");
  });
});

describe("dedupKeyFor", () => {
  it("prefers guid over link", () => {
    expect(dedupKeyFor("https://example.com/guid", "https://example.com/link")).toBe(
      "https://example.com/guid",
    );
  });

  it("falls back to link when guid is missing", () => {
    expect(dedupKeyFor(undefined, "https://example.com/link")).toBe("https://example.com/link");
  });

  it("returns empty when both are missing", () => {
    expect(dedupKeyFor(undefined, undefined)).toBe("");
  });
});

describe("stripHtml", () => {
  it("removes tags and collapses whitespace", () => {
    expect(stripHtml("<p>Hello   <b>world</b></p>")).toBe("Hello world");
  });
});

describe("truncate", () => {
  it("leaves short strings unchanged", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  it("truncates on a word boundary with an ellipsis", () => {
    expect(truncate("the quick brown fox", 12)).toBe("the quick…");
  });
});

describe("escapeMarkdown", () => {
  it("escapes Telegram legacy-Markdown special chars", () => {
    expect(escapeMarkdown("a*b_c`d[e]")).toBe("a\\*b\\_c\\`d\\[e\\]");
  });

  it("leaves plain text untouched", () => {
    expect(escapeMarkdown("Обычный заголовок без спецсимволов")).toBe(
      "Обычный заголовок без спецсимволов",
    );
  });

  it("escapes a lone backslash first so it cannot re-open an entity", () => {
    // '\*' in LLM output (regex/paths) must not survive as backslash+bold-open.
    expect(escapeMarkdown("regex \\d")).toBe("regex \\\\d");
    expect(escapeMarkdown("\\*")).toBe("\\\\\\*"); // \\ then \*
    // a backslash-escaped special is fully neutralized (no unbalanced entity)
    const out = escapeMarkdown("bold \\* here");
    expect(out).toBe("bold \\\\\\* here");
  });
});
