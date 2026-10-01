/**
 * Live dry run of one channel digest issue (`npm run digest:dry-run`).
 *
 * It runs the real pipeline (channel pages, relevance filter, queue, pick, the
 * item writer on the active model, photos, cover, article) on an IN-MEMORY
 * store and sends the article with «[проба]» in the title to the OWNER's DM,
 * never to the channel. No slot is recorded and no seen key or row is written
 * to the production ledger: the ledger is opened read-only, once, only to copy
 * the runtime model and mock overrides (the active model lives in its
 * `settings` table, not in the env), and closed. The channel sweep does not
 * mirror to the blog audit log (only the RSS collection does), so there is
 * nothing to switch off. It does call the model, and downloads photos.
 *
 * Run it on the VDS, after the deploy, with the env of the service. The unit's
 * `EnvironmentFile` is not shell-sourceable, so let systemd load it:
 *
 *   ssh blog 'systemd-run --quiet --wait --pipe --collect --unit=digest-dry-run \
 *     -p WorkingDirectory=/opt/blog-app/ai-bot-tg \
 *     -p EnvironmentFile=/opt/blog-app/ai-bot-tg/.env.production \
 *     "$(command -v npm)" run digest:dry-run'
 *
 * Exit code 0: the article went to the owner. Non-zero: nothing was sent
 * (fewer than 3 cards, no channel page read) or a step failed.
 */

import { CONFIG } from "../src/config.js";
import { CandidateState } from "../src/enums.js";
import { CandidateStore } from "../src/store/index.js";
import { runChannelWatch } from "../src/server/runChannelWatch.js";
import { markAsTrial, dryRunTarget, copyRuntimeOverrides } from "./dryRunGuards.js";
import { issueSlot, assembleIssue, deliverArticle } from "../src/channelDigest/index.js";

async function main(): Promise<void> {
  const target = dryRunTarget(CONFIG.OWNER_TELEGRAM_ID, CONFIG.TELEGRAM_CHANNEL_ID);
  const store = new CandidateStore(":memory:");
  try {
    const copied = copyRuntimeOverrides(store, CONFIG.SQLITE_PATH);
    const override = store.getModelOverride();
    const model = override ? `${override.provider} ${override.model}` : "env default";
    console.log(`[dry-run] ${copied} override(s) copied from the ledger, model: ${model}`);

    const now = Date.now();
    const sweep = await runChannelWatch(store, { now });
    console.log(
      `[dry-run] pages read ${sweep.pages}, failed ${sweep.failed.length}` +
        `${sweep.failed.length ? ` (${sweep.failed.join(", ")})` : ""}, queued ${sweep.queued}`,
    );

    const slot = issueSlot(now);
    const { assembled, picked, written } = await assembleIssue(store, slot, now);
    const skipped = store.listByState(CandidateState.Skipped);
    console.log(
      `[dry-run] ${slot.key}: picked ${picked}, written ${written}, ` +
        `skipped ${skipped.length}, failed ${picked - written - skipped.length}`,
    );
    for (const { id, error } of skipped) console.log(`[dry-run] skipped #${id}: ${error}`);
    if (!assembled) {
      console.error("[dry-run] fewer than 3 cards, nothing sent");
      process.exitCode = 1;
      return;
    }

    const trial = markAsTrial(assembled);
    const { messageId, rejected } = await deliverArticle(target, trial.article, trial.fallbackText);
    console.log(
      `[dry-run] sent to the owner chat ${target}, message_id ${messageId}, ` +
        `${trial.article.items.length} cards, ${trial.article.photos.length} media, ` +
        `${rejected ? `as text, the rich message was rejected: ${rejected}` : "as a rich message"}`,
    );
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error("[dry-run] fatal:", err);
  process.exit(1);
});
