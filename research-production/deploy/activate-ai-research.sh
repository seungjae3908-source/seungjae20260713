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
  research-production-approved-job-intake.timer
)

daemon_services=(
  research-production-workspace-worker.service
)

services=(
  research-production-ai-review.service
  research-production-video-discovery.service
  research-production-approved-job-intake.service
)

disable_timers() {
  "${SUDO[@]}" systemctl disable --now "${timers[@]}" >/dev/null 2>&1 || true
  local timer
  for timer in "${timers[@]}"; do
    if "${SUDO[@]}" systemctl is-active --quiet "$timer" 2>/dev/null; then
      echo "AI_RESEARCH_TIMER_STILL_ACTIVE:$timer" >&2
      return 1
    fi
    if "${SUDO[@]}" systemctl is-enabled --quiet "$timer" 2>/dev/null; then
      echo "AI_RESEARCH_TIMER_STILL_ENABLED:$timer" >&2
      return 1
    fi
  done
  "${SUDO[@]}" systemctl disable --now "${daemon_services[@]}" >/dev/null 2>&1 || true
  local service
  for service in "${daemon_services[@]}"; do
    if "${SUDO[@]}" systemctl is-active --quiet "$service" 2>/dev/null; then
      echo "AI_RESEARCH_DAEMON_STILL_ACTIVE:$service" >&2
      return 1
    fi
    if "${SUDO[@]}" systemctl is-enabled --quiet "$service" 2>/dev/null; then
      echo "AI_RESEARCH_DAEMON_STILL_ENABLED:$service" >&2
      return 1
    fi
  done
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

provider_credentials_present() {
  [[ -e "$PROVIDER_ENV" ]] || return 1
  "${SUDO[@]}" node - "$PROVIDER_ENV" <<'NODE'
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const env = parseEnv(fs.readFileSync(process.argv[2], 'utf8'));
const allowed = new Set(['YOUTUBE_DATA_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','GEMINI_MODEL','GROQ_API_KEY','GROQ_MODEL']);
for (const key of Object.keys(env)) if (!allowed.has(key)) process.exit(3);
const keyPattern = /^[A-Za-z0-9_.-]{8,512}$/u;
const present = (key) => typeof env[key] === 'string' && keyPattern.test(env[key].trim());
const geminiValues = ['GEMINI_API_KEY','GOOGLE_API_KEY'].map(k => env[k]?.trim()).filter(Boolean);
if (!present('YOUTUBE_DATA_API_KEY') || !present('GROQ_API_KEY') || geminiValues.length < 1
  || new Set(geminiValues).size !== 1 || !geminiValues.every(v => keyPattern.test(v))) process.exit(2);
process.stdout.write(JSON.stringify({
  schemaVersion:'research-provider-credential-readiness-v1',
  providers:{youtube:'PRESENT',gemini:'PRESENT',groq:'PRESENT'},
  credentialValuesExposed:false,executionAuthority:'NONE'
})+'\n');
NODE
}

provider_env_ready() {
  provider_credentials_present >/dev/null || return 1
  "${SUDO[@]}" node - "$PROVIDER_ENV" <<'NODE'
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const env = parseEnv(fs.readFileSync(process.argv[2], 'utf8'));
if (String(env.GEMINI_MODEL ?? '').trim() !== 'gemini-3.1-flash-lite'
  || String(env.GROQ_MODEL ?? '').trim() !== 'openai/gpt-oss-20b') process.exit(2);
process.stdout.write(JSON.stringify({
  schemaVersion:'research-provider-env-readiness-v2',
  providers:{youtube:'PRESENT',gemini:'PRESENT',groq:'PRESENT'},
  models:{gemini:'EXPLICIT_FIXED',groq:'EXPLICIT_FIXED'},
  credentialValuesExposed:false,executionAuthority:'NONE'
})+'\n');
NODE
}

provider_preflight() {
  if provider_env_ready >/dev/null; then
    provider_env_ready
    return 0
  fi
  if provider_credentials_present >/dev/null; then
    provider_credentials_present
    printf '%s\n' "AI_RESEARCH_PROVIDER_MODEL_REPAIR_REQUIRED=true"
    return 0
  fi
  local evidence
  evidence="$(mktemp)"
  trap 'rm -f "$evidence"' RETURN
  "${SUDO[@]}" node "$RESEARCH_ROOT/research-production/bin/research-provider-bootstrap.mjs" preflight \
    --app-root "$APP_ROOT" \
    --process-name stock-app > "$evidence"
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

normalize_existing_provider_env() {
  provider_credentials_present >/dev/null
  local tmp
  tmp="$(mktemp)"
  "${SUDO[@]}" node - "$PROVIDER_ENV" "$tmp" <<'NODE'
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const env = parseEnv(fs.readFileSync(process.argv[2], 'utf8'));
const geminiValues = ['GEMINI_API_KEY','GOOGLE_API_KEY'].map(k => env[k]?.trim()).filter(Boolean);
if (geminiValues.length < 1 || new Set(geminiValues).size !== 1) throw new Error('PROVIDER_GEMINI_CONFIGURATION_UNRESOLVED');
const rows = [
  '# Research provider-only environment. Trading/account secrets are forbidden.',
  'YOUTUBE_DATA_API_KEY=' + env.YOUTUBE_DATA_API_KEY.trim(),
  'GEMINI_API_KEY=' + geminiValues[0],
  'GEMINI_MODEL=gemini-3.1-flash-lite',
  'GROQ_API_KEY=' + env.GROQ_API_KEY.trim(),
  'GROQ_MODEL=openai/gpt-oss-20b',
  '',
];
fs.writeFileSync(process.argv[3], rows.join('\n'), {mode:0o600,flag:'w'});
NODE
  "${SUDO[@]}" install -o root -g investment-research -m 0640 "$tmp" "$PROVIDER_ENV"
  rm -f "$tmp"
  provider_env_ready >/dev/null
}

materialize_or_reuse_provider_env() {
  if provider_env_ready >/dev/null; then
    printf '%s\n' "AI_RESEARCH_PROVIDER_ENV_SOURCE=EXISTING_RESEARCH_PROVIDER_ENV"
    return 0
  fi
  if provider_credentials_present >/dev/null; then
    normalize_existing_provider_env
    printf '%s\n' "AI_RESEARCH_PROVIDER_ENV_SOURCE=EXISTING_RESEARCH_PROVIDER_ENV_MODELS_NORMALIZED"
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
  'RESEARCH_VIDEO_DISCOVERY_REGION_CODE',
  'RESEARCH_VIDEO_DISCOVERY_RELEVANCE_LANGUAGE',
  'RESEARCH_VIDEO_DISCOVERY_PUBLISHED_AFTER_HOURS',
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
const region = String(video.RESEARCH_VIDEO_DISCOVERY_REGION_CODE ?? '').trim().toUpperCase();
if (region && !/^[A-Z]{2}$/.test(region)) {
  throw new Error('VIDEO_RESEARCH_REGION_INVALID');
}
const language = String(video.RESEARCH_VIDEO_DISCOVERY_RELEVANCE_LANGUAGE ?? '').trim();
if (language && !/^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$/.test(language)) {
  throw new Error('VIDEO_RESEARCH_LANGUAGE_INVALID');
}
const publishedAfterHours = Number(video.RESEARCH_VIDEO_DISCOVERY_PUBLISHED_AFTER_HOURS ?? '720');
if (!Number.isSafeInteger(publishedAfterHours) || publishedAfterHours < 1 || publishedAfterHours > 2160) {
  throw new Error('VIDEO_RESEARCH_FRESHNESS_WINDOW_INVALID');
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
    region: region || null,
    language: language || null,
    publishedAfterHours,
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

print_ai_diagnostic() {
  "${SUDO[@]}" node "$RESEARCH_ROOT/research-production/bin/research-ai-diagnostic.mjs" \
    --state-root "$STATE_ROOT" \
    --research-sha "$TARGET_SHA" >&2 || true
}

print_forward_runtime_diagnostic() {
  "${SUDO[@]}" node "$RESEARCH_ROOT/research-production/bin/research-forward-runtime-diagnostic.mjs" \
    --state-root "$STATE_ROOT" \
    --research-sha "$TARGET_SHA" \
    --env-file "$ENV_ROOT/research-production.env" || true
}

require_current_sha_ai_evidence_ready() {
  "${SUDO[@]}" node - "$STATE_ROOT" "$TARGET_SHA" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const stateRoot = process.argv[2];
const targetSha = process.argv[3];
const allowedStatus = new Set(['complete', 'partial_failure', 'blocked_data']);
const current = [];
for (const profile of ['forward', 'fast-historical', 'long-history']) {
  const file = path.join(stateRoot, 'latest', profile + '.json');
  if (!fs.existsSync(file)) continue;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('AI_RESEARCH_CURRENT_SHA_EVIDENCE_JSON_INVALID:' + profile); }
  if (String(value?.researchSha ?? '').toLowerCase() !== targetSha) continue;
  if (value?.schemaVersion !== 'research-production-cycle-v1'
    || value?.profile !== profile
    || !allowedStatus.has(String(value?.status ?? ''))) {
    throw new Error('AI_RESEARCH_CURRENT_SHA_EVIDENCE_INVALID:' + profile);
  }
  current.push(profile);
}
if (!current.includes('forward')) throw new Error('AI_RESEARCH_CURRENT_SHA_FORWARD_EVIDENCE_MISSING');
process.stdout.write(JSON.stringify({
  schemaVersion: 'research-ai-current-sha-readiness-v1',
  targetSha, currentProfiles: current, forwardReady: true, executionAuthority: 'NONE'
}) + '\n');
NODE
}

refresh_current_sha_forward_evidence() {
  local service="research-production@forward.service"
  "${SUDO[@]}" systemctl start "$service"
  local result status
  result="$("${SUDO[@]}" systemctl show "$service" -p Result --value)"
  status="$("${SUDO[@]}" systemctl show "$service" -p ExecMainStatus --value)"
  if [[ "$result" != "success" || "$status" != "0" ]]; then
    print_forward_runtime_diagnostic
    echo "AI_RESEARCH_CURRENT_SHA_FORWARD_REFRESH_FAILED:$service:result=$result:status=$status" >&2
    return 1
  fi
  require_current_sha_ai_evidence_ready
}

verify_workspace_worker_health() {
  local evidence
  evidence="$(mktemp)"
  trap 'rm -f "$evidence"' RETURN
  local -a research_user_cmd
  if command -v runuser >/dev/null 2>&1; then
    research_user_cmd=("${SUDO[@]}" runuser -u investment-research --)
  else
    research_user_cmd=(sudo -n -u investment-research)
  fi
  local attempt
  for attempt in {1..10}; do
    if "${research_user_cmd[@]}" \
      /usr/bin/env node "$RESEARCH_ROOT/packages/external-research/scripts/run-research-worker-v9.mjs" \
      --root "$STATE_ROOT/workspace-worker" --status >"$evidence" 2>/dev/null; then
      if node - "$evidence" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value?.schemaVersion !== 'research-worker-status-v9'
  || value?.available !== true
  || value?.workerState !== 'ACTIVE'
  || !value?.lastHeartbeatAt
  || value?.authority?.executionAuthority !== 'NONE'
  || value?.authority?.providerCallsFromStatus !== 0) process.exit(2);
NODE
      then
        return 0
      fi
    fi
    sleep 1
  done
  echo "AI_RESEARCH_WORKSPACE_WORKER_HEARTBEAT_NOT_ACTIVE" >&2
  return 1
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
const acceptableAiStatus = new Set(['COMPLETE', 'PARTIAL_COVERAGE_COMPLETE']);
if (!acceptableAiStatus.has(String(ai?.status ?? ''))) {
  const leaf = [...(Array.isArray(ai?.blockedProfiles) ? ai.blockedProfiles : []),
    ...(Array.isArray(ai?.deferredProfiles) ? ai.deferredProfiles : [])]
    .map((row) => String(row?.profile ?? 'unknown') + '=' + String(row?.reason ?? 'UNKNOWN'))
    .slice(0, 6).join(',');
  throw new Error('AI_RESEARCH_ONE_SHOT_NOT_READY:' + String(ai?.status ?? 'MISSING') + (leaf ? ':' + leaf : ''));
}
if (!['gemini','groq'].includes(String(ai?.provider ?? ''))) {
  throw new Error('AI_RESEARCH_ONE_SHOT_PROVIDER_INVALID');
}
if (!Number.isSafeInteger(ai?.providerNetworkCalls) || ai.providerNetworkCalls < 0 || ai.providerNetworkCalls > 3
  || !Number.isSafeInteger(ai?.cacheHits) || ai.cacheHits < 0 || ai.cacheHits > 3
  || (ai.providerNetworkCalls < 1 && ai.cacheHits < 1)) {
  throw new Error('AI_RESEARCH_ONE_SHOT_PROVIDER_OR_CACHE_PROOF_MISSING');
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
if (!Number.isSafeInteger(video?.providerNetworkCalls) || video.providerNetworkCalls < 1 || video.providerNetworkCalls > 2) {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_NETWORK_PROOF_MISSING');
}
if (!Number.isSafeInteger(video?.sourceCount) || video.sourceCount < 0) {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_SOURCE_COUNT_INVALID');
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
    cacheHits: ai.cacheHits,
    reviewCount: ai.reviews.length,
    profileCoverage: ai.profileCoverage,
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
  for unit in "${services[@]}" "${timers[@]}" "${daemon_services[@]}"; do
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
  print_forward_runtime_diagnostic
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
      local safe_disabled=false
      if disable_timers; then safe_disabled=true; fi
      printf '%s\n' "AI_RESEARCH_ACTIVATION_FAILED_SAFE_DISABLED=$safe_disabled" "TARGET_SHA=$TARGET_SHA" >&2
    fi
    return "$status"
  }
  trap fail_safe EXIT

  # Safe cutover: stop old schedules before replacing unit definitions.
  disable_timers

  RESEARCH_RELEASE_ROOT="$RESEARCH_ROOT"     bash "$RESEARCH_ROOT/research-production/deploy/install-ai-research-units.sh"

  materialize_or_reuse_provider_env

  "${SUDO[@]}" chown root:investment-research "$PROVIDER_ENV" "$AI_POLICY_ENV" "$VIDEO_POLICY_ENV"
  "${SUDO[@]}" chmod 0640 "$PROVIDER_ENV" "$AI_POLICY_ENV" "$VIDEO_POLICY_ENV"
  if command -v runuser >/dev/null 2>&1; then
    "${SUDO[@]}" runuser -u investment-research -- test -r "$PROVIDER_ENV"
  else
    sudo -n -u investment-research test -r "$PROVIDER_ENV"
  fi

  "${SUDO[@]}" systemctl daemon-reload

  # Refresh exact-SHA forward evidence synchronously so activation never races the hourly :11 UTC timer.
  # blocked_data is still valid structural evidence; this only requires a current-release cycle artifact.
  refresh_current_sha_forward_evidence

  # A successful one-shot must prove validated current-release review evidence,
  # exact Research SHA, provider identity, and no trading authority before timers enable.
  local one_shot_started_ms
  one_shot_started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  "${SUDO[@]}" systemctl start research-production-ai-review.service || true
  "${SUDO[@]}" systemctl start research-production-video-discovery.service || true
  "${SUDO[@]}" systemctl start research-production-approved-job-intake.service || true

  local service
  for service in "${services[@]}"; do
    local result status
    result="$("${SUDO[@]}" systemctl show "$service" -p Result --value)"
    status="$("${SUDO[@]}" systemctl show "$service" -p ExecMainStatus --value)"
    [[ "$result" == "success" && "$status" == "0" ]] || {
      if [[ "$service" == "research-production-ai-review.service" ]]; then
        print_ai_diagnostic
      fi
      echo "AI_RESEARCH_ONE_SHOT_FAILED:$service:result=$result:status=$status" >&2
      exit 70
    }
  done

  verify_one_shot_evidence "$one_shot_started_ms"

  "${SUDO[@]}" systemctl enable --now "${timers[@]}" "${daemon_services[@]}"
  local timer
  for timer in "${timers[@]}"; do
    "${SUDO[@]}" systemctl is-enabled --quiet "$timer"
    "${SUDO[@]}" systemctl is-active --quiet "$timer"
  done
  local daemon
  for daemon in "${daemon_services[@]}"; do
    "${SUDO[@]}" systemctl is-enabled --quiet "$daemon"
    "${SUDO[@]}" systemctl is-active --quiet "$daemon"
  done
  verify_workspace_worker_health

  require_exact_research_release
  require_research_safety_env
  activated=true
  trap - EXIT

  printf '%s\n'     "AI_RESEARCH_ACTIVATED=$activated"     "TARGET_SHA=$TARGET_SHA"     "AI_REVIEW_ONE_SHOT=success"     "VIDEO_DISCOVERY_ONE_SHOT=success"     "AI_REVIEW_TIMER_ENABLED=true"     "VIDEO_DISCOVERY_TIMER_ENABLED=true"     "APPROVED_JOB_INTAKE_TIMER_ENABLED=true"     "WORKSPACE_WORKER_ENABLED=true"     "PROVIDER_YOUTUBE=PRESENT"     "PROVIDER_GEMINI=PRESENT"     "PROVIDER_GROQ=PRESENT"     "PROVIDER_ENV_READABLE_BY_RESEARCH_USER=true"     "LIVE_TRADING=false"     "PRIVATE_TRADING_API_ALLOWED=false"     "REAL_ORDER_ENABLED=false"     "executionAuthority=NONE"     "REAL_ORDER_SUBMITTED=false"
}

case "$MODE" in
  preflight) preflight ;;
  activate) activate ;;
  *)
    echo "usage: activate-ai-research.sh {preflight|activate}" >&2
    exit 64
    ;;
esac
