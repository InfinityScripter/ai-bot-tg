import { CONFIG } from './config.js';
import { fetchAllFeeds } from './feeds.js';
import { hasActiveOverride } from './providers.js';
import { rewriteToPost } from './rewriter.js';
import type { CandidateStore } from './store.js';
import type { Candidate, RewriteResult } from './types.js';

/**
 * Heuristic: does this rewrite error look like the provider rejecting the model
 * id (not a transient rate-limit/network issue)? Matches a 4xx whose text
 * mentions the model — used to auto-clear a stale /model override.
 */
function isModelNotFound(message: string): boolean {
  const is4xx = /\b(400|404)\b/.test(message);
  const mentionsModel = /model/i.test(message) || /модел/i.test(message);
  return is4xx && mentionsModel;
}

/** Summary of one collection run, returned for logging/visibility. */
export interface RunSummary {
  fetched: number;
  fresh: number;
  rewritten: number;
  failed: number;
  sent: number;
}

type SendApproval = (candidate: Candidate, rewrite: RewriteResult) => Promise<void>;

/**
 * Runs one full collection cycle: fetch feeds → dedup-insert → rewrite each
 * fresh item via Claude → DM the owner for approval. Caps the number of new
 * candidates per run (MAX_PER_RUN) to bound Claude spend. Resilient: a single
 * rewrite failure marks that candidate rewrite_failed and continues.
 *
 * Both the daily cron and the /fetch command call this.
 */
export async function runCollection(
  store: CandidateStore,
  sendApproval: SendApproval
): Promise<RunSummary> {
  const items = await fetchAllFeeds();
  const summary: RunSummary = { fetched: items.length, fresh: 0, rewritten: 0, failed: 0, sent: 0 };

  // Insert fresh (deduped) items, capped per run. Keep each FeedItem paired
  // with its new id so the rewrite has the full snippet (not persisted on the row).
  const fresh: { id: number; item: (typeof items)[number] }[] = [];
  for (const item of items) {
    if (fresh.length >= CONFIG.MAX_PER_RUN) break;
    const id = store.insertCollected(item);
    if (id !== null) fresh.push({ id, item });
  }
  summary.fresh = fresh.length;

  for (const { id, item } of fresh) {
    store.setState(id, 'rewriting');
    let rewrite: RewriteResult;
    try {
      rewrite = await rewriteToPost(item, store);
    } catch (err) {
      const message = String(err);
      store.setState(id, 'rewrite_failed', message);
      summary.failed += 1;
      // eslint-disable-next-line no-console
      console.warn(`[collector] rewrite failed for #${id}: ${message}`);
      // If a stored /model override points at a model the provider no longer
      // serves (a 400/404 about the model), clear it so the next run falls back
      // to the env default instead of failing the whole batch every day.
      if (isModelNotFound(message) && hasActiveOverride(store)) {
        store.clearModelOverride();
        // eslint-disable-next-line no-console
        console.warn('[collector] cleared invalid model override; falling back to env default');
      }
      continue;
    }

    store.attachRewrite(id, rewrite);
    summary.rewritten += 1;

    const updated = store.get(id);
    if (!updated) continue;
    try {
      await sendApproval(updated, rewrite);
      summary.sent += 1;
    } catch (err) {
      // Keep the candidate in pending_review (the rewrite is saved) but record
      // the delivery error so it's visible rather than silently lost.
      store.setState(id, 'pending_review', `Не удалось отправить в Telegram: ${String(err)}`);
      // eslint-disable-next-line no-console
      console.warn(`[collector] failed to DM approval for #${id}: ${String(err)}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[collector] run done: fetched=${summary.fetched} fresh=${summary.fresh} ` +
      `rewritten=${summary.rewritten} failed=${summary.failed} sent=${summary.sent}`
  );
  return summary;
}
