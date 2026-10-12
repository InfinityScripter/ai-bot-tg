import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";

import { MEMORY_SCHEMA } from "./schema.js";
import { recordMessage } from "./observe.js";

import type { Side } from "../debate/types.js";
import type { MemoryStatus, MemoryMessage } from "./types.js";

export interface StoredMessage {
  sequence: number;
  message: MemoryMessage;
}

export interface SourceRef {
  messageId: number;
  sequence: number;
}

export interface MemoryState {
  cursor: number;
  epoch: number;
  last_error: string | null;
}

/** Internal SQLite facade. No bot, model, or global profile state lives here. */
export class MemoryRepository {
  readonly db: Database.Database;

  constructor(
    path: string,
    readonly chatId: number,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
      this.db.exec(MEMORY_SCHEMA);
      this.db.prepare("INSERT OR IGNORE INTO chat_memory_state (chat_id) VALUES (?)").run(chatId);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  state(): MemoryState {
    return this.db
      .prepare("SELECT cursor, epoch, last_error FROM chat_memory_state WHERE chat_id = ?")
      .get(this.chatId) as MemoryState;
  }

  observe(message: MemoryMessage): boolean {
    return recordMessage(this.db, message);
  }

  message(messageId: number): StoredMessage | null {
    const row = this.db
      .prepare(
        "SELECT sequence, data FROM chat_memory_messages WHERE chat_id = ? AND message_id = ?",
      )
      .get(this.chatId, messageId) as { sequence: number; data: string } | undefined;
    return row ? { sequence: row.sequence, message: JSON.parse(row.data) as MemoryMessage } : null;
  }

  hasReply(side: Side, rootMessageId: number): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM chat_memory_messages WHERE chat_id = ?
         AND json_extract(data, '$.side') = ? AND json_extract(data, '$.rootMessageId') = ? LIMIT 1`,
      )
      .get(this.chatId, side, rootMessageId);
  }

  batch(limit: number): StoredMessage[] {
    return this.rows(
      `SELECT sequence, data FROM chat_memory_messages
       WHERE chat_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
      this.chatId,
      this.state().cursor,
      limit,
    );
  }

  recent(limit: number): StoredMessage[] {
    return this.rows(
      "SELECT sequence, data FROM chat_memory_messages WHERE chat_id = ? ORDER BY sequence DESC LIMIT ?",
      this.chatId,
      limit,
    );
  }

  search(query: string, limit: number): StoredMessage[] {
    if (!query) return [];
    return this.rows(
      `SELECT m.sequence, m.data FROM chat_memory_search s JOIN chat_memory_messages m
       ON m.chat_id = s.chat_id AND m.message_id = s.item_id
       WHERE chat_memory_search MATCH ? AND s.kind = 'message' AND s.chat_id = ?
       ORDER BY bm25(chat_memory_search) LIMIT ?`,
      query,
      this.chatId,
      limit,
    );
  }

  setError(error: string | null): void {
    this.db
      .prepare("UPDATE chat_memory_state SET last_error = ? WHERE chat_id = ?")
      .run(error, this.chatId);
  }

  status(): MemoryStatus {
    const count = (table: string) =>
      (
        this.db
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE chat_id = ?`)
          .get(this.chatId) as { n: number }
      ).n;
    const pending = this.db
      .prepare("SELECT count(*) AS n FROM chat_memory_messages WHERE chat_id = ? AND sequence > ?")
      .get(this.chatId, this.state().cursor) as { n: number };
    return {
      epoch: this.state().epoch,
      messages: count("chat_memory_messages"),
      notes: count("chat_memory_notes"),
      opinions: count("chat_memory_opinions"),
      pending: pending.n,
      lastError: this.state().last_error,
    };
  }

  clear(): void {
    this.db.transaction(() => {
      // Only IDs/versions survive deletion, so lagging delivery cannot restore erased text.
      this.db
        .prepare(
          `INSERT INTO chat_memory_tombstones (chat_id, message_id, version)
         SELECT chat_id, message_id, coalesce(json_extract(data, '$.editedAt'), json_extract(data, '$.at'))
         FROM chat_memory_messages WHERE chat_id = ?
         ON CONFLICT(chat_id, message_id) DO UPDATE SET version = max(version, excluded.version)`,
        )
        .run(this.chatId);
      for (const table of [
        "chat_memory_messages",
        "chat_memory_revisions",
        "chat_memory_notes",
        "chat_memory_opinions",
        "chat_memory_search",
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).run(this.chatId);
      }
      this.db
        .prepare(
          "UPDATE chat_memory_state SET epoch = epoch + 1, next_sequence = 0, cursor = 0, last_error = NULL WHERE chat_id = ?",
        )
        .run(this.chatId);
    })();
  }

  close(): void {
    this.db.close();
  }

  private rows(sql: string, ...args: (string | number)[]): StoredMessage[] {
    const rows = this.db.prepare(sql).all(...args) as { sequence: number; data: string }[];
    return rows.map((row) => ({
      sequence: row.sequence,
      message: JSON.parse(row.data) as MemoryMessage,
    }));
  }
}
