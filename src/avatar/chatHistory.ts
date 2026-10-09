import type { ChatLine } from "./types.js";

/** Hope's lines in the history: Telegram never gives this bot her user id. */
export const HOPE_AUTHOR_ID = 0;

/** Lines kept per chat: enough context for a reply, small enough for one prompt. */
const MAX_LINES = 40;

/** Moments the reply gate needs: the avatar spoke, the owner spoke, an unasked turn ran. */
export type ChatStamp = "avatar" | "owner" | "unasked";

/**
 * Recent group messages, in RAM only. A restart forgets them by design: the
 * avatar keeps no disk archive of other people's chats. The gate's moments are
 * kept apart from the lines, so 40 busy messages cannot push them out.
 */
export class ChatHistory {
  private readonly chats = new Map<number, ChatLine[]>();

  private readonly stamps = new Map<number, Partial<Record<ChatStamp, number>>>();

  push(chatId: number, line: ChatLine): void {
    const lines = [...this.recent(chatId), line];
    this.chats.set(chatId, lines.slice(-MAX_LINES));
  }

  recent(chatId: number): ChatLine[] {
    return this.chats.get(chatId) ?? [];
  }

  stamp(chatId: number, kind: ChatStamp, at: number): void {
    this.stamps.set(chatId, { ...this.stamps.get(chatId), [kind]: at });
  }

  /** When `kind` last happened in the chat (ms), or null. */
  lastAt(chatId: number, kind: ChatStamp): number | null {
    return this.stamps.get(chatId)?.[kind] ?? null;
  }

  forget(chatId: number): void {
    this.chats.delete(chatId);
    this.stamps.delete(chatId);
  }
}
