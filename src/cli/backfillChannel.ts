import { Bot } from "grammy";

import { CONFIG } from "../config.js";
import { fetchAllPosts, crossPostToChannel } from "../blog/index.js";

import type { RecentPost } from "../blog/types.js";
import type { CrossPostContent } from "../bot/types.js";

/**
 * One-shot backfill (`npm run backfill:channel`): announces EVERY published blog
 * post in the configured Telegram channel, oldest-first, so the channel gets the
 * full back-catalogue in chronological order. Complements the on-publish
 * cross-post (which only covers new posts going forward).
 *
 * Guardrails:
 *  - Requires TELEGRAM_CHANNEL_ID (same env as the live feature) — aborts if unset.
 *  - Throttled (SPACING_MS between sends) to stay under Telegram's channel rate.
 *  - Not idempotent: a second full run double-posts. Use --from N to resume after
 *    an interruption (skips the first N posts of the ordered list), and --limit N
 *    to cap a run. --dry-run prints the plan and sends nothing.
 *
 * Flags: --from N | --limit N | --dry-run
 */

/** Delay between channel sends. ~20 msg/min is the channel ceiling; 3s is safe. */
const SPACING_MS = 3000;
const PUBLIC_BASE = CONFIG.BLOG_PUBLIC_URL.replace(/\/$/, "");

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[backfill] ${msg}`);
}

/** Parses `--flag value` / `--dry-run` from argv into a small typed options bag. */
function parseArgs(argv: string[]): { from: number; limit: number | null; dryRun: boolean } {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const from = Number(get("--from") ?? 0);
  const limitRaw = get("--limit");
  return {
    from: Number.isFinite(from) && from > 0 ? Math.floor(from) : 0,
    limit: limitRaw !== undefined && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : null,
    dryRun: argv.includes("--dry-run"),
  };
}

/** Builds the channel announcement content for a published post. */
function toContent(post: RecentPost): CrossPostContent {
  const id = post.id ?? post._id ?? "";
  return {
    title: post.title,
    description: post.description ?? null,
    coverUrl: post.coverUrl ?? null,
    linkFor: () => `${PUBLIC_BASE}/post/${id}`,
  };
}

async function main(): Promise<void> {
  if (!CONFIG.TELEGRAM_CHANNEL_ID) {
    log("TELEGRAM_CHANNEL_ID is not set — nothing to backfill. Aborting.");
    process.exit(1);
  }

  const { from, limit, dryRun } = parseArgs(process.argv.slice(2));
  const posts = await fetchAllPosts();
  const slice = posts.slice(from, limit != null ? from + limit : undefined);

  log(
    `${posts.length} published posts total; backfilling ${slice.length} ` +
      `(from=${from}${limit != null ? `, limit=${limit}` : ""}) → ${CONFIG.TELEGRAM_CHANNEL_ID}` +
      `${dryRun ? " [DRY RUN]" : ""}`,
  );

  if (dryRun) {
    slice.forEach((p, i) => log(`  #${from + i + 1} ${p.createdAt} — ${p.title}`));
    log("Dry run complete — no messages sent.");
    process.exit(0);
  }

  const { api } = new Bot(CONFIG.TELEGRAM_BOT_TOKEN);

  // Sequential, throttled send. reduce carries progress (a for-loop is banned by
  // the es5/Airbnb config); each post waits SPACING_MS after the prior.
  //   sent          — total successes (for the summary count).
  //   failedIdx     — ABSOLUTE indices (from + i) that failed, for manual retry.
  //   lastContigDone— highest absolute index such that EVERY item up to and
  //                   including it succeeded; the safe single `--from` resume
  //                   point (a raw success count is wrong once a non-terminal
  //                   item fails — it would skip the gap and re-send the tail).
  const result = await slice.reduce(
    async (prev, post, i) => {
      const acc = await prev;
      const idx = from + i;
      if (i > 0) await new Promise((r) => setTimeout(r, SPACING_MS));
      try {
        await crossPostToChannel(api, toContent(post), post.id ?? post._id ?? "");
        log(`sent #${idx + 1}/${from + slice.length}: ${post.title}`);
        const contig = acc.failedIdx.length === 0 ? idx + 1 : acc.lastContigDone;
        return { ...acc, sent: acc.sent + 1, lastContigDone: contig };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`FAILED #${idx + 1}: ${post.title} — ${message}`);
        return { ...acc, failedIdx: acc.failedIdx.concat(idx) };
      }
    },
    Promise.resolve({ sent: 0, failedIdx: [] as number[], lastContigDone: from }),
  );

  log(`Done. sent=${result.sent} failed=${result.failedIdx.length}.`);
  if (result.failedIdx.length > 0) {
    // Some non-terminal item failed → the safe resume point is the last fully
    // contiguous index; the gaps must be retried individually.
    log(`Resume the rest with --from ${result.lastContigDone}.`);
    log(`Retry the failures individually: ${result.failedIdx.map((n) => `--from ${n} --limit 1`).join("  |  ")}`);
  }
  process.exit(result.failedIdx.length > 0 ? 1 : 0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
