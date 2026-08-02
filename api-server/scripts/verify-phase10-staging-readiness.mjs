import { execFileSync } from 'node:child_process';

const mode = process.argv[2] ?? '--environment';
const env = process.env;
const required = [
  'STAGING_SSH_HOST', 'STAGING_SSH_USER', 'STAGING_SSH_PRIVATE_KEY', 'STAGING_BASE_URL',
  'STAGING_DATABASE_URL', 'STAGING_AI_API_KEY',
  'STAGING_PENDING_EMAIL', 'STAGING_PENDING_PASSWORD',
  'STAGING_ASSOCIATE_EMAIL', 'STAGING_ASSOCIATE_PASSWORD',
  'STAGING_REGULAR_EMAIL', 'STAGING_REGULAR_PASSWORD',
  'STAGING_ADMIN_EMAIL', 'STAGING_ADMIN_PASSWORD',
];

const fail = (message) => { throw new Error(`[phase10-staging-readiness] ${message}`); };
const value = (name) => String(env[name] ?? '').trim();

for (const name of required) {
  if (!value(name)) fail(`missing required isolated staging value: ${name}`);
}

const forbiddenFragments = ['lsj119.duckdns.org', '/opt/stock-app', 'stock-app-production'];
for (const [name, raw] of Object.entries(env)) {
  if (!name.startsWith('STAGING_')) continue;
  const normalized = String(raw ?? '').toLowerCase();
  for (const forbidden of forbiddenFragments) {
    if (normalized.includes(forbidden.toLowerCase())) fail(`${name} contains a production identifier`);
  }
}
if (/\b(?:prod|production)\b/i.test(value('STAGING_DATABASE_URL'))) fail('staging database URL looks like production');
if (!/^https:\/\//i.test(value('STAGING_BASE_URL'))) fail('staging base URL must use HTTPS');
if (new Set([
  value('STAGING_PENDING_EMAIL'), value('STAGING_ASSOCIATE_EMAIL'),
  value('STAGING_REGULAR_EMAIL'), value('STAGING_ADMIN_EMAIL'),
]).size !== 4) fail('four distinct staging accounts are required');
if (value('STAGING_AI_API_KEY').length < 12) fail('staging AI key is not plausibly configured');

if (mode === '--environment') {
  console.log('[phase10-staging-readiness] isolated URL, DB, AI secret, SSH target, and four distinct accounts are configured');
  process.exit(0);
}

if (mode !== '--remote') fail(`unknown mode: ${mode}`);
const targetSha = value('TARGET_SHA');
if (!/^[0-9a-f]{40}$/.test(targetSha)) fail('TARGET_SHA must be an exact lowercase commit SHA');
const port = value('STAGING_SSH_PORT') || '22';
const remote = `${value('STAGING_SSH_USER')}@${value('STAGING_SSH_HOST')}`;
const sshArgs = ['-i', `${env.HOME}/.ssh/id_ed25519`, '-p', port, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', remote];
const runRemote = (script) => execFileSync('ssh', [...sshArgs, 'bash', '-s'], {
  input: script,
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
  maxBuffer: 8 * 1024 * 1024,
});

const result = runRemote(`
set -Eeuo pipefail
STAGING_DIR=/srv/seungjae-staging
BACKUP_ROOT=/srv/seungjae-staging-backups
STATE_DIR="$STAGING_DIR/.deploy"
[[ -s "$STATE_DIR/current-sha" ]]
ACTUAL_SHA="$(tr -d '[:space:]' < "$STATE_DIR/current-sha")"
[[ "$ACTUAL_SHA" == "${targetSha}" ]]
LATEST_BACKUP="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk 'NR==1 {print $2}')"
[[ -n "$LATEST_BACKUP" && -f "$LATEST_BACKUP/checksums.sha256" ]]
(
  cd "$LATEST_BACKUP/source"
  sha256sum -c "$LATEST_BACKUP/checksums.sha256" >/dev/null
)
! grep -RIlE '(Authorization:[[:space:]]*Bearer|SUPABASE_SERVICE_ROLE_KEY|TRADING_REVIEW_API_KEY=|BEGIN (RSA |OPENSSH )?PRIVATE KEY)' \
  "$STAGING_DIR/logs" "$STAGING_DIR/api-server/logs" 2>/dev/null | grep -q .
printf 'sha=%s\nbackup=%s\n' "$ACTUAL_SHA" "$LATEST_BACKUP"
`);

if (!result.includes(`sha=${targetSha}`)) fail('remote staging revision verification failed');
const health = await fetch(`${value('STAGING_BASE_URL').replace(/\/$/, '')}/api/health`, {
  headers: { 'user-agent': 'phase10-staging-readiness' },
  signal: AbortSignal.timeout(15_000),
});
if (!health.ok) fail(`staging health returned HTTP ${health.status}`);
const payload = await health.json();
if (payload?.ok !== true) fail('staging health payload is not ok');
const reportedSha = payload?.deploySha ?? payload?.sha ?? payload?.commitSha;
if (reportedSha && reportedSha !== targetSha) fail('staging health reports a different revision');

console.log('[phase10-staging-readiness] remote SHA, health, backup checksum, and log redaction checks succeeded');
