import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";

import { CONFIG } from "../config.js";
import { CandidateState } from "../enums.js";
import * as settings from "./storeSettings.js";
import * as queries from "./candidateQueries.js";
import * as mutations from "./candidateMutations.js";
import { parseRetell, parseRewrite, parseReleaseBundle } from "./parseExtraction.js";
import { SCHEMA, mapRow, MIGRATIONS, DIGEST_LAST_DATE_KEY } from "./candidateSchema.js";

import type { CandidateRow, MockOverride, ModelOverride } from "./types.js";
import type { FeedItem, Candidate, ChannelRetell, RewriteResult, ReleaseBundle } from "../types.js";

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
      } catch (err) {
        if (err instanceof Error && /duplicate column name/i.test(err.message)) continue;
        throw err;
      }
    }
    // Recover rows stuck in a transient in-flight state from a crash/deploy
    // (systemd SIGTERM on CI auto-deploy) mid-rewrite/publish: 'rewriting' →
    // 'collected' (re-offer the 🔄 card), 'publishing' → 'needs_verification'
    // (POST may have reached the blog — warn before re-publish). Idempotent;
    // runs once per process, on construction.
    mutations.recoverInFlight(this.db);
  }

  /**
   * Inserts a freshly-collected feed item as state 'collected'. Returns the new
   * candidate id, or null if the dedup_key already exists (already seen — skip).
   */
  insertCollected(item: FeedItem, autoPublish = false): number | null {
    return mutations.insertCollected(this.db, item, autoPublish);
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
      kind: candidate.kind, // carry the kind so a re-extract stays on the right path
    };
  }

  /** Returns all candidates in a given state (e.g. needs_verification on boot). */
  listByState(state: CandidateState): Candidate[] {
    return queries.listByState(this.db, state);
  }

  /** Automatic candidates recovered from a crash before their publish request. */
  listRecoveredAutomatic(): Candidate[] {
    return queries.listRecoveredAutomatic(this.db);
  }

  /** Automatic failures whose Telegram card has not reached the owner yet. */
  listAutomaticFailures(): Candidate[] {
    return queries.listAutomaticFailures(this.db);
  }

  /** Release candidates the bot published within the last `days` days. */
  listPublishedReleases(days: number): Candidate[] {
    return queries.listPublishedReleases(this.db, days);
  }

  /** Channel retellings published within the last `hours`. */
  countPublishedChannelPosts(hours: number): number {
    return queries.countPublishedChannelPosts(this.db, hours);
  }

  /**
   * True when a published candidate's source_url is this URL (trailing slash
   * ignored) — i.e. a blog-published article. A channel retelling's source_url is
   * its t.me permalink, so its outbound links never match here (see markSeenKeys).
   */
  isPublishedUrl(url: string): boolean {
    return queries.isPublishedUrl(this.db, url);
  }

  /** Turns a duplicate release back into news: digest queue or skipped (see mutation). */
  divertReleaseToNews(
    id: number,
    state: CandidateState.DigestQueued | CandidateState.Skipped,
  ): void {
    mutations.divertReleaseToNews(this.db, id, state);
  }

  /** Marks whether an automatic failure card still has to reach the owner. */
  setFailureNoticePending(id: number, pending: boolean): void {
    mutations.setFailureNoticePending(this.db, id, pending);
  }

  // --- daily digest queue (DIGEST_POSTS=on) --------------------------------

  /** Parks a collected news candidate in the digest queue (see mutation doc). */
  queueForDigest(id: number): boolean {
    return mutations.queueForDigest(this.db, id);
  }

  /** The digest queue, newest first. */
  listDigestQueue(): Candidate[] {
    return queries.listDigestQueue(this.db);
  }

  /** Expires queue rows older than `hours` to 'skipped'; returns the count. */
  expireDigestQueue(hours: number): number {
    return mutations.expireDigestQueue(this.db, hours);
  }

  /** Atomically claims a digest batch (digest_queued → publishing); returns the claimed count. */
  claimDigestBatch(ids: number[]): number {
    return mutations.claimDigestBatch(this.db, ids);
  }

  /** Returns a claimed batch to the queue after a CLEAR (4xx) publish failure. */
  requeueDigestBatch(ids: number[]): void {
    mutations.requeueDigestBatch(this.db, ids);
  }

  /** The YYYY-MM-DD of the last published daily digest, or null. */
  getDigestLastDate(): string | null {
    return settings.getRawSetting(this.db, DIGEST_LAST_DATE_KEY);
  }

  /** Records the day (YYYY-MM-DD in CRON_TZ) a daily digest was published. */
  setDigestLastDate(date: string): void {
    settings.setRawSetting(this.db, DIGEST_LAST_DATE_KEY, date);
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
   * Records extra dedup keys (e.g. a retold post's `link:` keys); isSeen honours
   * them. Marking an existing key again refreshes its seen_at for isSeenSince.
   */
  markSeenKeys(keys: string[]): void {
    mutations.markSeenKeys(this.db, keys);
  }

  /** True if this key was recorded in seen_keys within the last `days` days. */
  isSeenSince(key: string, days: number): boolean {
    return queries.isSeenSince(this.db, key, days);
  }

  /**
   * Prunes terminal candidates (published/skipped) older than `days`, preserving
   * their dedup_key in seen_keys so they're never re-collected. Bounds the
   * candidates table over a multi-year process. Returns the number pruned.
   */
  pruneOld(days = 90): number {
    return mutations.pruneOld(this.db, days);
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

  /**
   * Stores a release bundle (post + changelog card) and moves the candidate to
   * 'pending_review'. The JSON shares the rewrite_json column (discriminated by
   * `kind`), so the claim/publish lifecycle stays common with the news path.
   */
  attachRelease(id: number, bundle: ReleaseBundle): void {
    mutations.attachExtraction(this.db, id, bundle);
  }

  /** Stores a channel retelling and moves the candidate to 'pending_review'. */
  attachRetell(id: number, retell: ChannelRetell): void {
    mutations.attachExtraction(this.db, id, retell);
  }

  /** Clears the auto_publish flag (1 → 0) so a diverted item leaves the automatic lane. */
  clearAutoPublish(id: number): void {
    mutations.clearAutoPublish(this.db, id);
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
    return parseRewrite(candidate.rewriteJson);
  }

  /** The stored release bundle of a kind='release' candidate, or null (see parseReleaseBundle). */
  getRelease(candidate: Candidate): ReleaseBundle | null {
    return parseReleaseBundle(candidate.rewriteJson);
  }

  /** The stored retelling of a kind='channel' candidate, or null. */
  getRetell(candidate: Candidate): ChannelRetell | null {
    return parseRetell(candidate.rewriteJson);
  }

  // --- settings: runtime model + mock override (delegated to storeSettings) -
  // Thin delegations to the free functions in storeSettings.ts; the public
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
