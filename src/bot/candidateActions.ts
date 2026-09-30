import { CONFIG } from "../config.js";
import { enrichItemBody } from "../feeds/index.js";
import { renderRetellPreview } from "./renderRetell.js";
import { renderReleasePreview } from "./renderRelease.js";
import { CandidateKind, CandidateState } from "../enums.js";
import { renderPreview, isModelNotFound } from "./render.js";
import { assertNamesModel, assertNewRelease } from "./duplicateRelease.js";
import { PublishError, publishToBlog, publishRelease } from "../blog/index.js";
import { loadChannelExtraction, assertRetellPublishable } from "./channelExtraction.js";
import {
  PROVIDERS,
  rewriteToPost,
  extractRelease,
  hasActiveOverride,
  assertPublishable,
  retellChannelPost,
  NoModelInSourceError,
  resolveActiveProvider,
} from "../llm/index.js";

import type { CandidateStore } from "../store/index.js";
import type { FeedItem, Candidate, ReleaseResult } from "../types.js";
import type { LoadedExtraction, CrossPostContent, PublishedCandidate } from "./types.js";

/** Public site base, no trailing slash — for the channel "Читать" links. */
const PUBLIC_BASE = CONFIG.BLOG_PUBLIC_URL.replace(/\/$/, "");

/**
 * Adds the changelog card after the release post is live. Soft-fail: the post
 * is the point, and the daily catalog import fills the changelog anyway, so a
 * card that fails (or was never extracted) becomes a warning for the owner,
 * not a failed publish. Its own idempotency key keeps it from colliding with
 * the post's.
 */
async function publishReleaseCard(
  release: ReleaseResult | null,
  dedupKey: string,
): Promise<string | undefined> {
  if (!release || release.changes.length === 0) {
    return "карточка changelog не извлечена, пост опубликован без неё";
  }
  try {
    await publishRelease(release, `${dedupKey}#changelog`);
    return undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[release] changelog card failed for ${dedupKey}: ${message}`);
    return `карточка changelog не добавлена: ${message}`;
  }
}

/**
 * Reads the stored extraction for a candidate and wraps it with its publish
 * action, or returns null when nothing valid is stored (corrupt/missing JSON).
 * News → the saved RewriteResult; release → the saved ReleaseBundle, whose
 * post publishes like news and whose changelog card follows it.
 */
export function loadExtraction(
  store: CandidateStore,
  candidate: Candidate,
): LoadedExtraction | null {
  if (candidate.kind === CandidateKind.Channel) return loadChannelExtraction(store, candidate);
  const bundle = candidate.kind === CandidateKind.Release ? store.getRelease(candidate) : null;
  const rewrite = bundle ? bundle.post : store.getRewrite(candidate);
  if (!rewrite || (candidate.kind === CandidateKind.Release && !bundle)) return null;
  // Only the article's OWN image is decided here. When it has none we send no
  // cover at all and the blog assigns one no other post uses — the bot can't
  // know which images are still free (it doesn't see hand-written posts and its
  // SQLite can be reset), and guessing is what made covers repeat. The stored
  // cover comes back from publish() and lands on the channel card below.
  const sourceImage = store.getFeedItem(candidate).imageUrls[0];
  const cover = candidate.imageUrl || sourceImage || null;
  const crossPost: CrossPostContent = {
    title: rewrite.title,
    description: rewrite.description,
    coverUrl: cover,
    linkFor: (postId) => `${PUBLIC_BASE}/post/${postId}`,
  };
  return {
    title: rewrite.title,
    publish: async () => {
      const outcome = await publishToBlog(rewrite, cover, candidate.dedupKey);
      if (!bundle) return outcome;
      return { ...outcome, warning: await publishReleaseCard(bundle.release, candidate.dedupKey) };
    },
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
  if (item.kind === CandidateKind.Channel) {
    const retell = await retellChannelPost(item, store);
    store.attachRetell(id, retell);
    return renderRetellPreview(
      store.get(id) ?? fallback,
      retell,
      modelLabel,
      item.imageUrls.length,
    );
  }
  if (item.kind === CandidateKind.Release) {
    const post = await rewriteToPost(item, store);
    let noModel = false;
    const release = await extractRelease(item, store).catch((err: unknown) => {
      noModel = err instanceof NoModelInSourceError;
      console.warn(`[release] extraction failed for #${id}, post goes alone: ${String(err)}`);
      return null;
    });
    const bundle = noModel ? { post, release, noModel } : { post, release };
    store.attachRelease(id, bundle);
    const updated = store.get(id) ?? fallback;
    return renderReleasePreview(updated, bundle, modelLabel);
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
    const stored = store.getFeedItem(candidate);
    const item = candidate.kind === CandidateKind.Channel ? stored : await enrichItemBody(stored);
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

/**
 * Puts the cover the blog stored on the channel card. Blog-assigned covers can
 * be site-relative ("/assets/images/cover/cover-7.webp"); Telegram needs an
 * absolute URL (isUsableImageUrl rejects relative ones and the card silently
 * degrades to text), so those are resolved against the blog host.
 */
function withPublishedCover(
  extracted: LoadedExtraction,
  coverUrl?: string | null,
): LoadedExtraction {
  if (!coverUrl || !extracted.crossPost) return extracted;
  const absolute = coverUrl.startsWith("/")
    ? `${CONFIG.BLOG_API_URL.replace(/\/$/, "")}${coverUrl}`
    : coverUrl;
  return { ...extracted, crossPost: { ...extracted.crossPost, coverUrl: absolute } };
}

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
    const { postId, coverUrl, warning } = await extracted.publish();
    store.setPublished(candidate.id, postId);
    // The blog is the authority on the cover (it assigns one for imageless
    // items), so the channel card follows it instead of the pre-publish guess.
    return { extracted: withPublishedCover(extracted, coverUrl), postId, warning };
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
  if (extractedCandidate.kind === CandidateKind.Channel) {
    const retell = store.getRetell(extractedCandidate);
    if (!retell) throw new MissingExtractionError("Нет сохранённых данных.");
    assertRetellPublishable(retell, store.getFeedItem(extractedCandidate));
  } else {
    const extraction =
      extractedCandidate.kind === CandidateKind.Release
        ? store.getRelease(extractedCandidate)?.post
        : store.getRewrite(extractedCandidate);
    if (!extraction) throw new MissingExtractionError("Нет сохранённых данных.");
    assertPublishable(extractedCandidate, extraction);
    if (extractedCandidate.kind === CandidateKind.Release) {
      assertNamesModel(store, extractedCandidate);
      assertNewRelease(store, extractedCandidate);
    }
  }

  if (!store.claimForPublishing(candidate.id)) {
    throw new Error("Кандидат не готов к публикации.");
  }
  return publishClaimedCandidate(store, extractedCandidate);
}
