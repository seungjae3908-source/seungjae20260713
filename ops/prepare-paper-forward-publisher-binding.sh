#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

TARGET_SHA="${1:-${TARGET_SHA:-}}"
STATE_ROOT="${PAPER_FORWARD_STATE_ROOT:-/opt/stock-app-data/paper-forward-v1}"
PUBLISHER_DIR="$STATE_ROOT/publisher"
BINDING_PATH="$STATE_ROOT/publisher-binding.json"
SNAPSHOT_PATH="$PUBLISHER_DIR/paper-state-v2.json"
PUBLISHER_ACCOUNT_ID_SHA256="${PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256:-}"

fail() {
  printf '[paper-forward-binding] %s\n' "$1" >&2
  exit "${2:-1}"
}

[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'exact lowercase 40-character target SHA required' 2
[[ "$STATE_ROOT" == '/opt/stock-app-data/paper-forward-v1' ]] || fail 'unexpected Paper Forward state root' 3
[[ "$BINDING_PATH" == "$STATE_ROOT/publisher-binding.json" ]] || fail 'publisher binding path escaped canonical state root' 3
[[ "$SNAPSHOT_PATH" == "$STATE_ROOT/publisher/paper-state-v2.json" ]] || fail 'publisher snapshot path escaped canonical state root' 3
[[ "$PUBLISHER_ACCOUNT_ID_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'protected Paper publisher SHA-256 binding is missing or invalid' 4

for command_name in node mkdir chmod; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name" 5
done

mkdir -p "$STATE_ROOT" "$PUBLISHER_DIR"
chmod 700 "$STATE_ROOT" "$PUBLISHER_DIR"

PREVIOUS_SOURCE_SHA='NONE'
if [[ -e "$BINDING_PATH" ]]; then
  [[ -r "$BINDING_PATH" ]] || fail 'existing publisher binding is unreadable' 6
  PREVIOUS_SOURCE_SHA="$(node --input-type=module - "$BINDING_PATH" "$SNAPSHOT_PATH" "$PUBLISHER_ACCOUNT_ID_SHA256" <<'NODE'
import fs from 'node:fs';
const [path, expectedSnapshotPath, expectedPublisherDigest] = process.argv.slice(2);
let value;
try {
  value = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch {
  process.exit(1);
}
const valid = value?.schemaVersion === 'paper-state-publisher-runtime-binding-v1'
  && /^[0-9a-f]{40}$/.test(String(value?.paperRuntimeSourceSha ?? ''))
  && value?.snapshotPath === expectedSnapshotPath
  && /^[0-9a-f]{64}$/.test(String(value?.publisherAccountIdSha256 ?? ''))
  && value?.immutable === true
  && value?.executionAuthority === 'NONE'
  && value?.privateApiAllowed === false
  && value?.liveTrading === false
  && value?.financialMutationAllowed === false;
if (!valid) process.exit(1);
if (value.publisherAccountIdSha256 !== expectedPublisherDigest) process.exit(2);
process.stdout.write(value.paperRuntimeSourceSha);
NODE
)" || {
    status=$?
    if [[ "$status" == 2 ]]; then
      fail 'existing publisher account binding differs; separate identity migration approval required' 7
    fi
    fail 'existing publisher binding is invalid; refusing overwrite' 6
  }
fi

node --input-type=module - "$BINDING_PATH" "$TARGET_SHA" "$SNAPSHOT_PATH" "$PUBLISHER_ACCOUNT_ID_SHA256" <<'NODE'
import fs from 'node:fs';
const [path, paperRuntimeSourceSha, snapshotPath, publisherAccountIdSha256] = process.argv.slice(2);
const value = {
  schemaVersion: 'paper-state-publisher-runtime-binding-v1',
  paperRuntimeSourceSha,
  snapshotPath,
  publisherAccountIdSha256,
  immutable: true,
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  financialMutationAllowed: false,
};
const temporary = `${path}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, path);
NODE
chmod 600 "$BINDING_PATH"

node --input-type=module - "$BINDING_PATH" "$TARGET_SHA" "$SNAPSHOT_PATH" "$PUBLISHER_ACCOUNT_ID_SHA256" "$PREVIOUS_SOURCE_SHA" <<'NODE'
import fs from 'node:fs';
const [path, expectedSourceSha, expectedSnapshotPath, expectedPublisherDigest, previousSourceSha] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(path, 'utf8'));
const valid = value?.schemaVersion === 'paper-state-publisher-runtime-binding-v1'
  && value?.paperRuntimeSourceSha === expectedSourceSha
  && value?.snapshotPath === expectedSnapshotPath
  && value?.publisherAccountIdSha256 === expectedPublisherDigest
  && value?.immutable === true
  && value?.executionAuthority === 'NONE'
  && value?.privateApiAllowed === false
  && value?.liveTrading === false
  && value?.financialMutationAllowed === false;
if (!valid) process.exit(1);
process.stdout.write(`${JSON.stringify({
  schemaVersion: 'paper-forward-publisher-binding-preparation-v1',
  status: 'PREPARED',
  targetSha: expectedSourceSha,
  previousSourceSha,
  bindingPath: path,
  snapshotPath: expectedSnapshotPath,
  accountBindingVerified: true,
  scheduleMutationPerformed: false,
  productionAppMutationPerformed: false,
  privateApiUsed: false,
  financialMutationPerformed: false,
  orderAuthority: false,
  liveTrading: false,
  sensitiveValuesEmitted: false,
})}\n`);
NODE
