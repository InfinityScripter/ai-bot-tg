import { it, expect, describe } from "vitest";

import {
  hrefsOf,
  escapeHtml,
  tagNamesOf,
  visibleText,
  sanitizeTelegramHtml,
} from "../src/feeds/index.js";

describe("sanitizeTelegramHtml", () => {
  it("keeps Telegram formatting tags and turns <br> into newlines", () => {
    expect(
      sanitizeTelegramHtml(
        "<b>Жирный</b> <i>курсив</i> <u>u</u> <s>s</s><br/><code>x()</code><br><pre>a\nb</pre><blockquote>цитата</blockquote>",
      ),
    ).toBe(
      "<b>Жирный</b> <i>курсив</i> <u>u</u> <s>s</s>\n<code>x()</code>\n<pre>a\nb</pre><blockquote>цитата</blockquote>",
    );
  });

  it("maps strong/em to b/i and drops every attribute except a[href]", () => {
    expect(
      sanitizeTelegramHtml(
        '<strong class="x">a</strong><em style="y">b</em><a href="https://ex.com/p" target="_blank" rel="noopener" onclick="return confirm(\'Open?\');">c</a>',
      ),
    ).toBe('<b>a</b><i>b</i><a href="https://ex.com/p">c</a>');
  });

  it("replaces a Telegram emoji image with its emoji character", () => {
    expect(
      sanitizeTelegramHtml(
        '<b><i class="emoji" style="background-image:url(\'//telegram.org/img/emoji/40/E29AA1.png\')"><b>⚡️</b></i> Заголовок</b>',
      ),
    ).toBe("<b>⚡️ Заголовок</b>");
  });

  it("unwraps unknown tags to their text and escapes the text", () => {
    expect(
      sanitizeTelegramHtml(
        '<div class="x"><span>a &lt; b &amp;&#036;5 &quot;q&quot;</span></div><tg-spoiler>спойлер</tg-spoiler><script>x</script>',
      ),
    ).toBe("a &lt; b &amp;$5 &quot;q&quot;спойлерx");
  });

  it("unwraps links that are relative, non-http or not on the allow-list", () => {
    expect(sanitizeTelegramHtml('<a href="?q=%23ai">#ai</a> <a href="javascript:x">y</a>')).toBe(
      "#ai y",
    );
    expect(
      sanitizeTelegramHtml('<a href="https://ex.com/a/">ok</a> <a href="https://evil.com">no</a>', {
        allowedHrefs: ["https://ex.com/a"],
      }),
    ).toBe('<a href="https://ex.com/a/">ok</a> no');
  });

  it("closes unclosed tags, drops stray closers and repairs crossed nesting", () => {
    expect(sanitizeTelegramHtml("<b>a <i>b</b> c</i> d</u>")).toBe("<b>a <i>b</i></b> c d");
    expect(sanitizeTelegramHtml("<blockquote><b>x")).toBe("<blockquote><b>x</b></blockquote>");
  });

  it("allows no tags inside code/pre, no nested links and no nested blockquotes", () => {
    expect(sanitizeTelegramHtml("<pre><code><b>x</b></code></pre>")).toBe("<pre>x</pre>");
    expect(
      sanitizeTelegramHtml('<a href="https://a.io/1">x <a href="https://a.io/2">y</a> z</a>'),
    ).toBe('<a href="https://a.io/1">x y z</a>');
    expect(sanitizeTelegramHtml("<blockquote>a<blockquote>b</blockquote>c</blockquote>")).toBe(
      "<blockquote>abc</blockquote>",
    );
  });

  it("collapses runs of blank lines, trailing spaces and outer whitespace", () => {
    expect(sanitizeTelegramHtml("  a <br/><br/><br/><br/>b\n  ")).toBe("a\n\nb");
  });

  it("is idempotent", () => {
    const once = sanitizeTelegramHtml(
      '<b>a &amp; b</b><br/><a href="https://ex.com/?a=1&amp;b=2">l</a> <i>x',
    );
    expect(sanitizeTelegramHtml(once)).toBe(once);
    expect(once).toBe('<b>a &amp; b</b>\n<a href="https://ex.com/?a=1&amp;b=2">l</a> <i>x</i>');
  });
});

describe("helpers", () => {
  const html = '<b>a &amp; b</b>\n<a href="https://ex.com/?a=1&amp;b=2">l</a> <i>x</i><b>y</b>';

  it("visibleText strips tags and decodes entities", () => {
    expect(visibleText(html)).toBe("a & b\nl xy");
  });

  it("hrefsOf returns the decoded hrefs in order", () => {
    expect(hrefsOf(html)).toEqual(["https://ex.com/?a=1&b=2"]);
  });

  it("tagNamesOf returns the sorted opening tag names", () => {
    expect(tagNamesOf(html)).toEqual(["a", "b", "b", "i"]);
  });

  it("escapeHtml escapes &, <, > and quotes", () => {
    expect(escapeHtml(`a & <b> "c"`)).toBe("a &amp; &lt;b&gt; &quot;c&quot;");
  });
});
