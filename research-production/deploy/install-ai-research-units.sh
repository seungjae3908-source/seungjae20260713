#!/usr/bin/env bash
set -Eeuo pipefail

RESEARCH_RELEASE_ROOT="${RESEARCH_RELEASE_ROOT:-/opt/investment-research/current}"
if [[ ! -d "$RESEARCH_RELEASE_ROOT" ]]; then
  echo "Research release root is missing: $RESEARCH_RELEASE_ROOT" >&2
  exit 64
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  sudo -n true
  SUDO=(sudo -n)
fi

units=(
  research-production-ai-review.service
  research-production-ai-review.timer
  research-production-video-discovery.service
  research-production-video-discovery.timer
  research-production-approved-job-intake.service
  research-production-approved-job-intake.timer
  research-production-workspace-worker.service
)

if systemctl is-enabled --quiet research-production-workspace-worker.service 2>/dev/null ||
   systemctl is-active --quiet research-production-workspace-worker.service 2>/dev/null; then
  echo "Refusing implicit activation: research-production-workspace-worker.service is already active/enabled" >&2
  exit 68
fi

for unit in "${units[@]}"; do
  source_path="$RESEARCH_RELEASE_ROOT/research-production/deploy/$unit"
  [[ -f "$source_path" ]] || { echo "Missing unit: $source_path" >&2; exit 65; }
  systemd-analyze verify "$source_path" >/dev/null
done

# Refuse to rewrite unit definitions while a prior timer is active/enabled.
# This check happens before any /etc/systemd/system mutation.
for timer in research-production-ai-review.timer research-production-video-discovery.timer research-production-approved-job-intake.timer; do
  if systemctl is-enabled --quiet "$timer" 2>/dev/null; then
    echo "Refusing implicit activation: $timer is already enabled" >&2
    exit 66
  fi
  if systemctl is-active --quiet "$timer" 2>/dev/null; then
    echo "Refusing implicit activation: $timer is already active" >&2
    exit 67
  fi
done

for unit in "${units[@]}"; do
  source_path="$RESEARCH_RELEASE_ROOT/research-production/deploy/$unit"
  "${SUDO[@]}" install -o root -g root -m 0644 "$source_path" "/etc/systemd/system/$unit"
done
"${SUDO[@]}" systemctl daemon-reload

printf '%s\n'   "RESEARCH_AI_UNITS_INSTALLED=true"   "AI_REVIEW_TIMER_ENABLED=false"   "VIDEO_DISCOVERY_TIMER_ENABLED=false"   "APPROVED_JOB_INTAKE_TIMER_ENABLED=false"   "WORKSPACE_WORKER_ENABLED=false"   "LIVE_TRADING=false"   "PRIVATE_TRADING_API_ALLOWED=false"   "REAL_ORDER_ENABLED=false"   "executionAuthority=NONE"
