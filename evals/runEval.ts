/**
 * Eval harness entrypoint for the post-generation prompts.
 *
 *   npm run eval                         # mock mode, deterministic checks only
 *   npm run eval -- --judge              # + LLM-as-judge on the produced posts
 *   npm run eval -- --mode live          # call the real provider (spends credits)
 *   npm run eval -- --mode live --record # live + overwrite the recordings
 *   npm run eval -- --only ru-rich-images
 *
 * MODES
 *  - mock (default): read a recorded raw reply per case, push it through the
 *    EXACT production reply→JSON→finalize path (extractJson + finalizeRewrite),
 *    then run the deterministic contract checks. No network, no credits — this
 *    proves the harness + the output contract.
 *  - live: resolve the real provider from env and actually call the rewrite /
 *    relevance prompts. Used for manual QA and to regenerate recordings.
 *
 * Env bootstrap: src/config.ts validates env at import and process.exit(1)s on a
 * missing var, so we set safe placeholders for the always-required vars BEFORE
 * importing any src module, and force REWRITE_MOCK=1 in mock mode so no real API
 * key is needed. dotenv is non-overriding, so a real .env still wins in live mode.
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

type Mode = "mock" | "live";

interface Args {
  mode: Mode;
  judge: boolean;
  record: boolean;
  only: string | null;
}

/** Parses argv (after `node runEval.ts`). Unknown flags are ignored. */
function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "mock", judge: false, record: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--mode") args.mode = argv[++i] === "live" ? "live" : "mock";
    else if (a === "--judge") args.judge = true;
    else if (a === "--record") args.record = true;
    else if (a === "--only") args.only = argv[++i] ?? null;
  }
  return args;
}

const ARGS = parseArgs(process.argv.slice(2));
const HERE = dirname(fileURLToPath(import.meta.url));

// Placeholder env for the always-required vars (mirrors tests/setup.ts). Only
// set when unset, so a real .env value is never clobbered. dotenv/config (loaded
// by src/config.ts) is also non-overriding.
function setDefault(key: string, value: string): void {
  if (!process.env[key]) process.env[key] = value;
}
setDefault("TELEGRAM_BOT_TOKEN", "eval:telegram-token");
setDefault("OWNER_TELEGRAM_ID", "1");
setDefault("BLOG_API_URL", "http://localhost:7272");
setDefault("BOT_API_TOKEN", "eval-bot-api-token");
setDefault("SQLITE_PATH", ":memory:");
setDefault("CRON_SCHEDULE", "0 9 * * *");
setDefault("CRON_TZ", "Europe/Moscow");
if (ARGS.mode === "mock") {
  // Force the no-key path so env validation passes without a real provider key.
  // In mock mode we never call rewriteToPost's mock — we run finalizeRewrite on
  // recordings directly — so this only placates config validation.
  process.env.REWRITE_MOCK = "1";
}

/** Reads a recorded raw reply `{raw: string}`, returns the raw string. */
function readRecording(relPath: string): string {
  const abs = join(HERE, "fixtures", "recorded", relPath);
  const parsed = JSON.parse(readFileSync(abs, "utf8")) as { raw?: unknown };
  if (typeof parsed.raw !== "string") throw new Error(`recording ${relPath} has no string 'raw'`);
  return parsed.raw;
}

/** Writes a recording file for a case. */
function writeRecording(relPath: string, raw: string): void {
  const abs = join(HERE, "fixtures", "recorded", relPath);
  writeFileSync(abs, `${JSON.stringify({ raw }, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  // Dynamic imports AFTER env bootstrap (config validates on import).
  const [
    { extractJson, finalizeRewrite, completeChatJson, resolveActiveProvider, PROVIDERS },
    { CONFIG },
    { ProviderName },
    { CandidateStore },
    {
      REWRITE_SYSTEM_PROMPT,
      RELEVANCE_SYSTEM_PROMPT,
      buildRewriteUserContent,
      buildRelevanceUserContent,
    },
    { checkRewrite },
    { checkRelevance, parseRelevanceReply },
    { judgeRewrite },
    { REWRITE_CASES },
    { RELEVANCE_CASES },
    report,
  ] = await Promise.all([
    import("../src/llm/index.js"),
    import("../src/config.js"),
    import("../src/enums.js"),
    import("../src/store/index.js"),
    import("../src/llm/prompts.js"),
    import("./checks/rewriteChecks.js"),
    import("./checks/relevanceChecks.js"),
    import("./judge/runJudge.js"),
    import("./fixtures/rewriteCases.js"),
    import("./fixtures/relevanceCases.js"),
    import("./report.js"),
  ]);

  const { printCase, printSummary, findingsPass } = report;
  const store = new CandidateStore(":memory:");

  // In live mode, resolve the provider once for logging + a guard against the
  // mock provider (which has no chat endpoint).
  if (ARGS.mode === "live") {
    const { provider, model } = resolveActiveProvider(store);
    if (provider === ProviderName.Mock) {
      // eslint-disable-next-line no-console
      console.error(
        "live mode needs a real provider, but REWRITE_MOCK/env resolves to mock. Set REWRITE_PROVIDER + its API key.",
      );
      process.exit(2);
    }
    // eslint-disable-next-line no-console
    console.log(`live mode — provider=${PROVIDERS[provider].label} model=${model}\n`);
  } else {
    // eslint-disable-next-line no-console
    console.log("mock mode — recorded replies, deterministic checks (no credits)\n");
  }

  const judgeFloor = Number(process.env.EVAL_JUDGE_FLOOR ?? "3");

  // ---- REWRITE ----
  // eslint-disable-next-line no-console
  console.log("=== REWRITE ===");
  const rewriteReports: import("./report.js").CaseReport[] = [];
  for (const c of REWRITE_CASES) {
    if (ARGS.only && c.id !== ARGS.only) continue;

    const findings = [];
    let judgeNote: string | undefined;
    // One case's provider/parse error is a finding, never an abort — mirrors how
    // production marks a single candidate rewrite_failed without killing the batch.
    try {
      let raw: string;
      if (ARGS.mode === "live") {
        const { provider, model } = resolveActiveProvider(store);
        const reply = await completeChatJson(provider, model, {
          system: REWRITE_SYSTEM_PROMPT,
          user: buildRewriteUserContent(c.item),
          maxTokens: CONFIG.REWRITE_MAX_TOKENS,
          temperature: CONFIG.REWRITE_TEMPERATURE,
          refusalLabel: "обрабатывать новость",
        });
        raw = reply ?? "";
        if (ARGS.record) writeRecording(`${c.id}.json`, raw);
      } else {
        raw = readRecording(`${c.id}.json`);
      }

      const jsonStr = extractJson(raw);
      const result = finalizeRewrite(jsonStr, c.item);
      findings.push(...checkRewrite(result, c.item));

      if (ARGS.judge && ARGS.mode === "live") {
        const verdict = await judgeRewrite(c.item, result);
        if (verdict) {
          judgeNote = `judge ${verdict.score}/5${verdict.issues.length ? ` — ${verdict.issues.join("; ")}` : ""}`;
          if (verdict.score < judgeFloor) {
            findings.push({
              id: "judge.floor",
              ok: false,
              severity: "error" as const,
              detail: `judge ${verdict.score} < floor ${judgeFloor}`,
            });
          }
        } else {
          judgeNote = "judge unavailable";
        }
      }
    } catch (err) {
      findings.push({
        id: "rewrite.produce",
        ok: false,
        severity: "error" as const,
        detail: String(err),
      });
    }

    const failed = !findingsPass(findings);
    rewriteReports.push({ id: c.id, about: c.about, findings, judgeNote, failed });
    printCase({ id: c.id, about: c.about, findings, judgeNote, failed });
  }
  const rewriteOk = printSummary("REWRITE", rewriteReports);

  // ---- RELEVANCE ----
  // eslint-disable-next-line no-console
  console.log("=== RELEVANCE ===");
  const relevanceReports: import("./report.js").CaseReport[] = [];
  for (const c of RELEVANCE_CASES) {
    if (ARGS.only && c.id !== ARGS.only) continue;

    let findings;
    try {
      let raw: string;
      if (ARGS.mode === "live") {
        const { provider, model } = resolveActiveProvider(store);
        const usedModel = CONFIG.RELEVANCE_MODEL ?? model;
        const reply = await completeChatJson(provider, usedModel, {
          system: RELEVANCE_SYSTEM_PROMPT,
          user: buildRelevanceUserContent(c.item),
          maxTokens: 120,
          refusalLabel: "оценивать релевантность",
        });
        raw = reply ?? "";
        if (ARGS.record) writeRecording(join("relevance", `${c.id}.json`), raw);
      } else {
        raw = readRecording(join("relevance", `${c.id}.json`));
      }
      findings = checkRelevance(parseRelevanceReply(raw), c.band);
    } catch (err) {
      findings = [
        { id: "relevance.produce", ok: false, severity: "error" as const, detail: String(err) },
      ];
    }

    const failed = !findingsPass(findings);
    relevanceReports.push({ id: c.id, about: c.about, findings, failed });
    printCase({ id: c.id, about: c.about, findings, failed });
  }
  const relevanceOk = printSummary("RELEVANCE", relevanceReports);

  store.close();
  process.exit(rewriteOk && relevanceOk ? 0 : 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
