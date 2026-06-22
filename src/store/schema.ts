/**
 * Persistence-layer constants and row mapping for the candidate store: the
 * SQLite schema, the additive migrations, the settings keys, the raw row shape
 * and the row → domain `Candidate` mapper. Kept beside store.ts so the store
 * class stays focused on behaviour, not DDL.
 */

import { CandidateState } from "../enums.js";

import type { Candidate } from "../types.js";

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
];
// The UNIQUE constraint on dedup_key already creates an index — no separate
// CREATE INDEX needed.

/** The single settings row holding the active provider/model override. */
export const MODEL_OVERRIDE_KEY = "model_override";

/** The single settings row holding the runtime mock ("без LLM") override. */
export const MOCK_OVERRIDE_KEY = "mock_override";

/** Runtime override of the rewrite provider/model, stored in `settings`. */
export interface ModelOverride {
  provider: string;
  model: string;
}

/** Runtime override of mock mode, stored in `settings`. */
export interface MockOverride {
  enabled: boolean;
}

export interface CandidateRow {
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
    state: row.state as CandidateState,
    rewriteJson: row.rewrite_json,
    tgMessageId: row.tg_message_id,
    blogPostId: row.blog_post_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
