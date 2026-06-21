import type { Context } from "grammy";

/** Logs a swallowed edit error instead of hiding it entirely. */
export function logEditError(context: string) {
  return (err: unknown) => {
    // eslint-disable-next-line no-console
    console.warn(`[bot] ${context} failed: ${String(err)}`);
  };
}

/**
 * Answers a callback query best-effort. answerCallbackQuery THROWS when the
 * query is older than ~15s ("query is too old") — a routine event for any
 * lingering inline button. An unguarded throw here propagates out of the
 * handler and (without a bot.catch) crashes the whole process, so acking must
 * never reject. Always swallow + log.
 */
export async function ackSilently(ctx: Context, opts?: { text: string }): Promise<void> {
  await ctx.answerCallbackQuery(opts).catch(logEditError("answerCallbackQuery"));
}
