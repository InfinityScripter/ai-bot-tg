/**
 * Deterministic checks for the channel dress (rubric, why line, cover text).
 * Input is the model's raw reply; it goes through finalizeDress and
 * dropInventions exactly as in production, so a field production would
 * drop shows up here as a warning instead of vanishing. Checked: numbers
 * absent from the source, a cover title that fits the cover, nothing dropped,
 * no long dash.
 */

import { pass, fail } from "./types.js";
import { numbersOf } from "../../src/llm/numbersOf.js";
import { finalizeDress, dropInventions } from "../../src/llm/index.js";

import type { Finding } from "./types.js";

/** What the prompt asks for, and what the cover holds at its small size (3 lines × 31). */
const TITLE_ASKED = 60;
const TITLE_FITS = 93;

interface RawDress {
  why?: unknown;
  coverFact?: unknown;
}

const filled = (value: unknown) => typeof value === "string" && value.trim() !== "";

/** `source` is the text the dress was made from: the retelling, as in production. */
export function checkDress(raw: string, source: string): Finding[] {
  const asked = finalizeDress(raw);
  const dress = dropInventions(asked, source);
  const known = new Set(numbersOf(source));
  const novel = [asked.why, asked.coverTitle, asked.coverFact]
    .flatMap(numbersOf)
    .filter((n) => !known.has(n));
  if (!dress) {
    return [fail("dress.numbers", "error", `cover title invents ${novel.join(", ")}`)];
  }
  const reply = JSON.parse(raw) as RawDress;
  const dropped = [
    ...(filled(reply.why) && !dress.why ? ["why"] : []),
    ...(filled(reply.coverFact) && !dress.coverFact ? ["coverFact"] : []),
  ];
  const title = dress.coverTitle.length;
  return [
    novel.length === 0
      ? pass("dress.numbers")
      : fail("dress.numbers", "warn", `dropped for ${novel.join(", ")}`),
    title > TITLE_FITS
      ? fail("dress.title", "error", `${title} > ${TITLE_FITS}, cut on the cover`)
      : title > TITLE_ASKED
        ? fail("dress.title", "warn", `${title} > ${TITLE_ASKED}`)
        : pass("dress.title"),
    dropped.length === 0
      ? pass("dress.dropped")
      : fail(
          "dress.dropped",
          "warn",
          `${dropped.join(", ")}: too long, a link or an invented number`,
        ),
    [dress.why, dress.coverTitle, dress.coverFact].some((t) => /[—–]/.test(t))
      ? fail("dress.dash", "warn", "long dash in the text")
      : pass("dress.dash"),
  ];
}
