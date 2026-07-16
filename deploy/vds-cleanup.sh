#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# vds-cleanup.sh — reclaim disk on the blog VDS, safely and idempotently.
#
# WHY THIS EXISTS
#   The VDS is a small box (see deploy/RUNBOOK.md — the full dev toolchain OOMs
#   it). It runs two long-lived systemd services (blog-backend, blog-newsbot)
#   plus Postgres and nginx, and a long-running box accumulates disk in a small
#   set of predictable, throwaway places: the systemd journal, apt's .deb cache
#   and superseded kernels, npm's cache, rotated logs, coredumps, stale /tmp.
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
#   --harden        apply durable caps so growth stops at the SOURCE. Writes
#                   size-cap config only (no data deleted), so it applies on its
#                   own — no --apply needed. Idempotent, run once via ssh:
#                   journald SystemMaxUse=200M, coredump MaxUse=200M,
#                   snap refresh.retain=2. Pairs with the weekly cleanup timer;
#                   see deploy/CLEANUP.md "Stopping it at the source".
#   --journal-cap   just the journald cap (a subset of --harden)
#   --days N        age threshold for rotated logs / tmp (default 14 / 10)
#   -h, --help      show this help and exit
# ---------------------------------------------------------------------------

# NOT `set -e`: cleanup must be fail-soft — we handle failures per-step so one
# missing tool or busy file never aborts the whole reclaim.
set -uo pipefail

APPLY=0
JOURNAL_CAP=0
HARDEN=0
LOG_DAYS=14
TMP_DAYS=10

BOT_DIR=/opt/blog-app/ai-bot-tg
BACKEND_DIR=/opt/blog-app/backend

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)        APPLY=1 ;;
    --harden)       HARDEN=1 ;;
    --journal-cap)  JOURNAL_CAP=1 ;;
    --days)         shift; LOG_DAYS="${1:?--days needs a number}"; TMP_DAYS="$1" ;;
    -h|--help)      sed -n '2,/^# ---/p' "$0"; exit 0 ;;
    *) echo "[cleanup] unknown flag: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

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
    */.npm/_cacache|/var/lib/systemd/coredump) ;;  # allow-list
    *) say "  (refused unsafe rm: $p)"; return 0 ;;
  esac
  [ -e "$p" ] || return 0
  apply_or_echo "remove $p" rm -rf -- "$p"
}

df_root(){ df -h / | awk 'NR==1||NR==2'; }

# ---------------------------------------------------------------------------
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

# --- 3. npm caches (root + www-data) ---------------------------------------
# Deploys run `npm ci --omit=dev`, whose download cache (~/.npm/_cacache) grows
# unbounded. It is pure cache — npm refetches on the next install.
hr "npm download caches"
for u in root www-data; do
  home="$(getent passwd "$u" 2>/dev/null | cut -d: -f6)"
  [ -n "${home:-}" ] || continue
  safe_rm_rf "$home/.npm/_cacache"
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

# --- 10. durable caps: stop the fast growers at the source -----------------
# WHY: the reclaim steps above are a mop; these are the tap. journald defaults
# to a generous cap (up to ~4G), snapd keeps 3 old revisions, coredumps are
# uncapped — so all three creep back after every cleanup. Pinning hard limits
# means the fast growers self-bound in real time and you stop needing manual
# sweeps for them. These ONLY add size limits (no application data is deleted),
# so — unlike the reclaim steps — they apply on their own, without --apply.
# Idempotent: safe to re-run; the intent is "run once via ssh blog".
if [ "$HARDEN" -eq 1 ] || [ "$JOURNAL_CAP" -eq 1 ]; then
  hr "durable cap: journald SystemMaxUse=200M"
  { mkdir -p /etc/systemd/journald.conf.d \
      && printf '[Journal]\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/00-size-cap.conf \
      && systemctl restart systemd-journald \
      && say "→ journald capped at 200M (drop-in written, journald restarted)"; } \
    || say "  (ignored failure: journald cap)"
fi

if [ "$HARDEN" -eq 1 ]; then
  hr "durable cap: coredump MaxUse=200M"
  # systemd-coredump reads this per-dump — no restart needed.
  { mkdir -p /etc/systemd/coredump.conf.d \
      && printf '[Coredump]\nMaxUse=200M\n' > /etc/systemd/coredump.conf.d/00-size-cap.conf \
      && say "→ coredump storage capped at 200M"; } \
    || say "  (ignored failure: coredump cap)"

  if command -v snap >/dev/null 2>&1; then
    hr "durable cap: snap refresh.retain=2 (fewer old squashfs revisions)"
    { snap set system refresh.retain=2 \
        && say "→ snapd now keeps only 2 revisions per snap"; } \
      || say "  (ignored failure: snap retain)"
  fi
fi

# --- Report ----------------------------------------------------------------
hr "disk after"
df_root

hr "service health (cleanup should not have disturbed these)"
for svc in blog-newsbot blog-backend; do
  say "$svc: $(systemctl is-active "$svc" 2>/dev/null || echo unknown)"
done

if [ "$HARDEN" -eq 1 ]; then
  say "Hardening applied — journal/coredump/snap now self-cap. For hands-off"
  say "upkeep of the slow growers (kernels, npm cache, logs), enable the weekly"
  say "sweep timer: see deploy/CLEANUP.md \"Stopping it at the source\"."
fi
if [ "$APPLY" -eq 0 ]; then
  say "DRY-RUN complete. Re-run with --apply to reclaim the space above."
else
  say "Cleanup complete. Nothing stateful was touched (.env / SQLite ledger / Postgres intact)."
fi
