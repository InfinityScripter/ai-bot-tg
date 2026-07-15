import type { Server } from "node:http";

import type { Candidate } from "../types.js";
import type { pingModel } from "../llm/index.js";
import type { CandidateStore } from "../store/index.js";
import type { probeAllModels } from "../health/index.js";

/**
 * Shared types of the server module (collection runner, scheduler, control
 * server). Pure declarations only (mirrors health/types.ts).
 */

/** Summary of one collection run, returned for logging/visibility. */
export interface RunSummary {
  fetched: number;
  /** Items remaining after the keyword filter (before dedup/cap). */
  afterFilter: number;
  /**
   * New (not-yet-seen) items after dedup, i.e. what the relevance classifier
   * actually runs on. Dedup happens BEFORE relevance so already-seen items don't
   * burn an LLM call every run.
   */
  afterDedup: number;
  /**
   * Items kept by the relevance filter, from the freshest slice it classified
   * (that slice is capped per run so a huge backlog can't fire hundreds of LLM
   * calls). Equals the classified count unless mode='on' dropped some.
   */
  afterRelevance: number;
  /** Items the relevance filter actually dropped (only > 0 when mode='on'). */
  droppedRelevance: number;
  fresh: number;
  /** Raw cards successfully DM'd to the owner. */
  sent: number;
  /** Cards that failed to DM. */
  failed: number;
  /** True if a keyword filter (include/exclude) was active this run. */
  filterActive: boolean;
}

/** Sends the owner a "raw" review card for a freshly-collected candidate. */
export type SendRawCard = (candidate: Candidate) => Promise<void>;

export interface ControlServerOptions {
  port: number;
  token: string;
  store: CandidateStore;
  /** Next scheduled run, or null. Kept for future use; not in the V1 status body. */
  nextRun: () => Date | null;
  /** Model ping, injectable for tests; defaults to the real pingModel. */
  pingFn?: typeof pingModel;
  /** Full-matrix model health, injectable for tests; defaults to probeAllModels. */
  probeModelsFn?: typeof probeAllModels;
}

export interface ControlServerHandle {
  server: Server;
  close: () => Promise<void>;
}
