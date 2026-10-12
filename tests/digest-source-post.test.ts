import { it, expect, describe } from "vitest";

import { ChannelRubric } from "../src/enums.js";
import { visibleText } from "../src/feeds/telegramHtml.js";
import { buildArticle } from "../src/channelDigest/buildArticle.js";
import { buildFallbackText } from "../src/channelDigest/fallbackText.js";

import type { IssueItem } from "../src/channelDigest/types.js";

const ITEM: IssueItem = {
  candidateId: 1,
  channel: "@unrelated_channel",
  emoji: "🔥",
  rubric: ChannelRubric.Model,
  title: "Card1",
  html: "Текст.",
  photos: [],
  linkKeys: [],
};
const INVALID_URLS = [
  "",
  "https://lab.example/paper",
  // eslint-disable-next-line no-script-url -- Rejected URL fixture; never executed.
  "javascript:alert(1)",
  "https://t.me/devfm",
  "https://t.me/devfm/nope",
  "https://t.me/devfm/0",
  "https://t.me/devfm/678/other",
  "https://t.me/c/123",
  "https://t.me/s/678",
  "https://t.me.evil.example/devfm/678",
  "https://evil.t.me/devfm/678",
  "https://user:secret@t.me/devfm/678",
  "https://t.me:8080/devfm/678",
  "https://t.me/devfm/678\n",
  "https://t.me/devfm/67\u00008",
  "https://t.me\\@wrong.example/devfm/678",
];

describe("digest source posts", () => {
  it("renders safe saved post links separately from materials and includes their markup in both rich limits", () => {
    const items = [
      { ...ITEM, sourceUrl: "https://t.me/aimastersme/707", sourceLinks: [] },
      { ...ITEM, candidateId: 2, sourceUrl: "https://t.me/devfm/678", sourceLinks: [] },
      {
        ...ITEM,
        candidateId: 3,
        sourceUrl: 'http://telegram.me/example_channel/9?note="<tag>"&single=1',
        sourceLinks: [{ url: "https://lab.example/paper?a=1&b=2", label: "A & <B>" }],
      },
    ];
    const article = buildArticle({ title: "Digest", items, cover: () => null });

    expect(article.html.match(/>Исходный пост<\/a>/g) ?? []).toHaveLength(3);
    for (const url of ["https://t.me/aimastersme/707", "https://t.me/devfm/678"]) {
      expect(article.html).toContain(`<p><a href="${url}">Исходный пост</a></p>`);
    }
    expect(article.html).toContain(
      '<p><a href="http://telegram.me/example_channel/9?note=&quot;&lt;tag&gt;&quot;&amp;single=1">Исходный пост</a></p>' +
        '<p>Материалы: <a href="https://lab.example/paper?a=1&amp;b=2">A &amp; &lt;B&gt;</a></p>',
    );
    expect(article.html.match(/Материалы:/g)).toHaveLength(1);
    for (const sourceUrl of [undefined, ...INVALID_URLS]) {
      const historical = buildArticle({
        title: "Digest",
        items: [{ ...ITEM, sourceUrl }],
        cover: () => null,
      });
      expect(historical.html).not.toContain("Исходный пост");
      expect(historical.html).not.toContain("unrelated_channel");
    }

    const longItems = [1, 2].map((n) => ({
      ...ITEM,
      candidateId: n,
      title: `Card${n}`,
      html: "x".repeat(16_000),
      sourceUrl: `https://t.me/example_channel/${n}?payload=${"x".repeat(600)}`,
    }));
    const byteBounded = buildArticle({ title: "Digest", items: longItems, cover: () => null });
    expect(byteBounded.items.map((item) => item.candidateId)).toEqual([1]);
    expect(Buffer.byteLength(byteBounded.html, "utf8")).toBeLessThanOrEqual(32_768);
    expect(byteBounded.html).not.toContain("Card2");
    const blockBounded = buildArticle({
      title: "Digest",
      items: longItems.map((item) => ({ ...item, html: "<b>x</b> ".repeat(241) })),
      cover: () => null,
    });
    expect(blockBounded.items.map((item) => item.candidateId)).toEqual([1]);
    expect(blockBounded.html.match(/<[a-z][^>]*>/g)!.length).toBeLessThanOrEqual(500);
  });

  it("counts the source line in whole fallback cards and keeps its safe link separate from research", () => {
    const longItems = [1, 2].map((n) => ({
      ...ITEM,
      candidateId: n,
      title: `Card${n}`,
      html: "x".repeat(2019),
      sourceUrl: `https://t.me/example_channel/${n}`,
    }));
    const bounded = buildFallbackText("Digest", longItems)!;

    expect(bounded.items.map((item) => item.candidateId)).toEqual([1]);
    expect(visibleText(bounded.text).length).toBeLessThanOrEqual(4096);
    expect(bounded.text).toContain('<a href="https://t.me/example_channel/1">Исходный пост</a>');
    expect(bounded.text).not.toContain("Card2");
    const items = [
      { ...ITEM, sourceUrl: "https://t.me/aimastersme/707", sourceLinks: [] },
      { ...ITEM, candidateId: 2, sourceUrl: "https://t.me/devfm/678", sourceLinks: [] },
      {
        ...ITEM,
        candidateId: 3,
        sourceUrl: 'http://telegram.me/example_channel/9?note="<tag>"&single=1',
        sourceLinks: [{ url: "https://lab.example/paper?a=1&b=2", label: "A & <B>" }],
      },
    ];
    const fallback = buildFallbackText("Digest", items)!;

    expect(fallback.items).toEqual(items);
    expect(fallback.text.match(/>Исходный пост<\/a>/g) ?? []).toHaveLength(3);
    for (const url of ["https://t.me/aimastersme/707", "https://t.me/devfm/678"]) {
      expect(fallback.text).toContain(`\n<a href="${url}">Исходный пост</a>\n`);
    }
    expect(fallback.text).toContain(
      '\n<a href="http://telegram.me/example_channel/9?note=&quot;&lt;tag&gt;&quot;&amp;single=1">Исходный пост</a>\n' +
        'Материалы: <a href="https://lab.example/paper?a=1&amp;b=2">A &amp; &lt;B&gt;</a>\n',
    );
    expect(fallback.text.match(/Материалы:/g)).toHaveLength(1);
    for (const sourceUrl of [undefined, ...INVALID_URLS]) {
      const historical = buildFallbackText("Digest", [{ ...ITEM, sourceUrl }])!;
      expect(historical.text).not.toContain("Исходный пост");
      expect(historical.text).not.toContain("unrelated_channel");
    }
  });
});
