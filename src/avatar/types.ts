/**
 * Shared types of the avatar module. Pure declarations only.
 */
import type { DebateContext } from "../debate/types.js";
import type { ChatReply } from "../schemas/chatReplySchema.js";

/** One model turn: (system, user) → a reply, or null when the model failed. */
export type GenerateFn = (system: string, user: string) => Promise<ChatReply | null>;

/** A group text message, as the avatar takes it in. */
export interface IncomingText extends DebateContext {
  messageId: number;
  triggerMessageId: number;
  authorId: number;
  author: string;
  chatUsername?: string;
  text: string;
  /** Telegram's date, unix seconds. */
  date: number;
  /** Mentions the bot or replies to it. */
  direct: boolean;
}

/** One searchable piece of a blog post. */
export interface MemoryChunk {
  title: string;
  url: string;
  body: string;
}

/** One group message as the avatar remembers it — in RAM only, never on disk. */
export interface ChatLine extends DebateContext {
  messageId: number;
  authorId: number;
  author: string;
  text: string;
  /** Unix time in ms. */
  at: number;
  fromAvatar: boolean;
}

/** A group the owner added the bot to. */
export interface AllowedChat {
  chatId: number;
  title: string;
}
