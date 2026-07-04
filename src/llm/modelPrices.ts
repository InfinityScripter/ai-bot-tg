/**
 * Rough price hints per model, for the /model buttons and the admin panel.
 * Prices are USD per 1M tokens (input/output), approximate and
 * provider-published — meant to flag "free vs paid", not for billing. A model
 * absent here renders without a hint. Pure data (mirrors the marker-list
 * modules); the registry logic lives in providers.ts / modelRegistry.ts.
 *   tier 'free'  → 🆓
 *   tier 'paid'  → 💲 with the $in/$out note
 */

export interface ModelPrice {
  tier: "free" | "paid";
  /** Short note shown next to the model, e.g. "$0.14/$0.28 за 1M". */
  note?: string;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // GLM (Z.ai) — *-flash are free; others are paid.
  "glm-4.7-flash": { tier: "free" },
  "glm-4.5-flash": { tier: "free" },
  "glm-4.6": { tier: "paid", note: "$0.60/$2.20 за 1M" },
  "glm-4.7": { tier: "paid", note: "$0.60/$2.20 за 1M" },
  "glm-4.5-air": { tier: "paid", note: "дёшево" },
  "glm-5": { tier: "paid", note: "$1.00/… за 1M" },
  // DeepSeek — both V4 tiers are paid but cheap.
  "deepseek-v4-flash": { tier: "paid", note: "$0.14/$0.28 за 1M" },
  "deepseek-v4-pro": { tier: "paid", note: "$1.74/$3.48 за 1M" },
  "deepseek-chat": { tier: "paid", note: "≈ v4-flash" },
  // Claude — paid.
  "claude-haiku-4-5": { tier: "paid", note: "Anthropic, платно" },
  "claude-sonnet-4-6": { tier: "paid", note: "Anthropic, дороже" },
  // Gemini — free tier exists but is geo/quota limited from RU.
  "gemini-2.5-flash": { tier: "free", note: "free-tier (гео-лимит из РФ)" },
  "gemini-2.5-flash-lite": { tier: "free", note: "free-tier (гео-лимит из РФ)" },
  // OpenRouter (namespaced ids). Live-tested for clean rewrite output.
  "deepseek/deepseek-chat": { tier: "paid", note: "OpenRouter $0.20/$0.80 за 1M" },
  "google/gemini-2.5-flash": { tier: "paid", note: "OpenRouter, дёшево" },
  "qwen/qwen3-next-80b-a3b-instruct:free": {
    tier: "free",
    note: "OpenRouter $0 (нестабильно, 429)",
  },
  // Mock — no cost.
  mock: { tier: "free" },
};

/** A short price/tier label for a model, or '' if unknown. */
export function modelPriceLabel(model: string): string {
  const p = MODEL_PRICES[model];
  if (!p) return "";
  if (p.tier === "free") return p.note ? `🆓 ${p.note}` : "🆓";
  return p.note ? `💲 ${p.note}` : "💲";
}
