import { existsSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { fileURLToPath } from "node:url";

import { CONFIG } from "../config.js";
import { truncate } from "../utils.js";
import { escapeHtml } from "../feeds/index.js";

import type { ChannelDress } from "../types.js";
import type { ChannelRubric } from "../enums.js";

/**
 * The branded cover of every channel post (logo B palette: near-black, orange
 * accent, white title). resvg cannot wrap text, so layout is computed here:
 * JetBrains Mono is monospaced, every glyph (Cyrillic included) advances 0.6 em,
 * which makes the line width exact instead of estimated.
 */

export interface CoverSpec {
  title: string;
  /** The key number or fact, one line under the title; empty = no line. */
  fact: string;
  rubric: ChannelRubric | null;
  /** Already formatted, e.g. "01.10". */
  date: string;
}

const WIDTH = 1280;
const HEIGHT = 720;
const PAD = 80;
const ADVANCE_EM = 0.6;
/** The title tries the big size first; a title that needs more than 3 lines there drops to the small one. */
const TITLE_SIZES = [76, 60];
const TITLE_LINES = 3;
const FACT_SIZE = 36;
const FONT = "JetBrains Mono";
const FONT_FILES = ["JetBrainsMono-Bold.ttf", "JetBrainsMono-Regular.ttf"].map((name) =>
  fileURLToPath(new URL(`../../assets/fonts/${name}`, import.meta.url)),
);

/**
 * Emoji, which JetBrains Mono has no glyphs for: with system fonts off they
 * would render as empty boxes. Feed titles do start with emoji ("⚡️ Anthropic…").
 */
const EMOJI_RE = /\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu;

/** XML 1.0 allows tab, newline, carriage return and everything from U+0020 except U+FFFE/U+FFFF; resvg rejects the whole SVG otherwise. */
function isXmlChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x20) return code === 0x09 || code === 0x0a || code === 0x0d;
  return code !== 0xfffe && code !== 0xffff;
}

const drawable = (value: string) =>
  [...value.replace(EMOJI_RE, "")].filter(isXmlChar).join("").replace(/\s+/g, " ").trim();

const charsPerLine = (size: number) => Math.floor((WIDTH - 2 * PAD) / (size * ADVANCE_EM));

function cutWithEllipsis(line: string, max: number): string {
  const words = line.split(" ");
  while (words.length > 1 && `${words.join(" ")}…`.length > max) words.pop();
  const kept = words.join(" ");
  return `${kept.length + 1 > max ? kept.slice(0, max - 1) : kept}…`;
}

/** Greedy word wrap; a word longer than a line is split, overflow past maxLines ends in "…". */
export function wrapTitle(title: string, maxChars: number, maxLines: number): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const joined = current ? `${current} ${word}` : word;
    if (joined.length <= maxChars) {
      current = joined;
      continue;
    }
    if (current) lines.push(current);
    let rest = word;
    while (rest.length > maxChars) {
      lines.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    current = rest;
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = cutWithEllipsis(`${kept[maxLines - 1]} ${lines[maxLines]}`, maxChars);
  return kept;
}

function fitTitle(title: string): { size: number; lines: string[] } {
  for (const size of TITLE_SIZES) {
    const lines = wrapTitle(title, charsPerLine(size), TITLE_LINES + 1);
    if (lines.length <= TITLE_LINES) return { size, lines };
  }
  const size = TITLE_SIZES.at(-1)!;
  return { size, lines: wrapTitle(title, charsPerLine(size), TITLE_LINES) };
}

const text = (x: number, y: number, size: number, fill: string, body: string, extra = "") =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${fill}"${extra}>${escapeHtml(body)}</text>`;

/** The cover as SVG. Every piece of text is XML-escaped: it comes from the model. */
export function coverSvg(spec: CoverSpec): string {
  const { size, lines } = fitTitle(drawable(spec.title));
  const factText = drawable(spec.fact);
  const fact = factText ? wrapTitle(factText, charsPerLine(FACT_SIZE), 1)[0] : "";
  const lineHeight = Math.round(size * 1.18);
  const factY = 580;
  const lastTitleY = fact ? factY - FACT_SIZE - 40 : factY;
  const firstTitleY = lastTitleY - (lines.length - 1) * lineHeight;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="#17120f"/>`,
    text(PAD, 120, 34, "#E8672A", `> ${spec.rubric ?? "ai first"}`),
    text(WIDTH - PAD, 120, 30, "#8a7f76", spec.date, ' text-anchor="end"'),
    ...lines.map((line, i) =>
      text(PAD, firstTitleY + i * lineHeight, size, "#ffffff", line, ' font-weight="700"'),
    ),
    ...(fact ? [text(PAD, factY, FACT_SIZE, "#c9bfb6", fact)] : []),
    `<rect x="${PAD}" y="636" width="120" height="10" fill="#E8672A"/>`,
    text(WIDTH - PAD, 650, 30, "#8a7f76", "aifirst.us.com", ' text-anchor="end"'),
    "</svg>",
  ].join("");
}

/** PNG bytes of the cover. Throws on a render failure; callers decide the fallback. */
export function renderCover(spec: CoverSpec): Uint8Array {
  // resvg draws a text-less cover instead of failing when a font file is gone.
  const missing = FONT_FILES.filter((file) => !existsSync(file));
  if (missing.length > 0) throw new Error(`cover font missing: ${missing.join(", ")}`);
  const resvg = new Resvg(coverSvg(spec), {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: FONT },
  });
  return resvg.render().asPng();
}

/**
 * What the cover shows: the dress when the model gave one, else the post's own
 * title (cut to what three small-font lines hold) under the channel name.
 */
export function coverSpecFor(
  dress: ChannelDress | null | undefined,
  fallbackTitle: string,
  now = new Date(),
): CoverSpec {
  const date = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    timeZone: CONFIG.CRON_TZ,
  }).format(now);
  if (dress) return { title: dress.coverTitle, fact: dress.coverFact, rubric: dress.rubric, date };
  return { title: truncate(fallbackTitle.trim(), 90), fact: "", rubric: null, date };
}

/** The cover as PNG bytes, or null (logged) when rendering fails: a post never waits on its cover. */
export function tryRenderCover(spec: CoverSpec): Uint8Array | null {
  try {
    return renderCover(spec);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[cover] rendering failed, posting without the branded cover: ${reason}`);
    return null;
  }
}
