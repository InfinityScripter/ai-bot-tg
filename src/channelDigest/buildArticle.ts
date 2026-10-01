import { escapeHtml } from "../feeds/index.js";

import type { Article, IssueItem, ArticlePhoto } from "./types.js";

/**
 * Rich message limits (Bot API 10.1): 32 768 characters, counted here as
 * UTF-8 bytes so Cyrillic text can never overshoot; 500 blocks, counted as
 * every opening tag (an over-count, never an under-count); 50 media.
 */
export const ISSUE_LIMITS = { bytes: 32_768, blocks: 500, media: 50, photosPerItem: 4 } as const;

interface ArticleInput {
  title: string;
  items: IssueItem[];
  /** The cover PNG for the final card count, or null (render failed): no cover then. */
  cover: (count: number) => Uint8Array | null;
}

const COVER_ID = "cover";
const img = (id: string) => `<img src="tg://photo?id=${id}"/>`;
const heading = (item: IssueItem) => `${escapeHtml(item.emoji)} ${escapeHtml(item.title)}`;

function render(title: string, withCover: boolean, items: IssueItem[]) {
  const photos: ArticlePhoto[] = [];
  const gallery = (blobs: Blob[]): string => {
    // One media slot stays reserved for the cover whether or not it renders.
    const room = ISSUE_LIMITS.media - 1 - photos.length;
    const ids = blobs.slice(0, Math.min(ISSUE_LIMITS.photosPerItem, room)).map((blob) => {
      const id = `p${photos.length}`;
      photos.push({ id, blob });
      return id;
    });
    const imgs = ids.map((id) => img(id)).join("");
    return ids.length > 1 ? `<tg-slideshow>${imgs}</tg-slideshow>` : imgs;
  };
  const toc = items.map((item, i) => `<li><a href="#n${i + 1}">${heading(item)}</a></li>`);
  const html = [
    ...(withCover ? [img(COVER_ID)] : []),
    `<h3>${escapeHtml(title)}</h3>`,
    "<h5>В выпуске</h5>",
    `<ol>${toc.join("")}</ol>`,
    ...items.map(
      (item, i) =>
        `<a name="n${i + 1}"></a><blockquote><h5>${heading(item)}</h5><p>${item.html}</p>` +
        `<cite>#${escapeHtml(item.rubric)}</cite></blockquote>${gallery(item.photos)}`,
    ),
  ].join("\n");
  return { html, photos };
}

function fits(html: string): boolean {
  const blocks = (html.match(/<[a-z][^>]*>/g) ?? []).length;
  return Buffer.byteLength(html, "utf8") <= ISSUE_LIMITS.bytes && blocks <= ISSUE_LIMITS.blocks;
}

/**
 * The issue as one rich article in the owner's F4 layout (trial of 2026-10-01):
 * cover, h3 title, «В выпуске» contents with anchors, then per card a
 * blockquote (h5 heading, text, `#rubric`) with the post's photos
 * under it: a slideshow for several, a bare image for one. Cards are dropped
 * from the end until the limits hold; photos past the media budget are left out.
 */
export function buildArticle({ title, items, cover }: ArticleInput): Article {
  let kept = items;
  while (kept.length > 1 && !fits(render(title, true, kept).html)) kept = kept.slice(0, -1);
  const png = cover(kept.length);
  const { html, photos } = render(title, png !== null, kept);
  if (!fits(html)) throw new Error("выпуск не влезает в лимиты Telegram даже с одной новостью");
  const coverPhoto = png ? [{ id: COVER_ID, blob: new Blob([png], { type: "image/png" }) }] : [];
  return { html, photos: [...coverPhoto, ...photos], items: kept };
}
