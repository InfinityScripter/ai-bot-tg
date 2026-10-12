import type { Side } from "../debate/types.js";
import type { SourceRef, StoredMessage, MemoryRepository } from "./repository.js";
import type { Reflection, ReflectionNote, ReflectionOpinion } from "./reflectionSchema.js";

export interface Derived<T> {
  data: T;
  sources: SourceRef[];
}

/** Relevant summaries first, with a few recent items when the topic has not been indexed. */
function readRows<T>(
  repo: MemoryRepository,
  table: string,
  query: string,
  side?: Side,
): Derived<T>[] {
  const kind = side ? "opinion" : "note";
  const condition = side ? "AND d.side = ? AND d.active = 1" : "";
  const args = side ? [repo.chatId, side] : [repo.chatId];
  const sql = `SELECT d.id, d.data, d.sources FROM ${table} d WHERE d.chat_id = ? AND d.valid = 1 ${condition}`;
  const relevant = !query
    ? []
    : repo.db
        .prepare(
          `SELECT d.id, d.data, d.sources FROM chat_memory_search s JOIN ${table} d ON d.id = s.item_id
     WHERE chat_memory_search MATCH ? AND s.kind = ? AND d.chat_id = ? AND d.valid = 1 ${condition}
     ORDER BY bm25(chat_memory_search) LIMIT 4`,
        )
        .all(query, kind, ...args);
  const recent = repo.db.prepare(`${sql} ORDER BY d.id DESC LIMIT ?`).all(...args, side ? 8 : 4);
  const rows = [...relevant, ...recent] as { id: number; data: string; sources: string }[];
  return [...new Map(rows.map((row) => [row.id, row])).values()]
    .slice(0, side ? 8 : 6)
    .map((row) => ({
      data: JSON.parse(row.data) as T,
      sources: JSON.parse(row.sources) as SourceRef[],
    }));
}

export function readNotes(repo: MemoryRepository, query: string): Derived<ReflectionNote>[] {
  return readRows(repo, "chat_memory_notes", query);
}

export function readOpinions(
  repo: MemoryRepository,
  query: string,
  side: Side,
): Derived<ReflectionOpinion>[] {
  return readRows(repo, "chat_memory_opinions", query, side);
}

/** Validate the entire snapshot before any summary or cursor is committed. */
export function saveReflections(
  repo: MemoryRepository,
  epoch: number,
  batch: StoredMessage[],
  sources: StoredMessage[],
  results: Reflection[],
  at: number,
): boolean {
  return repo.db.transaction(() => {
    if (
      repo.state().epoch !== epoch ||
      sources.some((row) => repo.message(row.message.messageId)?.sequence !== row.sequence)
    )
      return false;
    const sourceMap = new Map(sources.map((row) => [row.message.messageId, row.sequence]));
    for (const result of results) {
      for (const note of result.notes) {
        const refs = note.sourceMessageIds.map((messageId) => ({
          messageId,
          sequence: sourceMap.get(messageId)!,
        }));
        const insert = repo.db
          .prepare(
            "INSERT OR IGNORE INTO chat_memory_notes (chat_id, data, sources) VALUES (?, ?, ?)",
          )
          .run(repo.chatId, JSON.stringify(note), JSON.stringify(refs));
        if (insert.changes)
          repo.db
            .prepare(
              "INSERT INTO chat_memory_search (kind, chat_id, item_id, text) VALUES ('note', ?, ?, ?)",
            )
            .run(repo.chatId, insert.lastInsertRowid, note.text);
      }
      for (const opinion of result.opinions) {
        const refs = opinion.sourceMessageIds.map((messageId) => ({
          messageId,
          sequence: sourceMap.get(messageId)!,
        }));
        const data = JSON.stringify(opinion);
        const sourceData = JSON.stringify(refs);
        const topic = opinion.topic.toLowerCase();
        const old = repo.db
          .prepare(
            "SELECT data, sources FROM chat_memory_opinions WHERE chat_id = ? AND side = ? AND topic = ? AND active = 1 AND valid = 1",
          )
          .get(repo.chatId, result.side, topic) as { data: string; sources: string } | undefined;
        if (old?.data === data && old.sources === sourceData) continue;
        repo.db
          .prepare(
            "UPDATE chat_memory_opinions SET active = 0 WHERE chat_id = ? AND side = ? AND topic = ?",
          )
          .run(repo.chatId, result.side, topic);
        const insert = repo.db
          .prepare(
            "INSERT INTO chat_memory_opinions (chat_id, side, topic, data, sources, at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(repo.chatId, result.side, topic, data, sourceData, at);
        repo.db
          .prepare(
            "INSERT INTO chat_memory_search (kind, chat_id, item_id, text) VALUES ('opinion', ?, ?, ?)",
          )
          .run(
            repo.chatId,
            insert.lastInsertRowid,
            `${opinion.topic} ${opinion.stance} ${opinion.reason}`,
          );
      }
    }
    const cursor = batch.at(-1)!.sequence;
    repo.db
      .prepare(
        "UPDATE chat_memory_state SET cursor = max(cursor, ?), last_error = NULL WHERE chat_id = ?",
      )
      .run(cursor, repo.chatId);
    return true;
  })();
}
