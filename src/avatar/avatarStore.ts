import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";

import { CONFIG } from "../config.js";
import { ENABLED_KEY, PROFILE_KEY, AVATAR_SCHEMA } from "./avatarSchema.js";

import type { MemoryChunk, AllowedChat } from "./types.js";

/**
 * The avatar's persistent state: groups the owner allowed, the profile, the
 * on/off switch, per-chat turn counters and the blog index. Group messages are
 * NOT stored here — they live in RAM (chatHistory.ts).
 */
export class AvatarStore {
  private readonly db: Database.Database;

  constructor(path: string = CONFIG.AVATAR_SQLITE_PATH) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(AVATAR_SCHEMA);
  }

  allowChat(chatId: number, title: string): void {
    this.db
      .prepare(
        `INSERT INTO avatar_chats (chat_id, title) VALUES (?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title`,
      )
      .run(chatId, title);
  }

  forgetChat(chatId: number): void {
    this.db.prepare("DELETE FROM avatar_chats WHERE chat_id = ?").run(chatId);
  }

  isAllowed(chatId: number): boolean {
    return (
      this.db.prepare("SELECT 1 FROM avatar_chats WHERE chat_id = ?").get(chatId) !== undefined
    );
  }

  listChats(): AllowedChat[] {
    return this.db
      .prepare("SELECT chat_id AS chatId, title FROM avatar_chats ORDER BY added_at")
      .all() as AllowedChat[];
  }

  getProfile(): string {
    return this.getSetting(PROFILE_KEY) ?? "";
  }

  setProfile(text: string): void {
    this.setSetting(PROFILE_KEY, text);
  }

  /** On unless the owner switched it off with /avatar off. */
  isEnabled(): boolean {
    return this.getSetting(ENABLED_KEY) !== "0";
  }

  setEnabled(enabled: boolean): void {
    this.setSetting(ENABLED_KEY, enabled ? "1" : "0");
  }

  /** Adds one answered turn to the chat's counter for `day` and returns the new total. */
  countCall(chatId: number, day: string): number {
    this.db
      .prepare(
        `INSERT INTO avatar_usage (chat_id, day, calls) VALUES (?, ?, 1)
           ON CONFLICT(chat_id, day) DO UPDATE SET calls = calls + 1`,
      )
      .run(chatId, day);
    return this.callsOn(chatId, day);
  }

  callsOn(chatId: number, day: string): number {
    const row = this.db
      .prepare("SELECT calls FROM avatar_usage WHERE chat_id = ? AND day = ?")
      .get(chatId, day) as { calls: number } | undefined;
    return row?.calls ?? 0;
  }

  /** Swaps the whole blog index in one transaction (the crawl happens before, outside it). */
  replaceChunks(chunks: MemoryChunk[]): void {
    const insert = this.db.prepare("INSERT INTO avatar_chunks (title, url, body) VALUES (?, ?, ?)");
    this.db.transaction(() => {
      this.db.exec("DELETE FROM avatar_chunks");
      for (const c of chunks) insert.run(c.title, c.url, c.body);
    })();
  }

  chunkCount(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM avatar_chunks").get() as { n: number }).n;
  }

  /** Best chunks for an FTS5 MATCH expression (build it with searchQuery.ts); "" finds nothing. */
  search(match: string, limit: number): MemoryChunk[] {
    if (!match) return [];
    return this.db
      .prepare(
        `SELECT title, url, body FROM avatar_chunks WHERE avatar_chunks MATCH ?
           ORDER BY bm25(avatar_chunks) LIMIT ?`,
      )
      .all(match, limit) as MemoryChunk[];
  }

  close(): void {
    this.db.close();
  }

  private getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM avatar_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO avatar_settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }
}
