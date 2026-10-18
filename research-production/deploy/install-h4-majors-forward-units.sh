#!/usr/bin/env bash
# One-time install of the H4 majors long forward paper ledger timer on the research server.
# Research only: public Bitget candles, no keys, no orders. Run as root from the deployed checkout:
#   sudo bash /opt/investment-research/current/research-production/deploy/install-h4-majors-forward-units.sh
# Remove: systemctl disable --now research-production-h4-majors-forward.timer
set -Eeuo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for unit in research-production-h4-majors-forward.service research-production-h4-majors-forward.timer; do
  install -o root -g root -m 0644 "$SRC/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now research-production-h4-majors-forward.timer
systemctl start research-production-h4-majors-forward.service || true
journalctl -u research-production-h4-majors-forward.service -n 30 --no-pager || true
echo "H4_MAJORS_FORWARD_TIMER_INSTALLED"
