/**
 * Deterministic checks for a channel retelling (after finalizeRetell +
 * withSourceLine): the caption cap, exactly one credit line, no links except
 * the source post, no numbers absent from the source, plain text only.
 */

import { pass, fail } from "./types.js";

import type { Finding } from "./types.js";
import type { FeedItem } from "../../src/types.js";

const BODY_MAX = 900;

export function checkChannelRetell(text: string, item: FeedItem): Finding[] {
  const [body = "", ...rest] = text.split("\n\nИсточник: ");
  const findings: Finding[] = [];
  findings.push(
    body.length <= BODY_MAX
      ? pass("channel.length")
      : fail("channel.length", "error", `${body.length} > ${BODY_MAX}`),
  );
  findings.push(
    rest.length === 1 && rest[0] === `${item.feedTitle} — ${item.url}`
      ? pass("channel.source")
      : fail("channel.source", "error", "no single credit line"),
  );
  const links = body.match(/https?:\/\/\S+/g) ?? [];
  findings.push(
    links.length === 0 ? pass("channel.links") : fail("channel.links", "error", links.join(", ")),
  );
  const known = new Set(item.snippet.match(/\d+(?:[.,]\d+)?/g) ?? []);
  const novel = (body.match(/\d+(?:[.,]\d+)?/g) ?? []).filter((n) => !known.has(n));
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
