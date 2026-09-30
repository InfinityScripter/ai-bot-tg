import { CONFIG } from "../config.js";

/**
 * Final "humanizer" pass: sends finished text to hemmingway-27b, the model the
 * owner's /humanizer skill treats as the standard of human-sounding prose, and
 * returns its rewrite. The system prompt is the skill's own
 * (scripts/hemmingway.sh) so the bot and the skill produce the same voice.
 *
 * Fail-soft by design: this is a polish step, never a reason to lose a post. No
 * key, a timeout, an HTTP error, an empty reply or a reply whose length drifted
 * too far from the input all return the ORIGINAL text and log why. The length
 * guard exists because a rewrite that shrank by half has dropped facts or
 * paragraphs, and one that grew by half has added content the source never had.
 */

const HEMMINGWAY_API = "https://hemmingway.io/v1";

// The model thinks at "xhigh" effort by default: measured 2026-09-30, a short
// paragraph took 9 s and ~1200 output tokens; at "low" it took 2 s and ~250
// tokens with the same quality of rewrite. Thinking tokens are billed as output.
const REASONING_EFFORT = "low";

// A full post is a few thousand characters; the default LLM timeout (30 s) is
// sized for short classify calls and would cut it off.
const TIMEOUT_MS = 90_000;

const MIN_LENGTH_RATIO = 0.67;
const MAX_LENGTH_RATIO = 1.5;

export const HUMANIZE_SYSTEM_PROMPT =
  "Rewrite the user text so it reads as written by a person, not an AI. Keep the language of the original, its meaning, facts, names, numbers, links, code and formatting. Do not add facts, opinions or examples that are not in the original. Never use the em dash (—) or the en dash (–): rebuild each such sentence with a period, a comma, a colon or other words. Return only the rewritten text, without comments.";

interface HemmingwayResponse {
  choices?: { finish_reason?: string; message?: { content?: string } }[];
}

/** Outcome of the latest pass, surfaced by /health. */
export interface HumanizeOutcome {
  ok: boolean;
  at: Date;
  error?: string;
}

// A fail-soft pass is invisible when it keeps failing (a revoked key means
// every post silently skips it), so the last outcome is kept for /health.
let lastOutcome: HumanizeOutcome | null = null;

export function lastHumanizeOutcome(): HumanizeOutcome | null {
  return lastOutcome;
}

function keepOriginal(text: string, reason: string): string {
  console.warn(`[humanize] kept original: ${reason}`);
  lastOutcome = { ok: false, at: new Date(), error: reason };
  return text;
}

async function callHemmingway(apiKey: string, text: string): Promise<string> {
  const response = await fetch(`${HEMMINGWAY_API}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "hemmingway-27b",
      reasoning_effort: REASONING_EFFORT,
      messages: [
        { role: "system", content: HUMANIZE_SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Hemmingway ответил ${response.status}: ${body.slice(0, 200)}`);
  }
  const choice = ((await response.json()) as HemmingwayResponse).choices?.[0];
  // A reply cut at the token limit can still pass the length guard (70% of a
  // post is in bounds) and would publish without its ending.
  if (choice?.finish_reason && choice.finish_reason !== "stop") {
    throw new Error(`Hemmingway оборвал ответ (finish_reason=${choice.finish_reason})`);
  }
  return (choice?.message?.content ?? "").trim();
}

/** Returns the humanized text, or the original when the pass is off or unusable. */
export async function humanizeText(text: string): Promise<string> {
  const apiKey = CONFIG.HEMMINGWAY_API_KEY;
  const original = text.trim();
  if (!apiKey || !original) return text;
  let rewritten: string;
  try {
    rewritten = await callHemmingway(apiKey, original);
  } catch (err) {
    return keepOriginal(text, err instanceof Error ? err.message : String(err));
  }
  const ratio = rewritten.length / original.length;
  if (ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO) {
    return keepOriginal(text, `длина ${original.length} → ${rewritten.length} вне допуска`);
  }
  lastOutcome = { ok: true, at: new Date() };
  return rewritten;
}

/**
 * Free key + reachability check for /health: lists the models, which needs a
 * valid key but spends no tokens. Returns null when the key is valid.
 */
export async function probeHemmingway(
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  try {
    const response = await fetchFn(`${HEMMINGWAY_API}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? null : `ответил ${response.status}`;
  } catch (err) {
    return String(err);
  }
}
