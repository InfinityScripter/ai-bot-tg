import { it, expect, describe } from "vitest";

import { parseViews, parseChannelList, parseTelegramChannel } from "../src/feeds/index.js";

/** One post block in the exact t.me/s markup (checked on 2026-09-30). */
function post(opts: {
  id: number;
  text?: string;
  photo?: string;
  views?: string;
  time?: string;
  forwarded?: boolean;
  reply?: boolean;
}): string {
  const photo = opts.photo
    ? `<a class="tgme_widget_message_photo_wrap 1 2" href="https://t.me/chan/${opts.id}" style="width:800px;background-image:url('${opts.photo}')"> <div class="tgme_widget_message_photo"></div> </a>`
    : "";
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
      links: ["https://ex.com/a"],
      views: 6740,
      forwarded: false,
      imageUrl: null,
      publishedAt: Date.parse("2026-09-30T07:37:00+00:00"),
    });
  });

  it("reads the photo from the background-image style", () => {
    const [p] = parseTelegramChannel(
      post({ id: 1, text: "x", photo: "https://cdn4.telesco.pe/file/a.jpg" }),
    );
    expect(p?.imageUrl).toBe("https://cdn4.telesco.pe/file/a.jpg");
  });

  it("returns the post's own text for a reply, not the quoted text or its thumbnail", () => {
    const [p] = parseTelegramChannel(post({ id: 5, reply: true, text: "Свой текст поста" }));
    expect(p?.text).toBe("Свой текст поста");
    expect(p?.text).not.toContain("ресет");
    expect(p?.imageUrl).toBeNull();
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
