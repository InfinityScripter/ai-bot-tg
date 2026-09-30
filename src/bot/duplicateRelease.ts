import { releaseKey } from "../llm/index.js";

import type { Candidate } from "../types.js";
import type { CandidateStore } from "../store/index.js";

/** Not a standalone release post: the automatic runner sends the article to the digest. */
export class ReleaseToNewsError extends Error {}

/**
 * How far back a published release blocks a repeat. A launch is covered by
 * outlets over several days (TechCrunch, then The Verge, then Habr), well
 * inside two weeks; a genuinely new version has a different name anyway.
 */
const DUPLICATE_RELEASE_DAYS = 14;

/** Throws ReleaseToNewsError when the extraction found no model in the source. */
export function assertNamesModel(store: CandidateStore, candidate: Candidate): void {
  if (store.getRelease(candidate)?.noModel) {
    throw new ReleaseToNewsError("В статье нет конкретной модели, это не релиз");
  }
}

/** Throws ReleaseToNewsError when the bot already published this model release. */
export function assertNewRelease(store: CandidateStore, candidate: Candidate): void {
  const release = store.getRelease(candidate)?.release;
  if (!release) return;
  const key = releaseKey(release);
  const published = store.listPublishedReleases(DUPLICATE_RELEASE_DAYS).some((c) => {
    const other = store.getRelease(c)?.release;
    return c.id !== candidate.id && !!other && releaseKey(other) === key;
  });
  if (published) {
    const name = `${release.vendor} ${release.model} ${release.version}`;
    throw new ReleaseToNewsError(`${name} уже опубликован, повтор не выпускаю`);
  }
}
