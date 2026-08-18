import { createBot } from "../bot/index.js";
import { CandidateStore } from "../store/index.js";

/**
 * One-shot daily digest run from the shell (`npm run digest:post`), without
 * starting the long-polling loop — the same flow the cron uses after the
 * collection. Mirrors runCollection.ts. `manual=true` so every skip reason
 * (already published today, queue too small) is reported to the owner DM.
 *
 * NOTE: if autoPublishNews is OFF the flow sends a preview card whose buttons
 * are answered by the RUNNING bot process — whose own pending draft is empty,
 * so ✅ there replies "нет готового дайджеста". Use the bot's /digestpost
 * command instead when approving manually; this CLI is for the auto path and
 * for ops/debugging.
 */
async function main() {
  const store = new CandidateStore();
  const { bot, runDigestPost } = createBot(store, async () => {});
  // No bot.start() — bot.api is still used for owner DMs and the cross-post.
  void bot;

  await runDigestPost(true);

  store.close();
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[cli] fatal:", err);
  process.exit(1);
});
