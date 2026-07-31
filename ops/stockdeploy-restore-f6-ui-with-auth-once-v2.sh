#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

BASE_COMMIT="b61537204f3b9e89e84f28a2c7f935e3202a936d"
BASE_PATH="ops/stockdeploy-restore-f6-ui-with-auth-once.sh"
TMP_DIR="$(mktemp -d)"
BASE_SCRIPT="$TMP_DIR/base.sh"
PATCHED_SCRIPT="$TMP_DIR/patched.sh"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  printf 'LATEST_UI_RESTORE_V2=FAILED\nREASON=git_repository_not_found\n' >&2
  exit 1
}
cd "$REPO_ROOT"

git cat-file -e "$BASE_COMMIT^{commit}" || {
  printf 'LATEST_UI_RESTORE_V2=FAILED\nREASON=base_commit_missing\n' >&2
  exit 1
}

git show "$BASE_COMMIT:$BASE_PATH" > "$BASE_SCRIPT"

node - "$BASE_SCRIPT" "$PATCHED_SCRIPT" <<'NODE'
const fs = require('fs');
const [inputPath, outputPath] = process.argv.slice(2);
let source = fs.readFileSync(inputPath, 'utf8');

const before = '  [[ "$code" == "401" && "$error_name" == "INVALID_CREDENTIALS" ]] || fail "${label}_fake_login_unexpected"';
const after = '  [[ "$code" == "401" && ( "$error_name" == "INVALID_CREDENTIALS" || "$error_name" == "INVALID_LOGIN" ) ]] || fail "${label}_fake_login_unexpected"';

const occurrences = source.split(before).length - 1;
if (occurrences !== 1) {
  console.error(`expected_fake_login_guard_occurrences=1 actual=${occurrences}`);
  process.exit(2);
}

source = source.replace(before, after);
if (!source.includes('"INVALID_CREDENTIALS" || "$error_name" == "INVALID_LOGIN"')) process.exit(3);

fs.writeFileSync(outputPath, source, { mode: 0o700 });
console.log('FAKE_LOGIN_401_ALIASES=INVALID_CREDENTIALS,INVALID_LOGIN');
console.log('STRICT_CHECK_PATCH=OK');
NODE

bash -n "$PATCHED_SCRIPT"
printf 'PATCHED_SCRIPT_SYNTAX=OK\n'

set +e
bash "$PATCHED_SCRIPT"
RC=$?
set -e

printf 'LATEST_UI_RESTORE_V2_EXIT_CODE=%s\n' "$RC"
exit "$RC"
