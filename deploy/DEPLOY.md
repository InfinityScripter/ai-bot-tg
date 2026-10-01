# Deploying ai-bot-tg to the VDS

The bot runs as a long-lived systemd service on the same VDS as the blog backend
(Ubuntu 22.04, `185.237.219.151`). It publishes to the blog over HTTP, so it can
talk to the backend at `http://localhost:7272` when co-located.

> **First deploy is manual** (steps 2–4 below: clone, env, systemd unit). After
> that, a push to `main` auto-deploys via GitHub Actions
> (`.github/workflows/bot-cicd.yml`): it SSHes in, `git reset --hard origin/main`,
> `npm ci --omit=dev`, and `systemctl restart blog-newsbot`. It is a **git-pull** deploy (not
> scp like the backend) so it never touches the env file or the SQLite ledger.
> See [CI auto-deploy](#7-ci-auto-deploy--rollback) for the required repo secrets
> and how to roll back.

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
sudo -u www-data npm ci --omit=dev --no-audit --no-fund   # runtime-only (deps + tsx); bot runs via tsx, no build
```

Node 20+ is required (the digest writer uses a RegExp `v` flag). Check: `node -v`.

## 3. Configure the bot env

Create `/opt/blog-app/ai-bot-tg/.env.production` (root-owned, `chmod 600`):

```
TELEGRAM_BOT_TOKEN=<from @BotFather>
OWNER_TELEGRAM_ID=<your numeric Telegram chat id>
ANTHROPIC_API_KEY=<Claude API key>
REWRITE_MODEL=claude-haiku-4-5

# Co-located with the backend → use localhost. (Public API is https://api.aifirst.us.com:8444)
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

## 4a. Group responder (optional)

The bot can answer in the channel's discussion group when someone mentions it
or replies to it. Replies run through the Codex CLI on the owner's ChatGPT
subscription (no API credits); every Codex tool is disabled and the child gets
no bot tokens in its environment (`src/chatReply/runCodex.ts`).

1. Add the bot to the discussion group and make it an admin with every right
   switched off. Admins receive every group message; with privacy mode ON
   (the @BotFather default) a plain member gets only commands and replies to
   its own messages — an `@mention` never arrives, and the bot looks dead.
   The alternative is `/setprivacy` → Disable in @BotFather and re-adding the
   bot, which affects every group it is in.

   Test from your own name, not as the group: an anonymous admin ("Send
   Anonymously…", the message signed with the group's name) reaches the bot
   from Telegram's `GroupAnonymousBot`, and the responder ignores messages from
   bots. Turn off "Remain Anonymous" in your admin rights. Channel commenters
   write as themselves and are answered normally.
2. Install Codex and log it in as the unit's `User=`. The login is the
   owner's ChatGPT session; copy it from a machine where `codex login status`
   says "Logged in using ChatGPT". Pin the version the owner runs locally:
   `runCodex.ts` passes flags (`--ignore-rules`, `--disable`,
   `--output-schema`) that older releases reject.

   The production box (2026-10) predates the hardened unit in this repo: its
   `/etc/systemd/system/blog-newsbot.service` runs as `root`, without
   `ProtectSystem`/`ReadWritePaths`. Check with `systemctl cat blog-newsbot`
   and use the matching variant:

   ```bash
   sudo npm i -g @openai/codex@0.155.0
   # unit runs as root (production today):
   sudo install -d -m 700 /opt/blog-app/ai-bot-tg/data/codex
   # unit runs as www-data (deploy/blog-newsbot.service):
   sudo install -d -o www-data -g www-data -m 700 /opt/blog-app/ai-bot-tg/data/codex

   # from the owner's Mac (ssh alias `blog` = root@VDS, port 3333):
   scp ~/.codex/auth.json blog:/opt/blog-app/ai-bot-tg/data/codex/auth.json

   sudo chmod 600 /opt/blog-app/ai-bot-tg/data/codex/auth.json
   # www-data only:
   sudo chown www-data:www-data /opt/blog-app/ai-bot-tg/data/codex/auth.json
   # prefix with `sudo -u www-data` for a www-data unit:
   sudo env CODEX_HOME=/opt/blog-app/ai-bot-tg/data/codex codex login status
   ```

   `CODEX_HOME` lives under `data/` on purpose: the hardened unit runs with
   `ProtectSystem=strict` and `ProtectHome=true`, and `data/` is its only
   writable path. Codex writes there on every run (session state, token
   refresh in `auth.json`); a read-only home makes every reply fall back to the
   paid provider without any visible error. `data/` is git-ignored and survives
   the git-pull deploy.
3. Point the unit at that home with a drop-in, so the unit file itself stays
   untouched:

   ```bash
   sudo mkdir -p /etc/systemd/system/blog-newsbot.service.d
   printf '[Service]\nEnvironment=CODEX_HOME=/opt/blog-app/ai-bot-tg/data/codex\n' \
     | sudo tee /etc/systemd/system/blog-newsbot.service.d/codex.conf
   sudo systemctl daemon-reload && sudo systemctl restart blog-newsbot
   systemctl show blog-newsbot -p Environment
   ```

   After the first mention, `journalctl -u blog-newsbot | grep "codex failed"`
   must be empty — otherwise replies run on the fallback.
4. Mention the bot once in the group and read its id from the journal:
   `journalctl -u blog-newsbot | grep chatReply` prints
   `mention in a chat that is not CHAT_REPLY_CHAT_ID: -100…`. Put that id into
   `CHAT_REPLY_CHAT_ID` in `.env.production` and restart.

`/chat` in the owner DM turns the responder off and on (kept in SQLite). When
Codex fails (quota spent, session expired, timeout) the active rewrite provider
answers instead; when both fail the bot stays silent.

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
2. `/fetch` → "Запускаю сбор новостей…", then **raw** cards arrive
   (un-rewritten: source title + snippet + [🔄 Переработать][❌ Пропустить])
3. Tap **🔄 Переработать** → the active model (see `/model`) rewrites the item
   and the card becomes a preview with [🔄 Заново][✅ Опубликовать][❌ Пропустить]
4. Tap **✅ Опубликовать** → the post appears on `https://aifirst.us.com`, authored
   by you, and the card edits to "✅ Опубликовано".

## 6. Manual update

Normally you don't do this — pushing to `main` auto-deploys (see section 7).
For a hotfix straight on the box:

```bash
cd /opt/blog-app/ai-bot-tg
git pull
npm ci --omit=dev --no-audit --no-fund   # runtime-only; if deps changed
systemctl restart blog-newsbot
```

The SQLite DB (`data/candidates.db`) persists across restarts — the dedup ledger
and candidate history survive. Back it up by copying that file.

A `/model` override (provider/model chosen at runtime in the bot) is also stored
in this DB, so it **survives deploys** — a git-pull deploy never touches
`data/candidates.db`. The `.env` provider (`REWRITE_PROVIDER` + the matching
`*_API_KEY`) is only the default used when no override is set; to force it again,
use `/model` → "↩️ Сбросить на env".

## 7. CI auto-deploy + rollback

A push to `main` triggers `.github/workflows/bot-cicd.yml`, which SSHes into the
VDS and runs: `git reset --hard origin/main` → `npm ci --omit=dev` → `systemctl
restart blog-newsbot`. It is a **git-pull** deploy, so it never overwrites
`.env.production` or `data/candidates.db`.

**Required GitHub repo secrets** (Settings → Secrets and variables → Actions).
These are the SAME ones the backend repo uses — reuse the same values:

| Secret | Value |
|---|---|
| `VDS_HOST` | `185.237.219.151` |
| `VDS_PORT` | SSH port |
| `VDS_USER` | deploy user |
| `VDS_SSH_PRIVATE_KEY` | private key whose public half is in the box's `authorized_keys` (falls back to `VDS`) |

**One-time CI prerequisite:** the deploy must reach the repo over the network and
fast-forward. The clone in step 2 already sets `origin`; confirm the box can
`git fetch` it non-interactively (HTTPS with a token, or a deploy key in
`~/.ssh`). `git reset --hard origin/main` then never prompts.

### Rollback

`git reset --hard` makes deploys deterministic — the box always matches a commit.
To roll back, point `main` at the last good commit and let CI redeploy:

```bash
# locally
git revert <bad-commit>            # safe: forward commit that undoes it
git push origin main               # CI redeploys the reverted tree
```

Or, for an immediate fix straight on the box (then reconcile `main` after):

```bash
cd /opt/blog-app/ai-bot-tg
git reset --hard <last-good-sha>
npm ci --omit=dev --no-audit --no-fund
systemctl restart blog-newsbot
```

Find the last-good SHA with `git log --oneline` on the box or in the repo. The
SQLite ledger is unaffected by either path.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `bot @… polling` never appears, 401 on getMe | bad `TELEGRAM_BOT_TOKEN` |
| Publish fails with 401 | bot's `BOT_API_TOKEN` ≠ backend's, or `OWNER_EMAIL` not an admin user |
| Publish fails with 500 | backend `OWNER_EMAIL` not set |
| Bot ignores your commands | wrong `OWNER_TELEGRAM_ID` (the owner-lock drops non-owner updates) |
| No candidates on `/fetch` | every fetched item already seen (dedup), or all feeds failed — check the journal |
