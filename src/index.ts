import { CONFIG } from "./config.js";
import { createBot } from "./bot/index.js";
import { CandidateStore } from "./store/index.js";
import { importCatalog } from "./catalog/index.js";
import { NOTIFY_LABELS, COLLECTION_LABELS } from "./labels.js";
import {
  runCollection,
  scheduleDaily,
  startControlServer,
  createProcessCandidate,
} from "./server/index.js";

/**
 * Entrypoint. Wires the store, bot, collector, and scheduler together, then
 * starts long-polling. Order matters: the cron job is registered before
 * bot.start() (which blocks), and shutdown stops both cleanly.
 */
async function main() {
  const store = new CandidateStore();

  // The bot owns autoPublishCandidate + sendRawCard; the collector run builds a
  // deciding processCandidate over both, gated on the blog's auto-publish flags
  // (read once per run). createBot's onFetch is invoked by /fetch and runs the
  // same cycle as the cron. It returns a short status note so /fetch can reply
  // with it — in particular when a keyword filter hid everything (otherwise the
  // owner can't tell a misconfigured filter from a genuine "no news today").
  let acceptingCollections = true;
  let activeCollection: Promise<string> | null = null;
  const runOnce = async (): Promise<string> => {
    const processCandidate = await createProcessCandidate(store, {
      autoPublish: autoPublishCandidate,
      sendRawCard,
    });
    const s = await runCollection(store, processCandidate);
    if (s.filterActive && s.fetched > 0 && s.afterFilter === 0) {
      return COLLECTION_LABELS.filterBlocked(s.fetched);
    }
    if (s.fresh === 0 && s.published === 0 && s.failed === 0) {
      return COLLECTION_LABELS.noNews(s.fetched);
    }
    return COLLECTION_LABELS.done(s.fresh, s.published, s.failed);
  };
  const run = (): Promise<string> => {
    if (!acceptingCollections) return Promise.resolve("Сервис останавливается, сбор не запущен.");
    if (activeCollection) return activeCollection;
    const current = runOnce().finally(() => {
      if (activeCollection === current) activeCollection = null;
    });
    activeCollection = current;
    return current;
  };
  // Declared before createBot so /health can read the next cron run via a lazy
  // getter; the actual job is assigned below (after the bot/notify wiring exists).
  let job: ReturnType<typeof scheduleDaily> | null = null;
  const {
    bot,
    sendRawCard,
    autoPublishCandidate,
    notifyAutomaticFailures,
    notifyNeedsVerification,
    drain,
  } = createBot(store, run, { nextRun: () => job?.nextRun() ?? null });

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
      const pruned = store.pruneOld(90);
      if (pruned > 0) {
        // eslint-disable-next-line no-console
        console.log(`[index] pruned ${pruned} old candidates (dedup keys preserved)`);
      }
      const note = await run();
      // Only ping the owner on the cron when something needs attention (a filter
      // hid everything) — a normal run stays quiet to avoid daily noise.
      if (note.startsWith("⚠️")) await notifyOwner(note);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[index] scheduled run failed: ${String(err)}`);
      await notifyOwner(NOTIFY_LABELS.scheduledRunFailed(err));
    }
  };

  job = scheduleDaily(scheduledRun);

  // The changelog catalog import runs on its own schedule and is registered only
  // when the expression is configured. Unset = no import job, bot unchanged — so
  // deploying this code before the env vars are added is a no-op. The import
  // itself is gated on the same autoPublishReleases flag as the RSS pipeline and
  // fails closed, so a live schedule still publishes nothing while it's off.
  const catalogRun = async (): Promise<void> => {
    try {
      const summary = await importCatalog();
      // eslint-disable-next-line no-console
      console.log("[index] catalog import:", summary);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[index] catalog import failed: ${String(err)}`);
      await notifyOwner(NOTIFY_LABELS.catalogImportFailed(err));
    }
  };
  const catalogJob = CONFIG.CATALOG_CRON_SCHEDULE
    ? scheduleDaily(catalogRun, CONFIG.CATALOG_CRON_SCHEDULE)
    : null;
  // eslint-disable-next-line no-console
  console.log(
    catalogJob
      ? `[index] catalog import scheduled: ${CONFIG.CATALOG_CRON_SCHEDULE} (${CONFIG.CRON_TZ})`
      : "[index] catalog import disabled (CATALOG_CRON_SCHEDULE unset)",
  );

  // The admin control server is started only when a token is configured. Unset
  // = no control server, bot still runs/publishes — so deploying this code
  // before the env var is added can never crash the pipeline.
  const controlServer = CONFIG.BOT_CONTROL_TOKEN
    ? startControlServer({
        port: CONFIG.CONTROL_PORT,
        token: CONFIG.BOT_CONTROL_TOKEN,
        store,
        nextRun: () => job?.nextRun() ?? null,
      })
    : null;
  // eslint-disable-next-line no-console
  console.log(
    controlServer
      ? `[index] control server on 127.0.0.1:${CONFIG.CONTROL_PORT}`
      : "[index] control server disabled (BOT_CONTROL_TOKEN unset)",
  );

  // eslint-disable-next-line no-console
  console.log(
    `[index] started. Next run: ${job?.nextRun()?.toISOString() ?? "n/a"} (${CONFIG.CRON_TZ})`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    acceptingCollections = false;
    // eslint-disable-next-line no-console
    console.log(`[index] ${signal} received, shutting down…`);
    let code = 0;
    try {
      job?.stop();
      catalogJob?.stop();
      if (controlServer) await controlServer.close();
      await bot.stop(); // grammy: stops polling; does not drain handlers
      if (activeCollection) await activeCollection;
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
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // A throw outside a handler, or a rejection nobody awaited, ends the process:
  // systemd (Restart=always, RestartSec=5) brings it straight back, so the bot
  // heals itself — but Node's default death skips store.close(), leaving the
  // SQLite WAL uncheckpointed, and prints the reason without the [index] prefix
  // the rest of the journal is grepped by. Handle it to log and checkpoint, then
  // exit anyway: swallowing the fault would keep a process alive in a state we
  // know nothing about, which is strictly worse than a five-second restart.
  const crash = (label: string, reason: unknown) => {
    console.error(`[index] ${label}:`, reason);
    if (!shuttingDown) {
      shuttingDown = true;
      try {
        store.close();
      } catch (err) {
        console.error(`[index] store close after ${label} failed: ${String(err)}`);
      }
    }
    process.exit(1);
  };
  process.on("uncaughtException", (err) => crash("uncaught exception", err));
  process.on("unhandledRejection", (reason) => crash("unhandled rejection", reason));

  // Blocks until stopped.
  await bot.start({
    onStart: (info) => {
      // eslint-disable-next-line no-console
      console.log(`[index] bot @${info.username} polling.`);
      // Warn the owner about any post-crash rows whose publish status is unknown.
      void notifyNeedsVerification();
      void notifyAutomaticFailures();
    },
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[index] fatal:", err);
  process.exit(1);
});
