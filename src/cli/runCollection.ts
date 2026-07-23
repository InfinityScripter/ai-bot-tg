import { createBot } from "../bot/index.js";
import { CandidateStore } from "../store/index.js";
import { runCollection, createProcessCandidate } from "../server/index.js";

/**
 * One-shot collection run from the shell (`npm run fetch`), without starting
 * the long-polling loop. Runs the same flag-gated auto-publish/divert path as
 * cron and /fetch (deciding processCandidate over autoPublish + sendRawCard).
 */
async function main() {
  const store = new CandidateStore();
  const { bot, autoPublishCandidate, sendRawCard } = createBot(store, async () => {});
  // No bot.start() — bot.api is still used for progress cards and cross-posts.
  void bot;

  const processCandidate = await createProcessCandidate(store, {
    autoPublish: autoPublishCandidate,
    sendRawCard,
  });
  const summary = await runCollection(store, processCandidate);
  // eslint-disable-next-line no-console
  console.log("[cli] summary:", summary);

  store.close();
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[cli] fatal:", err);
  process.exit(1);
});
