#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

BASE_COMMIT="1b515b89ac1850c226aeb56ed26d84ba57d6622c"
BASE_PATH="ops/stockdeploy-login-submit-guard-once.sh"
TMP_DIR="$(mktemp -d)"
BASE_SCRIPT="$TMP_DIR/base.sh"
PATCHED_SCRIPT="$TMP_DIR/patched.sh"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  printf 'LOGIN_SUBMIT_GUARD_V2=FAILED\nREASON=git_repository_not_found\n' >&2
  exit 1
}
cd "$REPO_ROOT"

git cat-file -e "$BASE_COMMIT^{commit}" || {
  printf 'LOGIN_SUBMIT_GUARD_V2=FAILED\nREASON=base_commit_missing\n' >&2
  exit 1
}

git show "$BASE_COMMIT:$BASE_PATH" > "$BASE_SCRIPT"

node - "$BASE_SCRIPT" "$PATCHED_SCRIPT" <<'NODE'
const fs = require('fs');
const [inputPath, outputPath] = process.argv.slice(2);
let source = fs.readFileSync(inputPath, 'utf8');

const patches = [
  [
    '  local base="$1" out="$2" code',
    '  local base\n  local out\n  local code\n  base="$1"\n  out="$2"',
  ],
  [
    '  local label="$1" base="$2" attempts="${3:-120}" out="$TMP_DIR/${label}.health.json"',
    '  local label\n  local base\n  local attempts\n  local out\n  label="$1"\n  base="$2"\n  attempts="${3:-120}"\n  out="$TMP_DIR/${label}.health.json"',
  ],
  [
    '  local root="$1" out="$2"',
    '  local root\n  local out\n  root="$1"\n  out="$2"',
  ],
  [
    '  local out="$1"; : > "$out"',
    '  local out\n  out="$1"\n  : > "$out"',
  ],
  [
    '  local label="$1" base="$2" body="$TMP_DIR/${label}.fake.json" code err',
    '  local label\n  local base\n  local body\n  local code\n  local err\n  label="$1"\n  base="$2"\n  body="$TMP_DIR/${label}.fake.json"',
  ],
  [
    '  local id="lg$(printf \'%s\' "$RUN_ID"|sha256sum|cut -c1-12)" pw="Invalid!$(printf \'%s\' "$RUN_ID"|sha256sum|cut -c13-24)"',
    '  local id\n  local pw\n  id="lg$(printf \'%s\' "$RUN_ID"|sha256sum|cut -c1-12)"\n  pw="Invalid!$(printf \'%s\' "$RUN_ID"|sha256sum|cut -c13-24)"',
  ],
];

let applied = 0;
for (const [before, after] of patches) {
  if (!source.includes(before)) {
    console.error(`required_patch_pattern_missing:${before}`);
    process.exit(2);
  }
  source = source.replace(before, after);
  applied += 1;
}

if (applied !== patches.length) process.exit(3);
if (source.includes('local label="$1" base=')) process.exit(4);
if (source.includes('out="$TMP_DIR/${label}')) {
  const lines = source.split('\n');
  for (const line of lines) {
    if (/^\s*local\s+.*out="\$TMP_DIR\/\$\{label\}/.test(line)) process.exit(5);
  }
}

fs.writeFileSync(outputPath, source, { mode: 0o700 });
console.log(`LOCAL_DECLARATION_PATCHES=${applied}`);
console.log('UNBOUND_LOCAL_PATTERN_CHECK=OK');
NODE

bash -n "$PATCHED_SCRIPT"
printf 'PATCHED_SCRIPT_SYNTAX=OK\n'

set +e
bash "$PATCHED_SCRIPT"
RC=$?
set -e

printf 'LOGIN_SUBMIT_GUARD_V2_EXIT_CODE=%s\n' "$RC"
exit "$RC"
