#!/usr/bin/env bash
# Installs a systemd timer that runs deploy/auto-update.sh every couple of minutes,
# so pushing to main on GitHub redeploys this server on its own.
#
#   sudo deploy/install-auto-update.sh              check every 2 minutes
#   sudo deploy/install-auto-update.sh 5min         check every 5 minutes
#   sudo deploy/install-auto-update.sh --uninstall  remove it again
#
# Run it with sudo from the account that owns this checkout and can use docker.

set -euo pipefail

NAME=wow-forever-update
UNIT_DIR=/etc/systemd/system

if [ "$(id -u)" != 0 ]; then
  echo "Run with sudo: sudo $0 $*" >&2
  exit 1
fi

if [ "${1:-}" = --uninstall ]; then
  systemctl disable --now "$NAME.timer" 2>/dev/null || true
  rm -f "$UNIT_DIR/$NAME.service" "$UNIT_DIR/$NAME.timer"
  systemctl daemon-reload
  echo "Removed the auto-update timer."
  exit 0
fi

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
user="${SUDO_USER:-}"
interval="${1:-2min}"

if [ -z "$user" ] || [ "$user" = root ]; then
  echo "Run this with sudo from your normal account (the one that owns $repo), not as root." >&2
  exit 1
fi
if [ "$(stat -c %U "$repo")" != "$user" ]; then
  echo "$repo is owned by $(stat -c %U "$repo"), not $user. Run the installer as that user (with sudo)." >&2
  exit 1
fi
if ! id -nG "$user" | tr ' ' '\n' | grep -qx docker; then
  echo "$user isn't in the docker group, so the timer couldn't run docker compose." >&2
  echo "Fix with: sudo usermod -aG docker $user" >&2
  exit 1
fi
if ! [[ "$interval" =~ ^[0-9]+(s|min|h)$ ]]; then
  echo "Interval must look like 90s, 2min or 1h (got \"$interval\")." >&2
  exit 1
fi

cat > "$UNIT_DIR/$NAME.service" <<EOF
[Unit]
Description=Redeploy wow-forever-tracker when main changes on GitHub
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
User=$user
WorkingDirectory=$repo
ExecStart=/bin/bash $repo/deploy/auto-update.sh
TimeoutStartSec=15min
EOF

cat > "$UNIT_DIR/$NAME.timer" <<EOF
[Unit]
Description=Check GitHub for wow-forever-tracker updates every $interval

[Timer]
OnBootSec=2min
OnUnitInactiveSec=$interval
AccuracySec=10s
RandomizedDelaySec=10s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "$NAME.timer"
systemctl start "$NAME.service" || true

echo
echo "Auto-update is on: $repo checks origin/main every $interval as $user."
echo "  Watch deploys:  journalctl -u $NAME -f"
echo "  Next check:     systemctl list-timers $NAME"
echo "  Run one now:    sudo systemctl start $NAME"
echo "  Remove it:      sudo $0 --uninstall"
