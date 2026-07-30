#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

REPOSITORY="${REPOSITORY:-seungjae3908-source/seungjae20260713}"
DEPLOY_HOST="${DEPLOY_HOST:-lsj119.duckdns.org}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_PR="${DEPLOY_PR:-6}"
KEY_FILE="${KEY_FILE:-/root/.ssh/stock-app-github-actions-ed25519}"
AUTHORIZED_KEYS="${AUTHORIZED_KEYS:-/root/.ssh/authorized_keys}"

if [[ "$(id -u)" != "0" ]]; then
  echo "[bootstrap] run this script as root" >&2
  exit 1
fi

for command_name in ssh-keygen sshd gh git; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "[bootstrap] missing command: $command_name" >&2
    exit 2
  }
done

if ! gh auth status >/dev/null 2>&1; then
  echo "[bootstrap] GitHub CLI is not logged in on this server." >&2
  echo "[bootstrap] run: gh auth login" >&2
  exit 3
fi

if [[ -z "${DEPLOY_PORT:-}" ]]; then
  DEPLOY_PORT="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }' || true)"
fi
DEPLOY_PORT="${DEPLOY_PORT:-22}"

mkdir -p "$(dirname "$KEY_FILE")"
chmod 700 "$(dirname "$KEY_FILE")"
touch "$AUTHORIZED_KEYS"
chmod 600 "$AUTHORIZED_KEYS"

if [[ ! -f "$KEY_FILE" ]]; then
  ssh-keygen \
    -t ed25519 \
    -N '' \
    -C 'github-actions-stock-app-production' \
    -f "$KEY_FILE" >/dev/null
  echo "[bootstrap] created deployment SSH key"
else
  echo "[bootstrap] reusing existing deployment SSH key"
fi

PUBLIC_KEY="$(cat "$KEY_FILE.pub")"
if ! grep -qxF "$PUBLIC_KEY" "$AUTHORIZED_KEYS"; then
  printf '%s\n' "$PUBLIC_KEY" >> "$AUTHORIZED_KEYS"
  echo "[bootstrap] authorized deployment key"
fi

HOST_KEY_FILE=''
for candidate in \
  /etc/ssh/ssh_host_ed25519_key.pub \
  /etc/ssh/ssh_host_ecdsa_key.pub \
  /etc/ssh/ssh_host_rsa_key.pub; do
  if [[ -f "$candidate" ]]; then
    HOST_KEY_FILE="$candidate"
    break
  fi
done

[[ -n "$HOST_KEY_FILE" ]] || {
  echo "[bootstrap] SSH host public key was not found" >&2
  exit 4
}

read -r HOST_KEY_TYPE HOST_KEY_VALUE _ < "$HOST_KEY_FILE"
if [[ "$DEPLOY_PORT" == "22" ]]; then
  KNOWN_HOSTS_LINE="$DEPLOY_HOST $HOST_KEY_TYPE $HOST_KEY_VALUE"
else
  KNOWN_HOSTS_LINE="[$DEPLOY_HOST]:$DEPLOY_PORT $HOST_KEY_TYPE $HOST_KEY_VALUE"
fi

echo "[bootstrap] registering GitHub Actions secrets"
printf '%s' "$DEPLOY_HOST" | gh secret set PROD_SSH_HOST --repo "$REPOSITORY"
printf '%s' "$DEPLOY_USER" | gh secret set PROD_SSH_USER --repo "$REPOSITORY"
printf '%s' "$DEPLOY_PORT" | gh secret set PROD_SSH_PORT --repo "$REPOSITORY"
gh secret set PROD_SSH_PRIVATE_KEY --repo "$REPOSITORY" < "$KEY_FILE"
printf '%s' "$KNOWN_HOSTS_LINE" | gh secret set PROD_SSH_KNOWN_HOSTS --repo "$REPOSITORY"

echo "[bootstrap] deployment secrets registered"

if gh pr view "$DEPLOY_PR" --repo "$REPOSITORY" >/dev/null 2>&1; then
  gh pr ready "$DEPLOY_PR" --repo "$REPOSITORY" >/dev/null 2>&1 || true
  gh pr merge "$DEPLOY_PR" \
    --repo "$REPOSITORY" \
    --squash \
    --delete-branch
  echo "[bootstrap] PR #$DEPLOY_PR merged; first automatic deployment has started"
else
  echo "[bootstrap] PR #$DEPLOY_PR was not found; secrets are ready, but nothing was merged" >&2
  exit 5
fi
