import type { ConversationMemory } from "./types.js";

/** Optional process wiring; older callers may keep their existing constructors. */
export interface MemoryWiring {
  memory?: ConversationMemory;
  refreshMaterials?: () => void;
  memoryError?: () => string | null;
  reportReplyError?: () => void;
}
