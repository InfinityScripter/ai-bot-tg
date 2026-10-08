/**
 * Shared types of the avatar module. Pure declarations only.
 */

/** One searchable piece of a blog post. */
export interface MemoryChunk {
  title: string;
  url: string;
  body: string;
}

/** One group message as the avatar remembers it — in RAM only, never on disk. */
export interface ChatLine {
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
