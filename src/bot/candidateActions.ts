import { CONFIG } from "../config.js";
import { CandidateKind } from "../enums.js";
import { renderPreview } from "./render.js";
import { renderReleasePreview } from "./renderRelease.js";
import { rewriteToPost, extractRelease } from "../llm/index.js";
import { publishToBlog, publishRelease, pickDefaultCover } from "../blog/index.js";

import type { CandidateStore } from "../store/index.js";
import type { LoadedExtraction, CrossPostContent } from "./types.js";
import type { FeedItem, Candidate, ReleaseResult } from "../types.js";

/** Public site base, no trailing slash — for the channel "Читать" links. */
const PUBLIC_BASE = CONFIG.BLOG_PUBLIC_URL.replace(/\/$/, "");

/** One-line release summary for the channel caption (vendor model version + first change). */
function releaseSummary(release: ReleaseResult): string {
  const head = `${release.vendor} ${release.model} ${release.version}`.trim();
  const firstChange = release.changes[0]?.trim();
  return firstChange ? `${head} — ${firstChange}` : head;
}

/**
 * Reads the stored extraction for a candidate and wraps it with its publish
 * action, or returns null when nothing valid is stored (corrupt/missing JSON).
 * News → the saved RewriteResult; release → the saved ReleaseResult.
 */
export function loadExtraction(
  store: CandidateStore,
  candidate: Candidate,
): LoadedExtraction | null {
  if (candidate.kind === CandidateKind.Release) {
    const release = store.getRelease(candidate);
    if (!release) return null;
    const title = `${release.vendor} ${release.model} ${release.version}`;
    const crossPost: CrossPostContent = {
      title,
      description: releaseSummary(release),
      // Releases have no per-item slug in the extraction → link to the changelog.
      coverUrl: null,
      linkFor: () => `${PUBLIC_BASE}/changelog`,
    };
    return {
      title,
      publish: () => publishRelease(release, candidate.dedupKey),
      crossPost,
    };
  }
  const rewrite = store.getRewrite(candidate);
  if (!rewrite) return null;
  // Decide the cover ONCE for both the blog post and the channel card: the feed
  // image if the source had one, else a themed default ROTATED by the candidate
  // id, so covers cycle through the topical pool instead of repeating. Keyed on
  // the stable id (not the title), so a publish retry and the cross-post agree
  // on the same image and an imageless post still gets a fitting photo card.
  const cover = candidate.imageUrl ?? pickDefaultCover(rewrite.tags, candidate.id);
  const crossPost: CrossPostContent = {
    title: rewrite.title,
    description: rewrite.description,
    coverUrl: cover,
    linkFor: (postId) => `${PUBLIC_BASE}/post/${postId}`,
  };
  return {
    title: rewrite.title,
    publish: () => publishToBlog(rewrite, cover, candidate.dedupKey),
    crossPost,
  };
}

/**
 * Runs the kind-appropriate extraction (news → LLM rewrite; release → structured
 * release extraction), persists it (→ pending_review), and returns the preview
 * card text for the updated candidate.
 */
export async function runExtraction(
  store: CandidateStore,
  id: number,
  item: FeedItem,
  fallback: Candidate,
  modelLabel: string,
): Promise<string> {
  if (item.kind === CandidateKind.Release) {
    const release = await extractRelease(item, store);
    store.attachRelease(id, release);
    const updated = store.get(id) ?? fallback;
    return renderReleasePreview(updated, release, modelLabel);
  }
  const rewrite = await rewriteToPost(item, store);
  store.attachRewrite(id, rewrite);
  const updated = store.get(id) ?? fallback;
  return renderPreview(updated, rewrite, modelLabel);
}
