import { HttpError } from 'grammy';
import type { Transformer } from 'grammy';

/**
 * A tiny, dependency-free grammY API transformer that mirrors the essential
 * behavior of @grammyjs/auto-retry: on a 429, wait the Bot API's `retry_after`
 * and resubmit; on a 5xx or a network HttpError, retry with capped exponential
 * backoff. Vendored inline because the VDS's npm mirror cannot fetch the
 * published package — an external dep there breaks `npm ci` and blocks deploys.
 *
 * Differences from the upstream plugin: no abort-signal pausing options and no
 * configurable caps — for a single-owner bot the defaults below are enough.
 */
const ONE_HOUR_S = 3600;
const INITIAL_BACKOFF_S = 3;

function pause(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1000 * seconds));
}

export function autoRetry(): Transformer {
  return async (prev, method, payload, signal) => {
    let nextBackoff = INITIAL_BACKOFF_S;

    // Retry the call itself on a network HttpError (with backoff).
    async function call(): Promise<Awaited<ReturnType<typeof prev>>> {
      for (;;) {
        try {
          return await prev(method, payload, signal);
        } catch (err) {
          if (err instanceof HttpError) {
            await pause(nextBackoff);
            nextBackoff = Math.min(ONE_HOUR_S, nextBackoff * 2);
            continue;
          }
          throw err;
        }
      }
    }

    for (;;) {
      const result = await call();
      const retryAfter = result.parameters?.retry_after;
      if (typeof retryAfter === 'number') {
        // 429: wait exactly as long as Telegram asks, then resubmit.
        await pause(retryAfter);
        nextBackoff = INITIAL_BACKOFF_S;
        continue;
      }
      if (!result.ok && result.error_code >= 500) {
        // Transient server error: back off and retry.
        await pause(nextBackoff);
        nextBackoff = Math.min(ONE_HOUR_S, nextBackoff * 2);
        continue;
      }
      return result;
    }
  };
}
