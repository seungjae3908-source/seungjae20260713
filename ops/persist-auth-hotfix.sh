#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP="${APP:-/opt/stock-app}"
REPO="${REPO:-/root/stock-app-staging/work-backup-20260721/seungjae20260713}"
BASE_REF="${BASE_REF:-v8-ai-live}"
REMOTE="${REMOTE:-origin}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BRANCH="${BRANCH:-agent/auth-session-permanent-$STAMP}"
WT="$(dirname "$REPO")/auth-hotfix-worktree-$STAMP-$$"
ADDED=0

fail(){ printf 'PERSIST_AUTH=FAILED\nREASON=%s\n' "$1" >&2; exit 1; }
cleanup(){ local rc=$?; trap - EXIT; git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$WT"; exit "$rc"; }
trap cleanup EXIT

for c in git grep find cp; do command -v "$c" >/dev/null || fail "${c}_missing"; done
[[ -d "$REPO/.git" ]] || fail 'source_repo_missing'
[[ -d "$APP/api-server/src" ]] || fail 'operating_source_missing'
git -C "$REPO" fetch "$REMOTE" --prune >/dev/null

git -C "$REPO" rev-parse --verify "$BASE_REF^{commit}" >/dev/null 2>&1 || git -C "$REPO" rev-parse --verify "$REMOTE/$BASE_REF^{commit}" >/dev/null 2>&1 || fail 'base_ref_missing'
BASE_COMMIT="$(git -C "$REPO" rev-parse --verify "$BASE_REF^{commit}" 2>/dev/null || git -C "$REPO" rev-parse --verify "$REMOTE/$BASE_REF^{commit}")"
git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH" && fail 'branch_already_exists'
git -C "$REPO" worktree add -b "$BRANCH" "$WT" "$BASE_COMMIT" >/dev/null

mapfile -t AUTH_FILES < <(grep -RIl --exclude-dir=node_modules --exclude-dir=dist --include='auth.ts' --include='auth.tsx' -E 'INVALID_CREDENTIALS|LOGIN_REQUIRED|signInWithPassword' "$APP/api-server/src" "$APP/stock-analyzer/src" 2>/dev/null | sort -u)
mapfile -t ROUTE_FILES < <(find "$APP/api-server/src" -maxdepth 6 -type f -path '*/routes/index.ts' -print 2>/dev/null | sort -u)
((${#AUTH_FILES[@]}>=1)) || fail 'auth_file_not_found'
((${#ROUTE_FILES[@]}>=1)) || fail 'routes_index_not_found'
FILES=("${AUTH_FILES[@]}" "${ROUTE_FILES[@]}")

for src in "${FILES[@]}"; do
  rel="${src#"$APP"/}"
  [[ "$rel" != "$src" ]] || fail 'source_outside_app'
  mkdir -p "$WT/$(dirname "$rel")"
  cp -a "$src" "$WT/$rel"
  git -C "$WT" add -- "$rel"
  ADDED=$((ADDED+1))
done

git -C "$WT" diff --cached --check
git -C "$WT" diff --cached --quiet && { printf 'PERSIST_AUTH=NO_CHANGES\n'; exit 0; }
git -C "$WT" commit -m 'fix(auth): persist login session recovery' >/dev/null
git -C "$WT" push -u "$REMOTE" "$BRANCH" >/dev/null
printf 'PERSIST_AUTH=PASSED\nBRANCH=%s\nCOMMIT=%s\nFILES=%s\n' "$BRANCH" "$(git -C "$WT" rev-parse HEAD)" "$ADDED"
