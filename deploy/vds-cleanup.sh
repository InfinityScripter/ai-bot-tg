#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# vds-cleanup.sh — reclaim disk on the blog VDS, safely and idempotently.
#
# WHY THIS EXISTS
#   The VDS is a small box (see deploy/RUNBOOK.md — the full dev toolchain OOMs
#   it). It runs two long-lived systemd services (blog-backend, blog-newsbot)
#   plus Postgres and nginx, and a long-running box accumulates disk in a small
#   set of predictable, throwaway places: the systemd journal, apt's .deb cache
#   and superseded kernels, npm's and yarn's caches, stale VS Code Remote
#   server builds, rotated logs, coredumps, stale /tmp.
#   This script reports and reclaims exactly those — and NOTHING that holds
#   state. It is the thing to run behind `ssh blog` when disk gets tight.
#
# HARD SAFETY INVARIANTS (this script never violates them):
#   * never touches any .env / .env.production            (secrets + config)
#   * never touches /opt/blog-app/ai-bot-tg/data/*        (SQLite dedup ledger)
#   * never touches Postgres data or any application DB
#   * never removes a service's runtime node_modules
#   * dry-run by DEFAULT; deletions happen only with --apply
#   * every step is fail-soft: one failure logs and the run continues
#     (mirrors the codebase's fail-soft boundaries — see CLAUDE.md)
#
# USAGE  (the `blog` ssh alias is root@185.237.219.151:3333)
#   Diagnose only (default — read-only, shows what WOULD be freed):
#     ssh blog 'bash -s' < deploy/vds-cleanup.sh
#   Actually reclaim space:
#     ssh blog 'bash -s -- --apply' < deploy/vds-cleanup.sh
#   Once this branch is deployed, the script already lives on the box:
#     ssh blog 'bash /opt/blog-app/ai-bot-tg/deploy/vds-cleanup.sh --apply'
#
# FLAGS
#   --apply         perform deletions (default is a read-only report)
#   --journal-cap   also pin journald to SystemMaxUse=200M so it can't regrow
#                   (writes a drop-in and restarts systemd-journald)
#   --days N        age threshold for rotated logs / tmp (default 14 / 10)
#   --alert         threshold mode (what vds-disk-alert.timer runs daily):
#                   exit quietly while / is under --threshold; at/over it run
#                   the normal cleanup, then DM the owner through the bot's
#                   own Telegram token from .env.production (DM needs --apply)
#   --threshold N   disk use% that arms --alert (default 85)
#   -h, --help      show this help and exit
#
# PREVENTION (one-time): deploy/vds-cleanup-install.sh installs a weekly
# cleanup timer, a daily --alert check and the journald size cap, so the box
# keeps itself clean unattended. Details: deploy/CLEANUP.md.
# ---------------------------------------------------------------------------

# NOT `set -e`: cleanup must be fail-soft — we handle failures per-step so one
# missing tool or busy file never aborts the whole reclaim.
set -uo pipefail

APPLY=0
JOURNAL_CAP=0
LOG_DAYS=14
TMP_DAYS=10
ALERT=0
THRESHOLD=85

BOT_DIR=/opt/blog-app/ai-bot-tg
BACKEND_DIR=/opt/blog-app/backend

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)        APPLY=1 ;;
    --journal-cap)  JOURNAL_CAP=1 ;;
    --days)         shift; LOG_DAYS="${1:?--days needs a number}"; TMP_DAYS="$1" ;;
    --alert)        ALERT=1 ;;
    --threshold)    shift; THRESHOLD="${1:?--threshold needs a number}" ;;
    -h|--help)      sed -n '2,/^# ------/p' "$0" 2>/dev/null \
                      || echo "[cleanup] (piped run — help is the header of deploy/vds-cleanup.sh)"; exit 0 ;;
    *) echo "[cleanup] unknown flag: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
case "$THRESHOLD" in *[!0-9]*|'') echo "[cleanup] --threshold must be an integer percent" >&2; exit 2 ;; esac

say(){ printf '[cleanup] %s\n' "$*"; }
hr(){  printf '[cleanup] --- %s\n' "$*"; }

# apply_or_echo "human description" cmd arg...   — runs the command as an argv
# array (no shell parsing, so globs/quotes are never re-interpreted) in --apply
# mode, or just prints the intent in dry mode. Failures are logged, not fatal.
apply_or_echo(){
  local desc="$1"; shift
  if [ "$APPLY" -eq 1 ]; then
    say "→ $desc"
    "$@" || say "  (ignored failure: $desc)"
  else
    say "[dry] would: $desc"
  fi
}

# Defence-in-depth for the two rm-based steps: refuse any path that isn't an
# expected throwaway cache/coredump dir, so a future edit can't fat-finger a
# protected path into an rm -rf.
safe_rm_rf(){
  local p="$1"
  case "$p" in
    */.npm/_cacache|*/.cache/yarn|/var/lib/systemd/coredump) ;;   # caches / dumps
    */.vscode-server/bin/*|*/.vscode-server/cli/servers/*) ;;     # old editor servers
    *) say "  (refused unsafe rm: $p)"; return 0 ;;
  esac
  [ -e "$p" ] || return 0
  apply_or_echo "remove $p" rm -rf -- "$p"
}

df_root(){ df -h / | awk 'NR==1||NR==2'; }
disk_pct(){ df -P / | awk 'NR==2 { gsub(/%/, "", $5); print $5 }'; }

# DM the owner through the bot's own Telegram token — no new secrets on the
# box; both vars are read straight from the bot's .env.production (values are
# unquoted there, see DEPLOY.md §3). Fail-soft: a missing file/var or a network
# hiccup only logs — the cleanup itself has already happened by this point.
notify_owner(){
  local text="$1" env_file="$BOT_DIR/.env.production" token chat_id
  [ -r "$env_file" ] || { say "(no $env_file — skipping Telegram notify)"; return 0; }
  token="$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$env_file" | cut -d= -f2- | tr -d '\r')"
  chat_id="$(grep -m1 '^OWNER_TELEGRAM_ID=' "$env_file" | cut -d= -f2- | tr -d '\r')"
  if [ -z "$token" ] || [ -z "$chat_id" ]; then
    say "(TELEGRAM_BOT_TOKEN / OWNER_TELEGRAM_ID not in env — skipping notify)"; return 0
  fi
  curl -fsS -m 15 -o /dev/null -X POST "https://api.telegram.org/bot${token}/sendMessage" \
      --data-urlencode "chat_id=${chat_id}" --data-urlencode "text=${text}" \
    && say "owner notified in Telegram" \
    || say "(ignored failure: Telegram notify)"
}

# ---------------------------------------------------------------------------
# Alert-mode gate (what vds-disk-alert.timer runs daily): below the threshold
# this must stay a one-line no-op in the journal; at/over it we fall through
# to the normal cleanup and report the outcome to the owner at the very end.
USE_BEFORE="$(disk_pct)"
if [ "$ALERT" -eq 1 ]; then
  if [ "${USE_BEFORE:-0}" -lt "$THRESHOLD" ]; then
    say "alert: / at ${USE_BEFORE}% < threshold ${THRESHOLD}% — nothing to do"
    exit 0
  fi
  say "alert: / at ${USE_BEFORE}% >= threshold ${THRESHOLD}% — running full cleanup"
fi

say "mode: $([ "$APPLY" -eq 1 ] && echo APPLY\ \(will\ delete\) || echo DRY-RUN\ \(read-only\))"
say "protected and never touched: *.env.production, $BOT_DIR/data (SQLite ledger), Postgres, runtime node_modules"
[ -d "$BOT_DIR" ] || say "WARNING: $BOT_DIR not found — is this the right box? Doing generic cleanup only."

hr "disk before"
df_root

# --- Diagnosis (always runs, read-only) ------------------------------------
hr "biggest consumers under / (one filesystem, depth 1)"
du -xhd1 / 2>/dev/null | sort -h | tail -12
hr "biggest consumers under /var"
du -xhd1 /var 2>/dev/null | sort -h | tail -10
hr "systemd journal on disk"
journalctl --disk-usage 2>/dev/null || say "journalctl unavailable"

# --- 1. systemd journal ----------------------------------------------------
# Usually the #1 hog on a long-lived box. Rotate then vacuum by both age and
# size so we always leave a bounded, recent tail for debugging.
hr "journal vacuum (keep <= ${LOG_DAYS}d and <= 200M)"
apply_or_echo "rotate active journal"      journalctl --rotate
apply_or_echo "vacuum journal to ${LOG_DAYS}d" journalctl --vacuum-time="${LOG_DAYS}d"
apply_or_echo "vacuum journal to 200M"     journalctl --vacuum-size=200M

# --- 2. apt: .deb cache + superseded kernels/orphans -----------------------
if command -v apt-get >/dev/null 2>&1; then
  hr "apt cache + orphaned packages / old kernels"
  apply_or_echo "apt-get clean (drop cached .debs)" apt-get clean
  # autoremove --purge is what actually frees old kernels under /boot, the other
  # classic space sink. Non-interactive so it never blocks on a prompt.
  apply_or_echo "apt-get autoremove --purge (old kernels/orphans)" \
    env DEBIAN_FRONTEND=noninteractive apt-get autoremove --purge -y
fi

# --- 3. npm + yarn caches (real homes + HOME-less orphan dirs) --------------
# Deploys run `npm ci --omit=dev`, whose download cache (~/.npm/_cacache) grows
# unbounded. The blog backend additionally uses yarn, whose cache keeps SWC
# binaries for every platform/arch — it alone hit 2 GB in the July 2026
# incident. Both are pure caches; the next install refetches what it needs.
#
# THE BLIND SPOT (fixed here): the backend deploy SSHes in non-login, so during
# `yarn install` $HOME can be unset — yarn then falls back to a GLOBAL cache
# under /usr/local/share, a path no getent-passwd home points at. That orphan
# `/usr/local/share/.cache/yarn` grew to 1.8 GB and this sweep never saw it
# (2026-07-23). We now also clean the well-known HOME-less fallback roots.
# Source-side fix lives in the workflow (pins YARN_CACHE_FOLDER); this is the
# belt-and-braces so a stray env can never silently refill the disk again.
hr "npm + yarn download caches"
cache_homes="$(for u in root www-data; do getent passwd "$u" 2>/dev/null | cut -d: -f6; done)"
# HOME-less yarn/npm fallbacks + the / and /root shells non-login sessions land in
cache_homes="$cache_homes
/usr/local/share
/usr/share
/"
printf '%s\n' "$cache_homes" | sort -u | while read -r home; do
  [ -n "${home:-}" ] || continue
  safe_rm_rf "$home/.npm/_cacache"
  safe_rm_rf "$home/.cache/yarn"
done

# --- 3b. stale VS Code Remote server builds ----------------------------------
# Every VS Code Remote-SSH auto-update drops another ~580 MB server build under
# ~/.vscode-server and never prunes old ones — 2.3 GB across 4 versions in the
# July 2026 incident, and 1.8 GB across 3 versions by 2026-07-23 (none older
# than a week, so the old >7d gate kept ALL of them on a 9.6 GB box). Keep the
# newest per layout (bin/ = legacy, cli/servers/ = current) — that's the one an
# active session uses — and prune every OLDER build after 2 days: deleting a
# non-current dir can't break a live session on Linux (open fds survive), and
# VS Code re-downloads on demand. VSCODE_KEEP_DAYS overrides the age.
VSCODE_KEEP_DAYS="${VSCODE_KEEP_DAYS:-2}"
prune_vscode(){
  local base="$1" newest d
  [ -d "$base" ] || return 0
  newest="$(ls -1t "$base" 2>/dev/null | head -1)"
  for d in "$base"/*/; do
    d="${d%/}"
    [ -d "$d" ] || continue
    if [ "$(basename "$d")" = "$newest" ]; then
      say "[keep] newest VS Code server: $d"
      continue
    fi
    # newest is already kept above; only superseded builds reach here. Leave one
    # touched within VSCODE_KEEP_DAYS (a just-superseded update may still settle).
    [ -n "$(find "$d" -maxdepth 0 -mtime "+${VSCODE_KEEP_DAYS}" 2>/dev/null)" ] \
      || { say "[keep] recent (<${VSCODE_KEEP_DAYS}d): $d"; continue; }
    safe_rm_rf "$d"
  done
}
hr "stale VS Code Remote server versions"
for u in root www-data; do
  home="$(getent passwd "$u" 2>/dev/null | cut -d: -f6)"
  [ -n "${home:-}" ] || continue
  prune_vscode "$home/.vscode-server/bin"
  prune_vscode "$home/.vscode-server/cli/servers"
done

# --- 4. rotated / compressed logs ------------------------------------------
# Only touch clearly-rotated artifacts (*.gz, *.old, foo.log.1) older than the
# threshold. Live logs and the current *.log are never deleted; logrotate keeps
# managing them.
hr "rotated logs older than ${LOG_DAYS}d under /var/log"
apply_or_echo "prune rotated logs >${LOG_DAYS}d" \
  find /var/log -type f \( -name '*.gz' -o -name '*.old' -o -regex '.*\.[0-9]+' \) -mtime "+${LOG_DAYS}" -delete

# --- 5. coredumps ----------------------------------------------------------
if [ -d /var/lib/systemd/coredump ]; then
  hr "systemd coredumps"
  safe_rm_rf /var/lib/systemd/coredump
fi

# --- 6. snap: drop disabled (old) revisions --------------------------------
if command -v snap >/dev/null 2>&1; then
  hr "old snap revisions"
  # `snap list --all` marks superseded revisions "disabled"; each is a full
  # squashfs image that can be removed with no effect on the active snap.
  snap list --all 2>/dev/null | awk '/disabled/{print $1" "$3}' | while read -r name rev; do
    [ -n "$name" ] || continue
    apply_or_echo "remove old snap $name (rev $rev)" snap remove "$name" --revision="$rev"
  done
fi

# --- 7. docker: images/build cache (NEVER volumes) -------------------------
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  hr "docker images / build cache"
  # Deliberately omit --volumes: a named volume could hold real data.
  apply_or_echo "docker system prune -af (no volumes)" docker system prune -af
fi

# --- 8. stale temp files ---------------------------------------------------
hr "temp files older than ${TMP_DAYS}d"
apply_or_echo "prune /tmp >${TMP_DAYS}d"     find /tmp     -xdev -type f -mtime "+${TMP_DAYS}" -delete
apply_or_echo "prune /var/tmp >${TMP_DAYS}d" find /var/tmp -xdev -type f -mtime "+${TMP_DAYS}" -delete

# --- 9. git gc in the deploy repos -----------------------------------------
# Repack loose objects a long history of `git reset --hard origin/main` deploys
# leaves behind. Run as the dir OWNER so we never leave root-owned objects that
# would break the service's next git-pull deploy.
gc_repo(){
  local dir="$1" owner
  [ -d "$dir/.git" ] || { say "[skip] git gc: no repo at $dir"; return 0; }
  owner="$(stat -c %U "$dir" 2>/dev/null || echo root)"
  if [ "$APPLY" -eq 1 ]; then
    say "→ git gc in $dir (as $owner)"
    runuser -u "$owner" -- git -C "$dir" gc --prune=now --quiet 2>/dev/null \
      || say "  (ignored failure: git gc $dir)"
  else
    say "[dry] would: git gc --prune=now in $dir (as $owner)"
  fi
}
hr "git gc in deploy repos"
gc_repo "$BOT_DIR"
gc_repo "$BACKEND_DIR"

# --- 10. optional: cap journald so it can't regrow -------------------------
if [ "$JOURNAL_CAP" -eq 1 ]; then
  hr "pin journald to SystemMaxUse=200M (persistent drop-in)"
  if [ "$APPLY" -eq 1 ]; then
    say "→ write /etc/systemd/journald.conf.d/00-size-cap.conf and restart journald"
    { mkdir -p /etc/systemd/journald.conf.d \
        && printf '[Journal]\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/00-size-cap.conf \
        && systemctl restart systemd-journald ; } \
      || say "  (ignored failure: journald cap)"
  else
    say "[dry] would: write journald.conf.d/00-size-cap.conf (SystemMaxUse=200M) + restart journald"
  fi
fi

# --- Report ----------------------------------------------------------------
hr "disk after"
df_root

hr "service health (cleanup should not have disturbed these)"
for svc in blog-newsbot blog-backend; do
  say "$svc: $(systemctl is-active "$svc" 2>/dev/null || echo unknown)"
done

if [ "$APPLY" -eq 0 ]; then
  say "DRY-RUN complete. Re-run with --apply to reclaim the space above."
else
  say "Cleanup complete. Nothing stateful was touched (.env / SQLite ledger / Postgres intact)."
fi

# --- Alert-mode outcome → owner DM ------------------------------------------
# Only with --apply (a dry alert run just prints the report above). The texts
# are owner-facing → Russian, like every user-visible bot string (CLAUDE.md).
if [ "$ALERT" -eq 1 ] && [ "$APPLY" -eq 1 ]; then
  USE_AFTER="$(disk_pct)"
  if [ "${USE_AFTER:-100}" -lt "$THRESHOLD" ]; then
    notify_owner "⚠️ VDS: диск был заполнен на ${USE_BEFORE}% — автоочистка вернула ${USE_AFTER}%. Делать ничего не нужно."
  else
    notify_owner "🔴 VDS: диск заполнен на ${USE_AFTER}% (было ${USE_BEFORE}%, порог ${THRESHOLD}%) — автоочистка не помогла, нужно смотреть вручную: ssh blog 'bash ${BOT_DIR}/deploy/vds-cleanup.sh' покажет, что именно съело место (см. deploy/CLEANUP.md)."
  fi
fi
