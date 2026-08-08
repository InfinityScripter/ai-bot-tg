import { importCatalog } from "../catalog/index.js";

/**
 * One-shot catalog import from the shell (`npm run import:catalog [days]`),
 * without starting the bot. Same code path the scheduled import runs, so a
 * manual sweep and the cron produce identical records.
 */
async function main() {
  const days = Number(process.argv[2]);
  const summary = await importCatalog(Number.isFinite(days) && days > 0 ? { days } : {});
  // eslint-disable-next-line no-console
  console.log("[cli] catalog import:", summary);
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[cli] fatal:", err);
  process.exit(1);
});
