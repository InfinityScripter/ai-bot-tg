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
    snippet       TEXT,
    image_urls    TEXT,
    state         TEXT NOT NULL,
    rewrite_json  TEXT,
    tg_message_id INTEGER,
    blog_post_id  TEXT,
    error         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS seen_keys (
    dedup_key TEXT PRIMARY KEY,
    seen_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/** The single settings row holding the active provider/model override. */
const MODEL_OVERRIDE_KEY = 'model_override';

/** The single settings row holding the runtime mock ("без LLM") override. */
const MOCK_OVERRIDE_KEY = 'mock_override';

/** Runtime override of the rewrite provider/model, stored in `settings`. */
export interface ModelOverride {
  provider: string;
  model: string;
}

/** Runtime override of mock mode, stored in `settings`. */
export interface MockOverride {
  enabled: boolean;
}
// Lightweight additive migrations for pre-existing DBs (ignore if present).
// snippet + image_urls hold the RAW feed item so a rewrite can run later
// (on a /publish-time button tap), not only inline at collection.
const MIGRATIONS = [
  `ALTER TABLE candidates ADD COLUMN image_url TEXT`,
  `ALTER TABLE candidates ADD COLUMN snippet TEXT`,
  `ALTER TABLE candidates ADD COLUMN image_urls TEXT`,
];
// The UNIQUE constraint on dedup_key already creates an index — no separate
// CREATE INDEX needed.

interface CandidateRow {
  id: number;
  dedup_key: string;
  source_url: string;
  source_title: string | null;
  feed_title: string | null;
  image_url: string | null;
  snippet: string | null;
  image_urls: string | null;
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
    snippet: row.snippet,
    imageUrls: row.image_urls,
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
    // busy_timeout: wait (not error) if another connection holds the lock —
    // cheap insurance if a second writer is ever added. synchronous=NORMAL is
    // the WAL-recommended durability/speed trade-off (survives process crash).
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
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
    this.recoverInFlight();
  }

  /**
   * Resets rows stuck in a transient in-flight state back to a retryable one.
   * A crash or deploy (systemd SIGTERM on CI auto-deploy) mid-rewrite/publish
   * leaves a row in 'rewriting'/'publishing' — a state none of the bot's button
   * guards accept, so the card would be permanently dead. On startup we move
   * those back: 'rewriting' → 'collected' (re-offer the 🔄 card), 'publishing'
   * → 'pending_review' (re-offer publish). Idempotent; runs once per process.
   */
  private recoverInFlight(): void {
    // 'rewriting' is safe to retry — no external side effect happened.
    this.db
      .prepare(`UPDATE candidates SET state = 'collected', updated_at = datetime('now') WHERE state = 'rewriting'`)
      .run();
    // 'publishing' MAY have already POSTed to the blog. Do NOT reset to
    // pending_review (that re-offers Publish and can create a duplicate post);
    // move to needs_verification so the owner is warned before re-publishing.
    this.db
      .prepare(
        `UPDATE candidates SET state = 'needs_verification', updated_at = datetime('now') WHERE state = 'publishing'`
      )
      .run();
  }

  /**
   * Inserts a freshly-collected feed item as state 'collected'. Returns the new
   * candidate id, or null if the dedup_key already exists (already seen — skip).
   */
  insertCollected(item: FeedItem): number | null {
    // A pruned-but-seen key lives only in seen_keys; honor it so an old
    // published/skipped article isn't re-collected after its row was deleted.
    const prunedSeen = this.db
      .prepare('SELECT 1 FROM seen_keys WHERE dedup_key = ?')
      .get(item.dedupKey);
    if (prunedSeen) return null;

    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO candidates
           (dedup_key, source_url, source_title, feed_title, image_url, snippet, image_urls, state)
         VALUES (@dedupKey, @url, @title, @feedTitle, @imageUrl, @snippet, @imageUrls, 'collected')`
      )
      .run({
        dedupKey: item.dedupKey,
        url: item.url,
        title: item.title,
        feedTitle: item.feedTitle,
        imageUrl: item.imageUrl,
        snippet: item.snippet,
        imageUrls: JSON.stringify(item.imageUrls ?? []),
      });
    return info.changes === 1 ? Number(info.lastInsertRowid) : null;
  }

  /**
   * Reconstructs the raw FeedItem from a stored candidate so a rewrite can run
   * later (on a publish-time button tap), not only inline at collection. Best
   * effort: a missing/corrupt image_urls yields [], a null snippet yields ''.
   */
  getFeedItem(candidate: Candidate): FeedItem {
    let imageUrls: string[] = [];
    if (candidate.imageUrls) {
      try {
        const parsed = JSON.parse(candidate.imageUrls) as unknown;
        if (Array.isArray(parsed)) {
          imageUrls = parsed.filter((u): u is string => typeof u === 'string');
        }
      } catch {
        /* corrupt JSON — fall back to [] */
      }
    }
    return {
      dedupKey: candidate.dedupKey,
      url: candidate.sourceUrl,
      title: candidate.sourceTitle ?? '',
      snippet: candidate.snippet ?? '',
      feedTitle: candidate.feedTitle ?? '',
      imageUrl: candidate.imageUrl,
      imageUrls,
      publishedAt: null, // not persisted — only used pre-insert for ordering
    };
  }

  /** Returns all candidates in a given state (e.g. needs_verification on boot). */
  listByState(state: CandidateState): Candidate[] {
    const rows = this.db
      .prepare('SELECT * FROM candidates WHERE state = ? ORDER BY id')
      .all(state) as CandidateRow[];
    return rows.map(mapRow);
  }

  /** True if this dedup key is known — a live candidate or a pruned seen key. */
  isSeen(dedupKey: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM candidates WHERE dedup_key = ?
         UNION ALL SELECT 1 FROM seen_keys WHERE dedup_key = ? LIMIT 1`
      )
      .get(dedupKey, dedupKey);
    return row !== undefined;
  }

  /**
   * Prunes terminal candidates (published/skipped) older than `days`, preserving
   * their dedup_key in seen_keys so they're never re-collected. Bounds the
   * candidates table over a multi-year process. Returns the number pruned.
   */
  pruneOld(days = 90): number {
    const offset = `-${Math.max(1, Math.floor(days))} days`;
    // Resolve the cutoff to a single fixed timestamp string, so the INSERT and
    // DELETE compare against the IDENTICAL boundary — datetime('now') re-evaluated
    // per-statement could otherwise let a row be deleted without its key copied.
    const { cutoff } = this.db.prepare("SELECT datetime('now', ?) AS cutoff").get(offset) as {
      cutoff: string;
    };
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO seen_keys (dedup_key)
             SELECT dedup_key FROM candidates
             WHERE state IN ('published', 'skipped') AND updated_at < ?`
        )
        .run(cutoff);
      const info = this.db
        .prepare(
          `DELETE FROM candidates
             WHERE state IN ('published', 'skipped') AND updated_at < ?`
        )
        .run(cutoff);
      return info.changes;
    });
    return tx() as number;
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
         WHERE id = ? AND state IN ('pending_review', 'needs_verification')`
      )
      .run(id);
    return info.changes === 1;
  }

  /**
   * Atomically claims a candidate for rewriting: transitions a
   * collected/pending_review/rewrite_failed row → 'rewriting' in one UPDATE and
   * reports whether THIS caller won. Mirrors claimForPublishing — a double-tap
   * of 🔄 can't start two concurrent (token-spending) rewrites on one candidate.
   */
  claimForRewriting(id: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE candidates SET state = 'rewriting', error = NULL, updated_at = datetime('now')
         WHERE id = ? AND state IN ('collected', 'pending_review', 'rewrite_failed')`
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

  // --- settings: runtime model override ------------------------------------

  /** Low-level setter for a settings key. Exposed mainly for tests. */
  setRawSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
      .run(key, value);
  }

  /** Low-level getter for a settings key, or null if absent. */
  private getRawSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /**
   * The active provider/model override, or null if none is set. A corrupt row
   * (e.g. hand-edited, or a shape change) returns null rather than throwing, so
   * the rewriter cleanly falls back to the env default.
   */
  getModelOverride(): ModelOverride | null {
    const raw = this.getRawSetting(MODEL_OVERRIDE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<ModelOverride>;
      if (typeof parsed.provider === 'string' && typeof parsed.model === 'string') {
        return { provider: parsed.provider, model: parsed.model };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Sets (upserts) the active provider/model override. */
  setModelOverride(provider: string, model: string): void {
    this.setRawSetting(MODEL_OVERRIDE_KEY, JSON.stringify({ provider, model }));
  }

  /** Clears the override; the rewriter then uses the env default. */
  clearModelOverride(): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(MODEL_OVERRIDE_KEY);
  }

  /**
   * The active mock override, or null if none is set. When set, it is strictly
   * authoritative over the env REWRITE_MOCK (so an admin toggling mock OFF in
   * the panel truly disables it even if REWRITE_MOCK=1). A corrupt row returns
   * null rather than throwing, so resolution cleanly falls back to env.
   */
  getMockOverride(): MockOverride | null {
    const raw = this.getRawSetting(MOCK_OVERRIDE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<MockOverride>;
      if (typeof parsed.enabled === 'boolean') {
        return { enabled: parsed.enabled };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Sets (upserts) the mock override. */
  setMockOverride(enabled: boolean): void {
    this.setRawSetting(MOCK_OVERRIDE_KEY, JSON.stringify({ enabled }));
  }

  /** Clears the mock override; resolution then falls back to env REWRITE_MOCK. */
  clearMockOverride(): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(MOCK_OVERRIDE_KEY);
  }

  close(): void {
    this.db.close();
  }
}
