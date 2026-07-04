import { it, expect, describe } from "vitest";

import { isCasePassing } from "../evals/checks/types.js";
import { checkRelevance, parseRelevanceReply } from "../evals/checks/relevanceChecks.js";
import {
  checkMeta,
  checkTags,
  checkTitle,
  checkImages,
  checkRewrite,
  checkMarkdown,
  checkSourceLine,
  checkNoLeadingHeading,
} from "../evals/checks/rewriteChecks.js";

import type { Finding } from "../evals/checks/types.js";
import type { FeedItem, RewriteResult } from "../src/types.js";

/**
 * Tests for the eval GRADERS themselves. A check that never fails on bad input is
 * worthless, so every check is proven to (a) pass a good artifact and (b) flag a
 * deliberately broken one at the right severity. This is what makes the eval
 * harness trustworthy.
 */

const ITEM: FeedItem = {
  dedupKey: "k",
  url: "https://ex.com/article",
  title: "Оригинальный заголовок источника",
  snippet: "snippet",
  feedTitle: "Хабр",
  imageUrl: "https://cdn/cover.jpg",
  imageUrls: ["https://cdn/cover.jpg", "https://cdn/in1.png"],
  publishedAt: null,
};

/** A fully valid rewrite for ITEM. */
function goodResult(): RewriteResult {
  return {
    title: "Хороший короткий заголовок",
    description: "Одно-два предложения резюме поста.",
    content:
      "Первый абзац поста.\n\n## Подзаголовок\n\n- пункт один\n- пункт два\n\n" +
      "![](https://cdn/in1.png)\n\nИсточник: [Хабр](https://ex.com/article)",
    tags: ["новости", "разработка"],
    metaTitle: "Хороший заголовок",
    metaDescription: "Короткое SEO-описание.",
  };
}

/** True if a finding id is present and failed at error severity. */
function erroredOn(findings: Finding[], id: string): boolean {
  return findings.some((f) => f.id === id && !f.ok && f.severity === "error");
}
function warnedOn(findings: Finding[], id: string): boolean {
  return findings.some((f) => f.id === id && !f.ok && f.severity === "warn");
}

describe("checkRewrite — full pass on a good result", () => {
  it("produces zero error findings for a clean rewrite", () => {
    const findings = checkRewrite(goodResult(), ITEM);
    expect(isCasePassing(findings)).toBe(true);
    expect(findings.filter((f) => !f.ok && f.severity === "error")).toEqual([]);
  });
});

describe("checkTitle", () => {
  it("errors on an empty title", () => {
    expect(erroredOn(checkTitle({ ...goodResult(), title: "  " }, ITEM), "title.nonEmpty")).toBe(
      true,
    );
  });
  it("errors on a title over the 100-char hard clamp", () => {
    const long = "А".repeat(120);
    expect(erroredOn(checkTitle({ ...goodResult(), title: long }, ITEM), "title.hardMax")).toBe(
      true,
    );
  });
  it("warns (not errors) on a title over the 80-char target", () => {
    const t = "Б".repeat(90);
    const f = checkTitle({ ...goodResult(), title: t }, ITEM);
    expect(warnedOn(f, "title.softMax")).toBe(true);
    expect(erroredOn(f, "title.softMax")).toBe(false);
  });
  it("errors when the title starts with '#'", () => {
    expect(
      erroredOn(checkTitle({ ...goodResult(), title: "# Заголовок" }, ITEM), "title.noHeading"),
    ).toBe(true);
  });
  it("warns when the title copies the source verbatim", () => {
    expect(
      warnedOn(checkTitle({ ...goodResult(), title: ITEM.title }, ITEM), "title.notVerbatim"),
    ).toBe(true);
  });
});

describe("checkNoLeadingHeading", () => {
  it("errors when the body opens with a heading", () => {
    const r = {
      ...goodResult(),
      content: "## Заголовок\n\nтекст\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(erroredOn(checkNoLeadingHeading(r), "content.noLeadingHeading")).toBe(true);
  });
  it("passes when the body opens with prose", () => {
    expect(isCasePassing(checkNoLeadingHeading(goodResult()))).toBe(true);
  });
});

describe("checkSourceLine", () => {
  it("errors when there is no source line", () => {
    const r = { ...goodResult(), content: "Просто текст без источника." };
    expect(erroredOn(checkSourceLine(r, ITEM), "source.present")).toBe(true);
  });
  it("errors when the source URL points elsewhere", () => {
    const r = { ...goodResult(), content: "Текст.\n\nИсточник: [Хабр](https://other.com/x)" };
    expect(erroredOn(checkSourceLine(r, ITEM), "source.url")).toBe(true);
  });
  it("passes for the canonical source line", () => {
    expect(isCasePassing(checkSourceLine(goodResult(), ITEM))).toBe(true);
  });
});

describe("checkImages", () => {
  it("errors on an off-allowlist image (invented or cover)", () => {
    const r = {
      ...goodResult(),
      content: "Текст.\n\n![](https://evil/fake.png)\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(erroredOn(checkImages(r, ITEM), "images.allowlist")).toBe(true);
  });
  it("errors when the cover image (index 0) is embedded in the body", () => {
    const r = {
      ...goodResult(),
      content: "Текст.\n\n![](https://cdn/cover.jpg)\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(erroredOn(checkImages(r, ITEM), "images.allowlist")).toBe(true);
  });
  it("passes when only allow-listed body images are used", () => {
    expect(isCasePassing(checkImages(goodResult(), ITEM))).toBe(true);
  });
});

describe("checkTags", () => {
  it("errors on an off-whitelist tag", () => {
    expect(
      erroredOn(checkTags({ ...goodResult(), tags: ["новости", "спорт"] }), "tags.whitelist"),
    ).toBe(true);
  });
  it("errors when новости is not first", () => {
    expect(
      erroredOn(checkTags({ ...goodResult(), tags: ["разработка", "новости"] }), "tags.newsFirst"),
    ).toBe(true);
  });
  it("errors on an empty tag list", () => {
    expect(erroredOn(checkTags({ ...goodResult(), tags: [] }), "tags.count")).toBe(true);
  });
});

describe("checkMarkdown", () => {
  it("errors on backslash-escaped markdown", () => {
    const r = {
      ...goodResult(),
      content: "Текст со \\# экранированием.\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(erroredOn(checkMarkdown(r), "md.noEscape")).toBe(true);
  });
  it("errors on raw HTML tags", () => {
    const r = {
      ...goodResult(),
      content: "Текст <b>жирный</b>.\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(erroredOn(checkMarkdown(r), "md.noHtml")).toBe(true);
  });
  it("errors on a malformed link (no url scheme)", () => {
    const r = {
      ...goodResult(),
      content: "Смотри [тут](/relative).\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(erroredOn(checkMarkdown(r), "md.links")).toBe(true);
  });
  it("warns on a bare URL in parens after text", () => {
    const r = {
      ...goodResult(),
      content: "Читайте на Хабре (https://habr.com/x).\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(warnedOn(checkMarkdown(r), "md.bareUrl")).toBe(true);
  });
  it("passes clean markdown", () => {
    expect(isCasePassing(checkMarkdown(goodResult()))).toBe(true);
  });
});

describe("checkMeta", () => {
  it("errors on an empty description", () => {
    expect(erroredOn(checkMeta({ ...goodResult(), description: "" }), "desc.nonEmpty")).toBe(true);
  });
  it("warns on an over-long metaDescription", () => {
    expect(
      warnedOn(checkMeta({ ...goodResult(), metaDescription: "x".repeat(200) }), "meta.descLen"),
    ).toBe(true);
  });
});

describe("relevance checks", () => {
  it("parses a valid reply", () => {
    expect(parseRelevanceReply('{"score":3,"topic":"ии","reason":"по теме"}')).toEqual({
      score: 3,
      topic: "ии",
      reason: "по теме",
    });
  });
  it("returns null for non-JSON", () => {
    expect(parseRelevanceReply("not json")).toBeNull();
  });
  it("errors when the score is out of the expected band", () => {
    const reply = parseRelevanceReply('{"score":0,"topic":"x","reason":"y"}');
    expect(erroredOn(checkRelevance(reply, "on"), "relevance.band")).toBe(true);
  });
  it("errors on an out-of-range score", () => {
    const reply = parseRelevanceReply('{"score":9,"topic":"x","reason":"y"}');
    expect(erroredOn(checkRelevance(reply, "on"), "relevance.range")).toBe(true);
  });
  it("passes a score inside the band", () => {
    const reply = parseRelevanceReply('{"score":4,"topic":"ии","reason":"по теме"}');
    expect(isCasePassing(checkRelevance(reply, "on"))).toBe(true);
  });
  it("errors when the reply is unparsable (null)", () => {
    expect(erroredOn(checkRelevance(null, "gray"), "relevance.parse")).toBe(true);
  });
});
