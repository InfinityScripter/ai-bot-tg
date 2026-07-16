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

## Why it fills up (root cause)

Nothing is leaking — a few things simply **append forever and nothing caps them
by default**. On this box the recurring growers are:

- **systemd journal** — both services log on every poll / cron / publish, and
  journald's default cap is generous (up to ~4 GB), so it grows until it hits
  that. Usually the single biggest consumer when journald is persistent.
- **npm cache** (`/root/.npm/_cacache`) — every deploy runs `npm ci`, which
  fills the download cache; nothing prunes it, so it grows per deploy.
- **old kernels** — `apt` upgrades install a new kernel but keep the old ones
  until `autoremove` runs; each is ~200–400 MB.
- **old snap revisions** — snapd keeps 3 revisions by default, each a full
  squashfs image.
- rotated logs, coredumps, stale `/tmp` — minor and mostly self-bounded.

Run the dry-run (TL;DR step 1) to see the **actual** breakdown on the box —
`journalctl --disk-usage` and the `du` output name the real culprits.

## Stopping it at the source (prevention)

Reclaiming (above) is the mop; this is the tap. Two one-time steps turn the box
from "clean it by hand" into self-capping.

### 1. Cap the fast growers — `--harden` (run once)

Pins hard limits so the journal, coredumps, and snap can't balloon again. It
only writes size-cap config (no data deleted), so it needs no `--apply`:

```bash
ssh blog 'bash /opt/blog-app/ai-bot-tg/deploy/vds-cleanup.sh --harden'
# journald SystemMaxUse=200M · coredump MaxUse=200M · snap refresh.retain=2
```

Idempotent — safe to re-run. (`--journal-cap` does just the journal subset.)

### 2. Auto-sweep the slow growers — weekly timer (enable once)

Old kernels, npm cache, and rotated logs still accrue slowly; a systemd timer
runs `vds-cleanup.sh --apply` weekly so you never touch them by hand. The units
ship in this repo (`deploy/blog-cleanup.service` + `deploy/blog-cleanup.timer`);
once this change is deployed to the box, enable them one time:

```bash
ssh blog '
  cp /opt/blog-app/ai-bot-tg/deploy/blog-cleanup.service /etc/systemd/system/
  cp /opt/blog-app/ai-bot-tg/deploy/blog-cleanup.timer   /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now blog-cleanup.timer
  systemctl list-timers blog-cleanup.timer --no-pager   # confirm next run
'
```

The timer fires Sunday 04:00 (box time, plus ≤1h jitter), `Persistent=true` so a
missed run catches up after downtime. Inspect a run with
`journalctl -u blog-cleanup.service -n 40`. With both steps in place the box
stays bounded on its own — the periodic manual reclaim below becomes a fallback,
not a chore.

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

To stop this growth at the source instead of mopping it up, see
[Stopping it at the source](#stopping-it-at-the-source-prevention) above
(`--harden` + the weekly timer). `--days N` changes the log/tmp age threshold.

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
