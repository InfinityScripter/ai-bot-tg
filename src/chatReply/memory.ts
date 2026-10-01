import { ChatTurnSchema } from "../schemas/chatReplySchema.js";

import type { ChatTurn } from "./types.js";
import type { CandidateStore } from "../store/index.js";

/** Turns kept per chat. ~50 short exchanges stay well inside one prompt. */
const KEEP_TURNS = 50;

const memoryKey = (chatId: number): string => `chat_reply_memory:${chatId}`;

/**
 * The responder's memory: the last exchanges of the chat, stored as one JSON
 * row in the settings table (no new DDL). Always loaded whole into the prompt
 * rather than searched — what the bot remembers shapes the reply before it
 * decides anything. A corrupt row reads as empty memory and a malformed turn is
 * dropped, never an error that would silence the bot in that chat for good.
 */
export function loadTurns(store: CandidateStore, chatId: number): ChatTurn[] {
  const raw = store.getRawSetting(memoryKey(chatId));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const turn = ChatTurnSchema.safeParse(item);
      return turn.success ? [turn.data] : [];
    });
  } catch {
    return [];
  }
}

export function appendTurn(store: CandidateStore, chatId: number, turn: ChatTurn): void {
  const turns = [...loadTurns(store, chatId), turn].slice(-KEEP_TURNS);
  store.setRawSetting(memoryKey(chatId), JSON.stringify(turns));
}
