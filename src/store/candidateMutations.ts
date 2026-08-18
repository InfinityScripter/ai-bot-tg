/**
 * Candidate-lifecycle write operations for the store: the atomic state-machine
 * transitions (claim/setState/attach/publish/recover). Free functions taking the
 * better-sqlite3 handle; `CandidateStore` delegates to them so the store class
 * stays a thin facade over the candidate lifecycle (mirrors storeSettings.ts).
 */

import type Database from "better-sqlite3";

import { CandidateKind, CandidateState } from "../enums.js";

import type { FeedItem, RewriteResult, ReleaseResult } from "../types.js";

/**
 * Inserts a freshly-collected feed item as state 'collected'. Returns the new
 * candidate id, or null if the dedup key is already known (a live candidate —
 * INSERT OR IGNORE — or a pruned-but-seen key in seen_keys, honored so an old
 * published/skipped article isn't re-collected after its row was deleted).
 */
export function insertCollected(
  db: Database.Database,
  item: FeedItem,
  autoPublish = false,
): number | null {
  const prunedSeen = db.prepare("SELECT 1 FROM seen_keys WHERE dedup_key = ?").get(item.dedupKey);
  if (prunedSeen) return null;

  const info = db
    .prepare(
      `INSERT OR IGNORE INTO candidates
         (dedup_key, source_url, source_title, feed_title, image_url, snippet, image_urls, kind, auto_publish, state)
       VALUES (@dedupKey, @url, @title, @feedTitle, @imageUrl, @snippet, @imageUrls, @kind, @autoPublish, @state)`,
    )
    .run({
      dedupKey: item.dedupKey,
      url: item.url,
      title: item.title,
      feedTitle: item.feedTitle,
      imageUrl: item.imageUrl,
      snippet: item.snippet,
      imageUrls: JSON.stringify(item.imageUrls ?? []),
      // The item carries its kind (decided by runCollection from the release
      // markers before insert); an unset kind defaults to 'news'.
      kind: item.kind ?? CandidateKind.News,
      autoPublish: autoPublish ? 1 : 0,
      state: CandidateState.Collected,
    });
  return info.changes === 1 ? Number(info.lastInsertRowid) : null;
}

/**
 * Resets rows stuck in a transient in-flight state back to a retryable one. A
 * crash/deploy mid-rewrite/publish leaves a row in 'rewriting'/'publishing' — a
 * state none of the bot's button guards accept, so the card would be permanently
 * dead. 'rewriting' → 'collected' (no side effect happened, safe to retry);
 * 'publishing' → 'needs_verification' (the POST MAY have reached the blog, so the
 * owner is warned before re-publishing). Idempotent; runs once per process.
 */
export function recoverInFlight(db: Database.Database): void {
  const move = db.prepare(
    `UPDATE candidates SET state = ?, updated_at = datetime('now') WHERE state = ?`,
  );
  move.run(CandidateState.Collected, CandidateState.Rewriting);
  move.run(CandidateState.NeedsVerification, CandidateState.Publishing);
}

/**
 * Atomically claims a candidate for publishing: pending_review/needs_verification
 * → publishing in one UPDATE. Returns whether THIS caller won (changes === 1) —
 * two concurrent Publish taps can't both win, preventing a double-post.
 */
export function claimForPublishing(db: Database.Database, id: number): boolean {
  const info = db
    .prepare(
      `UPDATE candidates SET state = ?, updated_at = datetime('now')
       WHERE id = ? AND state IN (?, ?)`,
    )
    .run(
      CandidateState.Publishing,
      id,
      CandidateState.PendingReview,
      CandidateState.NeedsVerification,
    );
  return info.changes === 1;
}

/**
 * Atomically claims a candidate for rewriting: collected/pending_review/
 * rewrite_failed → rewriting in one UPDATE. Returns whether THIS caller won —
 * a double-tap of 🔄 can't start two concurrent (token-spending) rewrites.
 */
export function claimForRewriting(db: Database.Database, id: number): boolean {
  const info = db
    .prepare(
      `UPDATE candidates SET state = ?, error = NULL, updated_at = datetime('now')
       WHERE id = ? AND state IN (?, ?, ?)`,
    )
    .run(
      CandidateState.Rewriting,
      id,
      CandidateState.Collected,
      CandidateState.PendingReview,
      CandidateState.RewriteFailed,
    );
  return info.changes === 1;
}

/** Sets the state (and optionally an error message) for a candidate. */
export function setState(
  db: Database.Database,
  id: number,
  state: CandidateState,
  error: string | null = null,
): void {
  db.prepare(
    `UPDATE candidates SET state = ?, error = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(state, error, id);
}

/**
 * Stores an extracted entity JSON (a RewriteResult for news, a ReleaseResult for
 * release) in the shared rewrite_json column and moves the candidate to
 * 'pending_review'. attachRewrite is the news-typed alias kept for callers.
 */
export function attachExtraction(
  db: Database.Database,
  id: number,
  extraction: RewriteResult | ReleaseResult,
): void {
  db.prepare(
    `UPDATE candidates
       SET rewrite_json = ?, state = ?, error = NULL, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(JSON.stringify(extraction), CandidateState.PendingReview, id);
}

/** Stores the rewrite result and moves the candidate to 'pending_review'. */
export function attachRewrite(db: Database.Database, id: number, rewrite: RewriteResult): void {
  attachExtraction(db, id, rewrite);
}

/**
 * Clears the auto_publish flag on a candidate (1 → 0). Used by the divert-to-manual
 * path: when the master switch for this kind is off, an item collected with
 * auto_publish=1 (insertCollected hardcodes it) must be dropped from the automatic
 * lane, or crash-recovery (listRecoveredAutomatic selects auto_publish=1) would
 * re-divert the same row on every boot. Idempotent; leaves state untouched.
 */
export function clearAutoPublish(db: Database.Database, id: number): void {
  db.prepare(
    `UPDATE candidates SET auto_publish = 0, updated_at = datetime('now') WHERE id = ?`,
  ).run(id);
}

/**
 * Parks a freshly-collected news candidate in the daily-digest queue:
 * collected → digest_queued, clearing auto_publish in the SAME statement so
 * crash-recovery (listRecoveredAutomatic selects collected + auto_publish=1)
 * can never pull a queued row back into the per-item automatic lane. Guarded
 * on state='collected' so a double call (or a row the owner already acted on)
 * is a no-op. Returns whether the row was queued.
 */
export function queueForDigest(db: Database.Database, id: number): boolean {
  const info = db
    .prepare(
      `UPDATE candidates SET state = ?, auto_publish = 0, updated_at = datetime('now')
       WHERE id = ? AND state = ?`,
    )
    .run(CandidateState.DigestQueued, id, CandidateState.Collected);
  return info.changes === 1;
}

/**
 * Atomically claims a digest batch for publishing: digest_queued → publishing
 * for every given id still in the queue, in ONE statement. Returns how many
 * rows were claimed — the caller compares against ids.length; a shortfall
 * means another actor touched a row (skip/publish race) and the batch should
 * be rebuilt from a fresh queue read rather than published blind.
 */
export function claimDigestBatch(db: Database.Database, ids: number[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  const info = db
    .prepare(
      `UPDATE candidates SET state = ?, updated_at = datetime('now')
       WHERE id IN (${placeholders}) AND state = ?`,
    )
    .run(CandidateState.Publishing, ...ids, CandidateState.DigestQueued);
  return info.changes;
}

/**
 * Returns a claimed-but-unpublished digest batch to the queue (publishing →
 * digest_queued) after a CLEAR publish failure (4xx — the POST definitely did
 * not create a post). A maybe-posted failure must use needs_verification
 * instead, never this.
 */
export function requeueDigestBatch(db: Database.Database, ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(
    `UPDATE candidates SET state = ?, updated_at = datetime('now')
     WHERE id IN (${placeholders}) AND state = ?`,
  ).run(CandidateState.DigestQueued, ...ids, CandidateState.Publishing);
}

/**
 * Expires digest-queued rows older than `hours` to 'skipped' — stale news
 * must not headline tomorrow's digest. updated_at is the queueing time (the
 * queue transition touches it), so the window measures time in the queue.
 * Returns the number expired.
 */
export function expireDigestQueue(db: Database.Database, hours: number): number {
  const offset = `-${Math.max(1, Math.floor(hours))} hours`;
  const info = db
    .prepare(
      `UPDATE candidates SET state = ?, updated_at = datetime('now')
       WHERE state = ? AND updated_at < datetime('now', ?)`,
    )
    .run(CandidateState.Skipped, CandidateState.DigestQueued, offset);
  return info.changes;
}

/**
 * Prunes terminal candidates (published/skipped) older than `days`, preserving
 * their dedup_key in seen_keys so they're never re-collected. The cutoff is
 * resolved to ONE fixed timestamp so the INSERT and DELETE compare against the
 * identical boundary — datetime('now') re-evaluated per-statement could let a
 * row be deleted without its key copied. Returns the number pruned.
 */
export function pruneOld(db: Database.Database, days = 90): number {
  const offset = `-${Math.max(1, Math.floor(days))} days`;
  const { cutoff } = db.prepare("SELECT datetime('now', ?) AS cutoff").get(offset) as {
    cutoff: string;
  };
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO seen_keys (dedup_key)
         SELECT dedup_key FROM candidates
         WHERE state IN (?, ?) AND updated_at < ?`,
    ).run(CandidateState.Published, CandidateState.Skipped, cutoff);
    const info = db
      .prepare(
        `DELETE FROM candidates
           WHERE state IN (?, ?) AND updated_at < ?`,
      )
      .run(CandidateState.Published, CandidateState.Skipped, cutoff);
    return info.changes;
  });
  return tx() as number;
}

/** Records the Telegram message id of the approval DM. */
export function setTelegramMessage(db: Database.Database, id: number, messageId: number): void {
  db.prepare(
    `UPDATE candidates SET tg_message_id = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(messageId, id);
}

/** Marks a candidate published and records the blog post id. */
export function setPublished(db: Database.Database, id: number, blogPostId: string): void {
  db.prepare(
    `UPDATE candidates
       SET state = ?, blog_post_id = ?, error = NULL, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(CandidateState.Published, blogPostId, id);
}
