// Populate the env that src/config.ts requires, BEFORE any module that imports
// it is loaded. Without this, importing config.ts would call process.exit(1).
process.env.TELEGRAM_BOT_TOKEN = 'test:telegram-token';
process.env.OWNER_TELEGRAM_ID = '123456789';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.BLOG_API_URL = 'http://localhost:7272';
process.env.BOT_API_TOKEN = 'test-bot-api-token-value';
process.env.SQLITE_PATH = ':memory:';
process.env.CRON_SCHEDULE = '0 9 * * *';
process.env.CRON_TZ = 'Europe/Moscow';
// Force the real Claude path in tests regardless of a local .env (which may set
// REWRITE_MOCK=1 for manual no-credit testing). The rewriter tests mock the SDK.
process.env.REWRITE_MOCK = '0';
