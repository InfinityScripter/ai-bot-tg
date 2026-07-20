import { it, expect, describe } from "vitest";

import { extractBody, ARTICLE_BODY_CHAR_LIMIT } from "../src/feeds/ingestArticle.js";

// Длинная статья (~12k символов текста) не должна резаться до старых 4000 —
// рерайтер получал только лид и выдавал тонкий пересказ. Лимит бережёт промпт
// от гигантских страниц, но обязан вмещать типичный лонгрид целиком.
describe("article body char limit", () => {
  const paragraph = `<p>${"Полезное содержимое статьи о выпуске новой модели. ".repeat(40)}</p>`;
  const longHtml = `<html><body><article>${paragraph.repeat(6)}</article></body></html>`;

  it("keeps a ~12k-char long-read intact instead of cutting it to 4000", () => {
    const body = extractBody(longHtml);
    expect(body.length).toBeGreaterThan(10_000);
    expect(body.length).toBeLessThanOrEqual(ARTICLE_BODY_CHAR_LIMIT);
  });

  it("still bounds a pathologically huge page to the limit", () => {
    const huge = `<html><body>${`<p>${"слово ".repeat(20_000)}</p>`}</body></html>`;
    expect(extractBody(huge).length).toBeLessThanOrEqual(ARTICLE_BODY_CHAR_LIMIT);
  });
});
