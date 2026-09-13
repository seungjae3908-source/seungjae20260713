#!/usr/bin/env bash

# Read-only diagnostic hooks for the Production deploy verifier.
# This file must never mutate application state. It records only the name of the
# post-switch gate that is executing when the deploy script fails.
unset BASH_ENV

PROD_VERIFY_ARMED=0
PROD_VERIFY_CURRENT_GATE=""

production_verify_debug() {
  local command_text="${BASH_COMMAND:-}"

  if [[ "$command_text" == *'printf'*'TARGET_SHA'*'DEPLOY_STATE_DIR/current-sha'* ]]; then
    PROD_VERIFY_ARMED=1
    PROD_VERIFY_CURRENT_GATE=""
    return 0
  fi

  [[ "$PROD_VERIFY_ARMED" == "1" ]] || return 0

  case "$command_text" in
    *'probe_health'*'127.0.0.1'*'TARGET_SHA'*)
      PROD_VERIFY_CURRENT_GATE="LOCAL_HEALTH"
      ;;
    *'probe_data'*'127.0.0.1'*)
      PROD_VERIFY_CURRENT_GATE="DATA_PLANE"
      ;;
    *'application_runtime_ready'*)
      PROD_VERIFY_CURRENT_GATE="PM2_RUNTIME"
      ;;
    *'probe_health'*'PUBLIC_BASE_URL'*'TARGET_SHA'*)
      PROD_VERIFY_CURRENT_GATE="PUBLIC_HEALTH"
      ;;
  esac
}

production_verify_error() {
  local status="$?"
  if [[ "$PROD_VERIFY_ARMED" == "1" && -n "$PROD_VERIFY_CURRENT_GATE" ]]; then
    echo "[deploy][verify] ${PROD_VERIFY_CURRENT_GATE}=FAIL status=${status}" >&2
  fi
  return "$status"
}

trap production_verify_debug DEBUG
trap production_verify_error ERR
