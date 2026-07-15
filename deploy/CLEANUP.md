# Cleaning up the VDS (freeing disk)

The VDS is a small box (Ubuntu, `185.237.219.151`, SSH port 3333, user `root`,
ssh alias `blog`). It runs two long-lived systemd services (`blog-backend`,
`blog-newsbot`) plus Postgres and nginx, and over time it fills up in a handful
of predictable, throwaway places. This is how to reclaim that space **without
touching anything stateful**.

`deploy/vds-cleanup.sh` automates the whole thing. It is **dry-run by default**
(read-only report) and only deletes with `--apply`.

## TL;DR

```bash
# 1. See what's eating disk and what WOULD be freed (read-only, safe):
ssh blog 'bash -s' < deploy/vds-cleanup.sh

# 2. Reclaim it:
ssh blog 'bash -s -- --apply' < deploy/vds-cleanup.sh

# Once this branch is deployed, the script is already on the box:
ssh blog 'bash /opt/blog-app/ai-bot-tg/deploy/vds-cleanup.sh --apply'
```

`ssh blog` is already `root`, so no `sudo` is needed. Piping over `bash -s`
means you can run the current version straight from your checkout before it is
deployed; `-- --apply` passes the flag to the piped script.

## What it reclaims (and why it's safe)

| # | Reclaims | Why it's throwaway |
|---|---|---|
| 1 | **systemd journal** — `journalctl --vacuum` to ≤14d / ≤200M | Usually the biggest hog. Keeps a recent tail for debugging. |
| 2 | **apt cache + old kernels** — `apt-get clean` + `autoremove --purge` | Cached `.deb`s refetch on demand; superseded kernels under `/boot` are dead weight. |
| 3 | **npm cache** — `~/.npm/_cacache` for `root` + `www-data` | Pure download cache; `npm ci` refetches. Grows every deploy. |
| 4 | **rotated logs** — `*.gz` / `*.old` / `foo.log.1` older than 14d | Only clearly-rotated artifacts; live `*.log` is untouched. |
| 5 | **coredumps** — `/var/lib/systemd/coredump/*` | Crash dumps, safe to drop. |
| 6 | **old snap revisions** — disabled squashfs images | Only superseded revisions; active snap untouched. |
| 7 | **docker** — `system prune -af` (images/build cache) | **Never** `--volumes`; a volume could hold data. Skipped if docker absent. |
| 8 | **stale temp** — `/tmp` + `/var/tmp` files older than 10d | Leftover temp files. |
| 9 | **git gc** in the deploy repos | Repacks loose objects from a long history of `git reset --hard` deploys. Runs as the dir owner so it never leaves root-owned objects that would break the next deploy. |

Optional: `--journal-cap` writes a `journald` drop-in pinning `SystemMaxUse=200M`
so the journal can't regrow. `--days N` changes the log/tmp age threshold.
`--alert` / `--threshold N` power the automated daily check — see
[Prevention](#prevention--the-box-cleans-itself-one-time-install) below.

## What it will NEVER touch (hard invariants)

These are load-bearing state; the script is written so it cannot reach them:

- **`*.env.production`** (`/opt/blog-app/ai-bot-tg/.env.production`,
  `/opt/blog-backend/.env.production`, `/opt/blog-app/backend/.env`) — secrets + config.
- **`/opt/blog-app/ai-bot-tg/data/`** — the SQLite dedup ledger + candidate
  history + runtime `/model` override. Losing it re-DMs already-seen items and
  resets the model choice.
- **Postgres data / the blog DB** — the blog's content.
- **runtime `node_modules`** — the services run from these (bot via `tsx`).

The two `rm -rf` steps go through an allow-list guard (`safe_rm_rf`) that refuses
any path outside `*/.npm/_cacache` and `/var/lib/systemd/coredump`, so a future
edit can't fat-finger a protected path into a delete.

## Prevention — the box cleans itself (one-time install)

Running the script by hand fixes today's 92%; the installer makes sure there is
no next time. `deploy/vds-cleanup-install.sh` wires everything into systemd —
plain units, **no extra packages** — and is dry-run by default, `--apply` to
install, idempotent to re-run:

```bash
# preview exactly what would be written/enabled (read-only):
ssh blog 'bash -s' < deploy/vds-cleanup-install.sh

# install (run AFTER this branch is deployed, so the units' ExecStart target exists):
ssh blog 'bash /opt/blog-app/ai-bot-tg/deploy/vds-cleanup-install.sh --apply'

# remove everything it installed:
ssh blog 'bash -s -- --apply --uninstall' < deploy/vds-cleanup-install.sh
```

What it installs:

| Piece | Runs | Does |
|---|---|---|
| journald cap (`/etc/systemd/journald.conf.d/00-size-cap.conf`) | always on | pins the journal to `SystemMaxUse=200M`, so the #1 grower can never regrow |
| `vds-cleanup.timer` | weekly, Sun ~05:30 | full `vds-cleanup.sh --apply` (everything in the table above) |
| `vds-disk-alert.timer` | daily, ~06:15 | `vds-cleanup.sh --alert --apply --threshold 85`: under 85% → silent no-op; at/over → full cleanup **plus a Telegram DM to the owner** — ⚠️ «почистил до N%», or 🔴 «не помогло — смотреть руками» |

The DM goes through the bot's own `TELEGRAM_BOT_TOKEN` + `OWNER_TELEGRAM_ID`,
read from `/opt/blog-app/ai-bot-tg/.env.production` — no new secrets anywhere,
and a missing env file just skips the DM (fail-soft, like everything else here).

Operating it:

```bash
# are the timers armed, when do they fire next:
ssh blog 'systemctl list-timers vds-cleanup.timer vds-disk-alert.timer --no-pager'

# what the last daily check did:
ssh blog 'journalctl -u vds-disk-alert.service -n 30 --no-pager'

# end-to-end test of the Telegram alert (--threshold 0 forces the alert path):
ssh blog 'bash /opt/blog-app/ai-bot-tg/deploy/vds-cleanup.sh --alert --apply --threshold 0'
```

To change the threshold, re-run the installer with `--threshold N --apply`
(units are overwritten in place).

## After cleanup

Nothing needs restarting — only caches/logs are removed, not running state. The
script re-prints `df -h /` and the `is-active` status of both services at the
end so you can confirm they stayed up. If you ever do want a clean service
bounce, use `systemctl restart blog-newsbot` (the SQLite ledger survives it —
see [DEPLOY.md](DEPLOY.md) §6).

## Manual one-liners (if you'd rather not run the script)

```bash
ssh blog '
  df -h /
  du -xhd1 / | sort -h | tail          # find the biggest dirs
  journalctl --disk-usage
  journalctl --vacuum-time=14d --vacuum-size=200M
  apt-get clean && DEBIAN_FRONTEND=noninteractive apt-get autoremove --purge -y
  rm -rf /root/.npm/_cacache
  df -h /
'
```

Do **not** free space by deleting anything under `/opt/blog-app/*/data`, any
`.env*`, or Postgres — see the invariants above.
