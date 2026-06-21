/**
 * Candidate-lifecycle write operations for the store: the atomic state-machine
 * transitions (claim/setState/attach/publish/recover). Free functions taking the
 * better-sqlite3 handle; `CandidateStore` delegates to them so the store class
 * stays a thin facade over the candidate lifecycle (mirrors store-settings.ts).
 */

import type Database from "better-sqlite3";

import { CandidateState } from "./enums.js";

import type { RewriteResult } from "./types.js";

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

/** Stores the rewrite result and moves the candidate to 'pending_review'. */
export function attachRewrite(db: Database.Database, id: number, rewrite: RewriteResult): void {
  db.prepare(
    `UPDATE candidates
       SET rewrite_json = ?, state = ?, error = NULL, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(JSON.stringify(rewrite), CandidateState.PendingReview, id);
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
