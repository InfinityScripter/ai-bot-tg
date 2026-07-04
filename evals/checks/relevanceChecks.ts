/**
 * Deterministic checks for a relevance-classifier reply. The classifier is only
 * called for the gray zone, so a fixture declares the band it should fall in and
 * the checks assert the parsed score lands there, plus that the reply is valid
 * JSON with a bounded score/topic. Zero LLM cost when run over recorded replies.
 */

import { pass, fail } from "./types.js";

import type { Finding } from "./types.js";

/** Which side of the keep-threshold a fixture is expected to land on. */
export type RelevanceBand = "off" | "gray" | "on";

/** The parsed shape of a relevance reply. */
export interface RelevanceReply {
  score: number;
  topic?: unknown;
  reason?: unknown;
}

/** Allowed score sets per band (threshold default is 2 → keep when score >= 2). */
const BAND_SCORES: Record<RelevanceBand, ReadonlySet<number>> = {
  off: new Set([0, 1]),
  gray: new Set([1, 2, 3]),
  on: new Set([3, 4]),
};

/**
 * Parses a raw relevance reply string into {score, topic, reason}, or null if it
 * is not valid JSON / has no finite numeric score. Mirrors the production
 * parseScore leniency (it clamps), but here we keep the raw score so the band
 * check can see an out-of-range value.
 */
export function parseRelevanceReply(raw: string | null): RelevanceReply | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as { score?: unknown; topic?: unknown; reason?: unknown };
    if (typeof obj.score !== "number" || !Number.isFinite(obj.score)) return null;
    return { score: obj.score, topic: obj.topic, reason: obj.reason };
  } catch {
    return null;
  }
}

/** Checks a parsed reply against the expected band + shape bounds. */
export function checkRelevance(reply: RelevanceReply | null, band: RelevanceBand): Finding[] {
  if (reply === null) {
    return [fail("relevance.parse", "error", "reply is not valid JSON with a numeric score")];
  }
  const out: Finding[] = [pass("relevance.parse")];

  out.push(
    reply.score >= 0 && reply.score <= 4 && Number.isInteger(reply.score)
      ? pass("relevance.range")
      : fail("relevance.range", "error", `score ${reply.score} out of 0–4 integer range`),
  );

  out.push(
    BAND_SCORES[band].has(reply.score)
      ? pass("relevance.band")
      : fail(
          "relevance.band",
          "error",
          `score ${reply.score} not in expected '${band}' band {${[...BAND_SCORES[band]].join(",")}}`,
        ),
  );

  const topic = typeof reply.topic === "string" ? reply.topic.trim() : "";
  out.push(
    topic.length > 0
      ? pass("relevance.topic")
      : fail("relevance.topic", "warn", "empty/missing topic"),
  );
  // topic 2–4 words is the prompt's ask; over 6 words → warn (bloat).
  const words = topic ? topic.split(/\s+/).length : 0;
  out.push(
    words <= 6
      ? pass("relevance.topicLen")
      : fail("relevance.topicLen", "warn", `topic has ${words} words`),
  );

  return out;
}
