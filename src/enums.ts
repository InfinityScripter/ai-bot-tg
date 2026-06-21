/**
 * Domain enums. Every member's VALUE is the exact wire string used on the
 * boundary (the SQLite `state` column, the env/db provider name, the relevance
 * mode env value, the blog publish flag, the audit action sent to the backend).
 * Using string enums (value === wire string) keeps full DB/env/JSON
 * compatibility while giving every literal a readable, single-source name —
 * replacing the string-literal unions that were scattered across the codebase.
 */

/**
 * Lifecycle of a candidate. Persisted verbatim in the `state` column, so the
 * member values MUST stay equal to the historical strings.
 *
 *   Collected ──🔄──→ Rewriting → PendingReview (preview saved)
 *      │                 │             │  └──✅──→ Publishing → Published
 *      │                 │             │                          └→ PublishFailed
 *      │                 └→ RewriteFailed (🔄 retry)             └→ (back to PendingReview on fail)
 *      └──❌──→ Skipped                 └──🔄 заново──→ Rewriting (overwrites preview)
 */
export enum CandidateState {
  Collected = "collected",
  Rewriting = "rewriting",
  RewriteFailed = "rewrite_failed",
  PendingReview = "pending_review",
  Skipped = "skipped",
  Publishing = "publishing",
  Published = "published",
  PublishFailed = "publish_failed",
  /**
   * A crash/deploy landed mid-publish: the POST may or may not have reached the
   * blog. Recovery puts the row here (NOT back to PendingReview) so the owner is
   * warned the post might already be live before re-publishing — avoiding a
   * silent duplicate article.
   */
  NeedsVerification = "needs_verification",
}

/** Which backend rewrites a feed item into a post. Value = env/db provider id. */
export enum ProviderName {
  Anthropic = "anthropic",
  Gemini = "gemini",
  Glm = "glm",
  DeepSeek = "deepseek",
  Mock = "mock",
}

/** How a provider is called — selects the rewriter/classifier code path. */
export enum ProviderKind {
  Anthropic = "anthropic",
  OpenAICompat = "openai-compat",
  Mock = "mock",
}

/** Topic relevance filter mode. Value = the RELEVANCE_MODE env value. */
export enum RelevanceMode {
  Off = "off",
  Shadow = "shadow",
  On = "on",
}

/** The blog publish flag sent in the post body. */
export enum PublishStatus {
  Draft = "draft",
  Published = "published",
}

/** The discriminant of a parsed /model inline-button callback. */
export enum CallbackKind {
  Provider = "provider",
  Model = "model",
  Reset = "reset",
  Back = "back",
  MockOn = "mockOn",
  MockOff = "mockOff",
}

/** What an owner-sent message was classified as (manual ingest). */
export enum InputKind {
  Url = "url",
  Text = "text",
  Empty = "empty",
}

/** The audit action mirrored into the backend log for a relevance decision. */
export enum RelevanceAuditAction {
  Dropped = "bot.relevance_dropped",
  ShadowDropped = "bot.relevance_shadow_dropped",
  Kept = "bot.relevance_kept",
}
