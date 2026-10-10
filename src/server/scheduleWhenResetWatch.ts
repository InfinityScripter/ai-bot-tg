import { CONFIG } from "../config.js";
import { scheduleDaily } from "./scheduler.js";
import { runWhenResetWatch } from "./runWhenResetWatch.js";
import { createProcessCandidate } from "./createProcessCandidate.js";

import type { Candidate } from "../types.js";
import type { CandidateStore } from "../store/index.js";

interface WhenResetWatchDeps {
  store: CandidateStore;
  inWatchSlot: (task: () => Promise<void>) => Promise<void>;
  notifyOwner: (text: string) => Promise<void>;
  autoPublish: (candidate: Candidate) => Promise<void>;
  sendRawCard: (candidate: Candidate) => Promise<void>;
}

/** Startup and cron share one tracked job; no async writes after idle resolves. */
export function scheduleWhenResetWatch(deps: WhenResetWatchDeps) {
  let stopping = false;
  let failing = false;
  let active: Promise<void> | null = null;
  const sweep = async (): Promise<void> => {
    try {
      if (stopping) return;
      const processCandidate = await createProcessCandidate(deps.store, deps);
      await runWhenResetWatch(deps.store, processCandidate, () => stopping);
      failing = false;
    } catch {
      console.error("[whenreset] sweep failed; next scheduled tick will retry");
      if (!failing) {
        // Set before awaiting: even a failed owner send cannot flood each tick.
        failing = true;
        await deps
          .notifyOwner(
            "⚠️ Не удалось проверить WhenReset. Бот повторит проверку на следующем тике; остальные источники продолжают работать.",
          )
          .catch(() => console.warn("[whenreset] owner notification failed"));
      }
    }
  };
  const run = async (): Promise<void> => {
    if (stopping || active) return;
    // Reserve before calling user code; synchronous re-entry also sees active.
    const current = Promise.resolve()
      .then(() => deps.inWatchSlot(sweep))
      .finally(() => {
        if (active === current) active = null;
      });
    active = current;
    await current;
  };
  const job = CONFIG.WHENRESET_WATCH_CRON ? scheduleDaily(run, CONFIG.WHENRESET_WATCH_CRON) : null;
  console.log(
    job
      ? `[whenreset] scheduled: ${CONFIG.WHENRESET_WATCH_CRON} (${CONFIG.CRON_TZ}), checking on startup`
      : "[whenreset] disabled (WHENRESET_WATCH_CRON empty)",
  );
  if (job) void run();
  return {
    stop: () => {
      stopping = true;
      job?.stop();
    },
    idle: async () => {
      if (active) await active;
    },
  };
}
