import type { Candidate, RewriteResult } from "../types.js";

/**
 * Quality gate for AUTO-publish only. A gate failure is not an error to swallow:
 * the caller (processClaimedCandidateAutomatically) lets it throw, the automatic
 * runner catches it and turns the candidate into a manual approval card — so a
 * borderline item is diverted to the owner, never dropped and never silently
 * auto-posted. Manual publish (the owner tapping ✅) deliberately bypasses this.
 *
 * Two checks beyond the zod schemas' `.min(1)`:
 *  1. substance — the post (news, or the post of a release) needs a body of
 *     real length: a headline-only stub is not a post.
 *  2. source — the article URL's host is not on a small junk blocklist (link
 *     shorteners, social/aggregator permalinks, parking). BLOCKLIST, not
 *     allowlist: most sources are fine, and Hacker News legitimately links out
 *     to arbitrary domains, so allow-listing feed hosts would wrongly divert
 *     good HN-surfaced articles. Fail-OPEN on an unparseable URL (keep going) —
 *     the substance check and the manual fallback are the real backstops.
 */

/** Minimum rewritten-body length (chars) for a news post to auto-publish. */
const MIN_NEWS_CONTENT = 400;

/**
 * Hosts that mark a non-article source: link shorteners, social and aggregator
 * permalinks (not the underlying article), and domain parking. A candidate whose
 * source host equals one of these (or is a subdomain of it) is diverted to manual
 * review rather than auto-published.
 */
const BLOCKED_HOSTS: readonly string[] = [
  "bit.ly",
  "t.co",
  "t.me",
  "x.com",
  "twitter.com",
  "facebook.com",
  "vk.com",
  "reddit.com",
  "lnkd.in",
  "tinyurl.com",
  "goo.gl",
  "sedoparking.com",
];

/** Thrown when an auto-publish candidate fails a quality gate. Message is shown to the owner. */
export class GateFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateFailure";
  }
}

/** True if the URL's host is on the junk blocklist. Unparseable URL → false (fail-open). */
function hasBlockedSource(sourceUrl: string): boolean {
  let host: string;
  try {
    host = new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    return false; // can't parse → don't block on the source (substance still gates)
  }
  // Match the exact host or a subdomain of it (www.x.com, m.reddit.com), but not
  // a lookalike that merely contains the string (e.g. "notbit.lyx.com").
  return BLOCKED_HOSTS.some((bad) => host === bad || host.endsWith(`.${bad}`));
}

/**
 * Asserts an extracted candidate is fit to auto-publish, else throws GateFailure.
 * `post` is the already-validated blog post: the news rewrite, or the post of a
 * release bundle. A release's changelog card is not gated: it is optional and
 * publishes after the post (see publishReleaseCard).
 */
export function assertPublishable(candidate: Candidate, post: RewriteResult): void {
  if (hasBlockedSource(candidate.sourceUrl)) {
    throw new GateFailure(`источник не в списке доверенных (${candidate.sourceUrl})`);
  }
  if (post.content.trim().length < MIN_NEWS_CONTENT) {
    throw new GateFailure(
      `текст поста слишком короткий (${post.content.trim().length} симв., нужно ≥ ${MIN_NEWS_CONTENT})`,
    );
  }
}
