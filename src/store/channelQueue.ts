import type Database from "better-sqlite3";

import { mapRow } from "./candidateSchema.js";
import { insertCollected } from "./candidateMutations.js";
import { CandidateKind, CandidateState } from "../enums.js";
import { getRawSetting, setRawSetting } from "./storeSettings.js";

import type { FeedItem } from "../types.js";
import type { QueuedPost, CandidateRow } from "./types.js";

/** The settings row with the last issue slot that went out, e.g. "2026-10-01/morning". */
const LAST_SLOT_KEY = "channel_digest_last_slot";

const placeholders = (ids: number[]) => ids.map(() => "?").join(", ");

/**
 * The channel digest queue: kind='channel' rows in 'digest_queued', filled by
 * the hourly sweep and drained by the twice-daily issue. Every statement
 * filters on kind, so the RSS digest's rows in the same state are never
 * touched (and the RSS digest filters channel rows out on its side).
 */
export class ChannelQueue {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Queues a fresh post: insertCollected's dedup (a live row or a pruned
   * seen key returns null), then digest_queued with the post's time and
   * score, in one transaction.
   */
  add(item: FeedItem, viewScore: number): number | null {
    const queue = this.db.transaction((): number | null => {
      const id = insertCollected(this.db, { ...item, kind: CandidateKind.Channel });
      if (id === null) return null;
      this.db
        .prepare(`UPDATE candidates SET state = ?, published_at = ?, view_score = ? WHERE id = ?`)
        .run(CandidateState.DigestQueued, item.publishedAt, viewScore, id);
      return id;
    });
    return queue();
  }

  /** The latest score of a queued post; false when the post is not (or no longer) queued. */
  refreshScore(dedupKey: string, viewScore: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE candidates SET view_score = ?
          WHERE dedup_key = ? AND kind = 'channel' AND state = ?`,
      )
      .run(viewScore, dedupKey, CandidateState.DigestQueued);
    return info.changes === 1;
  }

  list(): QueuedPost[] {
    const rows = this.db
      .prepare(`SELECT * FROM candidates WHERE kind = 'channel' AND state = ? ORDER BY id`)
      .all(CandidateState.DigestQueued) as (CandidateRow & { view_score: number | null })[];
    return rows.map((row) => ({ candidate: mapRow(row), viewScore: row.view_score ?? 0 }));
  }

  /** Queued posts published more than `maxAgeMs` before `now` → skipped; returns how many. */
  expire(now: number, maxAgeMs: number): number {
    return this.db
      .prepare(
        `UPDATE candidates SET state = ?, updated_at = datetime('now')
          WHERE kind = 'channel' AND state = ? AND (published_at IS NULL OR published_at < ?)`,
      )
      .run(CandidateState.Skipped, CandidateState.DigestQueued, now - maxAgeMs).changes;
  }

  /** digest_queued → skipped with a reason; a row claimed or published meanwhile stays as it is. */
  skipQueued(id: number, reason: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE candidates SET state = ?, error = ?, updated_at = datetime('now')
            WHERE id = ? AND kind = 'channel' AND state = ?`,
        )
        .run(CandidateState.Skipped, reason, id, CandidateState.DigestQueued).changes === 1
    );
  }

  /**
   * digest_queued → publishing for all the given channel rows or none: if any
   * of them is not queued (a concurrent publisher holds it, or it expired),
   * nothing changes and 0 is returned. Otherwise returns ids.length.
   */
  claim(ids: number[]): number {
    if (ids.length === 0) return 0;
    const claimAll = this.db.transaction((): number => {
      const { n } = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM candidates
            WHERE kind = 'channel' AND state = ? AND id IN (${placeholders(ids)})`,
        )
        .get(CandidateState.DigestQueued, ...ids) as { n: number };
      if (n !== ids.length) return 0;
      this.db
        .prepare(
          `UPDATE candidates SET state = ?, updated_at = datetime('now')
            WHERE kind = 'channel' AND state = ? AND id IN (${placeholders(ids)})`,
        )
        .run(CandidateState.Publishing, CandidateState.DigestQueued, ...ids);
      return ids.length;
    });
    return claimAll();
  }

  /** publishing → digest_queued after a send that surely did not post (4xx, 429, 403). */
  requeue(ids: number[]): void {
    if (ids.length === 0) return;
    this.db
      .prepare(
        `UPDATE candidates SET state = ?, updated_at = datetime('now')
          WHERE kind = 'channel' AND state = ? AND id IN (${placeholders(ids)})`,
      )
      .run(CandidateState.DigestQueued, CandidateState.Publishing, ...ids);
  }

  lastSlot(): string | null {
    return getRawSetting(this.db, LAST_SLOT_KEY);
  }

  setLastSlot(slot: string): void {
    setRawSetting(this.db, LAST_SLOT_KEY, slot);
  }
}
