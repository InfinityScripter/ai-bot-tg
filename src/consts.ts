/**
 * Shared string constants that are NOT domain enums: the Telegram callback-data
 * prefixes used to encode/decode inline-button taps. Centralised here so the
 * encoder (bot-model) and the decoder/handlers (bot) reference one source and
 * can never drift. (Domain value enums live in enums.ts.)
 */

/**
 * Callback-data prefixes for the /model menu. Telegram caps callback data at 64
 * bytes; all of these fit.
 *   mp_<provider>            choose a provider → show its models
 *   mm_<provider>__<model>   choose a model (provider + '__' + model)
 *   mreset                   clear the override, back to env default
 *   mback                    back to the provider list
 *   mmock_on / mmock_off     turn the runtime mock (без LLM) override on/off
 */
export const MODEL_CALLBACK = {
  PROVIDER: "mp_",
  MODEL: "mm_",
  RESET: "mreset",
  BACK: "mback",
  MOCK_ON: "mmock_on",
  MOCK_OFF: "mmock_off",
} as const;

/** Separator between provider and model id in a model-pick callback. */
export const MODEL_CALLBACK_SEP = "__";

/**
 * Callback-data prefixes for a candidate review card. Each is followed by the
 * numeric candidate id (e.g. `approve_42`).
 */
export const CARD_CALLBACK = {
  APPROVE: "approve_",
  SKIP: "skip_",
  REWRITE: "rewrite_",
} as const;

/**
 * Callback-data prefix for the command-menu buttons (/start, /menu). Followed by
 * a MenuAction value, e.g. `menu_fetch`. The handler routes the tap to the same
 * code path as the corresponding slash command.
 */
export const MENU_CALLBACK = "menu_";

/**
 * Callback-data values for the /digest review keyboard. Each is a complete,
 * distinct token (no id suffix — there is a single module-scoped pending digest,
 * one owner at a time), so a startsWith/equality check routes the tap. Prefixed
 * `digest_` so they never collide with CARD_CALLBACK (approve_/skip_/rewrite_),
 * MODEL_CALLBACK (m*), or MENU_CALLBACK (menu_).
 *   digest_send    → send the pending digest to all confirmed subscribers
 *   digest_rebuild → re-fetch + re-build the digest (overwrites the pending one)
 *   digest_verdict → prompt the owner for the verdict that fills the {{ВЕРДИКТ}} slot
 *   digest_cancel  → clear the pending digest, do nothing
 */
export const DIGEST_CALLBACK = {
  SEND: "digest_send",
  REBUILD: "digest_rebuild",
  VERDICT: "digest_verdict",
  CANCEL: "digest_cancel",
} as const;
