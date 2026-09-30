import { releaseKey } from "../llm/index.js";

import type { Candidate } from "../types.js";
import type { CandidateStore } from "../store/index.js";

/** The release is already on the blog: the automatic runner sends it to the digest instead. */
export class DuplicateReleaseError extends Error {}

/**
 * How far back a published release blocks a repeat. A launch is covered by
 * outlets over several days (TechCrunch, then The Verge, then Habr), well
 * inside two weeks; a genuinely new version has a different name anyway.
 */
const DUPLICATE_RELEASE_DAYS = 14;

/** Throws DuplicateReleaseError when the bot already published this model release. */
export function assertNewRelease(store: CandidateStore, candidate: Candidate): void {
  const release = store.getRelease(candidate)?.release;
  if (!release) return;
  const key = releaseKey(release);
  const published = store.listPublishedReleases(DUPLICATE_RELEASE_DAYS).some((c) => {
    const other = store.getRelease(c)?.release;
    return c.id !== candidate.id && !!other && releaseKey(other) === key;
  });
  if (published) {
    throw new DuplicateReleaseError(`${release.vendor} ${release.model} ${release.version}`);
  }
}
