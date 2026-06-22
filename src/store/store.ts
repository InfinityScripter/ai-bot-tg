import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";

import { CONFIG } from "../config.js";
import * as settings from "./settings.js";
import * as mutations from "./mutations.js";
import { CandidateState } from "../enums.js";
import { SCHEMA, mapRow, MIGRATIONS } from "./schema.js";

import type { FeedItem, Candidate, RewriteResult } from "../types.js";
import type { CandidateRow, MockOverride, ModelOverride } from "./schema.js";

// Re-exported so existing importers can keep importing these settings shapes
// from "./store.js" alongside the CandidateStore that produces them.
export type { MockOverride, ModelOverride } from "./schema.js";

/**
 * The candidate store. One SQLite file doubles as the dedup ledger and the
 * lifecycle store. All methods are synchronous (better-sqlite3), which suits a
 * single-process bot — no async races between the cron run and the bot handler.
 */
export class CandidateStore {
  private readonly db: Database.Database;

  constructor(path: string = CONFIG.SQLITE_PATH) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    // busy_timeout: wait (not error) if another connection holds the lock —
    // cheap insurance if a second writer is ever added. synchronous=NORMAL is
    // the WAL-recommended durability/speed trade-off (survives process crash).
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
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
    mutations.recoverInFlight(this.db);
  }

  /**
   * Inserts a freshly-collected feed item as state 'collected'. Returns the new
   * candidate id, or null if the dedup_key already exists (already seen — skip).
   */
  insertCollected(item: FeedItem): number | null {
    // A pruned-but-seen key lives only in seen_keys; honor it so an old
    // published/skipped article isn't re-collected after its row was deleted.
    const prunedSeen = this.db
      .prepare("SELECT 1 FROM seen_keys WHERE dedup_key = ?")
      .get(item.dedupKey);
    if (prunedSeen) return null;

    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO candidates
           (dedup_key, source_url, source_title, feed_title, image_url, snippet, image_urls, state)
         VALUES (@dedupKey, @url, @title, @feedTitle, @imageUrl, @snippet, @imageUrls, @state)`,
      )
      .run({
        dedupKey: item.dedupKey,
        url: item.url,
        title: item.title,
        feedTitle: item.feedTitle,
        imageUrl: item.imageUrl,
        snippet: item.snippet,
        imageUrls: JSON.stringify(item.imageUrls ?? []),
        state: CandidateState.Collected,
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
          imageUrls = parsed.filter((u): u is string => typeof u === "string");
        }
      } catch {
        /* corrupt JSON — fall back to [] */
      }
    }
    return {
      dedupKey: candidate.dedupKey,
      url: candidate.sourceUrl,
      title: candidate.sourceTitle ?? "",
      snippet: candidate.snippet ?? "",
      feedTitle: candidate.feedTitle ?? "",
      imageUrl: candidate.imageUrl,
      imageUrls,
      publishedAt: null, // not persisted — only used pre-insert for ordering
    };
  }

  /** Returns all candidates in a given state (e.g. needs_verification on boot). */
  listByState(state: CandidateState): Candidate[] {
    const rows = this.db
      .prepare("SELECT * FROM candidates WHERE state = ? ORDER BY id")
      .all(state) as CandidateRow[];
    return rows.map(mapRow);
  }

  /** Candidate count per state (one GROUP BY) — for the /health queue summary. */
  countsByState(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT state, COUNT(*) AS n FROM candidates GROUP BY state")
      .all() as { state: string; n: number }[];
    const out: Record<string, number> = {};
    for (const { state, n } of rows) out[state] = n;
    return out;
  }

  /** True if this dedup key is known — a live candidate or a pruned seen key. */
  isSeen(dedupKey: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM candidates WHERE dedup_key = ?
         UNION ALL SELECT 1 FROM seen_keys WHERE dedup_key = ? LIMIT 1`,
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
             WHERE state IN (?, ?) AND updated_at < ?`,
        )
        .run(CandidateState.Published, CandidateState.Skipped, cutoff);
      const info = this.db
        .prepare(
          `DELETE FROM candidates
             WHERE state IN (?, ?) AND updated_at < ?`,
        )
        .run(CandidateState.Published, CandidateState.Skipped, cutoff);
      return info.changes;
    });
    return tx() as number;
  }

  get(id: number): Candidate | null {
    const row = this.db.prepare("SELECT * FROM candidates WHERE id = ?").get(id) as
      | CandidateRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  /** Atomically claims pending_review/needs_verification → publishing (one winner). */
  claimForPublishing(id: number): boolean {
    return mutations.claimForPublishing(this.db, id);
  }

  /** Atomically claims collected/pending_review/rewrite_failed → rewriting (one winner). */
  claimForRewriting(id: number): boolean {
    return mutations.claimForRewriting(this.db, id);
  }

  /** Sets the state (and optionally an error message) for a candidate. */
  setState(id: number, state: CandidateState, error: string | null = null): void {
    mutations.setState(this.db, id, state, error);
  }

  /** Stores the rewrite result and moves the candidate to 'pending_review'. */
  attachRewrite(id: number, rewrite: RewriteResult): void {
    mutations.attachRewrite(this.db, id, rewrite);
  }

  /** Records the Telegram message id of the approval DM. */
  setTelegramMessage(id: number, messageId: number): void {
    mutations.setTelegramMessage(this.db, id, messageId);
  }

  /** Marks a candidate published and records the blog post id. */
  setPublished(id: number, blogPostId: string): void {
    mutations.setPublished(this.db, id, blogPostId);
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

  // --- settings: runtime model + mock override (delegated to store-settings) -
  // Thin delegations to the free functions in store-settings.ts; the public
  // method set/signatures are unchanged so existing callers keep working.

  /** Low-level setter for a settings key. Exposed mainly for tests. */
  setRawSetting(key: string, value: string): void {
    settings.setRawSetting(this.db, key, value);
  }

  /** The active provider/model override, or null if none is set. */
  getModelOverride(): ModelOverride | null {
    return settings.getModelOverride(this.db);
  }

  /** Sets (upserts) the active provider/model override. */
  setModelOverride(provider: string, model: string): void {
    settings.setModelOverride(this.db, provider, model);
  }

  /** Clears the override; the rewriter then uses the env default. */
  clearModelOverride(): void {
    settings.clearModelOverride(this.db);
  }

  /** The active mock override, or null if none is set. */
  getMockOverride(): MockOverride | null {
    return settings.getMockOverride(this.db);
  }

  /** Sets (upserts) the mock override. */
  setMockOverride(enabled: boolean): void {
    settings.setMockOverride(this.db, enabled);
  }

  /** Clears the mock override; resolution then falls back to env REWRITE_MOCK. */
  clearMockOverride(): void {
    settings.clearMockOverride(this.db);
  }

  close(): void {
    this.db.close();
  }
}
