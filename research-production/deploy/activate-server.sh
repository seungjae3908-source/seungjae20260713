#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-}"
TARGET_SHA="${TARGET_SHA:-}"
REPOSITORY_URL="${REPOSITORY_URL:-https://github.com/seungjae3908-source/seungjae20260713.git}"

if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "TARGET_SHA must be an exact lowercase 40-character SHA" >&2
  exit 64
fi

require_base_tools() {
  command -v git >/dev/null
  command -v node >/dev/null
  command -v systemctl >/dev/null
  command -v systemd-analyze >/dev/null
  if [[ "$(id -u)" -ne 0 ]]; then sudo -n true; fi
  local node_major
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  (( node_major >= 20 )) || {
    echo "Node >=20 required; found $(node --version)" >&2
    exit 70
  }
}

read_app_sha() {
  local state=/opt/stock-app/.deploy/current-sha
  if [[ -s "$state" ]]; then
    tr -d '[:space:]' < "$state"
  else
    printf 'absent'
  fi
}

resource_snapshot() {
  FREE_BYTES="$(df -PB1 / | awk 'NR==2 {print $4}')"
  FREE_INODES="$(df -Pi / | awk 'NR==2 {print $4}')"
  MEM_AVAILABLE_BYTES="$(awk '/MemAvailable:/ {print $2 * 1024}' /proc/meminfo)"
  CPU_CORES="$(nproc)"
  (( FREE_BYTES >= 5368709120 )) || {
    echo "Need at least 5 GiB free disk; have $FREE_BYTES" >&2
    exit 71
  }
  (( FREE_INODES >= 50000 )) || {
    echo "Need at least 50000 free inodes; have $FREE_INODES" >&2
    exit 72
  }
}

preflight() {
  require_base_tools
  resource_snapshot
  local app_sha
  app_sha="$(read_app_sha)"
  printf '%s\n' \
    "SERVER_PREFLIGHT=PASS" \
    "TARGET_SHA=$TARGET_SHA" \
    "NODE=$(node --version)" \
    "CPU_CORES=$CPU_CORES" \
    "MEM_AVAILABLE_BYTES=$MEM_AVAILABLE_BYTES" \
    "FREE_BYTES=$FREE_BYTES" \
    "FREE_INODES=$FREE_INODES" \
    "APP_SHA=$app_sha" \
    "LIVE_TRADING=false" \
    "PRIVATE_API=false" \
    "ORDER_AUTHORITY=false"
}

activate() {
  require_base_tools
  resource_snapshot

  if [[ "$(id -u)" -eq 0 ]]; then
    SUDO=()
  else
    SUDO=(sudo -n)
  fi

  ROOT=/opt/investment-research
  RELEASES="$ROOT/releases"
  RELEASE="$RELEASES/$TARGET_SHA"
  STAGED_RELEASE="$RELEASES/.staging-$TARGET_SHA-$$"
  CURRENT="$ROOT/current"
  NEXT_CURRENT="$ROOT/.current-$TARGET_SHA-$$"
  STATE=/var/lib/investment-research-production
  ENV_DIR=/etc/investment-research
  ENV_FILE="$ENV_DIR/research-production.env"
  APP_SHA_BEFORE="$(read_app_sha)"

  cleanup_transient() {
    "${SUDO[@]}" rm -rf -- "$STAGED_RELEASE" >/dev/null 2>&1 || true
    "${SUDO[@]}" rm -f -- "$NEXT_CURRENT" >/dev/null 2>&1 || true
  }

  fail_safe() {
    local status=$?
    if (( status != 0 )); then
      "${SUDO[@]}" systemctl disable --now \
        research-production-fast-historical.timer \
        research-production-long-history.timer \
        research-production-forward.timer >/dev/null 2>&1 || true
    fi
    cleanup_transient
    return "$status"
  }
  trap fail_safe EXIT

  release_is_valid() {
    local candidate="$1"
    [[ -d "$candidate" ]] || return 1
    "${SUDO[@]}" test -f "$candidate/research-production/bin/research-cycle.mjs" || return 1
    "${SUDO[@]}" test -f "$candidate/research-production/src/engine.mjs" || return 1
    "${SUDO[@]}" test -f "$candidate/research-production/deploy/research-production@.service" || return 1
    "${SUDO[@]}" test -f "$candidate/research-production/deploy/research-production-forward.timer" || return 1
    local candidate_sha
    candidate_sha="$("${SUDO[@]}" git -C "$candidate" rev-parse HEAD 2>/dev/null || true)"
    [[ "$candidate_sha" == "$TARGET_SHA" ]]
  }

  if ! id investment-research >/dev/null 2>&1; then
    "${SUDO[@]}" useradd --system --home /nonexistent --shell /usr/sbin/nologin investment-research
  fi
  "${SUDO[@]}" install -d -o root -g root -m 0755 "$ROOT" "$RELEASES"
  "${SUDO[@]}" install -d -o investment-research -g investment-research -m 0750 "$STATE"
  "${SUDO[@]}" install -d -o root -g investment-research -m 0750 "$ENV_DIR"

  if release_is_valid "$RELEASE"; then
    echo "RESEARCH_RELEASE_REUSED=true"
  else
    if [[ -e "$RELEASE" ]]; then
      echo "RESEARCH_RELEASE_REPAIR=required"
      "${SUDO[@]}" rm -rf -- "$RELEASE"
    fi
    cleanup_transient
    "${SUDO[@]}" git clone --quiet --filter=blob:none --no-checkout "$REPOSITORY_URL" "$STAGED_RELEASE"
    "${SUDO[@]}" git -C "$STAGED_RELEASE" fetch --quiet --depth 1 origin "$TARGET_SHA"
    local resolved
    resolved="$("${SUDO[@]}" git -C "$STAGED_RELEASE" rev-parse FETCH_HEAD^{commit})"
    [[ "$resolved" == "$TARGET_SHA" ]] || {
      echo "Exact SHA resolution mismatch" >&2
      exit 73
    }
    "${SUDO[@]}" git -C "$STAGED_RELEASE" checkout --quiet --detach "$TARGET_SHA"
    "${SUDO[@]}" chown -R root:root "$STAGED_RELEASE"
    if ! release_is_valid "$STAGED_RELEASE"; then
      echo "Staged Research release verification failed" >&2
      exit 75
    fi
    "${SUDO[@]}" mv -- "$STAGED_RELEASE" "$RELEASE"
    echo "RESEARCH_RELEASE_BUILT=true"
  fi

  if ! release_is_valid "$RELEASE"; then
    echo "Final Research release verification failed" >&2
    exit 76
  fi

  "${SUDO[@]}" rm -f -- "$NEXT_CURRENT"
  "${SUDO[@]}" ln -s -- "$RELEASE" "$NEXT_CURRENT"
  "${SUDO[@]}" mv -Tf -- "$NEXT_CURRENT" "$CURRENT"
  local resolved_current
  resolved_current="$(readlink -f "$CURRENT")"
  [[ "$resolved_current" == "$RELEASE" ]] || {
    echo "Research current symlink mismatch: expected=$RELEASE actual=$resolved_current" >&2
    exit 77
  }
  "${SUDO[@]}" test -f "$CURRENT/research-production/bin/research-cycle.mjs"
  local current_sha
  current_sha="$("${SUDO[@]}" git -C "$CURRENT" rev-parse HEAD)"
  [[ "$current_sha" == "$TARGET_SHA" ]] || {
    echo "Research current SHA mismatch: expected=$TARGET_SHA actual=$current_sha" >&2
    exit 78
  }

  local concurrency=1
  if (( CPU_CORES >= 4 && MEM_AVAILABLE_BYTES >= 4294967296 && FREE_BYTES >= 10737418240 )); then
    concurrency=4
  elif (( CPU_CORES >= 2 && MEM_AVAILABLE_BYTES >= 2147483648 )); then
    concurrency=2
  fi

  local env_tmp
  env_tmp="$(mktemp)"
  cat > "$env_tmp" <<ENV
RESEARCH_REPO_ROOT=$CURRENT
RESEARCH_STATE_ROOT=$STATE
RESEARCH_CODE_SHA=$TARGET_SHA
RESEARCH_CONCURRENCY=$concurrency
RESEARCH_MIN_FREE_BYTES=5368709120
LIVE_TRADING=false
LIVE_TRADING_ENABLED=false
REAL_ORDER_ENABLED=false
REAL_TRADING_ENABLED=false
PRIVATE_API_ENABLED=false
PRIVATE_ACCOUNT_ACCESS=false
PRIVATE_TRADING_API_ALLOWED=false
ORDER_AUTHORITY=false
ORDER_SUBMISSION_ENABLED=false
ENV
  "${SUDO[@]}" install -o root -g investment-research -m 0640 "$env_tmp" "$ENV_FILE"
  rm -f "$env_tmp"

  "${SUDO[@]}" install -o root -g root -m 0644 \
    "$CURRENT/research-production/deploy/research-production@.service" \
    /etc/systemd/system/research-production@.service
  local timer
  for timer in fast-historical long-history forward; do
    "${SUDO[@]}" install -o root -g root -m 0644 \
      "$CURRENT/research-production/deploy/research-production-$timer.timer" \
      "/etc/systemd/system/research-production-$timer.timer"
  done
  "${SUDO[@]}" systemctl daemon-reload

  local -a RUN_AS_RESEARCH
  if command -v runuser >/dev/null 2>&1; then
    RUN_AS_RESEARCH=(runuser -u investment-research --)
  else
    RUN_AS_RESEARCH=(sudo -n -u investment-research)
  fi

  "${RUN_AS_RESEARCH[@]}" env -i \
    PATH=/usr/local/bin:/usr/bin:/bin \
    HOME=/nonexistent \
    LANG=C.UTF-8 \
    TZ=UTC \
    RESEARCH_REPO_ROOT="$CURRENT" \
    RESEARCH_STATE_ROOT="$STATE" \
    RESEARCH_CODE_SHA="$TARGET_SHA" \
    RESEARCH_CONCURRENCY="$concurrency" \
    RESEARCH_MIN_FREE_BYTES=5368709120 \
    LIVE_TRADING=false \
    PRIVATE_API_ENABLED=false \
    ORDER_AUTHORITY=false \
    node "$CURRENT/research-production/bin/research-cycle.mjs" preflight \
      --repo-root "$CURRENT" \
      --state-root "$STATE" \
      --research-sha "$TARGET_SHA"

  "${SUDO[@]}" systemctl enable --now \
    research-production-fast-historical.timer \
    research-production-long-history.timer \
    research-production-forward.timer

  for timer in \
    research-production-fast-historical.timer \
    research-production-long-history.timer \
    research-production-forward.timer; do
    "${SUDO[@]}" systemctl is-enabled --quiet "$timer"
    "${SUDO[@]}" systemctl is-active --quiet "$timer"
  done

  local app_sha_after
  app_sha_after="$(read_app_sha)"
  [[ "$app_sha_after" == "$APP_SHA_BEFORE" ]] || {
    echo "Existing application deployment SHA changed unexpectedly" >&2
    exit 74
  }

  printf '%s\n' \
    "RESEARCH_PRODUCTION_ACTIVATED=true" \
    "TARGET_SHA=$TARGET_SHA" \
    "CURRENT_RELEASE=$resolved_current" \
    "CONCURRENCY=$concurrency" \
    "APP_SHA_BEFORE=$APP_SHA_BEFORE" \
    "APP_SHA_AFTER=$app_sha_after" \
    "LIVE_TRADING=false" \
    "PRIVATE_API=false" \
    "ORDER_AUTHORITY=false"

  "${SUDO[@]}" systemctl list-timers --all \
    research-production-fast-historical.timer \
    research-production-long-history.timer \
    research-production-forward.timer --no-pager
}

case "$MODE" in
  preflight) preflight ;;
  activate) activate ;;
  *)
    echo "usage: activate-server.sh {preflight|activate}" >&2
    exit 64
    ;;
esac
