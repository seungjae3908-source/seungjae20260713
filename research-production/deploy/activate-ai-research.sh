#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-}"
TARGET_SHA="${TARGET_SHA:-}"
RESEARCH_ROOT="${RESEARCH_ROOT:-/opt/investment-research/current}"
STATE_ROOT="${STATE_ROOT:-/var/lib/investment-research-production}"
ENV_ROOT="${ENV_ROOT:-/etc/investment-research}"
PROVIDER_ENV="$ENV_ROOT/research-providers.env"
AI_POLICY_ENV="$ENV_ROOT/research-ai.env"
VIDEO_POLICY_ENV="$ENV_ROOT/research-video.env"
APP_ROOT="${APP_ROOT:-/opt/stock-app}"

if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "TARGET_SHA must be an exact lowercase 40-character SHA" >&2
  exit 64
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  sudo -n true
  SUDO=(sudo -n)
fi

timers=(
  research-production-ai-review.timer
  research-production-video-discovery.timer
)

services=(
  research-production-ai-review.service
  research-production-video-discovery.service
)

disable_timers() {
  "${SUDO[@]}" systemctl disable --now "${timers[@]}" >/dev/null 2>&1 || true
}

research_sha() {
  git -C "$RESEARCH_ROOT" rev-parse HEAD 2>/dev/null || true
}

require_exact_research_release() {
  [[ -d "$RESEARCH_ROOT" ]]
  local resolved current
  resolved="$(readlink -f "$RESEARCH_ROOT")"
  current="$(research_sha)"
  [[ "$current" == "$TARGET_SHA" ]] || {
    echo "AI_RESEARCH_CURRENT_SHA_MISMATCH:expected=$TARGET_SHA:actual=${current:-missing}" >&2
    exit 65
  }
  case "$resolved" in
    /opt/investment-research/releases/"$TARGET_SHA") ;;
    *)
      echo "AI_RESEARCH_CURRENT_RELEASE_PATH_MISMATCH:$resolved" >&2
      exit 66
      ;;
  esac
}

require_research_safety_env() {
  local file="$ENV_ROOT/research-production.env"
  [[ -r "$file" ]] || {
    echo "AI_RESEARCH_PRODUCTION_ENV_MISSING" >&2
    exit 67
  }
  for token in     'LIVE_TRADING=false'     'LIVE_TRADING_ENABLED=false'     'REAL_ORDER_ENABLED=false'     'REAL_TRADING_ENABLED=false'     'PRIVATE_API_ENABLED=false'     'PRIVATE_ACCOUNT_ACCESS=false'     'PRIVATE_TRADING_API_ALLOWED=false'     'ORDER_AUTHORITY=false'     'ORDER_SUBMISSION_ENABLED=false'; do
    grep -Fxq "$token" "$file" || {
      echo "AI_RESEARCH_UNSAFE_ENV:$token" >&2
      exit 68
    }
  done
}

provider_env_ready() {
  [[ -e "$PROVIDER_ENV" ]] || return 1
  "${SUDO[@]}" node - "$PROVIDER_ENV" <<'NODE'
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const file = process.argv[2];
const raw = fs.readFileSync(file, 'utf8');
const env = parseEnv(raw);
const keyPattern = /^[A-Za-z0-9_.-]{8,512}$/u;
const present = (key) => typeof env[key] === 'string' && keyPattern.test(env[key].trim());
const youtube = present('YOUTUBE_DATA_API_KEY');
const gemini = present('GEMINI_API_KEY') || present('GOOGLE_API_KEY');
const groq = present('GROQ_API_KEY');
if (!youtube || !gemini || !groq) process.exit(2);
process.stdout.write(JSON.stringify({
  schemaVersion: 'research-provider-env-readiness-v1',
  source: 'EXISTING_RESEARCH_PROVIDER_ENV',
  providers: { youtube: 'PRESENT', gemini: 'PRESENT', groq: 'PRESENT' },
  credentialValuesExposed: false,
  executionAuthority: 'NONE'
}) + '\n');
NODE
}

provider_preflight() {
  if provider_env_ready; then
    return 0
  fi
  local evidence
  evidence="$(mktemp)"
  trap 'rm -f "$evidence"' RETURN
  "${SUDO[@]}" node "$RESEARCH_ROOT/research-production/bin/research-provider-bootstrap.mjs" preflight     --app-root "$APP_ROOT"     --process-name stock-app > "$evidence"
  node - "$evidence" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const providers = value?.providers ?? {};
if (value?.schemaVersion !== 'research-provider-bootstrap-v1'
  || value?.fullStackReady !== true
  || providers.youtube !== 'PRESENT'
  || providers.gemini !== 'PRESENT'
  || providers.groq !== 'PRESENT'
  || !Array.isArray(value?.conflicts)
  || value.conflicts.length !== 0
  || value?.credentialValuesExposed !== false
  || value?.executionAuthority !== 'NONE'
  || value?.liveTrading !== false
  || value?.privateTradingApiAllowed !== false) {
  throw new Error('AI_RESEARCH_PROVIDER_PREFLIGHT_NOT_READY');
}
NODE
}

materialize_or_reuse_provider_env() {
  if provider_env_ready >/dev/null; then
    printf '%s\n' "AI_RESEARCH_PROVIDER_ENV_SOURCE=EXISTING_RESEARCH_PROVIDER_ENV"
    return 0
  fi
  "${SUDO[@]}" node "$RESEARCH_ROOT/research-production/bin/research-provider-bootstrap.mjs" materialize \
    --app-root "$APP_ROOT" \
    --process-name stock-app \
    --output-root "$ENV_ROOT" >/dev/null
  provider_env_ready >/dev/null
  printf '%s\n' "AI_RESEARCH_PROVIDER_ENV_SOURCE=BOOTSTRAP_MATERIALIZED"
}

require_runtime_policy_env() {
  [[ -r "$AI_POLICY_ENV" ]] || {
    echo "AI_RESEARCH_POLICY_ENV_MISSING:$AI_POLICY_ENV" >&2
    exit 71
  }
  [[ -r "$VIDEO_POLICY_ENV" ]] || {
    echo "VIDEO_RESEARCH_POLICY_ENV_MISSING:$VIDEO_POLICY_ENV" >&2
    exit 72
  }

  "${SUDO[@]}" node - "$AI_POLICY_ENV" "$VIDEO_POLICY_ENV" <<'NODE'
const fs = require('node:fs');
const { parseEnv } = require('node:util');

const aiPath = process.argv[2];
const videoPath = process.argv[3];
const ai = parseEnv(fs.readFileSync(aiPath, 'utf8'));
const video = parseEnv(fs.readFileSync(videoPath, 'utf8'));

const selected = String(ai.AI_CHAT_PROVIDER ?? '').trim().toLowerCase();
const allowedAiKeys = new Set([
  'RESEARCH_AI_FREE_TIER_CONFIRMED',
  'AI_CHAT_PROVIDER',
  'RESEARCH_AI_MAX_CALLS_PER_SCAN',
]);
const allowedVideoKeys = new Set([
  'RESEARCH_VIDEO_DISCOVERY_APPROVED',
  'RESEARCH_VIDEO_DISCOVERY_MAX_RESULTS',
  'RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON',
]);

for (const key of Object.keys(ai)) {
  if (!allowedAiKeys.has(key)) throw new Error('AI_RESEARCH_POLICY_UNSUPPORTED_KEY:' + key);
}
for (const key of Object.keys(video)) {
  if (!allowedVideoKeys.has(key)) throw new Error('VIDEO_RESEARCH_POLICY_UNSUPPORTED_KEY:' + key);
}

if (String(ai.RESEARCH_AI_FREE_TIER_CONFIRMED ?? '').trim().toLowerCase() !== 'true') {
  throw new Error('AI_RESEARCH_FREE_TIER_CONFIRMATION_REQUIRED');
}
if (!['gemini','groq'].includes(selected)) {
  throw new Error('AI_RESEARCH_PROVIDER_SELECTION_REQUIRED');
}
const maxCalls = Number(ai.RESEARCH_AI_MAX_CALLS_PER_SCAN ?? '3');
if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 3) {
  throw new Error('AI_RESEARCH_MAX_CALLS_INVALID');
}

if (String(video.RESEARCH_VIDEO_DISCOVERY_APPROVED ?? '').trim().toLowerCase() !== 'true') {
  throw new Error('VIDEO_RESEARCH_DISCOVERY_APPROVAL_REQUIRED');
}
const maxResults = Number(video.RESEARCH_VIDEO_DISCOVERY_MAX_RESULTS ?? '3');
if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 3) {
  throw new Error('VIDEO_RESEARCH_MAX_RESULTS_INVALID');
}

process.stdout.write(JSON.stringify({
  schemaVersion: 'research-ai-runtime-policy-readiness-v1',
  ai: {
    freeTierConfirmed: true,
    provider: selected,
    maxCalls,
  },
  video: {
    approved: true,
    maxResults,
  },
  credentialValuesExposed: false,
  executionAuthority: 'NONE'
}) + '\n');
NODE

  if command -v runuser >/dev/null 2>&1; then
    "${SUDO[@]}" runuser -u investment-research -- test -r "$AI_POLICY_ENV"
    "${SUDO[@]}" runuser -u investment-research -- test -r "$VIDEO_POLICY_ENV"
  else
    sudo -n -u investment-research test -r "$AI_POLICY_ENV"
    sudo -n -u investment-research test -r "$VIDEO_POLICY_ENV"
  fi
}

verify_one_shot_evidence() {
  local started_ms="$1"
  "${SUDO[@]}" node - "$STATE_ROOT" "$TARGET_SHA" "$started_ms" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const stateRoot = process.argv[2];
const targetSha = process.argv[3];
const startedMs = Number(process.argv[4]);

const aiPath = path.join(stateRoot, 'ai-review', 'latest.json');
const videoPath = path.join(stateRoot, 'video-research', 'latest.json');

const ai = JSON.parse(fs.readFileSync(aiPath, 'utf8'));
const video = JSON.parse(fs.readFileSync(videoPath, 'utf8'));

if (ai?.schemaVersion !== 'research-production-ai-scan-v1') {
  throw new Error('AI_RESEARCH_ONE_SHOT_SCHEMA_INVALID');
}
if (ai?.researchSha !== targetSha) {
  throw new Error('AI_RESEARCH_ONE_SHOT_SHA_MISMATCH');
}
if (ai?.status !== 'COMPLETE') {
  throw new Error('AI_RESEARCH_ONE_SHOT_NOT_COMPLETE:' + String(ai?.status ?? 'MISSING'));
}
if (!['gemini','groq'].includes(String(ai?.provider ?? ''))) {
  throw new Error('AI_RESEARCH_ONE_SHOT_PROVIDER_INVALID');
}
if (!Number.isSafeInteger(ai?.providerNetworkCalls) || ai.providerNetworkCalls < 1 || ai.providerNetworkCalls > 3) {
  throw new Error('AI_RESEARCH_ONE_SHOT_NETWORK_PROOF_MISSING');
}
if (!Array.isArray(ai?.reviews) || ai.reviews.length < 1) {
  throw new Error('AI_RESEARCH_ONE_SHOT_REVIEW_MISSING');
}
if (!Array.isArray(ai?.blockedProfiles) || ai.blockedProfiles.length !== 0) {
  throw new Error('AI_RESEARCH_ONE_SHOT_BLOCKED_PROFILE');
}
if (!Number.isSafeInteger(ai?.observedAt) || ai.observedAt < startedMs) {
  throw new Error('AI_RESEARCH_ONE_SHOT_STALE');
}
if (ai?.safety?.executionAuthority !== 'NONE'
  || ai?.safety?.liveTrading !== false
  || ai?.safety?.privateTradingApiAllowed !== false
  || ai?.safety?.orderAllowed !== false
  || ai?.evidenceCredit !== 0
  || ai?.profitabilityProven !== false) {
  throw new Error('AI_RESEARCH_ONE_SHOT_SAFETY_INVALID');
}

if (video?.schemaVersion !== 'research-video-discovery-scan-v1') {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_SCHEMA_INVALID');
}
if (video?.researchSha !== targetSha) {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_SHA_MISMATCH');
}
if (video?.status !== 'COMPLETE') {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_NOT_COMPLETE:' + String(video?.status ?? 'MISSING'));
}
if (video?.provider !== 'YOUTUBE_DATA_API_V3') {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_PROVIDER_INVALID');
}
if (video?.providerNetworkCalls !== 1) {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_NETWORK_PROOF_MISSING');
}
if (!Number.isSafeInteger(video?.sourceCount) || video.sourceCount < 1) {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_SOURCE_MISSING');
}
const videoObservedAtMs = Date.parse(String(video?.observedAt ?? ''));
if (!Number.isFinite(videoObservedAtMs) || videoObservedAtMs < startedMs) {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_STALE');
}
if (video?.safety?.executionAuthority !== 'NONE'
  || video?.safety?.liveTrading !== false
  || video?.safety?.privateTradingApiAllowed !== false
  || video?.safety?.realOrderEnabled !== false
  || video?.safety?.profitabilityCredit !== 0
  || video?.safety?.economicEvidenceCredit !== 0) {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_SAFETY_INVALID');
}

process.stdout.write(JSON.stringify({
  schemaVersion: 'research-ai-one-shot-proof-v1',
  targetSha,
  ai: {
    status: ai.status,
    provider: ai.provider,
    providerNetworkCalls: ai.providerNetworkCalls,
    reviewCount: ai.reviews.length,
  },
  video: {
    status: video.status,
    providerNetworkCalls: video.providerNetworkCalls,
    sourceCount: video.sourceCount,
  },
  credentialValuesExposed: false,
  executionAuthority: 'NONE'
}) + '\n');
NODE
}

verify_unit_sources() {
  local unit
  for unit in "${services[@]}" "${timers[@]}"; do
    local source="$RESEARCH_ROOT/research-production/deploy/$unit"
    [[ -f "$source" ]] || {
      echo "AI_RESEARCH_UNIT_MISSING:$source" >&2
      exit 69
    }
    systemd-analyze verify "$source" >/dev/null
  done
}

preflight() {
  command -v git >/dev/null
  command -v node >/dev/null
  command -v systemctl >/dev/null
  command -v systemd-analyze >/dev/null
  require_exact_research_release
  require_research_safety_env
  provider_preflight
  require_runtime_policy_env
  verify_unit_sources
  printf '%s\n'     "AI_RESEARCH_PREFLIGHT=PASS"     "TARGET_SHA=$TARGET_SHA"     "PROVIDER_YOUTUBE=PRESENT"     "PROVIDER_GEMINI=PRESENT"     "PROVIDER_GROQ=PRESENT"     "LIVE_TRADING=false"     "PRIVATE_TRADING_API_ALLOWED=false"     "REAL_ORDER_ENABLED=false"     "executionAuthority=NONE"
}

activate() {
  preflight

  local activated=false
  fail_safe() {
    local status=$?
    if (( status != 0 )); then
      disable_timers
      printf '%s\n'         "AI_RESEARCH_ACTIVATION_FAILED_SAFE_DISABLED=true"         "TARGET_SHA=$TARGET_SHA" >&2
    fi
    return "$status"
  }
  trap fail_safe EXIT

  # Safe cutover: stop old schedules before replacing unit definitions.
  disable_timers

  RESEARCH_RELEASE_ROOT="$RESEARCH_ROOT"     bash "$RESEARCH_ROOT/research-production/deploy/install-ai-research-units.sh"

  materialize_or_reuse_provider_env

  "${SUDO[@]}" chown root:investment-research "$PROVIDER_ENV"
  "${SUDO[@]}" chmod 0640 "$PROVIDER_ENV"
  if command -v runuser >/dev/null 2>&1; then
    "${SUDO[@]}" runuser -u investment-research -- test -r "$PROVIDER_ENV"
  else
    sudo -n -u investment-research test -r "$PROVIDER_ENV"
  fi

  "${SUDO[@]}" systemctl daemon-reload

  # A successful one-shot must prove fresh provider network activity, validated
  # output schema, exact Research SHA, and no trading authority before timers enable.
  local one_shot_started_ms
  one_shot_started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  "${SUDO[@]}" systemctl start research-production-ai-review.service
  "${SUDO[@]}" systemctl start research-production-video-discovery.service

  local service
  for service in "${services[@]}"; do
    local result status
    result="$("${SUDO[@]}" systemctl show "$service" -p Result --value)"
    status="$("${SUDO[@]}" systemctl show "$service" -p ExecMainStatus --value)"
    [[ "$result" == "success" && "$status" == "0" ]] || {
      echo "AI_RESEARCH_ONE_SHOT_FAILED:$service:result=$result:status=$status" >&2
      exit 70
    }
  done

  verify_one_shot_evidence "$one_shot_started_ms"

  "${SUDO[@]}" systemctl enable --now "${timers[@]}"
  local timer
  for timer in "${timers[@]}"; do
    "${SUDO[@]}" systemctl is-enabled --quiet "$timer"
    "${SUDO[@]}" systemctl is-active --quiet "$timer"
  done

  require_exact_research_release
  require_research_safety_env
  activated=true
  trap - EXIT

  printf '%s\n'     "AI_RESEARCH_ACTIVATED=$activated"     "TARGET_SHA=$TARGET_SHA"     "AI_REVIEW_ONE_SHOT=success"     "VIDEO_DISCOVERY_ONE_SHOT=success"     "AI_REVIEW_TIMER_ENABLED=true"     "VIDEO_DISCOVERY_TIMER_ENABLED=true"     "PROVIDER_YOUTUBE=PRESENT"     "PROVIDER_GEMINI=PRESENT"     "PROVIDER_GROQ=PRESENT"     "PROVIDER_ENV_READABLE_BY_RESEARCH_USER=true"     "LIVE_TRADING=false"     "PRIVATE_TRADING_API_ALLOWED=false"     "REAL_ORDER_ENABLED=false"     "executionAuthority=NONE"     "REAL_ORDER_SUBMITTED=false"
}

case "$MODE" in
  preflight) preflight ;;
  activate) activate ;;
  *)
    echo "usage: activate-ai-research.sh {preflight|activate}" >&2
    exit 64
    ;;
esac
