#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="${SOURCE_DIR:-${1:-}}"
BASE_SHA="${BASE_SHA:-${2:-}}"
HEAD_SHA="${HEAD_SHA:-${3:-}}"
MANIFEST_REL=market-intelligence-sidecar/config/public-forward-liquidity-server-component-paths-v1.txt

fail() {
  echo "[server-component-equivalence] $1" >&2
  exit "${2:-1}"
}

[[ -n "$SOURCE_DIR" && -d "$SOURCE_DIR/.git" ]] || fail "SOURCE_DIR must be a Git checkout" 2
[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "BASE_SHA must be exact lowercase SHA" 2
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "HEAD_SHA must be exact lowercase SHA" 2
[[ -r "$SOURCE_DIR/$MANIFEST_REL" ]] || fail "component manifest missing" 2

for command_name in git sha256sum awk sort grep mktemp node; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name" 3
done

git -C "$SOURCE_DIR" cat-file -e "$BASE_SHA^{commit}" || fail "BASE_SHA commit missing" 4
git -C "$SOURCE_DIR" cat-file -e "$HEAD_SHA^{commit}" || fail "HEAD_SHA commit missing" 4
git -C "$SOURCE_DIR" merge-base --is-ancestor "$BASE_SHA" "$HEAD_SHA"   || fail "evidence SHA is not an ancestor of current main" 5

mapfile -t COMPONENT_PATHS < <(
  grep -Ev '^[[:space:]]*(#|$)' "$SOURCE_DIR/$MANIFEST_REL"
)
[[ "${#COMPONENT_PATHS[@]}" -gt 0 ]] || fail "component manifest empty" 6

BASE_LIST="$(mktemp)"
HEAD_LIST="$(mktemp)"
CHANGED_LIST="$(mktemp)"
cleanup() { rm -f -- "$BASE_LIST" "$HEAD_LIST" "$CHANGED_LIST"; }
trap cleanup EXIT

git -C "$SOURCE_DIR" ls-tree -r "$BASE_SHA" -- "${COMPONENT_PATHS[@]}" | LC_ALL=C sort > "$BASE_LIST"
git -C "$SOURCE_DIR" ls-tree -r "$HEAD_SHA" -- "${COMPONENT_PATHS[@]}" | LC_ALL=C sort > "$HEAD_LIST"
git -C "$SOURCE_DIR" diff --name-only "$BASE_SHA" "$HEAD_SHA" -- "${COMPONENT_PATHS[@]}"   | LC_ALL=C sort > "$CHANGED_LIST"

[[ -s "$BASE_LIST" && -s "$HEAD_LIST" ]] || fail "component tree listing empty" 7

BASE_DIGEST="$(sha256sum "$BASE_LIST" | awk '{print $1}')"
HEAD_DIGEST="$(sha256sum "$HEAD_LIST" | awk '{print $1}')"
CHANGED_N="$(grep -c . "$CHANGED_LIST" || true)"

EQUIVALENT=false
if [[ "$BASE_DIGEST" == "$HEAD_DIGEST" && "$CHANGED_N" == "0" ]]; then
  EQUIVALENT=true
fi

node - "$BASE_SHA" "$HEAD_SHA" "$BASE_DIGEST" "$HEAD_DIGEST" "$CHANGED_N" "$EQUIVALENT" <<'NODE'
const [baseSha, headSha, baseDigest, headDigest, changedNRaw, equivalentRaw] = process.argv.slice(2);
const value = {
  schemaVersion: 'public-forward-liquidity-server-component-equivalence-v1',
  evidenceSha: baseSha,
  currentMainSha: headSha,
  evidenceComponentDigest: baseDigest,
  currentComponentDigest: headDigest,
  changedPathCount: Number(changedNRaw),
  componentEquivalentCurrentMain: equivalentRaw === 'true',
  ancestorRequired: true,
};
process.stdout.write(JSON.stringify(value));
NODE

[[ "$EQUIVALENT" == true ]] || fail "component drift detected" 8
