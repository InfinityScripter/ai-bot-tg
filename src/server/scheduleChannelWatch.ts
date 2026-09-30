import type { Cron } from "croner";

import { CONFIG } from "../config.js";
import { NOTIFY_LABELS } from "../labels.js";
import { scheduleDaily } from "./scheduler.js";
import { runChannelWatch } from "./runChannelWatch.js";

import type { CandidateStore } from "../store/index.js";

interface ChannelWatchDeps {
  store: CandidateStore;
  /** Runs the task in the slot shared with the release watch, or skips it when the slot is busy. */
  inWatchSlot: (task: () => Promise<void>) => Promise<void>;
  notifyOwner: (text: string) => Promise<void>;
}

/**
 * Schedules the channel sweep on CHANNEL_WATCH_CRON (unset = off): it queues posts for the digest. A failure
 * pings the owner once per failure streak: at an hourly cadence every failure
 * would spam.
 */
export function scheduleChannelWatch(deps: ChannelWatchDeps): Cron | null {
  let failing = false;
  const sweep = async (): Promise<void> => {
    try {
      await runChannelWatch(deps.store);
      failing = false;
    } catch (err) {
      console.error(`[channels] channel watch failed: ${String(err)}`);
      if (!failing) await deps.notifyOwner(NOTIFY_LABELS.channelWatchFailed(err));
      failing = true;
    }
  };
  const job = CONFIG.CHANNEL_WATCH_CRON
    ? scheduleDaily(() => deps.inWatchSlot(sweep), CONFIG.CHANNEL_WATCH_CRON)
    : null;
  console.log(
    job
      ? `[channels] channel watch scheduled: ${CONFIG.CHANNEL_WATCH_CRON} (${CONFIG.CRON_TZ})`
      : "[channels] channel watch disabled (CHANNEL_WATCH_CRON unset)",
  );
  return job;
}
