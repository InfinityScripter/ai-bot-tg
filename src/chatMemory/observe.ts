import type Database from "better-sqlite3";

import { MessageSchema } from "./schema.js";

import type { MemoryMessage } from "./types.js";

/** Atomic deduplication happens before the background model can see a revision. */
export function recordMessage(db: Database.Database, message: MemoryMessage): boolean {
  const parsed = MessageSchema.safeParse(message);
  if (!parsed.success) throw new Error("Некорректное сообщение памяти.");
  const value = parsed.data;
  return db.transaction(() => {
    const tombstone = db
      .prepare("SELECT version FROM chat_memory_tombstones WHERE chat_id = ? AND message_id = ?")
      .get(value.chatId, value.messageId) as { version: number } | undefined;
    if (tombstone && (value.editedAt === undefined || value.editedAt <= tombstone.version))
      return false;
    const previous = db
      .prepare("SELECT data FROM chat_memory_messages WHERE chat_id = ? AND message_id = ?")
      .get(value.chatId, value.messageId) as { data: string } | undefined;
    if (previous) {
      const old = JSON.parse(previous.data) as MemoryMessage;
      if (value.editedAt === undefined || value.editedAt <= (old.editedAt ?? old.at)) return false;
    }
    db.prepare(
      "UPDATE chat_memory_state SET next_sequence = next_sequence + 1 WHERE chat_id = ?",
    ).run(value.chatId);
    const { sequence } = db
      .prepare("SELECT next_sequence AS sequence FROM chat_memory_state WHERE chat_id = ?")
      .get(value.chatId) as { sequence: number };
    const data = JSON.stringify(value);
    db.prepare(
      `INSERT INTO chat_memory_messages (chat_id, message_id, sequence, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id, message_id) DO UPDATE SET sequence = excluded.sequence, data = excluded.data`,
    ).run(value.chatId, value.messageId, sequence, data);
    db.prepare(
      "INSERT INTO chat_memory_revisions (chat_id, message_id, sequence, data) VALUES (?, ?, ?, ?)",
    ).run(value.chatId, value.messageId, sequence, data);
    db.prepare(
      "DELETE FROM chat_memory_search WHERE kind = 'message' AND chat_id = ? AND item_id = ?",
    ).run(value.chatId, value.messageId);
    db.prepare(
      "INSERT INTO chat_memory_search (kind, chat_id, item_id, text) VALUES ('message', ?, ?, ?)",
    ).run(value.chatId, value.messageId, value.text);
    // Source revisions remain archived, but corrected claims stop entering active context.
    for (const table of ["chat_memory_notes", "chat_memory_opinions"]) {
      db.prepare(
        `UPDATE ${table} SET valid = 0 WHERE chat_id = ? AND EXISTS (
           SELECT 1 FROM json_each(sources) WHERE json_extract(value, '$.messageId') = ?
         )`,
      ).run(value.chatId, value.messageId);
    }
    return true;
  })();
}
