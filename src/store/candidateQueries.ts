import type Database from "better-sqlite3";

import { CandidateState } from "../enums.js";
import { mapRow } from "./candidateSchema.js";

import type { Candidate } from "../types.js";
import type { CandidateRow } from "./types.js";

function list(db: Database.Database, sql: string, ...states: CandidateState[]): Candidate[] {
  return (db.prepare(sql).all(...states) as CandidateRow[]).map(mapRow);
}

export function listByState(db: Database.Database, state: CandidateState): Candidate[] {
  return list(db, "SELECT * FROM candidates WHERE state = ? ORDER BY id", state);
}

export function listRecoveredAutomatic(db: Database.Database): Candidate[] {
  return list(
    db,
    "SELECT * FROM candidates WHERE state = ? AND auto_publish = 1 ORDER BY id",
    CandidateState.Collected,
  );
}

/** The RSS daily-digest queue, newest first (channel posts wait for their own issue). */
export function listDigestQueue(db: Database.Database): Candidate[] {
  return list(
    db,
    "SELECT * FROM candidates WHERE state = ? AND kind != 'channel' ORDER BY id DESC",
    CandidateState.DigestQueued,
  );
}

export function listAutomaticFailures(db: Database.Database): Candidate[] {
  return list(
    db,
    `SELECT * FROM candidates
      WHERE auto_publish = 1 AND failure_notice_pending = 1 AND state IN (?, ?) ORDER BY id`,
    CandidateState.RewriteFailed,
    CandidateState.PendingReview,
  );
}

/** Release candidates the bot published within the last `days` days. */
export function listPublishedReleases(db: Database.Database, days: number): Candidate[] {
  return (
    db
      .prepare(
        `SELECT * FROM candidates
          WHERE kind = 'release' AND state = ? AND updated_at >= datetime('now', ?)`,
      )
      .all(CandidateState.Published, `-${days} days`) as CandidateRow[]
  ).map(mapRow);
}

/** True when a published candidate's source_url is this URL (trailing slash ignored). */
export function isPublishedUrl(db: Database.Database, url: string): boolean {
  const bare = url.trim().replace(/\/+$/, "");
  const row = db
    .prepare(
      `SELECT 1 FROM candidates WHERE state = ? AND (source_url = ? OR source_url = ?) LIMIT 1`,
    )
    .get(CandidateState.Published, bare, `${bare}/`);
  return row !== undefined;
}

/** True if this key was recorded in seen_keys within the last `days` days. */
export function isSeenSince(db: Database.Database, key: string, days: number): boolean {
  const row = db
    .prepare("SELECT 1 FROM seen_keys WHERE dedup_key = ? AND seen_at >= datetime('now', ?)")
    .get(key, `-${days} days`);
  return row !== undefined;
}
