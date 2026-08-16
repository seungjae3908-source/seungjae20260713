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
  CURRENT="$ROOT/current"
  STATE=/var/lib/investment-research-production
  ENV_DIR=/etc/investment-research
  ENV_FILE="$ENV_DIR/research-production.env"
  SOURCE_DIR="$(mktemp -d /tmp/investment-research-source.XXXXXX)"
  RELEASE_TMP=""
  APP_SHA_BEFORE="$(read_app_sha)"
  PREVIOUS_CURRENT=""
  CURRENT_SWITCHED=false

  validate_release() {
    local candidate="$1"
    [[ -n "$candidate" && -d "$candidate" ]] || return 1
    [[ -f "$candidate/research-production/bin/research-cycle.mjs" ]] || return 1
    [[ -f "$candidate/research-production/deploy/research-production@.service" ]] || return 1
    [[ -f "$candidate/research-production/deploy/research-production-fast-historical.timer" ]] || return 1
    [[ -f "$candidate/research-production/deploy/research-production-long-history.timer" ]] || return 1
    [[ -f "$candidate/research-production/deploy/research-production-forward.timer" ]] || return 1
    [[ -d "$candidate/.git" ]] || return 1
    local candidate_sha
    candidate_sha="$(git -C "$candidate" rev-parse HEAD^{commit} 2>/dev/null || true)"
    [[ "$candidate_sha" == "$TARGET_SHA" ]]
  }

  local existing_current
  existing_current="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  if validate_release "$existing_current"; then
    PREVIOUS_CURRENT="$existing_current"
  fi

  rollback_current() {
    if [[ "$CURRENT_SWITCHED" != true ]]; then
      return 0
    fi
    if [[ -n "$PREVIOUS_CURRENT" ]] && validate_release "$PREVIOUS_CURRENT"; then
      "${SUDO[@]}" ln -sfn "$PREVIOUS_CURRENT" "$ROOT/current.rollback"
      "${SUDO[@]}" mv -Tf "$ROOT/current.rollback" "$CURRENT"
    else
      "${SUDO[@]}" rm -f -- "$CURRENT"
    fi
    CURRENT_SWITCHED=false
  }

  fail_safe() {
    local status=$?
    if (( status != 0 )); then
      "${SUDO[@]}" systemctl disable --now \
        research-production-fast-historical.timer \
        research-production-long-history.timer \
        research-production-forward.timer >/dev/null 2>&1 || true
      rollback_current || true
    fi
    if [[ -n "${RELEASE_TMP:-}" ]]; then
      "${SUDO[@]}" rm -rf -- "$RELEASE_TMP" >/dev/null 2>&1 || true
    fi
    rm -rf -- "${SOURCE_DIR:-}"
    return "$status"
  }
  trap fail_safe EXIT

  git clone --quiet --filter=blob:none --no-checkout "$REPOSITORY_URL" "$SOURCE_DIR"
  git -C "$SOURCE_DIR" fetch --quiet --depth 1 origin "$TARGET_SHA"
  local resolved
  resolved="$(git -C "$SOURCE_DIR" rev-parse FETCH_HEAD^{commit})"
  [[ "$resolved" == "$TARGET_SHA" ]] || {
    echo "Exact SHA resolution mismatch" >&2
    exit 73
  }
  git -C "$SOURCE_DIR" checkout --quiet --detach "$TARGET_SHA"

  local concurrency=1
  if (( CPU_CORES >= 4 && MEM_AVAILABLE_BYTES >= 4294967296 && FREE_BYTES >= 10737418240 )); then
    concurrency=4
  elif (( CPU_CORES >= 2 && MEM_AVAILABLE_BYTES >= 2147483648 )); then
    concurrency=2
  fi

  if ! id investment-research >/dev/null 2>&1; then
    "${SUDO[@]}" useradd --system --home /nonexistent --shell /usr/sbin/nologin investment-research
  fi
  "${SUDO[@]}" install -d -o root -g root -m 0755 "$ROOT" "$RELEASES"
  "${SUDO[@]}" install -d -o investment-research -g investment-research -m 0750 "$STATE"
  "${SUDO[@]}" install -d -o root -g investment-research -m 0750 "$ENV_DIR"

  if [[ -e "$RELEASE" || -L "$RELEASE" ]]; then
    if ! validate_release "$RELEASE"; then
      echo "Removing incomplete isolated Research release for exact target SHA" >&2
      "${SUDO[@]}" rm -rf -- "$RELEASE"
    fi
  fi

  if ! validate_release "$RELEASE"; then
    RELEASE_TMP="$RELEASES/.${TARGET_SHA}.tmp.$$"
    "${SUDO[@]}" rm -rf -- "$RELEASE_TMP"
    "${SUDO[@]}" install -d -o root -g root -m 0755 "$RELEASE_TMP"
    "${SUDO[@]}" cp -a "$SOURCE_DIR"/. "$RELEASE_TMP"/
    "${SUDO[@]}" chown -R root:root "$RELEASE_TMP"
    validate_release "$RELEASE_TMP" || {
      echo "Staged Research release failed exact-SHA/content validation" >&2
      exit 75
    }
    "${SUDO[@]}" mv -T "$RELEASE_TMP" "$RELEASE"
    RELEASE_TMP=""
  fi

  validate_release "$RELEASE" || {
    echo "Research release is incomplete after installation" >&2
    exit 76
  }

  "${SUDO[@]}" install -o root -g root -m 0644 \
    "$RELEASE/research-production/deploy/research-production@.service" \
    /etc/systemd/system/research-production@.service
  local timer
  for timer in fast-historical long-history forward; do
    "${SUDO[@]}" install -o root -g root -m 0644 \
      "$RELEASE/research-production/deploy/research-production-$timer.timer" \
      "/etc/systemd/system/research-production-$timer.timer"
  done

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
    RESEARCH_REPO_ROOT="$RELEASE" \
    RESEARCH_STATE_ROOT="$STATE" \
    RESEARCH_CODE_SHA="$TARGET_SHA" \
    RESEARCH_CONCURRENCY="$concurrency" \
    RESEARCH_MIN_FREE_BYTES=5368709120 \
    LIVE_TRADING=false \
    PRIVATE_API_ENABLED=false \
    ORDER_AUTHORITY=false \
    node "$RELEASE/research-production/bin/research-cycle.mjs" preflight \
      --repo-root "$RELEASE" \
      --state-root "$STATE" \
      --research-sha "$TARGET_SHA"

  "${SUDO[@]}" ln -sfn "$RELEASE" "$ROOT/current.new"
  "${SUDO[@]}" mv -Tf "$ROOT/current.new" "$CURRENT"
  CURRENT_SWITCHED=true

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

  "${SUDO[@]}" systemctl daemon-reload
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
