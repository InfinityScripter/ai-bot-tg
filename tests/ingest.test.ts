import { it, vi, expect, describe, afterEach } from "vitest";

import { InputKind } from "../src/enums.js";
import {
  fetchArticle,
  classifyInput,
  enrichItemBody,
  fetchArticleBody,
  feedItemFromText,
} from "../src/feeds/index.js";

import type { FeedItem } from "../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("classifyInput", () => {
  it("classifies a bare http(s) URL as url mode", () => {
    expect(classifyInput("https://ex.com/article")).toEqual({
      kind: InputKind.Url,
      url: "https://ex.com/article",
    });
    expect(classifyInput("http://ex.com/a")).toEqual({
      kind: InputKind.Url,
      url: "http://ex.com/a",
    });
  });

  it("takes the URL when the message is a URL plus a trailing note", () => {
    expect(classifyInput("https://ex.com/article смотри это")).toEqual({
      kind: InputKind.Url,
      url: "https://ex.com/article",
    });
  });

  it("classifies free text as text mode", () => {
    expect(classifyInput("Просто новость про ИИ")).toEqual({
      kind: InputKind.Text,
      text: "Просто новость про ИИ",
    });
  });

  it("does NOT treat text that merely contains a non-leading url as url mode", () => {
    const r = classifyInput("читай тут https://ex.com/a");
    expect(r.kind).toBe(InputKind.Text);
  });

  it("classifies empty / whitespace as empty", () => {
    expect(classifyInput("")).toEqual({ kind: InputKind.Empty });
    expect(classifyInput("   \n  ")).toEqual({ kind: InputKind.Empty });
  });
});

describe("feedItemFromText", () => {
  it("uses the first non-empty line as the title and the whole text as the body", () => {
    const item = feedItemFromText("Заголовок новости\n\nТело статьи с деталями.");
    expect(item.title).toBe("Заголовок новости");
    expect(item.snippet).toContain("Тело статьи с деталями.");
    expect(item.url).toBe("");
    expect(item.imageUrls).toEqual([]);
    expect(item.feedTitle).toBe("Прислано вручную");
  });

  it("clamps a very long first line into a title but keeps the full body", () => {
    const long = "a".repeat(300);
    const item = feedItemFromText(long);
    expect(item.title.length).toBeLessThanOrEqual(121); // 120 + ellipsis
    expect(item.snippet.length).toBeGreaterThan(item.title.length);
  });

  it("produces a stable manual: dedupKey for identical text", () => {
    const a = feedItemFromText("одинаковый текст");
    const b = feedItemFromText("  одинаковый текст  ");
    expect(a.dedupKey).toMatch(/^manual:[0-9a-f]{40}$/);
    expect(a.dedupKey).toBe(b.dedupKey); // trimmed → same hash
  });

  it("produces different dedupKeys for different text", () => {
    expect(feedItemFromText("текст один").dedupKey).not.toBe(
      feedItemFromText("текст два").dedupKey,
    );
  });
});

/** Builds a fetch mock that returns the given HTML with a 200 text/html. */
function htmlResponse(html: string, init?: { status?: number; contentType?: string }): Response {
  return new Response(html, {
    status: init?.status ?? 200,
    headers: { "content-type": init?.contentType ?? "text/html; charset=utf-8" },
  });
}

describe("fetchArticle", () => {
  it("extracts title, cover, body images, and body text from a rich page", async () => {
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="Заголовок статьи — Habr">
      <meta property="og:description" content="Краткое описание.">
      <meta property="og:image" content="https://img.example/cover.jpg">
      <title>fallback</title>
      </head><body>
      <nav>menu junk</nav>
      <article><p>Первый абзац тела статьи.</p>
      <img src="https://img.example/inline1.png">
      <p>Второй абзац.</p></article>
      <script>var x = 1;</script>
      <footer>footer junk</footer>
      </body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(html)),
    );

    const item = await fetchArticle("https://ex.com/post?utm_source=tg");
    expect(item.title).toBe("Заголовок статьи"); // site suffix stripped
    expect(item.imageUrl).toBe("https://img.example/cover.jpg");
    expect(item.imageUrls).toContain("https://img.example/cover.jpg");
    expect(item.imageUrls).toContain("https://img.example/inline1.png");
    expect(item.snippet).toContain("Первый абзац тела статьи.");
    expect(item.snippet).not.toContain("var x = 1"); // script dropped
    expect(item.snippet).not.toContain("menu junk"); // nav dropped
    // dedupKey is canonicalized (tracking param stripped, lowercased).
    expect(item.dedupKey).toBe("https://ex.com/post");
  });

  it("decodes named and numeric HTML entities in the title", async () => {
    const html = `<html><head>
      <meta property="og:title" content="AT&amp;T &#171;новость&#187; &#x2014; тест">
      </head><body><p>тело</p></body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(html)),
    );
    const item = await fetchArticle("https://ex.com/e");
    // & decoded, «» (numeric) decoded, em-dash (hex) decoded; "— тест" is a site
    // suffix split off by cleanTitle, leaving the longest segment.
    expect(item.title).toContain("AT&T");
    expect(item.title).toContain("«новость»");
  });

  it("falls back to the <title> tag when there are no og tags", async () => {
    const html = `<html><head><title>Только title</title></head><body><p>тело</p></body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(html)),
    );
    const item = await fetchArticle("https://ex.com/x");
    expect(item.title).toBe("Только title");
    expect(item.imageUrl).toBeNull();
    expect(item.imageUrls).toEqual([]);
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse("nope", { status: 404 })),
    );
    await expect(fetchArticle("https://ex.com/missing")).rejects.toThrow(/404/);
  });

  it("throws when the response is not HTML", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    await expect(fetchArticle("https://ex.com/api")).rejects.toThrow(/не на HTML/i);
  });

  it("throws when the page has no usable title", async () => {
    const html = `<html><head></head><body><p>тело без заголовка</p></body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(html)),
    );
    await expect(fetchArticle("https://ex.com/notitle")).rejects.toThrow(/заголовок/i);
  });

  it("throws on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(fetchArticle("https://ex.com/down")).rejects.toThrow(/Не удалось загрузить/i);
  });
});

/**
 * Mirrors the handleRewrite enrichment rule: when a stored snippet is short,
 * the scraped body replaces it if longer; a scrape failure keeps the snippet.
 */
async function enrichSnippet(url: string, snippet: string): Promise<string> {
  try {
    const body = await fetchArticleBody(url);
    return body.length > snippet.length ? body : snippet;
  } catch {
    return snippet;
  }
}

describe("fetchArticleBody (rewrite enrichment)", () => {
  it("returns only the body text, stripped of chrome", async () => {
    const html = `<html><head><title>t</title></head><body>
      <nav>menu junk</nav>
      <article><p>Полное тело статьи с деталями.</p></article>
      <script>var x = 1;</script></body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(html)),
    );
    const body = await fetchArticleBody("https://ex.com/a");
    expect(body).toContain("Полное тело статьи с деталями.");
    expect(body).not.toContain("menu junk"); // nav dropped
    expect(body).not.toContain("var x = 1"); // script dropped
  });

  it("a longer scraped body replaces a short stored snippet", async () => {
    const longBody = "Развёрнутое тело статьи. ".repeat(30);
    const html = `<html><head><title>t</title></head><body><article><p>${longBody}</p></article></body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(html)),
    );
    const shortSnippet = "Короткий заголовок";
    const result = await enrichSnippet("https://ex.com/long", shortSnippet);
    expect(result.length).toBeGreaterThan(shortSnippet.length);
    expect(result).toContain("Развёрнутое тело статьи.");
  });

  it("falls back to the stored snippet when the fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const stored = "Сохранённый сниппет из фида";
    const result = await enrichSnippet("https://ex.com/down", stored);
    expect(result).toBe(stored);
  });
});

/** A base feed item with the given url/snippet and empty media. */
function feedItem(url: string, snippet: string): FeedItem {
  return {
    dedupKey: "k",
    url,
    title: "T",
    snippet,
    feedTitle: "Feed",
    imageUrl: null,
    imageUrls: [],
    publishedAt: null,
  };
}

describe("enrichItemBody", () => {
  it("does NOT re-fetch when the stored snippet is already long (>= 500)", async () => {
    const fetchMock = vi.fn(async () => htmlResponse("<html></html>"));
    vi.stubGlobal("fetch", fetchMock);
    const longSnippet = "я".repeat(500); // at the skip threshold
    const item = feedItem("https://ex.com/long", longSnippet);

    const out = await enrichItemBody(item);

    expect(out).toBe(item); // unchanged, returned as-is
    expect(fetchMock).not.toHaveBeenCalled(); // scrape skipped
  });

  it("does NOT fetch for a non-http url even with a short snippet", async () => {
    const fetchMock = vi.fn(async () => htmlResponse("<html></html>"));
    vi.stubGlobal("fetch", fetchMock);
    const item = feedItem("", "короткий сниппет");

    const out = await enrichItemBody(item);

    expect(out).toBe(item);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scrapes and replaces a short snippet with a longer body", async () => {
    const longBody = "Развёрнутое тело статьи. ".repeat(30);
    const html = `<html><head><title>t</title></head><body><article><p>${longBody}</p></article></body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(html)),
    );
    const item = feedItem("https://ex.com/short", "Короткий заголовок");

    const out = await enrichItemBody(item);

    expect(out.snippet.length).toBeGreaterThan(item.snippet.length);
    expect(out.snippet).toContain("Развёрнутое тело статьи.");
  });
});
