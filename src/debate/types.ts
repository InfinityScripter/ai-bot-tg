/** Hope is the news bot's group voice (the skeptic); the avatar is the owner's bot (the practitioner). */
export type Side = "hope" | "avatar";

/** One debate reply, already sent to the chat. */
export interface DebateLine {
  side: Side;
  text: string;
  messageId: number;
  authorName?: string;
  authorId?: number;
}

export interface DebateContext {
  rootMessageId?: number;
  /** A forum topic, never the thread id of an ordinary linked discussion. */
  messageThreadId?: number;
}

export interface ReplyTarget extends DebateContext {
  messageId?: number;
  authorName?: string;
  chatUsername?: string;
}

export interface Debate extends DebateContext {
  chatId: number;
  /** What started it: the channel post or the person's message. */
  topic: string;
  /** Every reply so far, the opener first. */
  lines: DebateLine[];
}

/** Opens a debate: the first line, already sent, and what it answers. */
export type DebateOpener = (
  chatId: number,
  line: DebateLine,
  topic: string,
  context?: DebateContext,
) => void;

/** One bot's side of a debate. */
export interface Speaker {
  /** The bot is in this chat, switched on and under its limits. */
  canSpeak(chatId: number): Promise<boolean>;
  /** Sends one reply to the last line. Null ends the debate. */
  speak(debate: Debate): Promise<DebateLine | null>;
}
