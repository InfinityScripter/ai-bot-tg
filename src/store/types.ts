/**
 * Shared types of the store module: the raw SQLite row and the runtime
 * override shapes persisted in the `settings` table. Pure declarations only —
 * DDL/keys live in candidateSchema.ts (mirrors health/types.ts).
 */

/** Runtime override of the rewrite provider/model, stored in `settings`. */
export interface ModelOverride {
  provider: string;
  model: string;
}

/** Runtime override of mock mode, stored in `settings`. */
export interface MockOverride {
  enabled: boolean;
}

/** A raw row of the `candidates` table (snake_case, as SQLite returns it). */
export interface CandidateRow {
  id: number;
  dedup_key: string;
  source_url: string;
  source_title: string | null;
  feed_title: string | null;
  image_url: string | null;
  snippet: string | null;
  image_urls: string | null;
  kind: string;
  state: string;
  rewrite_json: string | null;
  tg_message_id: number | null;
  blog_post_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
