#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# vds-cleanup-install.sh — one-time install of the disk-hygiene automation.
#
# vds-cleanup.sh only helps when someone remembers to run it; this installer
# makes the box maintain itself, so "disk at 92%, ssh barely usable" stops
# recurring. Plain systemd units, NO extra packages:
#
#   1. size caps              journald SystemMaxUse=200M, systemd-coredump
#                             MaxUse=200M, snap refresh.retain=2 — the
#                             unbounded growers can never balloon again
#   2. vds-cleanup.timer      weekly full `vds-cleanup.sh --apply` (Sun 05:30)
#   3. vds-disk-alert.timer   daily check (06:15): under the threshold it is a
#                             silent no-op; at/over it runs the full cleanup
#                             and DMs the owner through the bot's own Telegram
#                             token (see --alert in vds-cleanup.sh)
#
# Unit files are heredocs below — the single source of truth — so the installer
# also works piped over ssh from a checkout. ExecStart points at the DEPLOYED
# script (/opt/blog-app/ai-bot-tg/deploy/vds-cleanup.sh): install AFTER this
# branch reaches main (push to main auto-deploys), or the timers fail until
# the next deploy puts the script on the box.
#
# Idempotent: re-running overwrites the same files and re-enables the timers —
# that is also how you change the threshold later (--threshold N --apply).
#
# USAGE (dry-run by default, like vds-cleanup.sh; ssh alias `blog` = root)
#   preview:  ssh blog 'bash -s' < deploy/vds-cleanup-install.sh
#   install:  ssh blog 'bash /opt/blog-app/ai-bot-tg/deploy/vds-cleanup-install.sh --apply'
#   piped:    ssh blog 'bash -s -- --apply' < deploy/vds-cleanup-install.sh
#   remove:   ssh blog 'bash -s -- --apply --uninstall' < deploy/vds-cleanup-install.sh
#
# FLAGS
#   --apply         actually write/enable (default: read-only preview)
#   --threshold N   disk use% that arms the daily alert (default 85)
#   --uninstall     disable and remove the timers, units and the journald cap
#   -h, --help      show this help and exit
# ---------------------------------------------------------------------------

# Fail-soft like vds-cleanup.sh: report every step, never die halfway through
# an install — the final verification shows what actually landed.
set -uo pipefail

APPLY=0
UNINSTALL=0
THRESHOLD=85

BOT_DIR=/opt/blog-app/ai-bot-tg
CLEANUP_SH="$BOT_DIR/deploy/vds-cleanup.sh"
UNIT_DIR=/etc/systemd/system
# Same file `vds-cleanup.sh --journal-cap` writes — one cap, two entry points.
DROPIN=/etc/systemd/journald.conf.d/00-size-cap.conf
COREDUMP_DROPIN=/etc/systemd/coredump.conf.d/00-size-cap.conf

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)      APPLY=1 ;;
    --uninstall)  UNINSTALL=1 ;;
    --threshold)  shift; THRESHOLD="${1:?--threshold needs a number}" ;;
    -h|--help)    sed -n '2,/^# ------/p' "$0" 2>/dev/null \
                    || echo "[install] (piped run — help is the header of deploy/vds-cleanup-install.sh)"; exit 0 ;;
    *) echo "[install] unknown flag: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
case "$THRESHOLD" in *[!0-9]*|'') echo "[install] --threshold must be an integer percent" >&2; exit 2 ;; esac

say(){ printf '[install] %s\n' "$*"; }

run(){
  local desc="$1"; shift
  if [ "$APPLY" -eq 1 ]; then
    say "→ $desc"
    "$@" || say "  (FAILED: $desc — installer is idempotent, fix and re-run)"
  else
    say "[dry] would: $desc"
  fi
}

# write_file <path> — content on stdin. Dry mode prints the content, so the
# preview shows exactly what would land in /etc.
write_file(){
  local path="$1"
  if [ "$APPLY" -eq 1 ]; then
    say "→ write $path"
    { mkdir -p "$(dirname "$path")" && cat > "$path"; } \
      || say "  (FAILED: write $path)"
  else
    say "[dry] would write $path:"
    sed 's/^/[install]   | /'
  fi
}

say "mode: $([ "$APPLY" -eq 1 ] && echo APPLY || echo DRY-RUN\ preview)"

# --- Uninstall ---------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
  run "stop + disable vds-cleanup.timer"    systemctl disable --now vds-cleanup.timer
  run "stop + disable vds-disk-alert.timer" systemctl disable --now vds-disk-alert.timer
  run "remove unit files" rm -f \
    "$UNIT_DIR/vds-cleanup.service" "$UNIT_DIR/vds-cleanup.timer" \
    "$UNIT_DIR/vds-disk-alert.service" "$UNIT_DIR/vds-disk-alert.timer"
  run "remove journald cap" rm -f "$DROPIN"
  run "remove coredump cap" rm -f "$COREDUMP_DROPIN"
  if command -v snap >/dev/null 2>&1; then
    run "snap: restore default refresh.retain" snap unset system refresh.retain
  fi
  run "systemd daemon-reload" systemctl daemon-reload
  run "restart journald (drop the cap)" systemctl restart systemd-journald
  say "uninstall done."
  exit 0
fi

# --- Install -----------------------------------------------------------------
[ -f "$CLEANUP_SH" ] || say "WARNING: $CLEANUP_SH is not on the box yet — timers will fail until this branch is deployed (push to main auto-deploys); they recover on the next tick after that."

# 1) journald cap. The journal is the classic grower on this box; capping it
#    makes the weekly vacuum a formality instead of the only line of defence.
write_file "$DROPIN" <<'EOF'
[Journal]
SystemMaxUse=200M
EOF
run "restart systemd-journald (apply the cap)" systemctl restart systemd-journald

# 1b) coredump cap — crash dumps are unbounded by default. systemd-coredump
#     reads its config on every dump, so writing the drop-in is enough.
write_file "$COREDUMP_DROPIN" <<'EOF'
[Coredump]
MaxUse=200M
EOF

# 1c) snap keeps 3 full squashfs images of every snap by default; 2 is plenty
#     (current + one rollback). Persistent snapd setting, applied once.
if command -v snap >/dev/null 2>&1; then
  run "snap: keep only 2 revisions (refresh.retain=2)" snap set system refresh.retain=2
else
  say "[skip] snap not installed — no revision cap needed"
fi

# 2) weekly full cleanup
write_file "$UNIT_DIR/vds-cleanup.service" <<EOF
# Installed by ai-bot-tg/deploy/vds-cleanup-install.sh — edit THERE and re-run.
[Unit]
Description=VDS disk cleanup: journal/apt/npm caches, rotated logs (deploy/CLEANUP.md)

[Service]
Type=oneshot
ExecStart=/usr/bin/bash ${CLEANUP_SH} --apply
Nice=19
IOSchedulingClass=idle
EOF

write_file "$UNIT_DIR/vds-cleanup.timer" <<'EOF'
# Installed by ai-bot-tg/deploy/vds-cleanup-install.sh — edit THERE and re-run.
[Unit]
Description=Weekly VDS disk cleanup

[Timer]
OnCalendar=Sun *-*-* 05:30
RandomizedDelaySec=20m
Persistent=true

[Install]
WantedBy=timers.target
EOF

# 3) daily threshold check + owner DM ("percent" spelled out: % is a systemd
#    specifier inside unit files, not worth escaping in a Description)
write_file "$UNIT_DIR/vds-disk-alert.service" <<EOF
# Installed by ai-bot-tg/deploy/vds-cleanup-install.sh — edit THERE and re-run.
[Unit]
Description=Daily VDS disk check: auto-clean and DM the owner when over ${THRESHOLD} percent

[Service]
Type=oneshot
ExecStart=/usr/bin/bash ${CLEANUP_SH} --alert --apply --threshold ${THRESHOLD}
Nice=19
IOSchedulingClass=idle
EOF

write_file "$UNIT_DIR/vds-disk-alert.timer" <<'EOF'
# Installed by ai-bot-tg/deploy/vds-cleanup-install.sh — edit THERE and re-run.
[Unit]
Description=Daily VDS disk usage check

[Timer]
OnCalendar=*-*-* 06:15
RandomizedDelaySec=20m
Persistent=true

[Install]
WantedBy=timers.target
EOF

run "systemd daemon-reload" systemctl daemon-reload
run "enable + start vds-cleanup.timer"    systemctl enable --now vds-cleanup.timer
run "enable + start vds-disk-alert.timer" systemctl enable --now vds-disk-alert.timer

# --- Verify --------------------------------------------------------------------
if [ "$APPLY" -eq 1 ]; then
  say "installed. Next runs:"
  systemctl list-timers vds-cleanup.timer vds-disk-alert.timer --no-pager 2>/dev/null || true
  say "test the Telegram alert end-to-end (--threshold 0 forces the alert path):"
  say "  bash $CLEANUP_SH --alert --apply --threshold 0"
else
  say "DRY-RUN preview complete. Re-run with --apply to install."
fi
