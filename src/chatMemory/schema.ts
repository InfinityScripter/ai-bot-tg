import { z } from "zod";

const id = z.number().int().safe();
const messageId = id.positive();
const timestamp = id.nonnegative();

export const MessageSchema = z
  .object({
    chatId: id,
    messageId,
    authorId: id,
    authorName: z.string().min(1),
    text: z.string(),
    at: timestamp,
    editedAt: timestamp.optional(),
    replyToMessageId: messageId.optional(),
    rootMessageId: messageId.optional(),
    triggerMessageId: messageId.optional(),
    messageThreadId: messageId.optional(),
    side: z.enum(["hope", "avatar"]).optional(),
    isPost: z.boolean().optional(),
  })
  .strict()
  .refine((m) => m.editedAt === undefined || m.editedAt >= m.at);

/** Separate names allow the shared WAL file to keep existing avatar tables intact. */
export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_memory_state (
  chat_id INTEGER PRIMARY KEY,
  next_sequence INTEGER NOT NULL DEFAULT 0,
  cursor INTEGER NOT NULL DEFAULT 0,
  epoch INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS chat_memory_messages (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS chat_memory_pending ON chat_memory_messages(chat_id, sequence);
CREATE TABLE IF NOT EXISTS chat_memory_tombstones (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE IF NOT EXISTS chat_memory_revisions (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (chat_id, sequence)
);
CREATE TABLE IF NOT EXISTS chat_memory_notes (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  sources TEXT NOT NULL,
  valid INTEGER NOT NULL DEFAULT 1,
  UNIQUE (chat_id, data, sources)
);
CREATE TABLE IF NOT EXISTS chat_memory_opinions (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  side TEXT NOT NULL,
  topic TEXT NOT NULL,
  data TEXT NOT NULL,
  sources TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  valid INTEGER NOT NULL DEFAULT 1,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_memory_positions
  ON chat_memory_opinions(chat_id, side, active, valid, topic);
CREATE VIRTUAL TABLE IF NOT EXISTS chat_memory_search USING fts5(
  kind UNINDEXED, chat_id UNINDEXED, item_id UNINDEXED, text,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;
