import { z } from 'zod';
import 'dotenv/config';

/**
 * Environment schema. Parsed once at import; a missing/invalid var aborts the
 * process with a readable error rather than failing deep inside the bot loop.
 */
const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  OWNER_TELEGRAM_ID: z.coerce.number().int().positive('OWNER_TELEGRAM_ID must be a positive integer'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  BLOG_API_URL: z.string().url('BLOG_API_URL must be a URL'),
  BOT_API_TOKEN: z.string().min(8, 'BOT_API_TOKEN must be a long shared secret'),
  SQLITE_PATH: z.string().default('./data/candidates.db'),
  CRON_SCHEDULE: z.string().default('0 9 * * *'),
  CRON_TZ: z.string().default('Europe/Moscow'),
  /** Optional CSV override of the default feed list. */
  RSS_FEEDS: z.string().optional(),
  /** Claude model for the rewrite. Haiku is plenty for this task. */
  REWRITE_MODEL: z.string().default('claude-haiku-4-5'),
  /** Max candidates surfaced per run, to cap Claude spend on a noisy day. */
  MAX_PER_RUN: z.coerce.number().int().positive().default(15),
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
