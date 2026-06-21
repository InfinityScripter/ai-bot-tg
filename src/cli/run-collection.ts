import { createBot } from "../bot.js";
import { CandidateStore } from "../store.js";
import { runCollection } from "../collector.js";

/**
 * One-shot collection run from the shell (`npm run fetch`), without starting
 * the long-polling loop. Uses the bot API only to send raw cards, then exits.
 * Handy for testing the pipeline end-to-end on demand.
 */
async function main() {
  const store = new CandidateStore();
  const { bot, sendRawCard } = createBot(store, async () => {});
  // No bot.start() — we only use bot.api.sendMessage to DM raw cards.
  void bot;

  const summary = await runCollection(store, sendRawCard);
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
