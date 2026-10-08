/**
 * DDL of the avatar's SQLite file. The blog index is an FTS5 table:
 * better-sqlite3 bundles SQLite with FTS5, so keyword search over the posts
 * needs no embeddings API and no new dependency.
 */
export const AVATAR_SCHEMA = `
CREATE TABLE IF NOT EXISTS avatar_chats (
  chat_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS avatar_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS avatar_usage (
  chat_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, day)
);
CREATE VIRTUAL TABLE IF NOT EXISTS avatar_chunks USING fts5(
  title,
  url UNINDEXED,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

export const PROFILE_KEY = "profile";
export const ENABLED_KEY = "enabled";
