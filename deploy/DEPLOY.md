# Deploying ai-bot-tg to the VDS

The bot runs as a long-lived systemd service on the same VDS as the blog backend
(Ubuntu 22.04, `185.237.219.151`). It publishes to the blog over HTTP, so it can
talk to the backend at `http://localhost:7272` when co-located.

> The bot has **no CI auto-deploy** (unlike the backend). Deploy it manually the
> first time, then update with `git pull` + `systemctl restart`. If you want CI
> later, mirror `.github/workflows/backend-cicd.yml`.

## 1. Backend prerequisites (one-time)

The blog backend must authenticate the bot. Add these to the VDS backend env
(`/opt/blog-backend/.env.production`, the file CI copies to `.env` on deploy):

```
BOT_API_TOKEN=<long random secret>          # generate once, keep it secret
OWNER_EMAIL=talalaev.misha@gmail.com         # must be an existing role='admin' user
```

Generate the token:

```bash
openssl rand -hex 32
```

Confirm the owner account is admin (psql on the VDS):

```sql
UPDATE users SET role = 'admin' WHERE LOWER(email) = LOWER('talalaev.misha@gmail.com');
```

The backend change itself (`BOT_API_TOKEN` path in `requireAuth`) is already on
`main` and deploys via CI — only the env vars above need setting. Redeploy the
backend (push to `main`, or `systemctl restart blog-backend`) after adding them.

## 2. Get the bot onto the box

```bash
# as a deploy user with sudo
sudo mkdir -p /opt/blog-app/ai-bot-tg
sudo chown www-data:www-data /opt/blog-app/ai-bot-tg
cd /opt/blog-app/ai-bot-tg
sudo -u www-data git clone git@github.com:InfinityScripter/ai-bot-tg.git .
sudo -u www-data npm ci            # or: npm install --omit=dev if you build first
```

Node 18+ is required (croner). Check: `node -v`.

## 3. Configure the bot env

Create `/opt/blog-app/ai-bot-tg/.env.production` (root-owned, `chmod 600`):

```
TELEGRAM_BOT_TOKEN=<from @BotFather>
OWNER_TELEGRAM_ID=<your numeric Telegram chat id>
ANTHROPIC_API_KEY=<Claude API key>
REWRITE_MODEL=claude-haiku-4-5

# Co-located with the backend → use localhost. (Public API is https://api.talalaev.su:8444)
BLOG_API_URL=http://localhost:7272
BOT_API_TOKEN=<MUST equal the backend's BOT_API_TOKEN from step 1>

SQLITE_PATH=/opt/blog-app/ai-bot-tg/data/candidates.db
CRON_SCHEDULE=0 9 * * *
CRON_TZ=Europe/Moscow
MAX_PER_RUN=15
```

Find your `OWNER_TELEGRAM_ID` by messaging [@userinfobot](https://t.me/userinfobot).

```bash
sudo chmod 600 /opt/blog-app/ai-bot-tg/.env.production
sudo mkdir -p /opt/blog-app/ai-bot-tg/data
sudo chown -R www-data:www-data /opt/blog-app/ai-bot-tg/data
```

## 4. Install the systemd unit

Two `ExecStart` options — pick one and edit `blog-newsbot.service` accordingly:

**A. Run TypeScript directly with tsx (simplest, matches `npm start`):**

```ini
ExecStart=/usr/bin/npx tsx /opt/blog-app/ai-bot-tg/src/index.ts
```

(or `/usr/bin/node --import tsx .../src/index.ts` — verify the node/tsx paths
with `which node` / `npx tsx --version` on the box.)

**B. Build to JS first (no tsx at runtime):**

```bash
sudo -u www-data npm run build      # emits dist/
```

```ini
ExecStart=/usr/bin/node /opt/blog-app/ai-bot-tg/dist/src/index.js
```

Then:

```bash
sudo cp /opt/blog-app/ai-bot-tg/deploy/blog-newsbot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blog-newsbot
```

## 5. Verify

```bash
sudo systemctl status blog-newsbot
journalctl -u blog-newsbot -f
```

Expected on a healthy start:

```
[index] started. Next run: <ISO timestamp> (Europe/Moscow)
[index] bot @<username> polling.
```

Then in Telegram, from the owner account:

1. `/ping` → `pong`
2. `/fetch` → "Запускаю сбор новостей…", then approval cards arrive
3. Tap **✅ Опубликовать** on a card → the post appears on `https://talalaev.su`,
   authored by you, and the card edits to "✅ Опубликовано".

## 6. Update / rollback

```bash
cd /opt/blog-app/ai-bot-tg
sudo -u www-data git pull
sudo -u www-data npm ci          # if deps changed
sudo -u www-data npm run build   # only if using ExecStart option B
sudo systemctl restart blog-newsbot
```

The SQLite DB (`data/candidates.db`) persists across restarts — the dedup ledger
and candidate history survive. Back it up by copying that file.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `bot @… polling` never appears, 401 on getMe | bad `TELEGRAM_BOT_TOKEN` |
| Publish fails with 401 | bot's `BOT_API_TOKEN` ≠ backend's, or `OWNER_EMAIL` not an admin user |
| Publish fails with 500 | backend `OWNER_EMAIL` not set |
| Bot ignores your commands | wrong `OWNER_TELEGRAM_ID` (the owner-lock drops non-owner updates) |
| No candidates on `/fetch` | every fetched item already seen (dedup), or all feeds failed — check the journal |
