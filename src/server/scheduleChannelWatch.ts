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
  /** Assembles one digest issue and publishes or previews it. */
  runChannelIssue: () => Promise<void>;
}

/** Both channel jobs: stop the crons, and wait out an issue that is being sent. */
export interface ChannelJobs {
  stop: () => void;
  idle: () => Promise<void>;
}

/**
 * Schedules the channel sweep on CHANNEL_WATCH_CRON and the digest issue on
 * CHANNEL_DIGEST_CRON (each unset = off). A failure of either pings the owner
 * once per failure streak. The issue runs outside the shared watch slot: its
 * `0 11,19` ticks fall on the release watch's half-hour ticks and would
 * otherwise be skipped. It has its own no-overlap guard, and a throw never
 * leaves this function.
 */
export function scheduleChannelWatch(deps: ChannelWatchDeps): ChannelJobs {
  let sweepFailing = false;
  const sweep = async (): Promise<void> => {
    try {
      await runChannelWatch(deps.store);
      sweepFailing = false;
    } catch (err) {
      console.error(`[channels] channel watch failed: ${String(err)}`);
      if (!sweepFailing) await deps.notifyOwner(NOTIFY_LABELS.channelWatchFailed(err));
      sweepFailing = true;
    }
  };
  const watchJob = CONFIG.CHANNEL_WATCH_CRON
    ? scheduleDaily(() => deps.inWatchSlot(sweep), CONFIG.CHANNEL_WATCH_CRON)
    : null;
  console.log(
    watchJob
      ? `[channels] channel watch scheduled: ${CONFIG.CHANNEL_WATCH_CRON} (${CONFIG.CRON_TZ})`
      : "[channels] channel watch disabled (CHANNEL_WATCH_CRON unset)",
  );

  let issueFailing = false;
  let issue: Promise<void> | null = null;
  const runIssue = async (): Promise<void> => {
    if (issue) {
      console.warn("[digest-issue] the previous issue is still running, skipping this tick");
      return;
    }
    issue = deps
      .runChannelIssue()
      .then(() => {
        issueFailing = false;
      })
      .catch(async (err: unknown) => {
        console.error(`[digest-issue] issue failed: ${String(err)}`);
        if (!issueFailing) {
          await deps
            .notifyOwner(NOTIFY_LABELS.channelIssueFailed(err))
            .catch((e: unknown) => console.warn(`[digest-issue] owner note failed: ${String(e)}`));
        }
        issueFailing = true;
      })
      .finally(() => {
        issue = null;
      });
    await issue;
  };
  const issueJob = CONFIG.CHANNEL_DIGEST_CRON
    ? scheduleDaily(runIssue, CONFIG.CHANNEL_DIGEST_CRON)
    : null;
  console.log(
    issueJob
      ? `[digest-issue] scheduled: ${CONFIG.CHANNEL_DIGEST_CRON} (${CONFIG.CRON_TZ})`
      : "[digest-issue] disabled (CHANNEL_DIGEST_CRON unset)",
  );

  return {
    stop: () => {
      watchJob?.stop();
      issueJob?.stop();
    },
    idle: async () => {
      if (issue) await issue;
    },
  };
}
