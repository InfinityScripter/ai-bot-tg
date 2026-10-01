/** One exchange the group responder took part in, kept as its memory. */
export interface ChatTurn {
  /** Unix ms. */
  at: number;
  userId: number;
  name: string;
  text: string;
  /** What the bot said; empty when it chose silence. */
  reply: string;
}

/** A group message the responder decided to answer, as the prompt sees it. */
export interface IncomingMessage {
  chatId: number;
  messageId: number;
  userId: number;
  name: string;
  /** Message text with the bot's @mention removed. */
  text: string;
  /** Text of the bot's own message this one replies to, if any. */
  repliedToBot: string | null;
  /** Text of the channel post this one replies to (its copy in the group), if any. */
  post: string | null;
}
