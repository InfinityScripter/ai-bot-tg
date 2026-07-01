import { pingModel } from "../llm/index.js";
import { checkBlog, processCheck, checkProvider, scheduleCheck } from "./probeChecks.js";

import type { CandidateStore } from "../store/index.js";
import type { HealthDeps, HealthReport } from "./types.js";

/**
 * Collects a full readiness report: process uptime, next cron run, the active
 * LLM provider, the blog API, and the queue counts. Every probe is isolated, so
 * one failing subsystem never aborts the others. `healthy` is true only when all
 * checks pass; the queue summary is informational and never flips it.
 */
export async function collectHealth(
  store: CandidateStore,
  deps: HealthDeps = {},
): Promise<HealthReport> {
  const pingFn = deps.pingFn ?? pingModel;
  const fetchFn = deps.fetchFn ?? fetch;
  const uptimeSec = deps.uptimeSec ?? (() => process.uptime());

  const checks = [processCheck(uptimeSec), scheduleCheck(deps.nextRun)];

  const [provider, blog] = await Promise.all([checkProvider(store, pingFn), checkBlog(fetchFn)]);
  checks.push(provider, blog);

  const queue = store.countsByState();
  const healthy = checks.every((c) => c.ok);
  return { healthy, checks, queue };
}
