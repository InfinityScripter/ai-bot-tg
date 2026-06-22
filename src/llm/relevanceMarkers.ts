/**
 * Stage A keyword marker lists for the topic relevance filter. Kept in their own
 * module so relevance.ts stays focused on the decision/orchestration logic.
 */

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
