import { z } from 'zod';
import 'dotenv/config';

/**
 * Environment schema. Parsed once at import; a missing/invalid var aborts the
 * process with a readable error rather than failing deep inside the bot loop.
 */
const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  OWNER_TELEGRAM_ID: z.coerce.number().int().positive('OWNER_TELEGRAM_ID must be a positive integer'),
  /** Required only when REWRITE_PROVIDER=anthropic (the default). */
  ANTHROPIC_API_KEY: z.string().optional(),
  BLOG_API_URL: z.string().url('BLOG_API_URL must be a URL'),
  BOT_API_TOKEN: z.string().min(8, 'BOT_API_TOKEN must be a long shared secret'),
  SQLITE_PATH: z.string().default('./data/candidates.db'),
  CRON_SCHEDULE: z.string().default('0 9 * * *'),
  CRON_TZ: z.string().default('Europe/Moscow'),
  /** Optional CSV override of the default feed list. */
  RSS_FEEDS: z.string().optional(),
  /**
   * Which backend rewrites a feed item into a post:
   *   'anthropic' — Claude (needs ANTHROPIC_API_KEY, paid)
   *   'gemini'    — Google Gemini free tier (needs GEMINI_API_KEY)
   *   'mock'      — no LLM, build the post from the feed item directly
   * REWRITE_MOCK=1 still forces 'mock' regardless of this, for back-compat.
   */
  REWRITE_PROVIDER: z.enum(['anthropic', 'gemini', 'mock']).default('anthropic'),
  /** Claude model for the rewrite. Haiku is plenty for this task. */
  REWRITE_MODEL: z.string().default('claude-haiku-4-5'),
  /** Google AI Studio API key — required when REWRITE_PROVIDER=gemini. */
  GEMINI_API_KEY: z.string().optional(),
  /** Gemini model. Flash is free-tier and plenty for a rewrite. */
  GEMINI_MODEL: z.string().default('gemini-3-flash'),
  /** Max candidates surfaced per run, to cap Claude spend on a noisy day. */
  MAX_PER_RUN: z.coerce.number().int().positive().default(15),
  /**
   * When '1'/'true', skip the Claude call and build the post from the feed item
   * directly. Lets the full pipeline (collect → approve → publish) be tested
   * without API credits. NOT for production — output isn't a real rewrite.
   */
  REWRITE_MOCK: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
}).superRefine((cfg, ctx) => {
  // Fail fast at boot if the chosen provider is missing its key, rather than
  // crashing deep in the rewrite during a run. REWRITE_MOCK overrides the
  // provider, so skip the check then.
  if (cfg.REWRITE_MOCK) return;
  if (cfg.REWRITE_PROVIDER === 'gemini' && !cfg.GEMINI_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['GEMINI_API_KEY'],
      message: 'GEMINI_API_KEY is required when REWRITE_PROVIDER=gemini',
    });
  }
  if (cfg.REWRITE_PROVIDER === 'anthropic' && !cfg.ANTHROPIC_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ANTHROPIC_API_KEY'],
      message: 'ANTHROPIC_API_KEY is required when REWRITE_PROVIDER=anthropic',
    });
  }
});

function loadConfig() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const CONFIG = loadConfig();

export type Config = typeof CONFIG;
