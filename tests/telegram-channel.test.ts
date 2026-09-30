import { it, expect, describe } from "vitest";

import {
  parseViews,
  parseChannelList,
  DEFAULT_CHANNELS,
  parseTelegramChannel,
} from "../src/feeds/index.js";

/** One post block in the exact t.me/s markup (checked on 2026-09-30). */
function post(opts: {
  id: number;
  text?: string;
  photo?: string;
  photos?: string[];
  views?: string;
  time?: string;
  forwarded?: boolean;
  reply?: boolean;
}): string {
  const photo = (opts.photos ?? (opts.photo ? [opts.photo] : []))
    .map(
      (url) =>
        `<a class="tgme_widget_message_photo_wrap 1 2" href="https://t.me/chan/${opts.id}" style="width:800px;background-image:url('${url}')"> <div class="tgme_widget_message_photo"></div> </a>`,
    )
    .join("");
  const fwd = opts.forwarded
    ? `<div class="tgme_widget_message_forwarded_from accent_color">Forwarded from&nbsp;<span class="tgme_widget_message_forwarded_from_name">Пух</span></div>`
    : "";
  const reply = opts.reply
    ? `<a class="tgme_widget_message_reply user-color-default" href="https://t.me/chan/113"><i class="tgme_widget_message_reply_thumb" style="background-image:url('https://cdn4.telesco.pe/file/quote.jpg')"></i> <div class="tgme_widget_message_author accent_color"> <span class="tgme_widget_message_author_name" dir="auto">Name</span> </div> <div class="tgme_widget_message_text js-message_reply_text" dir="auto">а вот и ресет подарили</div> </a>`
    : "";
  const text =
    opts.text === undefined
      ? ""
      : `<div class="tgme_widget_message_text js-message_text" dir="auto">${opts.text}</div>`;
  return `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="chan/${opts.id}" data-view="x"> <div class="tgme_widget_message_bubble"> ${fwd} ${reply}${photo}${text} <div class="tgme_widget_message_footer compact js-message_footer"> <div class="tgme_widget_message_info short js-message_info"> <span class="tgme_widget_message_views">${opts.views ?? "1.2K"}</span><span class="copyonly"> views</span><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/chan/${opts.id}"><time datetime="${opts.time ?? "2026-09-30T07:37:00+00:00"}" class="time">07:37</time></a></span> </div> </div> </div></div></div>`;
}

describe("parseViews", () => {
  it.each([
    ["401", 401],
    ["1.2K", 1200],
    ["12.7K", 12700],
    ["1.1M", 1100000],
    ["", null],
    [".", null],
    ["1.2.3", null],
  ])("%s → %s", (raw, expected) => {
    expect(parseViews(raw)).toBe(expected);
  });
});

describe("parseTelegramChannel", () => {
  it("reads id, url, text with line breaks and entities, links, time and views", () => {
    const html = post({
      id: 184,
      text: 'Новая <b>модель</b> &amp; агент:<br/><a href="https://ex.com/a" target="_blank">https://ex.com/a</a><br/>Цена &#036;200 <a href="?q=%23ai">#ai</a>',
      views: "6.74K",
    });
    const [p] = parseTelegramChannel(html);
    expect(p).toMatchObject({
      channel: "chan",
      id: 184,
      url: "https://t.me/chan/184",
      text: "Новая модель & агент:\nhttps://ex.com/a\nЦена $200 #ai",
      html: 'Новая <b>модель</b> &amp; агент:\n<a href="https://ex.com/a">https://ex.com/a</a>\nЦена $200 #ai',
      links: ["https://ex.com/a"],
      views: 6740,
      forwarded: false,
      imageUrls: [],
      publishedAt: Date.parse("2026-09-30T07:37:00+00:00"),
    });
  });

  it("reads the photo from the background-image style", () => {
    const [p] = parseTelegramChannel(
      post({ id: 1, text: "x", photo: "https://cdn4.telesco.pe/file/a.jpg" }),
    );
    expect(p?.imageUrls).toEqual(["https://cdn4.telesco.pe/file/a.jpg"]);
  });

  it("reads every photo of an album, at most 10", () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://cdn4.telesco.pe/file/${i}.jpg`);
    const [p] = parseTelegramChannel(post({ id: 1, text: "x", photos: urls }));
    expect(p?.imageUrls).toEqual(urls.slice(0, 10));
  });

  it("keeps the whole text of the live markup: nested text div, blockquote, emoji", () => {
    // Shape of ai_for_devs/640 on 2026-09-30: the text div is doubled and the
    // blockquote sits between links; a lazy match to the first </div> cut it short.
    const inner =
      '<b><i class="emoji" style="background-image:url(\'//telegram.org/img/emoji/40/E29AA1.png\')"><b>⚡️</b></i> Заголовок</b><br/><br/>' +
      '<blockquote>Anthropic <a href="https://www.anthropic.com/research/x" target="_blank" rel="noopener" onclick="return confirm(\'Open this link?\\n\\n\'+this.href);">проделали это</a>, <b>с 95% до 6%</b>.<br/></blockquote><br/><br/>' +
      '<div class="inner">хвост</div> <a href="https://t.me/ai_for_devs" target="_blank">@ai_for_devs</a>';
    const [p] = parseTelegramChannel(
      post({
        id: 640,
        text: `<div class="tgme_widget_message_text js-message_text" dir="auto">${inner}</div>`,
      }),
    );
    expect(p?.html).toBe(
      '<b>⚡️ Заголовок</b>\n\n<blockquote>Anthropic <a href="https://www.anthropic.com/research/x">проделали это</a>, <b>с 95% до 6%</b>.\n</blockquote>\n\nхвост <a href="https://t.me/ai_for_devs">@ai_for_devs</a>',
    );
    expect(p?.text).toBe(
      "⚡️ Заголовок\n\nAnthropic проделали это, с 95% до 6%.\n\n\nхвост @ai_for_devs",
    );
    expect(p?.links).toEqual(["https://www.anthropic.com/research/x", "https://t.me/ai_for_devs"]);
  });

  it("returns the post's own text for a reply, not the quoted text or its thumbnail", () => {
    const [p] = parseTelegramChannel(post({ id: 5, reply: true, text: "Свой текст поста" }));
    expect(p?.text).toBe("Свой текст поста");
    expect(p?.text).not.toContain("ресет");
    expect(p?.imageUrls).toEqual([]);
  });

  it("marks forwarded posts and keeps posts without text with empty text", () => {
    const posts = parseTelegramChannel(
      post({ id: 2, forwarded: true, text: "x" }) + post({ id: 3 }),
    );
    expect(posts.map((p) => [p.id, p.forwarded, p.text])).toEqual([
      [2, true, "x"],
      [3, false, ""],
    ]);
  });

  it("returns [] for a page with no post blocks (markup changed)", () => {
    expect(parseTelegramChannel("<html><body>nothing</body></html>")).toEqual([]);
  });
});

describe("parseChannelList", () => {
  it("strips @, marks ! as priority, skips blanks", () => {
    expect(parseChannelList(" !@ai_for_devs, devfm ,,@shilovtech")).toEqual([
      { name: "ai_for_devs", priority: true },
      { name: "devfm", priority: false },
      { name: "shilovtech", priority: false },
    ]);
  });
});

describe("DEFAULT_CHANNELS", () => {
  it("drops aostrikov_ai_agents and adds the six channels checked on 2026-10-01", () => {
    const names = DEFAULT_CHANNELS.map((c) => c.name);
    expect(names).not.toContain("aostrikov_ai_agents");
    expect(DEFAULT_CHANNELS.filter((c) => c.priority).map((c) => c.name)).toEqual([
      "ai_for_devs",
      "sukharev_ii",
      "aimastersme",
    ]);
    for (const name of [
      "the_ai_architect",
      "nobilix",
      "neuraldeep",
      "evilfreelancer",
      "kdoronin_blog",
      "oestick",
    ]) {
      expect(DEFAULT_CHANNELS).toContainEqual({ name, priority: false });
    }
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });
});
