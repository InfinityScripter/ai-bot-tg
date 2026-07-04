/**
 * Keyword marker lists for the AI-model RELEASE detector. Kept in their own
 * module (mirrors relevanceMarkers.ts) so runCollection stays focused on the
 * decision/orchestration logic. A candidate is marked kind='release' only when
 * BOTH a release marker AND a vendor marker hit — a precision bias that keeps
 * generic "news about AI" out of the changelog pipeline.
 */

/**
 * Release-event markers (lowercase, title+snippet substring). A hit signals the
 * item is announcing a launch — but is NOT sufficient alone (many news items say
 * "launch"), so it must co-occur with a vendor marker below.
 */
export const RELEASE_MARKERS: string[] = [
  "launch",
  "launches",
  "released",
  "release",
  "releasing",
  "announcing",
  "announces",
  "announced",
  "unveils",
  "unveiled",
  "introducing",
  "introduces",
  "now available",
  "generally available",
  "general availability",
  " ga ",
  "preview",
  "выпустил",
  "выпустила",
  "представил",
  "представила",
  "анонсировал",
  "анонсировала",
  "релиз",
  "запустил",
  "запустила",
];

/**
 * AI-vendor markers (lowercase, title+snippet substring). A release marker only
 * flips kind='release' when one of these also hits — so the item is a vendor
 * announcing a model, not just any product launch.
 */
export const VENDOR_MARKERS: string[] = [
  "openai",
  "anthropic",
  "claude",
  "gpt",
  "google",
  "deepmind",
  "gemini",
  "meta",
  "llama",
  "mistral",
  "deepseek",
  "qwen",
  "alibaba",
  "cohere",
  "xai",
  "grok",
  "microsoft",
  "phi",
];
