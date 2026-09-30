/**
 * Deterministic checks for a channel retelling. Input is the model's HTML
 * (finalizeRetell); the published form is rebuilt through the production path
 * (cleanRetellHtml + withSourceLine). Checked: the visible-text cap, exactly one
 * credit line, no links beyond the source's, no numbers absent from the source,
 * no markdown, and markup Telegram accepts without repair.
 */

import { pass, fail } from "./types.js";
import { numbersOf } from "../../src/llm/numbersOf.js";
import { RETELL_MAX, withSourceLine, cleanRetellHtml } from "../../src/llm/index.js";
import { hrefsOf, tagNamesOf, visibleText, sanitizeTelegramHtml } from "../../src/feeds/index.js";

import type { Finding } from "./types.js";
import type { FeedItem } from "../../src/types.js";

const LINK_FORMS = /https?:\/\/\S+|www\.\S+|\bt\.me\/\S+/gi;
const TAG_RE = /<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi;
const TELEGRAM_TAGS = new Set(
  "b strong i em u ins s strike del a code pre blockquote br".split(" "),
);
const normalizeHref = (href: string) => href.trim().replace(/\/+$/, "");

/** What the sanitizer would have to repair: unknown tags, unbalanced tags, dropped links. */
function markupProblems(html: string): string[] {
  const tags = [...html.matchAll(TAG_RE)].map((m) => ({
    close: m[1] === "/",
    name: (m[2] ?? "").toLowerCase(),
  }));
  const unknown = tags.filter((t) => !TELEGRAM_TAGS.has(t.name)).map((t) => `<${t.name}>`);
  const opens = tags.filter((t) => !t.close && t.name !== "br").length;
  const closes = tags.filter((t) => t.close).length;
  const kept = tagNamesOf(sanitizeTelegramHtml(html)).length;
  return [
    ...new Set(unknown),
    ...(opens === closes ? [] : [`${opens} open vs ${closes} close`]),
    ...(unknown.length === 0 && kept !== opens ? [`${opens - kept} tag(s) dropped`] : []),
  ];
}

export function checkChannelRetell(html: string, item: FeedItem): Finding[] {
  const published = withSourceLine(cleanRetellHtml(html, item), item);
  const visible = visibleText(published);
  const creditAt = visible.lastIndexOf("\n\nИсточник: ");
  const body = creditAt >= 0 ? visible.slice(0, creditAt) : visible;
  const findings: Finding[] = [];
  findings.push(
    body.length <= RETELL_MAX
      ? pass("channel.length")
      : fail("channel.length", "error", `${body.length} > ${RETELL_MAX}`),
  );
  const creditLines = visible.match(/^\s*Источник:/gm) ?? [];
  findings.push(
    creditLines.length === 1 && published.endsWith(withSourceLine("", item))
      ? pass("channel.source")
      : fail("channel.source", "error", "no single credit line"),
  );
  const sourceLinks = new Set(hrefsOf(item.html ?? "").map(normalizeHref));
  const foreign = [
    ...hrefsOf(sanitizeTelegramHtml(html)).filter((href) => !sourceLinks.has(normalizeHref(href))),
    ...(body.match(LINK_FORMS) ?? []).filter((link) => !item.snippet.includes(link)),
  ];
  findings.push(
    foreign.length === 0
      ? pass("channel.links")
      : fail("channel.links", "error", foreign.join(", ")),
  );
  const known = new Set(numbersOf(item.snippet));
  const novel = numbersOf(body).filter((n) => !known.has(n));
  findings.push(
    novel.length === 0
      ? pass("channel.numbers")
      : fail("channel.numbers", "error", novel.join(", ")),
  );
  findings.push(
    /\*\*|__|^#{1,6}\s/m.test(body)
      ? fail("channel.markdown", "warn", "markdown in the text")
      : pass("channel.markdown"),
  );
  const problems = markupProblems(html);
  findings.push(
    problems.length === 0
      ? pass("channel.markup")
      : fail("channel.markup", "error", problems.join(", ")),
  );
  return findings;
}
