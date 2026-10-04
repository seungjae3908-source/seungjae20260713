#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-}"
case "$MODE" in
  comprehensive|account|credential) ;;
  *) echo 'Usage: run-production-readonly-qa.sh <comprehensive|account|credential>' >&2; exit 2 ;;
esac

: "${EXPECTED_DEPLOY_SHA:?EXPECTED_DEPLOY_SHA is required}"
: "${PRODUCTION_DEPLOY_RUN_ID:?PRODUCTION_DEPLOY_RUN_ID is required}"
: "${PRODUCTION_BASE_URL:?PRODUCTION_BASE_URL is required}"
: "${PRODUCTION_QA_LOGIN:?PRODUCTION_QA_LOGIN is required}"
: "${PRODUCTION_QA_PASSWORD:?PRODUCTION_QA_PASSWORD is required}"
: "${GH_TOKEN:?GH_TOKEN is required for read-only deploy provenance}"

[[ "$EXPECTED_DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'PRODUCTION_QA_TARGET_SHA_INVALID' >&2; exit 1; }
[[ "$PRODUCTION_DEPLOY_RUN_ID" =~ ^[1-9][0-9]*$ ]] || { echo 'PRODUCTION_QA_DEPLOY_RUN_ID_INVALID' >&2; exit 1; }
[[ "$(git rev-parse HEAD^{commit})" == "$EXPECTED_DEPLOY_SHA" ]] || { echo 'PRODUCTION_QA_CHECKOUT_SHA_MISMATCH' >&2; exit 1; }

for forbidden_name in \
  PROD_DATABASE_URL PROD_SSH_HOST PROD_SSH_USER PROD_SSH_PORT PROD_SSH_PRIVATE_KEY PROD_SSH_KNOWN_HOSTS \
  SSH_HOST SSH_USER SSH_PORT SSH_PRIVATE_KEY SSH_KNOWN_HOSTS \
  TOSS_CLIENT_SECRET UPBIT_SECRET_KEY BITGET_SECRET_KEY KIWOOM_APP_SECRET
do
  if [[ -n "${!forbidden_name:-}" ]]; then
    echo "PRODUCTION_QA_FORBIDDEN_AUTHORITY_ENV_PRESENT:$forbidden_name" >&2
    exit 1
  fi
done

for flag_name in \
  LIVE_TRADING AUTO_TRADING REAL_ORDER_ENABLED PRIVATE_TRADING_API_ALLOWED ORDER_EXECUTION_ENABLED \
  LIVE_TRADING_ACTIVATION_APPROVED SPOT_LIVE_LIMITED_ACTIVATION_APPROVED LIVE_AUTOMATIC_TRADING_ENABLED \
  MEMBER_AUTO_TRADING_BACKGROUND_ENABLED MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED \
  FUTURES_LIVE_LIMITED_ACTIVATION_APPROVED BITGET_FUTURES_LIVE_ORDER_ENABLED \
  BITGET_LIVE_ORDER_ENABLED UPBIT_LIVE_ORDER_ENABLED KIWOOM_LIVE_ORDER_ENABLED TOSS_LIVE_ORDER_ENABLED
do
  if [[ "${!flag_name:-false}" != false ]]; then
    echo "PRODUCTION_QA_LIVE_FLAG_NOT_FALSE:$flag_name" >&2
    exit 1
  fi
  export "$flag_name=false"
done
export executionAuthority=NONE

echo "::add-mask::$PRODUCTION_QA_LOGIN"
echo "::add-mask::$PRODUCTION_QA_PASSWORD"

deploy_mode="${PRODUCTION_DEPLOY_MODE:-completed}"
[[ "$deploy_mode" == completed || "$deploy_mode" == inline ]] || { echo 'PRODUCTION_QA_DEPLOY_MODE_INVALID' >&2; exit 1; }
run_json="$(mktemp "${RUNNER_TEMP:-/tmp}/production-deploy-run.XXXXXX.json")"
health_json="$(mktemp "${RUNNER_TEMP:-/tmp}/production-health.XXXXXX.json")"
cleanup() { rm -f -- "$run_json" "$health_json"; }
trap cleanup EXIT

gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${PRODUCTION_DEPLOY_RUN_ID}" > "$run_json"
curl --fail --silent --show-error --max-time 15 "$PRODUCTION_BASE_URL/api/health" -o "$health_json"
node .github/scripts/verify-production-deploy-execution.cjs \
  "$run_json" "$health_json" "$EXPECTED_DEPLOY_SHA" "$PRODUCTION_DEPLOY_RUN_ID" \
  "$deploy_mode" "${GITHUB_RUN_ID:-}"

case "$MODE" in
  comprehensive)
    artifact_dir='stock-analyzer/production-comprehensive-artifacts'
    rm -rf -- "$artifact_dir"
    export PRODUCTION_READONLY_E2E=true
    export PRODUCTION_QA_INCLUDE_TELEGRAM="${PRODUCTION_QA_INCLUDE_TELEGRAM:-false}"
    (
      cd stock-analyzer
      pnpm exec playwright test --config=playwright.production-comprehensive.config.ts
    )
    node api-server/scripts/build-production-comprehensive-readonly-receipt.mjs \
      "$artifact_dir" "$EXPECTED_DEPLOY_SHA" "$PRODUCTION_DEPLOY_RUN_ID"
    receipt="$artifact_dir/production-comprehensive-readonly-qa.json"
    ;;
  account)
    artifact_dir='stock-analyzer/production-account-readonly-artifacts'
    rm -rf -- "$artifact_dir"
    export PRODUCTION_ACCOUNT_READONLY_LIVE_QA=true
    export PRODUCTION_ACCOUNT_READONLY_ARTIFACT_DIR=production-account-readonly-artifacts
    export PRODUCTION_ACCOUNT_READONLY_TARGET_PROVIDERS="${PRODUCTION_ACCOUNT_READONLY_TARGET_PROVIDERS:-bitget,kiwoom,toss,upbit}"
    [[ "$PRODUCTION_ACCOUNT_READONLY_TARGET_PROVIDERS" == 'bitget,kiwoom,toss,upbit' ]] || {
      echo 'PRODUCTION_ACCOUNT_QA_ALL_FOUR_PROVIDERS_REQUIRED' >&2
      exit 1
    }
    (
      cd stock-analyzer
      pnpm exec playwright test --config=playwright.production-account-readonly.config.ts
    )
    receipt="$artifact_dir/production-account-readonly-live-qa.json"
    ;;
  credential)
    artifact_dir='stock-analyzer/production-live-credential-reuse-artifacts'
    rm -rf -- "$artifact_dir"
    export EXPECTED_PRODUCTION_DEPLOY_RUN_ID="$PRODUCTION_DEPLOY_RUN_ID"
    export PRODUCTION_LIVE_CREDENTIAL_REUSE_QA=true
    export PRODUCTION_LIVE_CREDENTIAL_REUSE_ARTIFACT_DIR=production-live-credential-reuse-artifacts
    (
      cd stock-analyzer
      pnpm exec playwright test --config=playwright.production-live-credential-reuse.config.ts
    )
    receipt="$artifact_dir/production-live-credential-reuse-qa.json"
    ;;
esac

test -s "$receipt"
node .github/scripts/verify-production-qa-receipt.cjs \
  "$MODE" "$receipt" "$EXPECTED_DEPLOY_SHA" "$PRODUCTION_DEPLOY_RUN_ID"

for flag_name in \
  LIVE_TRADING AUTO_TRADING REAL_ORDER_ENABLED PRIVATE_TRADING_API_ALLOWED ORDER_EXECUTION_ENABLED \
  LIVE_AUTOMATIC_TRADING_ENABLED MEMBER_AUTO_TRADING_BACKGROUND_ENABLED MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED
do
  [[ "${!flag_name}" == false ]] || { echo "PRODUCTION_QA_POST_FLAG_NOT_FALSE:$flag_name" >&2; exit 1; }
done
[[ "$executionAuthority" == NONE ]] || { echo 'PRODUCTION_QA_POST_EXECUTION_AUTHORITY_NOT_NONE' >&2; exit 1; }

printf '{"ok":true,"mode":"%s","targetSha":"%s","productionDeployRunId":%s,"orders":0,"cancels":0,"amends":0,"transfers":0,"withdrawals":0,"realOrderSubmitted":false,"liveTradingAuthorityGranted":false,"autoTradingAuthorityGranted":false}\n' \
  "$MODE" "$EXPECTED_DEPLOY_SHA" "$PRODUCTION_DEPLOY_RUN_ID"
