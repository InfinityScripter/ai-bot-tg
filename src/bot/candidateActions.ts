import { CandidateKind } from "../enums.js";
import { renderPreview } from "./render.js";
import { renderReleasePreview } from "./renderRelease.js";
import { rewriteToPost, extractRelease } from "../llm/index.js";
import { publishToBlog, publishRelease } from "../blog/index.js";

import type { LoadedExtraction } from "./types.js";
import type { FeedItem, Candidate } from "../types.js";
import type { CandidateStore } from "../store/index.js";

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
    return {
      title: `${release.vendor} ${release.model} ${release.version}`,
      publish: () => publishRelease(release, candidate.dedupKey),
    };
  }
  const rewrite = store.getRewrite(candidate);
  if (!rewrite) return null;
  return {
    title: rewrite.title,
    publish: () => publishToBlog(rewrite, candidate.imageUrl, candidate.dedupKey),
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
