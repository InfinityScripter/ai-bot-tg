import type Database from "better-sqlite3";

import type { Side } from "../debate/types.js";

/** Message allowances survive memory clears and restarts in the shared news SQLite file. */
export class ReplyAllowance {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Re-delivery of an older source must not revive its automatic continuation. */
  activate(chatId: number, triggerMessageId: number): void {
    this.db
      .prepare(
        `INSERT INTO bot_reply_triggers (chat_id, trigger_message_id) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET trigger_message_id = excluded.trigger_message_id
         WHERE excluded.trigger_message_id > bot_reply_triggers.trigger_message_id`,
      )
      .run(chatId, triggerMessageId);
  }

  isCurrent(chatId: number, triggerMessageId: number): boolean {
    const latest = this.db
      .prepare("SELECT trigger_message_id FROM bot_reply_triggers WHERE chat_id = ?")
      .get(chatId) as { trigger_message_id: number } | undefined;
    return latest === undefined || latest.trigger_message_id <= triggerMessageId;
  }

  /** One atomic insert wins across both bots, both routes and SQLite connections. */
  claim(chatId: number, triggerMessageId: number, side: Side): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO bot_reply_claims (chat_id, trigger_message_id, side)
           VALUES (?, ?, ?)`,
        )
        .run(chatId, triggerMessageId, side).changes === 1
    );
  }

  /** Only the holder may release, and only before any Telegram send attempt. */
  release(chatId: number, triggerMessageId: number, side: Side): void {
    this.db
      .prepare(
        "DELETE FROM bot_reply_claims WHERE chat_id = ? AND trigger_message_id = ? AND side = ?",
      )
      .run(chatId, triggerMessageId, side);
  }
}
