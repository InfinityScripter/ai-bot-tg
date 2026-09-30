import { it, expect, describe } from "vitest";

import { ChannelRubric } from "../src/enums.js";
import { ISSUE_LIMITS, buildArticle } from "../src/channelDigest/buildArticle.js";
import { TEXT_LIMIT, buildFallbackText } from "../src/channelDigest/fallbackText.js";

import type { IssueItem } from "../src/channelDigest/types.js";

const TITLE = "AI за утро · 1 октября";
const COVER = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const photo = () => new Blob([new Uint8Array(3)], { type: "image/jpeg" });

function item(n: number, over: Partial<IssueItem> = {}): IssueItem {
  return {
    candidateId: n,
    channel: "@ai_for_devs",
    emoji: "🔥",
    rubric: ChannelRubric.Model,
    title: `Новость ${n}`,
    html: `Текст новости ${n}.`,
    photos: [],
    linkKeys: [],
    ...over,
  };
}

describe("buildArticle", () => {
  it("lays the issue out as trial F4, cover first, photos under the card", () => {
    const covers: number[] = [];
    const article = buildArticle({
      title: TITLE,
      items: [
        item(1, {
          title: "Anthropic сделали GLM отличную рекламу",
          html: "Текст <b>важный</b>.",
          photos: [photo(), photo()],
        }),
      ],
      cover: (count) => {
        covers.push(count);
        return COVER;
      },
    });
    expect(article.html).toBe(
      [
        '<img src="tg://photo?id=cover"/>',
        "<h3>AI за утро · 1 октября</h3>",
        "<h5>В выпуске</h5>",
        '<ol><li><a href="#n1">🔥 Anthropic сделали GLM отличную рекламу</a></li></ol>',
        '<a name="n1"></a><blockquote><h5>🔥 Anthropic сделали GLM отличную рекламу</h5>' +
          "<p>Текст <b>важный</b>.</p><cite>#модель · @ai_for_devs</cite></blockquote>" +
          '<tg-slideshow><img src="tg://photo?id=p0"/><img src="tg://photo?id=p1"/></tg-slideshow>',
      ].join("\n"),
    );
    expect(article.photos.map((p) => p.id)).toEqual(["cover", "p0", "p1"]);
    expect(article.photos[0]?.blob.type).toBe("image/png");
    expect(covers).toEqual([1]);
  });

  it("puts a single photo bare, nothing for none, and numbers photos across cards", () => {
    const article = buildArticle({
      title: TITLE,
      items: [item(1, { photos: [photo()] }), item(2), item(3, { photos: [photo(), photo()] })],
      cover: () => null,
    });
    expect(article.html).not.toContain("id=cover");
    expect(article.html).toContain('</blockquote><img src="tg://photo?id=p0"/>\n<a name="n2">');
    expect(article.html).toContain(
      '<cite>#модель · @ai_for_devs</cite></blockquote>\n<a name="n3">',
    );
    expect(article.html).toContain(
      '<tg-slideshow><img src="tg://photo?id=p1"/><img src="tg://photo?id=p2"/></tg-slideshow>',
    );
    expect(article.photos.map((p) => p.id)).toEqual(["p0", "p1", "p2"]);
  });

  it("escapes the model's titles and emoji", () => {
    const article = buildArticle({
      title: TITLE,
      items: [item(1, { title: "<script>A & B", emoji: "<b>" })],
      cover: () => null,
    });
    expect(article.html).toContain("<h5>&lt;b&gt; &lt;script&gt;A &amp; B</h5>");
  });

  it("takes at most 4 photos per card and 50 media per article", () => {
    const items = Array.from({ length: 14 }, (_, i) =>
      item(i + 1, { photos: Array.from({ length: 6 }, photo) }),
    );
    const article = buildArticle({ title: TITLE, items, cover: () => COVER });
    expect(article.photos).toHaveLength(ISSUE_LIMITS.media);
    expect(article.html.match(/<img /g)).toHaveLength(ISSUE_LIMITS.media);
    expect(article.html).toContain('<a name="n1"></a>');
    expect(article.html).not.toContain("id=p49");
  });

  it("drops cards from the end until the article fits 32 768 bytes", () => {
    const items = Array.from({ length: 7 }, (_, i) => item(i + 1, { html: "д".repeat(3000) }));
    const article = buildArticle({ title: TITLE, items, cover: () => COVER });
    expect(Buffer.byteLength(article.html, "utf8")).toBeLessThanOrEqual(ISSUE_LIMITS.bytes);
    expect(article.items.map((i) => i.candidateId)).toEqual([1, 2, 3, 4, 5]);
  });

  it("drops cards from the end until the article has at most 500 blocks", () => {
    const items = Array.from({ length: 7 }, (_, i) =>
      item(i + 1, { html: "<b>x</b> ".repeat(80) }),
    );
    const article = buildArticle({ title: TITLE, items, cover: () => COVER });
    expect(article.items).toHaveLength(5);
  });

  it("throws when not even one card fits", () => {
    expect(() =>
      buildArticle({
        title: TITLE,
        items: [item(1, { html: "д".repeat(20_000) })],
        cover: () => null,
      }),
    ).toThrow(/лимиты/);
  });
});

describe("buildFallbackText", () => {
  it("renders bold headings, the text and the cite line", () => {
    const text = buildFallbackText(TITLE, [
      item(1),
      item(2, { emoji: "✍️", rubric: ChannelRubric.Tool, channel: "@aimastersme" }),
    ]);
    expect(text).toBe(
      "<b>AI за утро · 1 октября</b>\n\n" +
        "<b>🔥 Новость 1</b>\nТекст новости 1.\n#модель · @ai_for_devs\n\n" +
        "<b>✍️ Новость 2</b>\nТекст новости 2.\n#инструмент · @aimastersme",
    );
  });

  it("cuts whole cards from the end to fit 4096 characters", () => {
    const items = Array.from({ length: 7 }, (_, i) => item(i + 1, { html: "д".repeat(900) }));
    const text = buildFallbackText(TITLE, items);
    expect(text.length).toBeLessThanOrEqual(TEXT_LIMIT);
    expect(text).toContain("Новость 4");
    expect(text).not.toContain("Новость 5");
  });

  it("throws when not even one card fits, instead of returning the title alone", () => {
    expect(() => buildFallbackText(TITLE, [item(1, { html: "д".repeat(5000) })])).toThrow(
      /не влезает/,
    );
  });

  it("escapes the rubric the way the article does", () => {
    const text = buildFallbackText(TITLE, [item(1, { rubric: "<b>" as ChannelRubric })]);
    expect(text).toContain("#&lt;b&gt; · @ai_for_devs");
  });
});
