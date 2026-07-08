import { z } from "zod";

import { ProviderName, RelevanceMode } from "../enums.js";

/**
 * Zod schema for the environment entity. Parsed once at config load; a
 * missing/invalid var aborts the process with a readable error rather than
 * failing deep inside the bot loop. Kept in src/schemas/ (one schema file per
 * entity) so validation lives apart from the config loader in src/config.ts.
 *
 * The provider/mode fields validate against the domain enums (z.nativeEnum), so
 * the env contract and the rest of the code share one source of truth.
 */
export const EnvSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
    OWNER_TELEGRAM_ID: z.coerce
      .number()
      .int()
      .positive("OWNER_TELEGRAM_ID must be a positive integer"),
    /** Required only when REWRITE_PROVIDER=anthropic (the default). */
    ANTHROPIC_API_KEY: z.string().optional(),
    BLOG_API_URL: z.string().url("BLOG_API_URL must be a URL"),
    /**
     * Public site (frontend) base URL, used to build the "Читать" link when
     * cross-posting a published post/release to the Telegram channel. OPTIONAL:
     * defaults to the well-known prod site so an existing deploy keeps working;
     * override for staging/local. Distinct from BLOG_API_URL (the backend API).
     */
    BLOG_PUBLIC_URL: z.string().url("BLOG_PUBLIC_URL must be a URL").default("https://aifirst.us.com"),
    /**
     * Target channel/chat for auto cross-posting a post on publish (a @username
     * or a numeric -100… id). OPTIONAL: when unset, cross-posting is DISABLED and
     * the bot publishes to the blog exactly as before — so deploying this code
     * without the var added never changes behavior. The bot must be an admin of
     * the channel with post permission for the send to succeed.
     */
    TELEGRAM_CHANNEL_ID: z.string().min(1).optional(),
    BOT_API_TOKEN: z.string().min(8, "BOT_API_TOKEN must be a long shared secret"),
    /** Port for the localhost-only admin control server. */
    CONTROL_PORT: z.coerce.number().int().positive().default(8455),
    /**
     * Shared secret for the backend→bot control API. OPTIONAL: when unset, the
     * control server is NOT started and the bot runs/publishes normally — so
     * deploying this code without the var added cannot crash the pipeline. Min 16
     * chars when present. Separate from BOT_API_TOKEN (which is bot→blog).
     */
    BOT_CONTROL_TOKEN: z.string().min(16, "BOT_CONTROL_TOKEN must be >= 16 chars").optional(),
    SQLITE_PATH: z.string().default("./data/candidates.db"),
    CRON_SCHEDULE: z.string().default("0 9 * * *"),
    CRON_TZ: z.string().default("Europe/Moscow"),
    /** Optional CSV override of the default feed list. */
    RSS_FEEDS: z.string().optional(),
    /**
     * Which backend rewrites a feed item into a post:
     *   'anthropic' — Claude (needs ANTHROPIC_API_KEY, paid)
     *   'gemini'    — Google Gemini (needs GEMINI_API_KEY; free tier is geo/quota limited)
     *   'glm'       — Zhipu Z.ai GLM (needs GLM_API_KEY; GLM-4.7-Flash is free)
     *   'deepseek'  — DeepSeek (needs DEEPSEEK_API_KEY; V4 Flash is very cheap)
     *   'openrouter'— OpenRouter (needs OPENROUTER_API_KEY; one key, many models)
     *   'mock'      — no LLM, build the post from the feed item directly
     * REWRITE_MOCK=1 still forces 'mock' regardless of this, for back-compat.
     * gemini/glm/deepseek/openrouter all use the same OpenAI-compatible code path.
     */
    REWRITE_PROVIDER: z.nativeEnum(ProviderName).default(ProviderName.Anthropic),
    /** Claude model for the rewrite. Haiku is plenty for this task. */
    REWRITE_MODEL: z.string().default("claude-haiku-4-5"),
    /**
     * Sampling temperature for the rewrite. 0–1 so ONE value is valid for both
     * Anthropic (0–1) and the OpenAI-compatible providers (0–2). Default 0.6 —
     * enough variation for an "original" rewrite without drifting off-source.
     */
    REWRITE_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.6),
    /** Max output tokens for the rewrite. 4096 fits a full structured post. */
    REWRITE_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
    /**
     * Hard per-call wall-clock timeout (ms) for EVERY LLM request — rewrite,
     * relevance classify, digest, release extraction. Without it the Anthropic
     * SDK / fetch would wait out their ~10-min default on a stalled or degraded
     * upstream, and since collection classifies items serially, one hung call
     * makes /fetch look frozen. 30s is generous for a single completion; a
     * relevance classify that hits it fails open (keep), so the cap never
     * swallows the queue.
     */
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    /**
     * Max automatic retries per LLM call. The Anthropic SDK defaults to 2, which
     * multiplies the stall on retriable errors (429/5xx/connection). Capped at 1
     * so a degraded provider can't turn one collection run into many minutes of
     * back-off. Set 0 to disable retries entirely.
     */
    LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(1),
    /** Google AI Studio API key — required when REWRITE_PROVIDER=gemini. */
    GEMINI_API_KEY: z.string().optional(),
    /** Gemini model. 2.0-flash is retired; 2.5-flash is the current free-tier floor. */
    GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
    /** Z.ai (Zhipu) API key — required when REWRITE_PROVIDER=glm. */
    GLM_API_KEY: z.string().optional(),
    /** GLM model. The Flash variant is free for all Z.ai accounts. */
    GLM_MODEL: z.string().default("glm-4.7-flash"),
    /** DeepSeek API key — required when REWRITE_PROVIDER=deepseek. */
    DEEPSEEK_API_KEY: z.string().optional(),
    /** DeepSeek model. V4 Flash is the cheap frontier-class option. */
    DEEPSEEK_MODEL: z.string().default("deepseek-v4-flash"),
    /** OpenRouter API key — required when REWRITE_PROVIDER=openrouter. One key
     * proxies many upstream models, sidestepping per-provider geo blocks. */
    OPENROUTER_API_KEY: z.string().optional(),
    /** OpenRouter model (namespaced). deepseek-chat: cheap, clean rewrite output,
     * fits the $5 free-tier credit. (GLM-flash there is a reasoning model →
     * empty content; qwen :free is 429-prone — both avoided as the default.) */
    OPENROUTER_MODEL: z.string().default("deepseek/deepseek-chat"),
    /** Max candidates surfaced per run, to cap Claude spend on a noisy day. */
    MAX_PER_RUN: z.coerce.number().int().positive().default(15),
    /**
     * Optional CSV keyword filters applied to title+snippet (case-insensitive)
     * before items enter the review queue. INCLUDE: if set, keep only items
     * matching at least one keyword. EXCLUDE: drop items matching any keyword.
     * Both cut noise with zero LLM cost.
     */
    FILTER_INCLUDE: z.string().optional(),
    FILTER_EXCLUDE: z.string().optional(),
    /**
     * Topic relevance filter (AI/tech). Two-stage: a free keyword fast-path, then
     * a single cheap LLM classify for ambiguous items. Modes:
     *   'off'    — no filtering (legacy behavior).
     *   'shadow' — run + LOG every decision, but DON'T drop (calibration window).
     *   'on'     — actually drop off-topic items.
     * Default 'shadow' so deploying this code never silently drops the queue.
     */
    RELEVANCE_MODE: z.nativeEnum(RelevanceMode).default(RelevanceMode.Shadow),
    /** Keep an item when its LLM relevance score is >= this (0–4). Default 2. */
    RELEVANCE_THRESHOLD: z.coerce.number().int().min(0).max(4).default(2),
    /** Optional model for the classify call; default = the active rewrite model. */
    RELEVANCE_MODEL: z.string().optional(),
    /**
     * Mirror each relevance decision into the backend audit log
     * (/dashboard/admin/audit-logs). Default ON. Lets the owner silence audit
     * emission without disabling the filter itself — emission is fire-and-forget
     * and fail-silent, so this only controls noise, never the pipeline.
     */
    RELEVANCE_AUDIT: z
      .enum(["0", "1", "true", "false"])
      .default("1")
      .transform((v) => v === "1" || v === "true"),
    /**
     * When '1'/'true', skip the Claude call and build the post from the feed item
     * directly. Lets the full pipeline (collect → approve → publish) be tested
     * without API credits. NOT for production — output isn't a real rewrite.
     */
    REWRITE_MOCK: z
      .enum(["0", "1", "true", "false"])
      .default("0")
      .transform((v) => v === "1" || v === "true"),
  })
  .superRefine((cfg, ctx) => {
    // Fail fast at boot if the chosen provider is missing its key, rather than
    // crashing deep in the rewrite during a run. REWRITE_MOCK overrides the
    // provider, so skip the check then.
    if (cfg.REWRITE_MOCK || cfg.REWRITE_PROVIDER === ProviderName.Mock) return;
    // provider → the env key it requires.
    const REQUIRED_KEY = {
      [ProviderName.Anthropic]: "ANTHROPIC_API_KEY",
      [ProviderName.Gemini]: "GEMINI_API_KEY",
      [ProviderName.Glm]: "GLM_API_KEY",
      [ProviderName.DeepSeek]: "DEEPSEEK_API_KEY",
      [ProviderName.OpenRouter]: "OPENROUTER_API_KEY",
    } as const;
    const keyName = REQUIRED_KEY[cfg.REWRITE_PROVIDER as keyof typeof REQUIRED_KEY];
    if (keyName && !cfg[keyName]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [keyName],
        message: `${keyName} is required when REWRITE_PROVIDER=${cfg.REWRITE_PROVIDER}`,
      });
    }
  });

/** The parsed, validated environment config. */
export type Env = z.infer<typeof EnvSchema>;
