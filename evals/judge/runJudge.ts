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

/** Clamps a raw score to the 1–5 integer range, or null if unusable. */
function clampScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(1, Math.min(5, Math.round(value)));
}

/** Parses the judge's raw JSON reply into a verdict, or null if malformed. */
export function parseJudgeVerdict(raw: string | null): JudgeVerdict | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as { score?: unknown; issues?: unknown };
    const score = clampScore(obj.score);
    if (score === null) return null;
    const issues = Array.isArray(obj.issues) ? obj.issues.map(String) : [];
    return { score, issues };
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
    maxTokens: 400,
    temperature: 0,
    refusalLabel: "оценивать пост",
  });
  return parseJudgeVerdict(raw);
}
