/**
 * Deterministic checks for a channel retelling (after finalizeRetell +
 * withSourceLine): the caption cap, exactly one credit line, no links except
 * the source post, no numbers absent from the source, plain text only.
 */

import { pass, fail } from "./types.js";
import { RETELL_MAX } from "../../src/llm/index.js";

import type { Finding } from "./types.js";
import type { FeedItem } from "../../src/types.js";

const CREDIT_SEPARATOR = "\n\nИсточник: ";
const LINK_FORMS = /https?:\/\/\S+|www\.\S+|\bt\.me\/\S+/gi;

function numbersOf(text: string): string[] {
  // Space-like separators only: posts list tariffs one per line ("x5\n200$"), and a
  // newline join turned 5 and 200 into a fake "5200" (abstractDL, 2026-09-30).
  const normalised = text.replace(/(\d)[ \u00a0\u2009\u202f](?=\d{3}(?!\d))/g, "$1");
  return (normalised.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));
}

export function checkChannelRetell(text: string, item: FeedItem): Finding[] {
  const creditAt = text.lastIndexOf(CREDIT_SEPARATOR);
  const body = creditAt >= 0 ? text.slice(0, creditAt) : text;
  const creditLines = text.match(/^\s*Источник:/gm) ?? [];
  const lastLine = text.slice(text.lastIndexOf("\n") + 1);
  const findings: Finding[] = [];
  findings.push(
    body.length <= RETELL_MAX
      ? pass("channel.length")
      : fail("channel.length", "error", `${body.length} > ${RETELL_MAX}`),
  );
  findings.push(
    creditLines.length === 1 && lastLine === `Источник: ${item.feedTitle} — ${item.url}`
      ? pass("channel.source")
      : fail("channel.source", "error", "no single credit line"),
  );
  const links = body.match(LINK_FORMS) ?? [];
  findings.push(
    links.length === 0 ? pass("channel.links") : fail("channel.links", "error", links.join(", ")),
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
      ? fail("channel.markdown", "warn", "markdown in plain text")
      : pass("channel.markdown"),
  );
  return findings;
}
