import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

import Database from 'better-sqlite3';

import { CONFIG } from './config.js';
import type { Candidate, CandidateState, FeedItem, RewriteResult } from './types.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS candidates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_key     TEXT UNIQUE NOT NULL,
    source_url    TEXT NOT NULL,
    source_title  TEXT,
    feed_title    TEXT,
    image_url     TEXT,
    state         TEXT NOT NULL,
    rewrite_json  TEXT,
    tg_message_id INTEGER,
    blog_post_id  TEXT,
    error         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;
// Lightweight migration: add image_url to pre-existing DBs (ignore if present).
const MIGRATIONS = [`ALTER TABLE candidates ADD COLUMN image_url TEXT`];
// The UNIQUE constraint on dedup_key already creates an index — no separate
// CREATE INDEX needed.

interface CandidateRow {
  id: number;
  dedup_key: string;
  source_url: string;
  source_title: string | null;
  feed_title: string | null;
  image_url: string | null;
  state: string;
  rewrite_json: string | null;
  tg_message_id: number | null;
  blog_post_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: CandidateRow): Candidate {
  return {
    id: row.id,
    dedupKey: row.dedup_key,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    feedTitle: row.feed_title,
    imageUrl: row.image_url,
    state: row.state as CandidateState,
    rewriteJson: row.rewrite_json,
    tgMessageId: row.tg_message_id,
    blogPostId: row.blog_post_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The candidate store. One SQLite file doubles as the dedup ledger and the
 * lifecycle store. All methods are synchronous (better-sqlite3), which suits a
 * single-process bot — no async races between the cron run and the bot handler.
 */
export class CandidateStore {
  private readonly db: Database.Database;

  constructor(path: string = CONFIG.SQLITE_PATH) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    // Apply additive migrations; ALTER ADD COLUMN throws if it already exists,
    // which is the "already migrated" case — safe to ignore.
    for (const sql of MIGRATIONS) {
      try {
        this.db.exec(sql);
      } catch {
        /* column already present */
      }
    }
  }

  /**
   * Inserts a freshly-collected feed item as state 'collected'. Returns the new
   * candidate id, or null if the dedup_key already exists (already seen — skip).
   */
  insertCollected(item: FeedItem): number | null {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO candidates (dedup_key, source_url, source_title, feed_title, image_url, state)
         VALUES (@dedupKey, @url, @title, @feedTitle, @imageUrl, 'collected')`
      )
      .run({
        dedupKey: item.dedupKey,
        url: item.url,
        title: item.title,
        feedTitle: item.feedTitle,
        imageUrl: item.imageUrl,
      });
    return info.changes === 1 ? Number(info.lastInsertRowid) : null;
  }

  /** True if a candidate with this dedup key already exists. */
  isSeen(dedupKey: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM candidates WHERE dedup_key = ?').get(dedupKey);
    return row !== undefined;
  }

  get(id: number): Candidate | null {
    const row = this.db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as
      | CandidateRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * Atomically claims a candidate for publishing: transitions
   * pending_review → publishing in a single UPDATE and reports whether THIS
   * caller won. Two concurrent Publish taps both call this; exactly one gets
   * `true` (changes === 1), the other gets `false` — preventing a double-post.
   */
  claimForPublishing(id: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE candidates SET state = 'publishing', updated_at = datetime('now')
         WHERE id = ? AND state = 'pending_review'`
      )
      .run(id);
    return info.changes === 1;
  }

  /** Sets the state (and optionally an error message) for a candidate. */
  setState(id: number, state: CandidateState, error: string | null = null): void {
    this.db
      .prepare(`UPDATE candidates SET state = ?, error = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(state, error, id);
  }

  /** Stores the rewrite result and moves the candidate to 'pending_review'. */
  attachRewrite(id: number, rewrite: RewriteResult): void {
    this.db
      .prepare(
        `UPDATE candidates
         SET rewrite_json = ?, state = 'pending_review', error = NULL, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(JSON.stringify(rewrite), id);
  }

  /** Records the Telegram message id of the approval DM. */
  setTelegramMessage(id: number, messageId: number): void {
    this.db
      .prepare(`UPDATE candidates SET tg_message_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(messageId, id);
  }

  /** Marks a candidate published and records the blog post id. */
  setPublished(id: number, blogPostId: string): void {
    this.db
      .prepare(
        `UPDATE candidates
         SET state = 'published', blog_post_id = ?, error = NULL, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(blogPostId, id);
  }

  /** Parses and returns the stored rewrite for a candidate, or null. */
  getRewrite(candidate: Candidate): RewriteResult | null {
    if (!candidate.rewriteJson) return null;
    try {
      return JSON.parse(candidate.rewriteJson) as RewriteResult;
    } catch {
      return null;
    }
  }

  close(): void {
    this.db.close();
  }
}
