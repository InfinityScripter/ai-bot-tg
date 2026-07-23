import { CONFIG } from "../config.js";
import { enrichItemBody } from "../feeds/index.js";
import { renderReleasePreview } from "./renderRelease.js";
import { CandidateKind, CandidateState } from "../enums.js";
import { renderPreview, isModelNotFound } from "./render.js";
import { PublishError, publishToBlog, publishRelease, pickDefaultCover } from "../blog/index.js";
import {
  PROVIDERS,
  rewriteToPost,
  extractRelease,
  hasActiveOverride,
  assertPublishable,
  resolveActiveProvider,
} from "../llm/index.js";

import type { CandidateStore } from "../store/index.js";
import type { FeedItem, Candidate, ReleaseResult } from "../types.js";
import type { LoadedExtraction, CrossPostContent, PublishedCandidate } from "./types.js";

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
  const sourceImage = store.getFeedItem(candidate).imageUrls[0];
  const cover = candidate.imageUrl || sourceImage || pickDefaultCover(rewrite.tags, candidate.id);
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

/** Active provider label shown in manual previews and automatic-run logs. */
export function activeModelLabel(store: CandidateStore): string {
  const active = resolveActiveProvider(store);
  return `${PROVIDERS[active.provider].label} / ${active.model}`;
}

/** Runs a previously claimed extraction and maps every failure to a retryable state. */
export async function runClaimedExtraction(
  store: CandidateStore,
  id: number,
  candidate: Candidate,
  modelLabel: string,
): Promise<string> {
  try {
    const item = await enrichItemBody(store.getFeedItem(candidate));
    return await runExtraction(store, id, item, candidate, modelLabel);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.setState(id, CandidateState.RewriteFailed, message);
    if (isModelNotFound(message) && hasActiveOverride(store)) store.clearModelOverride();
    throw err;
  }
}

/** Missing/corrupt saved extraction needs a fresh rewrite, not another publish attempt. */
export class MissingExtractionError extends Error {}

/** Publishes a previously claimed candidate and preserves duplicate-safety states. */
export async function publishClaimedCandidate(
  store: CandidateStore,
  candidate: Candidate,
): Promise<PublishedCandidate> {
  const current = store.get(candidate.id) ?? candidate;
  const extracted = loadExtraction(store, current);
  if (!extracted) {
    store.setState(candidate.id, CandidateState.RewriteFailed, "Нет сохранённых данных.");
    throw new MissingExtractionError("Нет сохранённых данных.");
  }

  try {
    const postId = await extracted.publish();
    store.setPublished(candidate.id, postId);
    return { extracted, postId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const maybePosted = err instanceof PublishError && err.maybePosted;
    store.setState(
      candidate.id,
      maybePosted ? CandidateState.NeedsVerification : CandidateState.PendingReview,
      message,
    );
    throw err;
  }
}

/** Finishes automatic processing after caller atomically claimed the rewrite. */
export async function processClaimedCandidateAutomatically(
  store: CandidateStore,
  candidate: Candidate,
): Promise<PublishedCandidate> {
  const modelLabel = activeModelLabel(store);
  await runClaimedExtraction(store, candidate.id, candidate, modelLabel);

  const extractedCandidate = store.get(candidate.id);
  if (!extractedCandidate) throw new Error("Кандидат не готов к публикации.");

  // Quality gate — AUTO-publish only. The extraction is stored (state is now
  // pending_review); assert it's fit to publish unattended before claiming. A
  // GateFailure propagates up to runAutomaticPublish's catch → showFailure, which
  // leaves the candidate on its preview card (✅ to publish manually) — so a
  // borderline item is diverted to the owner, never auto-posted or dropped.
  const extraction =
    extractedCandidate.kind === CandidateKind.Release
      ? store.getRelease(extractedCandidate)
      : store.getRewrite(extractedCandidate);
  if (!extraction) throw new MissingExtractionError("Нет сохранённых данных.");
  assertPublishable(extractedCandidate, extraction);

  if (!store.claimForPublishing(candidate.id)) {
    throw new Error("Кандидат не готов к публикации.");
  }
  return publishClaimedCandidate(store, extractedCandidate);
}
