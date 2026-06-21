import { Cron } from "croner";

import { CONFIG } from "./config.js";

/**
 * Registers the daily collection job. Returns the Cron handle so the caller can
 * `.trigger()` it on demand (the /fetch command reuses the same job function)
 * and `.stop()` it on shutdown. The `catch` option prevents a thrown run from
 * killing the scheduler silently.
 */
export function scheduleDaily(run: () => Promise<void>): Cron {
  return new Cron(
    CONFIG.CRON_SCHEDULE,
    {
      timezone: CONFIG.CRON_TZ,
      catch: (err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`[scheduler] collection run threw: ${String(err)}`);
      },
    },
    run,
  );
}
