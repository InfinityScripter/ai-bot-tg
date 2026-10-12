import { it, expect, describe } from "vitest";

import {
  isExternalSourceUrl,
  sourceLinksFromHtml,
  sourceLinksFromMarkdown,
} from "../src/sourceLinks.js";

describe("sourceLinks", () => {
  it("keeps original external hrefs and labels while rejecting unsafe or Telegram targets", () => {
    const url = 'https://Lab.example/paper?a=1&b="2"';
    const html =
      `<a href="https://Lab.example/paper?a=1&amp;b=&quot;2&quot;"><b>A &amp; B</b></a>` +
      `<a href="https://Lab.example/paper?a=1&amp;b=&quot;2&quot;">повтор</a>` +
      `<a href="https://home.example"> </a>` +
      `<a href="https://long.example/">${"длинная подпись ".repeat(20)}</a>` +
      `<a href="https://t.me/post/1">Канал</a>` +
      `<a href="https://www.telegram.me/">Канал</a>` +
      `<a href="https://s.telegram.dog/">Канал</a>` +
      `<a href="https://user:secret@private.example/">Закрытая ссылка</a>` +
      `<a href="javascript:alert(1)">скрипт</a>` +
      `<a href="mailto:test@example.com">почта</a>` +
      `<a href="/relative">относительная</a>` +
      `<a href="https://">сломанная</a>`;

    expect(sourceLinksFromHtml(html)).toEqual([
      { url, label: "A & B" },
      { url: "https://home.example", label: "home.example" },
      { url: "https://long.example/", label: "long.example" },
    ]);
    expect(isExternalSourceUrl("https://t.me.example/article")).toBe(true);
    expect(isExternalSourceUrl("https://TELEGRAM.ME./article")).toBe(false);
    expect(isExternalSourceUrl("https://safe.example/a\nb")).toBe(false);
    expect(isExternalSourceUrl("https:example.com")).toBe(false);
  });

  it("reads named Markdown materials and references in order without treating images as sources", () => {
    const markdown = [
      "[Материал **A & B**](https://Lab.example/paper?a=1&b=2)",
      "[Сайт лаборатории][root]",
      "[Повтор](https://Lab.example/paper?a=1&b=2)",
      "![Обложка](https://images.example/cover.png)",
      "[Канал](https://preview.t.me/lab/1)",
      "[Закрытая ссылка](https://user:secret@private.example/)",
      "[Почта](mailto:test@example.com)",
      "https://bare.example/article",
      "",
      "[root]: https://Lab.example/",
      "[unused]: https://unused.example/",
    ].join("\n\n");

    expect(sourceLinksFromMarkdown(markdown)).toEqual([
      { url: "https://Lab.example/paper?a=1&b=2", label: "Материал A & B" },
      { url: "https://Lab.example/", label: "Сайт лаборатории" },
      { url: "https://bare.example/article", label: "bare.example" },
    ]);
  });

  it("keeps the image reference alt as the containing link label", () => {
    const markdown =
      "[![Содержательная подпись][img]](https://lab.example/paper)\n\n" +
      "[img]: https://lab.example/image.png";

    expect(sourceLinksFromMarkdown(markdown)).toEqual([
      { url: "https://lab.example/paper", label: "Содержательная подпись" },
    ]);
  });

  it.each(["https://t.me/lab/1", "https://wrong.example/other"])(
    "keeps the first active reference definition when a later one points to %s",
    (duplicateUrl) => {
      const markdown = `[Обзор][paper]\n\n[paper]: https://lab.example/real\n[paper]: ${duplicateUrl}`;

      expect(sourceLinksFromMarkdown(markdown)).toEqual([
        { url: "https://lab.example/real", label: "Обзор" },
      ]);
    },
  );
});
