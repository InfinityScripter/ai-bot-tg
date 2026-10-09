import type { BotError } from "grammy";

import { HttpError, GrammyError } from "grammy";

/**
 * A bot's global error boundary: grammy rethrows an uncaught handler error
 * out of the polling loop, which exits the process (systemd then
 * restart-loops). Benign Telegram 400s ("message is not modified", "query is
 * too old") log as warnings; real Bot API errors and network errors are told
 * apart for clearer logs.
 */
export function logBotError(prefix: string) {
  return (err: BotError): void => {
    const e = err.error;
    const updateId = err.ctx.update.update_id;
    if (e instanceof GrammyError) {
      const benign = /message is not modified|query is too old|message to edit not found/i.test(
        e.description,
      );
      console[benign ? "warn" : "error"](
        `[${prefix}] Telegram error on update ${updateId}: ${e.description}`,
      );
    } else if (e instanceof HttpError) {
      console.warn(`[${prefix}] network error on update ${updateId}: ${String(e)}`);
    } else {
      console.error(`[${prefix}] unhandled error on update ${updateId}: ${String(e)}`);
    }
  };
}
