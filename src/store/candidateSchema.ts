/**
 * Persistence-layer constants and row mapping for the candidate store: the
 * SQLite schema, the additive migrations, the settings keys and the raw-row →
 * domain `Candidate` mapper. Kept beside CandidateStore.ts so the store class
 * stays focused on behaviour, not DDL.
 */

import { CandidateKind, CandidateState } from "../enums.js";

import type { Candidate } from "../types.js";
import type { CandidateRow } from "./types.js";

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS candidates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_key     TEXT UNIQUE NOT NULL,
    source_url    TEXT NOT NULL,
    source_title  TEXT,
    feed_title    TEXT,
    image_url     TEXT,
    snippet       TEXT,
    image_urls    TEXT,
    kind          TEXT NOT NULL DEFAULT 'news',
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

// Lightweight additive migrations for pre-existing DBs (ignore if present).
// snippet + image_urls hold the RAW feed item so a rewrite can run later
// (on a /publish-time button tap), not only inline at collection.
export const MIGRATIONS = [
  `ALTER TABLE candidates ADD COLUMN image_url TEXT`,
  `ALTER TABLE candidates ADD COLUMN snippet TEXT`,
  `ALTER TABLE candidates ADD COLUMN image_urls TEXT`,
  // 'release' candidates reuse the same table + rewrite_json column, discriminated
  // by kind. NOT NULL DEFAULT 'news' back-fills every existing row in one statement
  // (SQLite-safe on ADD COLUMN); no second migration or column needed.
  `ALTER TABLE candidates ADD COLUMN kind TEXT NOT NULL DEFAULT 'news'`,
];
// The UNIQUE constraint on dedup_key already creates an index — no separate
// CREATE INDEX needed.

/** The single settings row holding the active provider/model override. */
export const MODEL_OVERRIDE_KEY = "model_override";

/** The single settings row holding the runtime mock ("без LLM") override. */
export const MOCK_OVERRIDE_KEY = "mock_override";

/** Narrows a stored `kind` string to the enum; anything unexpected → News. */
function toKind(value: string): CandidateKind {
  return value === CandidateKind.Release ? CandidateKind.Release : CandidateKind.News;
}

export function mapRow(row: CandidateRow): Candidate {
  return {
    id: row.id,
    dedupKey: row.dedup_key,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    feedTitle: row.feed_title,
    imageUrl: row.image_url,
    snippet: row.snippet,
    imageUrls: row.image_urls,
    kind: toKind(row.kind),
    state: row.state as CandidateState,
    rewriteJson: row.rewrite_json,
    tgMessageId: row.tg_message_id,
    blogPostId: row.blog_post_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
