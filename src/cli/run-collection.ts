import { createBot } from '../bot.js';
import { runCollection } from '../collector.js';
import { CandidateStore } from '../store.js';

/**
 * One-shot collection run from the shell (`npm run fetch`), without starting
 * the long-polling loop. Uses the bot API only to send approval DMs, then
 * exits. Handy for testing the pipeline end-to-end on demand.
 */
async function main() {
  const store = new CandidateStore();
  const { bot, sendApproval } = createBot(store, async () => {});
  // No bot.start() — we only use bot.api.sendMessage to DM approvals.
  void bot;

  const summary = await runCollection(store, sendApproval);
  // eslint-disable-next-line no-console
  console.log('[cli] summary:', summary);

  store.close();
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[cli] fatal:', err);
  process.exit(1);
});
