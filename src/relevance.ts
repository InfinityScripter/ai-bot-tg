import Anthropic from "@anthropic-ai/sdk";

import { CONFIG } from "./config.js";
import { chatUrl, PROVIDERS, resolveActiveProvider } from "./providers.js";

import type { FeedItem } from "./types.js";
import type { CandidateStore } from "./store.js";
import type { ProviderSpec } from "./providers.js";

const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

/**
 * Stage A — hard blocklist (lowercase, title+snippet substring). Deliberately
 * SMALL and UNAMBIGUOUS: terms that never carry an AI/tech angle. A hit drops
 * the item for free (no LLM). Borderline words (политика, бизнес, …) are NOT
 * here on purpose — those route to the LLM, which knows about the AI carve-out.
 */
export const OFF_TOPIC_MARKERS: string[] = [
  "гороскоп",
  "футбол",
  "матч",
  "погода",
  "шоу-бизнес",
  "знаменитост",
  "свадьб",
  "развод",
  "диета",
  "рецепт",
  "сериал",
  "спорт",
  "олимпиад",
  "эстрад",
  "певиц",
  "певец",
  "актрис",
  "актёр",
  "мода",
  "гламур",
];

/**
 * Stage A — on-topic fast-accept (lowercase, title+snippet substring). A hit
 * keeps the item immediately and SKIPS the LLM call — these are obvious AI/tech
 * signals where a classify call would only burn latency/tokens.
 */
export const ON_TOPIC_MARKERS: string[] = [
  "ии",
  "нейросет",
  "llm",
  "gpt",
  "claude",
  "openai",
  "anthropic",
  "машинное обучение",
  "deep learning",
  "чип",
  "процессор",
  "gpu",
  "разработ",
  "opensource",
  "open source",
  "алгоритм",
  "программир",
  "kubernetes",
  "linux",
  "ai",
  "ml",
  "модель",
  "датасет",
  "трансформер",
  "агент",
];

/** Lowercased title + first ~300 chars of snippet — the text every stage reads. */
function haystack(item: FeedItem): string {
  return `${item.title} ${item.snippet}`.toLowerCase();
}

/** True if title+snippet contains any of the (already-lowercased) markers. */
function hasMarker(item: FeedItem, markers: string[]): boolean {
  const hay = haystack(item);
  return markers.some((m) => hay.includes(m));
}

/** Pulls the first balanced-looking JSON object out of a text blob. */
function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** Clamps a parsed score to the valid 0..4 range, or null if not a finite number. */
function clampScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(4, Math.round(value)));
}

// Constant system prompt → eligible for prompt caching across the daily batch.
// Carries the explicit carve-out so AI policy / AI business / AI labor stories
// (which surface as "политика"/"бизнес") are scored ON-topic, not dropped.
const SYSTEM_PROMPT = `Ты — фильтр релевантности для блога об ИИ и технологиях.
Тематика блога: искусственный интеллект, машинное обучение, нейросети, языковые
модели, чипы и железо, разработка ПО, opensource, кибербезопасность, гаджеты.
ВАЖНО: политика вокруг ИИ, бизнес и инвестиции в ИИ, влияние ИИ на рынок труда —
это ON-topic (релевантно), даже если выглядит как «политика» или «бизнес».

Оцени, насколько новость подходит блогу, по шкале 0–4:
  0 — совсем не по теме (спорт, шоу-бизнес, погода, светская хроника);
  4 — прямо про ИИ/технологии.

Верни СТРОГО валидный JSON-объект и ничего кроме него:
{"score":<0-4>,"topic":"<2-4 слова>","reason":"<кратко>"}`;

/** Builds the per-item user message: title + first ~300 chars of snippet. */
function buildUserContent(item: FeedItem): string {
  const snippet = item.snippet.slice(0, 300);
  return `Заголовок: ${item.title}
Описание: ${snippet || "(нет описания)"}`;
}

interface ScoreResponse {
  score?: unknown;
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string } }[];
}

/** Parses a raw JSON blob into a clamped 0..4 score, or null if unusable. */
function parseScore(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ScoreResponse;
    return clampScore(parsed.score);
  } catch {
    return null;
  }
}

/** Extracts the text from the first text content block of a message response. */
function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

/** Classifies via Claude (Anthropic). max_tokens is tiny — only a JSON score. */
async function classifyWithAnthropic(item: FeedItem, model: string): Promise<number | null> {
  const response = await client.messages.create({
    model,
    max_tokens: 120,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserContent(item) }],
  });
  return parseScore(extractJson(extractText(response)));
}

/** Classifies via any OpenAI-compatible endpoint (Gemini, GLM, DeepSeek). */
async function classifyWithOpenAICompat(
  item: FeedItem,
  spec: ProviderSpec,
  model: string,
): Promise<number | null> {
  const response = await fetch(chatUrl(spec), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${spec.apiKey()}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserContent(item) },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as OpenAIChatResponse;
  const text = data.choices?.[0]?.message?.content ?? "";
  return parseScore(extractJson(text));
}

/**
 * Asks the active provider for a 0–4 relevance score. Resolves provider/model
 * via resolveActiveProvider (a /model override wins over the env default); the
 * model is RELEVANCE_MODEL when set, else the active model. FAILS OPEN: provider
 * 'mock', any error/timeout, or an unparsable response all return null — the
 * orchestrator treats null as KEEP, so the filter can never swallow the queue.
 */
export async function classifyRelevance(
  item: FeedItem,
  store: CandidateStore,
): Promise<number | null> {
  const { provider, model } = resolveActiveProvider(store);
  if (provider === "mock") return null;
  const usedModel = CONFIG.RELEVANCE_MODEL ?? model;
  const spec = PROVIDERS[provider];
  try {
    if (spec.kind === "anthropic") {
      return await classifyWithAnthropic(item, usedModel);
    }
    return await classifyWithOpenAICompat(item, spec, usedModel);
  } catch {
    // Any network/timeout/SDK error → fail open (keep).
    return null;
  }
}

/** What the filter decided for one item (used for the shadow-mode audit log). */
export interface RelevanceDecision {
  url: string;
  title: string;
  /** What WOULD happen: true = keep, false = drop. */
  kept: boolean;
  /** Which path decided it. */
  stage: "blocklist" | "accept" | "llm" | "failopen" | "shadow";
  /** The LLM score (0–4), or null when no LLM call was made/usable. */
  score: number | null;
  reason: string;
}

/** Relevance modes (mirrors RELEVANCE_MODE): off = no-op, shadow = log only. */
export type RelevanceMode = "off" | "shadow" | "on";

/** Injected classifier — defaults to the real classifyRelevance; tests pass a stub. */
type ClassifyFn = (item: FeedItem, store: CandidateStore) => Promise<number | null>;

export interface FilterOptions {
  /** Inject a fake classifier so tests never hit the network. */
  classify?: ClassifyFn;
  /** Override the env RELEVANCE_MODE. */
  mode?: RelevanceMode;
  /** Override the env RELEVANCE_THRESHOLD (keep if score >= threshold). */
  threshold?: number;
}

/** Computes the decision for one item (stages A then B). Pure aside from classify. */
async function decide(
  item: FeedItem,
  store: CandidateStore,
  classify: ClassifyFn,
  threshold: number,
): Promise<RelevanceDecision> {
  const base = { url: item.url, title: item.title };
  // Stage A — hard blocklist: unambiguously off-topic, drop for free.
  if (hasMarker(item, OFF_TOPIC_MARKERS)) {
    return { ...base, kept: false, stage: "blocklist", score: null, reason: "off-topic marker" };
  }
  // Stage A — on-topic fast-accept: obvious AI/tech, keep without an LLM call.
  if (hasMarker(item, ON_TOPIC_MARKERS)) {
    return { ...base, kept: true, stage: "accept", score: null, reason: "on-topic marker" };
  }
  // Stage B — single LLM classify. null (mock/error/unparsable) → fail open.
  // Guard the call too: an injected classifier that THROWS must also fail open
  // (the real classifyRelevance never throws, but a custom one might).
  let score: number | null;
  try {
    score = await classify(item, store);
  } catch {
    score = null;
  }
  if (score === null) {
    return { ...base, kept: true, stage: "failopen", score: null, reason: "classify unavailable" };
  }
  const kept = score >= threshold;
  return { ...base, kept, stage: "llm", score, reason: `score=${score} threshold=${threshold}` };
}

/** Logs one decision. Would-drops in shadow mode are prefixed 'SHADOW-DROP'. */
function logDecision(d: RelevanceDecision, shadow: boolean): void {
  const verb = d.kept ? "KEEP" : shadow ? "SHADOW-DROP" : "DROP";
  // eslint-disable-next-line no-console
  console.log(
    `[relevance] ${verb} score=${d.score ?? "-"} stage=${d.stage} reason=${d.reason} url=${d.url}`,
  );
}

/**
 * The orchestrator. For each item: stage A blocklist → drop; on-topic marker →
 * accept (no LLM); else LLM classify (fail open on null). Returns the decisions
 * for every item plus the `kept` slice the caller should actually insert:
 *   - 'off'    → no work; kept === items, decisions === [].
 *   - 'shadow' → compute + log all decisions, but kept === ALL input (never
 *                drops in prod; the 2-week calibration window).
 *   - 'on'     → kept === items whose decision.kept === true.
 * mode/threshold default from CONFIG when not passed.
 */
export async function filterRelevant(
  items: FeedItem[],
  store: CandidateStore,
  opts: FilterOptions = {},
): Promise<{ kept: FeedItem[]; decisions: RelevanceDecision[] }> {
  const mode = opts.mode ?? (CONFIG.RELEVANCE_MODE as RelevanceMode);
  const threshold = opts.threshold ?? CONFIG.RELEVANCE_THRESHOLD;
  const classify = opts.classify ?? classifyRelevance;

  // 'off' — current behavior: no filtering, no decisions, no LLM work.
  if (mode === "off") {
    return { kept: items, decisions: [] };
  }

  const shadow = mode === "shadow";
  const decisions: RelevanceDecision[] = [];
  for (const item of items) {
    const d = await decide(item, store, classify, threshold);
    decisions.push(d);
    logDecision(d, shadow);
  }

  // shadow never drops (kept = all input); 'on' keeps only decision.kept items.
  const kept = shadow ? items : items.filter((_, i) => decisions[i]!.kept);
  return { kept, decisions };
}
