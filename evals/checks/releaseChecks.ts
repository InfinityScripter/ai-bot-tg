/**
 * Deterministic check for a release-confirm reply: the reply must be the JSON
 * object {"release": boolean} the prompt asks for, and the verdict must match
 * the fixture. Production treats anything else as "could not tell" (null).
 */

import { pass, fail } from "./types.js";

import type { Finding } from "./types.js";

/** The verdict in a raw reply, or null when it is not {"release": boolean}. */
export function parseReleaseReply(raw: string | null): boolean | null {
  if (!raw) return null;
  try {
    const verdict = (JSON.parse(raw) as { release?: unknown }).release;
    return typeof verdict === "boolean" ? verdict : null;
  } catch {
    return null;
  }
}

/** Checks a parsed verdict against the expected one. */
export function checkRelease(verdict: boolean | null, expected: boolean): Finding[] {
  if (verdict === null) {
    return [fail("release.parse", "error", 'reply is not {"release": boolean}')];
  }
  return [
    pass("release.parse"),
    verdict === expected
      ? pass("release.verdict")
      : fail("release.verdict", "error", `said ${verdict}, expected ${expected}`),
  ];
}
