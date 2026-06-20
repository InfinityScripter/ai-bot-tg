import { CONFIG } from './config.js';
import { createBot } from './bot.js';
import { runCollection } from './collector.js';
import { scheduleDaily } from './scheduler.js';
import { CandidateStore } from './store.js';

/**
 * Entrypoint. Wires the store, bot, collector, and scheduler together, then
 * starts long-polling. Order matters: the cron job is registered before
 * bot.start() (which blocks), and shutdown stops both cleanly.
 */
async function main() {
  const store = new CandidateStore();

  // The bot owns sendApproval; the collector run closes over it. createBot's
  // onFetch is invoked by /fetch and runs the same cycle as the cron. The
  // RunSummary is consumed for logging inside runCollection, so callers get void.
  const run = async (): Promise<void> => {
    await runCollection(store, (candidate, rewrite) => sendApproval(candidate, rewrite));
  };
  const { bot, sendApproval, drain } = createBot(store, run);

  // Best-effort DM to the owner (used to alert on a failed scheduled run).
  const notifyOwner = async (text: string): Promise<void> => {
    try {
      await bot.api.sendMessage(CONFIG.OWNER_TELEGRAM_ID, text);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[index] failed to notify owner: ${String(err)}`);
    }
  };

  // The scheduled run alerts the owner on failure — a broken daily run is
  // otherwise invisible. (The scheduler's `catch` is a second backstop.)
  const scheduledRun = async (): Promise<void> => {
    try {
      await run();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[index] scheduled run failed: ${String(err)}`);
      await notifyOwner(`⚠️ Ежедневный сбор новостей упал с ошибкой:\n${String(err)}`);
    }
  };

  const job = scheduleDaily(scheduledRun);

  // eslint-disable-next-line no-console
  console.log(
    `[index] started. Next run: ${job.nextRun()?.toISOString() ?? 'n/a'} (${CONFIG.CRON_TZ})`
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[index] ${signal} received, shutting down…`);
    let code = 0;
    try {
      job.stop();
      await bot.stop(); // grammy: stops polling; does not drain handlers
      await drain(); // wait for any in-flight publish to finish its DB writes
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[index] error during shutdown: ${String(err)}`);
      code = 1;
    } finally {
      store.close(); // always close the DB so WAL is checkpointed cleanly
    }
    process.exit(code);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // Blocks until stopped.
  await bot.start({
    onStart: (info) => {
      // eslint-disable-next-line no-console
      console.log(`[index] bot @${info.username} polling.`);
    },
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[index] fatal:', err);
  process.exit(1);
});
