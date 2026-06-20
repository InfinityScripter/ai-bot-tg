# Runbook — deploying a service to the VDS with CI auto-deploy

Reproducible recipe for putting a Node service (like this bot) on the VDS and
wiring GitHub Actions so a push to `main` auto-deploys it. Written after doing it
for `ai-bot-tg` so the next service (or a re-run) is copy-paste, not archaeology.

> **The infrastructure**
> - VDS: `185.237.219.151`, SSH **port 3333**, user `root`. Ubuntu, Node 20, git,
>   psql, nginx, Postgres all on the box.
> - Blog backend lives at `/opt/blog-app/backend`, runs as systemd `blog-backend`,
>   reads `/opt/blog-app/backend/.env`. The source-of-truth env is
>   `/opt/blog-backend/.env.production` (copied to `.env` on deploy).
> - This bot lives at `/opt/blog-app/ai-bot-tg`, runs as systemd `blog-newsbot`,
>   reads `/opt/blog-app/ai-bot-tg/.env.production`.
> - Infra credentials (VDS password, DB, deploy keys) are kept OUTSIDE every repo
>   at `~/.config/blog-app/.env` on the dev machine.

---

## The mistake this runbook prevents

CI failed the first time with **"Missing secret: VDS_SSH_PRIVATE_KEY"**. The
workflow was committed before the GitHub repo had the four deploy secrets. The
fix isn't re-running blindly — it's: **set the secrets first, THEN the workflow
runs green.** Section 3 is the part that bit us.

---

## 0. Decide the deploy style up front

Two ways CI gets code onto the box. Pick by repo visibility:

| Repo | Style | Why |
|---|---|---|
| **public** | **git-pull** (this bot): SSH in → `git reset --hard origin/main` → `npm ci` → restart | Box fetches over HTTPS, no key needed for git. Leaves `.env`/SQLite in place. |
| **private** | **scp** (the backend): GitHub Actions checks out, scp's sources to the box | Box can't fetch a private repo without a deploy key; Actions already has the code. |

git-pull is simpler and never wipes the deploy dir, so **prefer making the repo
public** (only if it has no secrets in history — verify with the audit in §1)
and using git-pull. That's what this bot does.

---

## 1. Pre-flight: make sure the repo is safe to publish

Run in the repo before `gh repo edit --visibility public`:

```bash
# .env must never have been committed (only .env.example):
git log --all --oneline -- .env .env.local .env.production    # must be EMPTY

# no real keys anywhere in history (placeholders like <Claude API key> are fine):
git grep -nIE "sk-ant-|[0-9]{8,}:[A-Za-z0-9_-]{30,}|BEGIN OPENSSH" $(git rev-list --all) | grep -v .env.example
```

Empty output → safe. Then:

```bash
gh repo edit <owner>/<repo> --visibility public --accept-visibility-change-consequences
```

`gh` is already authed as `InfinityScripter`. Making a repo public is
**irreversible** in the sense that anything exposed is exposed — do the audit.

---

## 2. The CI workflow file

`.github/workflows/bot-cicd.yml` (already in this repo) is the template. Key
choices, so you don't re-derive them:

- **git-pull, not scp + `rm: true`.** The backend's scp deploy wipes the target
  dir each push (`rm: true`). For this bot that would destroy `.env.production`
  AND `data/candidates.db` (the SQLite dedup ledger), which live inside the
  deploy dir. `git reset --hard origin/main` updates tracked files only and
  leaves both untouched.
- **No build step.** The bot runs TypeScript directly with `tsx`
  (`node --import tsx src/index.ts`), so CI is just `npm ci` + restart.
- **Secret validation step** fails fast with a readable message if a secret is
  missing — that's what told us `VDS_SSH_PRIVATE_KEY` wasn't set.

---

## 3. The four GitHub repo secrets (THE step that failed)

Settings → Secrets and variables → Actions. **Set all four BEFORE expecting CI to
pass.** Same values the backend repo uses — reuse them.

| Secret | Value / where to get it |
|---|---|
| `VDS_HOST` | `185.237.219.151` |
| `VDS_PORT` | `3333` |
| `VDS_USER` | `root` |
| `VDS_SSH_PRIVATE_KEY` | private SSH key whose **public** half is in the box's `~/.ssh/authorized_keys`. See §3a. |

Set the simple three from the shell:

```bash
printf '185.237.219.151' | gh secret set VDS_HOST --repo <owner>/<repo>
printf '3333'            | gh secret set VDS_PORT --repo <owner>/<repo>
printf 'root'            | gh secret set VDS_USER --repo <owner>/<repo>
gh secret list --repo <owner>/<repo>          # confirm names (values are write-only)
```

### 3a. The SSH private key — where to get it

GitHub secret values are **write-only** — you can't read the backend's key back
out. The box already trusts a key named `github-actions-deploy` (visible in
`ssh -p 3333 root@185.237.219.151 'cat ~/.ssh/authorized_keys'`). Two options:

**Option A — reuse the existing deploy key** (if you can find its private half):
look in `~/.config/blog-app/.env`, your password manager, or wherever the backend
CI was set up. Then:

```bash
gh secret set VDS_SSH_PRIVATE_KEY --repo <owner>/<repo> < /path/to/private_key
```

**Option B — generate a fresh, service-scoped key** (cleaner — revoke it without
touching the backend):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/blog-bot-deploy -N "" -C "github-actions-bot-deploy"
# trust its public half on the box:
ssh-copy-id -i ~/.ssh/blog-bot-deploy.pub -p 3333 root@185.237.219.151
# load the private half into the secret:
gh secret set VDS_SSH_PRIVATE_KEY --repo <owner>/<repo> < ~/.ssh/blog-bot-deploy
```

> The key is ONLY for SSH-ing into the box (to run git-pull + restart). git
> itself fetches over public HTTPS, so the key needs no GitHub access.

---

## 4. First deploy (manual — once)

CI updates an existing deploy; the very first one is by hand. From the dev
machine, SSH password is in `~/.config/blog-app/.env`:

```bash
ssh -p 3333 root@185.237.219.151
# on the box:
mkdir -p /opt/blog-app/<service>
cd /opt/blog-app/<service>
git clone https://github.com/<owner>/<repo>.git .     # HTTPS works once repo is public
npm ci
mkdir -p data                                          # for SQLite, if used
```

Write the env file (root-owned, 0600) and the systemd unit — see
[DEPLOY.md](DEPLOY.md) §3–§4 for this bot's exact env keys and unit. Then:

```bash
systemctl daemon-reload
systemctl enable --now blog-newsbot
systemctl status blog-newsbot --no-pager
```

---

## 5. The cross-service gotcha: backend must know the bot

The bot authenticates to the blog with a shared secret. The **backend** needs two
env vars or the publish path 401s/500s:

```bash
# on the box, in /opt/blog-backend/.env.production:
BOT_API_TOKEN=<openssl rand -hex 32>          # MUST equal the bot's BOT_API_TOKEN
OWNER_EMAIL=talalaev.misha@gmail.com          # must be a role='admin' user

# the backend reads the COPY at /opt/blog-app/backend/.env — sync + restart:
cp /opt/blog-backend/.env.production /opt/blog-app/backend/.env
systemctl restart blog-backend
```

Confirm the owner is admin:

```sql
SELECT email, role FROM users WHERE LOWER(email)=LOWER('talalaev.misha@gmail.com');
-- if not admin:  UPDATE users SET role='admin' WHERE LOWER(email)=LOWER('...');
```

---

## 6. Verify (do every time, in order)

```bash
# 1. service up, not crash-looping:
systemctl is-active blog-newsbot
systemctl show blog-newsbot -p NRestarts          # NRestarts=0 is healthy
journalctl -u blog-newsbot -n 5 --no-pager        # expect "bot @... polling."

# 2. CI actually ran green (not just "secrets set"):
gh run list --repo <owner>/<repo> --limit 3
gh run watch <run-id> --repo <owner>/<repo> --exit-status

# 3. end-to-end publish path (bot token → backend → owner-admin → post):
TOKEN=$(grep ^BOT_API_TOKEN= /opt/blog-app/ai-bot-tg/.env.production | cut -d= -f2)
curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:7272/api/post/new \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"__SMOKE__","description":"x","content":"x","tags":["t"],"metaTitle":"t","metaDescription":"t","metaKeywords":["t"],"publish":"published"}'
# expect HTTP 201 — then DELETE it so it doesn't show on the blog:
psql "$(grep ^DATABASE_URL= /opt/blog-backend/.env.production | cut -d= -f2-)" \
  -c "DELETE FROM posts WHERE title='__SMOKE__';"
```

A green `gh run list` is NOT proof — a workflow can be green and still no-op.
The smoke publish is the real proof the auth chain works.

---

## 7. Rollback

```bash
# preferred: forward-revert on main, let CI redeploy
git revert <bad-sha> && git push origin main

# emergency, straight on the box (reconcile main after):
cd /opt/blog-app/ai-bot-tg
git reset --hard <last-good-sha> && npm ci && systemctl restart blog-newsbot
```

SQLite ledger survives both. See [DEPLOY.md](DEPLOY.md) §7.

---

## Bot Telegram commands (owner-only, @blog_talalaev_bot)

| Command | Does |
|---|---|
| `/start` | health check + help |
| `/ping`  | replies `pong` |
| `/fetch` | run a collection cycle now (same as the 09:00 MSK cron): RSS → dedup → DM **raw** cards (no rewrite yet) |
| `/model` | switch the rewrite provider/model at runtime (persists in the SQLite ledger across restarts) |

Flow: a **raw** card arrives with **🔄 Переработать / ❌ Пропустить**. On 🔄 the
active model (`/model`) rewrites the item and the card becomes a **preview** with
**🔄 Заново / ✅ Опубликовать / ❌ Пропустить**. Publish posts to the blog (cover
from the feed, authored by owner). Only the owner (`OWNER_TELEGRAM_ID`) can drive
the bot. The rewrite runs on the 🔄 tap, not at collection.

`REWRITE_MOCK=1` (or `REWRITE_PROVIDER=mock`) in the bot env = skip the LLM,
publish a copy of the source (saves credits). Set provider to a real one for
real rewrites.
