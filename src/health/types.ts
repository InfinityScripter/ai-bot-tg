import type { pingModel } from "../llm/index.js";

/** One probed subsystem: ok/!ok plus a short human detail. */
export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** The full readiness report assembled by collectHealth. */
export interface HealthReport {
  /** True only when every check is ok. */
  healthy: boolean;
  checks: HealthCheck[];
  /** Candidate count per state, for the queue summary. */
  queue: Record<string, number>;
}

/** Injectable deps so tests never touch the real network/clock. */
export interface HealthDeps {
  /** Active-model probe; defaults to the real pingModel. */
  pingFn?: typeof pingModel;
  /** HTTP client for the blog-API reachability probe; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Next scheduled cron run; null when unknown. */
  nextRun?: () => Date | null;
  /** Process uptime in seconds; defaults to process.uptime. */
  uptimeSec?: () => number;
}
