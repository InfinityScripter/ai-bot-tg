/**
 * Runs the LLM-as-judge against a produced post. Resolves the judge provider
 * from env (EVAL_JUDGE_PROVIDER / EVAL_JUDGE_MODEL, falling back to the rewrite
 * provider/model), calls the shared chat core, and parses a {score, issues}
 * verdict. Only invoked when the eval runner is given --judge; the deterministic
 * path never touches this file, so a default eval spends no credits.
 */

import { CONFIG } from "../../src/config.js";
import { ProviderName } from "../../src/enums.js";
import { PROVIDERS } from "../../src/llm/providers.js";
import { completeChatJson } from "../../src/llm/chatCompletion.js";
import { JUDGE_SYSTEM_PROMPT, buildJudgeUserContent } from "./judgePrompt.js";

import type { FeedItem, RewriteResult } from "../../src/types.js";

/** A parsed judge verdict. */
export interface JudgeVerdict {
  score: number;
  headline: number;
  hook: number;
  readerValue: number;
  brandVoice: number;
  humanizer: number;
  trust: number;
  issues: string[];
}

/** Env-derived judge provider/model (defaults to the rewrite provider). */
function resolveJudge(): { provider: ProviderName; model: string } {
  const envProvider = process.env.EVAL_JUDGE_PROVIDER;
  const provider =
    envProvider && envProvider in PROVIDERS
      ? (envProvider as ProviderName)
      : CONFIG.REWRITE_PROVIDER;
  const model = process.env.EVAL_JUDGE_MODEL ?? PROVIDERS[provider].defaultModel;
  return { provider, model };
}

/** Accepts one integer rubric score inside its dimension range. */
function rubricScore(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded >= 0 && rounded <= max ? rounded : null;
}

/** Parses the judge's raw JSON reply into a verdict, or null if malformed. */
export function parseJudgeVerdict(raw: string | null): JudgeVerdict | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const headline = rubricScore(obj.headline, 20);
    const hook = rubricScore(obj.hook, 15);
    const readerValue = rubricScore(obj.readerValue, 20);
    const brandVoice = rubricScore(obj.brandVoice, 15);
    const humanizer = rubricScore(obj.humanizer, 15);
    const trust = rubricScore(obj.trust, 15);
    if ([headline, hook, readerValue, brandVoice, humanizer, trust].includes(null)) return null;
    const issues = Array.isArray(obj.issues) ? obj.issues.map(String) : [];
    const scores = { headline, hook, readerValue, brandVoice, humanizer, trust } as const;
    const score = Object.values(scores).reduce<number>((sum, value) => sum + value!, 0);
    return { score, ...scores, issues } as JudgeVerdict;
  } catch {
    return null;
  }
}

/**
 * Judges one produced post. Throws only on a hard provider error (network,
 * non-OK, refusal); a malformed reply resolves to null so the caller can mark
 * the case "judge unavailable" without aborting the whole run.
 */
export async function judgeRewrite(
  item: FeedItem,
  result: RewriteResult,
): Promise<JudgeVerdict | null> {
  const { provider, model } = resolveJudge();
  if (provider === ProviderName.Mock) return null;
  const raw = await completeChatJson(provider, model, {
    system: JUDGE_SYSTEM_PROMPT,
    user: buildJudgeUserContent(item, result),
    maxTokens: 700,
    temperature: 0,
    refusalLabel: "оценивать пост",
  });
  return parseJudgeVerdict(raw);
}
