import type { Side } from "../debate/types.js";
import type { MemoryChunk } from "../avatar/types.js";

export interface MemoryMessage {
  chatId: number;
  messageId: number;
  authorId: number;
  authorName: string;
  text: string;
  at: number;
  editedAt?: number;
  replyToMessageId?: number;
  rootMessageId?: number;
  triggerMessageId?: number;
  messageThreadId?: number;
  side?: Side;
  isPost?: boolean;
}

export interface MemoryStatus {
  epoch: number;
  messages: number;
  notes: number;
  opinions: number;
  pending: number;
  lastError: string | null;
}

export interface ConversationMemory {
  observe(message: MemoryMessage): void;
  message(chatId: number, messageId: number): MemoryMessage | null;
  hasReply(chatId: number, side: Side, rootMessageId: number): boolean;
  context(chatId: number, side: Side, query: string): string;
  reflect(chatId: number): Promise<void>;
  clear(chatId: number): void;
  status(chatId: number): MemoryStatus;
  drain(): Promise<void>;
  close(): void;
}

export interface MemoryDeps {
  path: string;
  chatId: number;
  materials?: (query: string, limit: number) => MemoryChunk[];
  persona?: (side: Side) => string;
  generate?: (prompt: string) => Promise<string | null>;
  now?: () => number;
  debounceMs?: number;
}
