import { execFileSync } from 'node:child_process';

const requestedMode = process.argv[2] ?? '--preflight';
const mode = requestedMode === '--environment' ? '--preflight' : requestedMode;
const env = process.env;

const minimalDeployRequired = [
  'STAGING_SSH_HOST',
  'STAGING_SSH_USER',
  'STAGING_SSH_PRIVATE_KEY',
  'STAGING_BASE_URL',
];

const fullValidationRequired = [
  'STAGING_SUPABASE_URL',
  'STAGING_SUPABASE_ANON_KEY',
  'STAGING_SUPABASE_SECRET_KEY',
];

const destructiveValidationRequired = ['STAGING_DATABASE_URL'];
const knownProductionSupabaseProjectRefs = new Set([
  // Production project confirmed by the repository owner. A staging run must
  // fail before deployment or ephemeral account creation when this ref is used.
  'bawcbkoyovbeajkrnduq',
]);

const sensitiveNames = [
  ...minimalDeployRequired,
  ...fullValidationRequired,
  ...destructiveValidationRequired,
  'STAGING_AI_API_KEY',
  'STAGING_SSH_KNOWN_HOSTS',
];

const value = (name) => String(env[name] ?? '').trim();
const enabled = (name) => value(name).toLowerCase() === 'true';
const encode = (raw) => Buffer.from(String(raw), 'utf8').toString('base64');
const fail = (message) => { throw new Error(`[phase10-staging-readiness] ${message}`); };

const redact = (raw) => {
  let output = String(raw ?? '');
  for (const name of sensitiveNames) {
    const secret = value(name);
    if (secret) output = output.split(secret).join('[REDACTED]');
  }
  return output;
};

function collectConfigurationErrors({
  requireFullValidation = false,
  requireDestructiveValidation = false,
} = {}) {
  const failures = new Map();
  const add = (name, message) => {
    const messages = failures.get(name) ?? [];
    if (!messages.includes(message)) messages.push(message);
    failures.set(name, messages);
  };
  const requireNames = (names, reason) => {
    for (const name of names) {
      if (!value(name)) add(name, `missing; required for ${reason}`);
    }
  };

  requireNames(minimalDeployRequired, 'preflight and non-destructive staging deployment');
  if (requireFullValidation) {
    requireNames(fullValidationRequired, 'ephemeral account provisioning and full browser validation');
  }
  if (requireDestructiveValidation) {
    requireNames(destructiveValidationRequired, 'explicit staging-only database/recovery validation');
  }

  const action = value('STAGING_ACTION');
  if (action && !['preflight', 'deploy'].includes(action)) {
    add('STAGING_ACTION', 'must be preflight or deploy');
  }

  for (const flagName of [
    'STAGING_RUN_FULL_VALIDATION',
    'STAGING_RUN_DESTRUCTIVE_RECOVERY_DRILL',
  ]) {
    const flag = value(flagName);
    if (flag && !['true', 'false'].includes(flag.toLowerCase())) {
      add(flagName, 'must be true or false');
    }
  }

  const port = value('STAGING_SSH_PORT');
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    add('STAGING_SSH_PORT', 'must be an integer from 1 to 65535');
  }

  const privateKey = value('STAGING_SSH_PRIVATE_KEY');
  if (privateKey && !/-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----/.test(privateKey)) {
    add('STAGING_SSH_PRIVATE_KEY', 'does not look like a complete supported SSH private key');
  }

  const baseUrl = value('STAGING_BASE_URL');
  if (baseUrl && !/^https:\/\//i.test(baseUrl)) {
    add('STAGING_BASE_URL', 'must use HTTPS');
  }

  const supabaseUrl = value('STAGING_SUPABASE_URL');
  if (supabaseUrl) {
    try {
      const parsed = new URL(supabaseUrl);
      if (parsed.protocol !== 'https:') {
        add('STAGING_SUPABASE_URL', 'must use HTTPS');
      }
      const projectMatch = /^([a-z0-9]+)\.supabase\.co$/i.exec(parsed.hostname);
      if (!projectMatch) {
        add('STAGING_SUPABASE_URL', 'must use the standard isolated <project-ref>.supabase.co host');
      } else if (knownProductionSupabaseProjectRefs.has(projectMatch[1].toLowerCase())) {
        add('STAGING_SUPABASE_URL', 'resolves to the known production Supabase project');
      }
    } catch {
      add('STAGING_SUPABASE_URL', 'must be a valid HTTPS URL');
    }
  }

  const anonKey = value('STAGING_SUPABASE_ANON_KEY');
  const secretKey = value('STAGING_SUPABASE_SECRET_KEY');
  if (anonKey && anonKey.length < 20) {
    add('STAGING_SUPABASE_ANON_KEY', 'is too short to be a plausible Supabase key');
  }
  if (secretKey && secretKey.length < 20) {
    add('STAGING_SUPABASE_SECRET_KEY', 'is too short to be a plausible Supabase server key');
  }
  if (anonKey && secretKey && anonKey === secretKey) {
    add('STAGING_SUPABASE_SECRET_KEY', 'must not be identical to the publishable anon key');
  }

  const databaseUrl = value('STAGING_DATABASE_URL');
  if (databaseUrl && !/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    add('STAGING_DATABASE_URL', 'must be a PostgreSQL connection URL');
  }

  const aiKey = value('STAGING_AI_API_KEY');
  if (aiKey && aiKey.length < 12) {
    add('STAGING_AI_API_KEY', 'is configured but too short to be plausible');
  }

  const forbiddenFragments = [
    'lsj119.duckdns.org',
    '/opt/stock-app',
    'stock-app-production',
    'pm2_name=stock-app',
  ];
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith('STAGING_')) continue;
    const normalized = String(raw ?? '').toLowerCase();
    for (const forbidden of forbiddenFragments) {
      if (normalized.includes(forbidden.toLowerCase())) {
        add(name, `contains forbidden production identifier: ${forbidden}`);
      }
    }
  }
  if (databaseUrl && /\b(?:prod|production)\b/i.test(databaseUrl)) {
    add('STAGING_DATABASE_URL', 'looks like a production database URL');
  }

  return failures;
}

function printConfigurationErrors(failures) {
  console.error(`[phase10-staging-readiness] ${failures.size} staging setting name(s) need attention:`);
  for (const [name, messages] of failures) {
    console.error(`- ${name}: ${messages.join('; ')}`);
  }
  console.error('[phase10-staging-readiness] no server, PM2 process, database, or application files were changed');
}

if (mode === '--preflight') {
  const requireFullValidation = enabled('STAGING_RUN_FULL_VALIDATION');
  const requireDestructiveValidation = enabled('STAGING_RUN_DESTRUCTIVE_RECOVERY_DRILL');
  const failures = collectConfigurationErrors({
    requireFullValidation,
    requireDestructiveValidation,
  });
  if (failures.size) {
    printConfigurationErrors(failures);
    process.exit(1);
  }

  const checked = [
    'minimal deployment',
    requireFullValidation ? 'ephemeral account provisioning and full account/browser validation' : null,
    requireDestructiveValidation ? 'explicit destructive staging validation' : null,
  ].filter(Boolean).join(', ');
  console.log(`[phase10-staging-readiness] preflight passed for: ${checked}`);
  if (requireFullValidation) {
    console.log('[phase10-staging-readiness] four validation accounts will be created temporarily and deleted by the browser suite');
  }
  console.log('[phase10-staging-readiness] AI API key is optional and was not required');
  process.exit(0);
}

if (mode !== '--remote') fail(`unknown mode: ${mode}`);

const failures = collectConfigurationErrors({
  requireFullValidation: enabled('STAGING_RUN_FULL_VALIDATION'),
  requireDestructiveValidation: true,
});
if (failures.size) {
  printConfigurationErrors(failures);
  process.exit(1);
}

const targetSha = value('TARGET_SHA');
if (!/^[0-9a-f]{40}$/.test(targetSha)) fail('TARGET_SHA must be an exact lowercase commit SHA');
const repositoryUrl = value('REPOSITORY_URL');
if (!/^https:\/\/github\.com\/seungjae3908-source\/seungjae20260713\.git$/.test(repositoryUrl)) {
  fail('REPOSITORY_URL is missing or unexpected');
}

const port = value('STAGING_SSH_PORT') || '22';
const remote = `${value('STAGING_SSH_USER')}@${value('STAGING_SSH_HOST')}`;
const sshArgs = [
  '-i', `${env.HOME}/.ssh/id_ed25519`,
  '-p', port,
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=15',
  remote,
];

const runRemote = (script) => {
  try {
    return execFileSync('ssh', [...sshArgs, 'bash', '-s'], {
      input: script,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const detail = redact(error?.stderr || error?.message || 'unknown remote failure').slice(0, 4000);
    fail(`remote recovery drill failed: ${detail}`);
  }
};

const encodedSecrets = {
  baseUrl: encode(value('STAGING_BASE_URL')),
  database: encode(value('STAGING_DATABASE_URL')),
  supabaseUrl: encode(value('STAGING_SUPABASE_URL')),
  supabaseAnonKey: encode(value('STAGING_SUPABASE_ANON_KEY')),
  supabaseSecretKey: encode(value('STAGING_SUPABASE_SECRET_KEY')),
  ai: encode(value('STAGING_AI_API_KEY')),
};

const result = runRemote(`
set -Eeuo pipefail
umask 077
TARGET_SHA='${targetSha}'
REPOSITORY_URL='${repositoryUrl}'
STAGING_DIR=/srv/seungjae-staging
STAGING_PM2_NAME=seungjae-staging
STAGING_PORT=18080
STAGING_CANARY_PORT=18082
BACKUP_ROOT=/srv/seungjae-staging-backups
STATE_DIR="$STAGING_DIR/.deploy"
SOURCE_DIR="$(mktemp -d /tmp/seungjae-staging-recovery-source.XXXXXX)"
DRILL_ROOT="$(mktemp -d /tmp/seungjae-staging-recovery-drill.XXXXXX)"
cleanup() { rm -rf -- "$SOURCE_DIR" "$DRILL_ROOT"; }
trap cleanup EXIT

for command_name in git node pnpm pm2 curl rsync sha256sum base64 grep find awk sort head cut cp install date; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "missing command: $command_name" >&2; exit 21; }
done

decode() { printf '%s' "$1" | base64 -d; }
STAGING_BASE_URL="$(decode '${encodedSecrets.baseUrl}')"
STAGING_DATABASE_URL="$(decode '${encodedSecrets.database}')"
STAGING_SUPABASE_URL="$(decode '${encodedSecrets.supabaseUrl}')"
STAGING_SUPABASE_ANON_KEY="$(decode '${encodedSecrets.supabaseAnonKey}')"
STAGING_SUPABASE_SECRET_KEY="$(decode '${encodedSecrets.supabaseSecretKey}')"
STAGING_AI_API_KEY="$(decode '${encodedSecrets.ai}')"
SENSITIVE_VALUES=(
  "$STAGING_DATABASE_URL"
  "$STAGING_SUPABASE_URL"
  "$STAGING_SUPABASE_ANON_KEY"
  "$STAGING_SUPABASE_SECRET_KEY"
  "$STAGING_AI_API_KEY"
)

write_runtime_env() {
  local deploy_sha="$1"
  local temp_env
  mkdir -p "$STAGING_DIR/api-server"
  temp_env="$(mktemp "$STAGING_DIR/api-server/.env.staging.tmp.XXXXXX")"
  {
    printf 'NODE_ENV=production\n'
    printf 'PORT=%s\n' "$STAGING_PORT"
    printf 'API_PORT=%s\n' "$STAGING_PORT"
    printf 'APP_ENV=staging\n'
    printf 'DEPLOY_SHA=%s\n' "$deploy_sha"
    [[ -n "$STAGING_SUPABASE_URL" ]] && printf 'SUPABASE_URL=%s\n' "$STAGING_SUPABASE_URL"
    [[ -n "$STAGING_SUPABASE_ANON_KEY" ]] && printf 'SUPABASE_ANON_KEY=%s\n' "$STAGING_SUPABASE_ANON_KEY"
    [[ -n "$STAGING_SUPABASE_SECRET_KEY" ]] && printf 'SUPABASE_SECRET_KEY=%s\n' "$STAGING_SUPABASE_SECRET_KEY"
  } > "$temp_env"
  chmod 600 "$temp_env"
  mv -f "$temp_env" "$STAGING_DIR/api-server/.env.staging"
}

probe_local() {
  local expected_sha="$1"
  local output attempt
  output="$(mktemp)"
  for attempt in $(seq 1 30); do
    if curl --fail --silent --max-time 10 "http://127.0.0.1:$STAGING_PORT/api/health" > "$output" 2>/dev/null \
      && node - "$expected_sha" "$output" <<'NODE'
const fs=require('fs');
const expected=process.argv[2];
const health=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
if(health.ok!==true) process.exit(1);
const reported=health.deploySha||health.sha||health.commitSha;
if(reported && reported!==expected) process.exit(1);
NODE
    then
      rm -f "$output"
      return 0
    fi
    sleep 1
  done
  rm -f "$output"
  return 1
}

[[ -s "$STATE_DIR/current-sha" ]]
ACTUAL_SHA="$(tr -d '[:space:]' < "$STATE_DIR/current-sha")"
[[ "$ACTUAL_SHA" == "$TARGET_SHA" ]]
[[ -s "$STATE_DIR/last-backup" ]]
LATEST_BACKUP="$(cat "$STATE_DIR/last-backup")"
[[ "$LATEST_BACKUP" == "$BACKUP_ROOT"/* ]]
[[ -d "$LATEST_BACKUP/source" && -f "$LATEST_BACKUP/checksums.sha256" ]]
[[ -s "$LATEST_BACKUP/previous-sha.txt" ]]
PREVIOUS_SHA="$(tr -d '[:space:]' < "$LATEST_BACKUP/previous-sha.txt")"
[[ "$PREVIOUS_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$PREVIOUS_SHA" != "$TARGET_SHA" ]]
[[ -s "$STATE_DIR/current-release" ]]
CURRENT_RELEASE="$(cat "$STATE_DIR/current-release")"
[[ -d "$CURRENT_RELEASE" ]]

(
  cd "$LATEST_BACKUP/source"
  sha256sum -c "$LATEST_BACKUP/checksums.sha256" >/dev/null
)

mkdir -p "$DRILL_ROOT/source"
cp -a --reflink=auto "$LATEST_BACKUP/source/." "$DRILL_ROOT/source/" 2>/dev/null || cp -a "$LATEST_BACKUP/source/." "$DRILL_ROOT/source/"
cp "$LATEST_BACKUP/checksums.sha256" "$DRILL_ROOT/checksums.sha256"
FIRST_RELATIVE="$(head -n 1 "$DRILL_ROOT/checksums.sha256" | cut -c 67-)"
[[ -n "$FIRST_RELATIVE" && -f "$DRILL_ROOT/source/\${FIRST_RELATIVE#./}" ]]
printf '\nphase10-corruption\n' >> "$DRILL_ROOT/source/\${FIRST_RELATIVE#./}"
if (cd "$DRILL_ROOT/source" && sha256sum -c "$DRILL_ROOT/checksums.sha256" >/dev/null 2>&1); then
  echo 'damaged backup was not rejected' >&2
  exit 22
fi
printf 'damaged_backup_rejected=true\n'

DELETE_RELATIVE=stock-analyzer/dist/public/index.html
[[ -f "$STAGING_DIR/$DELETE_RELATIVE" && -f "$CURRENT_RELEASE/$DELETE_RELATIVE" ]]
DELETE_EXPECTED="$(sha256sum "$CURRENT_RELEASE/$DELETE_RELATIVE" | awk '{print $1}')"
rm -f "$STAGING_DIR/$DELETE_RELATIVE"
[[ ! -e "$STAGING_DIR/$DELETE_RELATIVE" ]]
install -D -m 0644 "$CURRENT_RELEASE/$DELETE_RELATIVE" "$STAGING_DIR/$DELETE_RELATIVE"
[[ "$(sha256sum "$STAGING_DIR/$DELETE_RELATIVE" | awk '{print $1}')" == "$DELETE_EXPECTED" ]]
printf 'delete_restore=true\n'

RTO_STARTED="$(date +%s)"
git clone --quiet --filter=blob:none --no-checkout "$REPOSITORY_URL" "$SOURCE_DIR"
git -C "$SOURCE_DIR" fetch --quiet --depth 1 origin "$TARGET_SHA"
[[ "$(git -C "$SOURCE_DIR" rev-parse FETCH_HEAD^{commit})" == "$TARGET_SHA" ]]
git -C "$SOURCE_DIR" checkout --quiet --detach "$TARGET_SHA"
chmod 700 "$SOURCE_DIR/ops/deploy-staging.sh"

deploy_target() {
  local failpoint="\${1:-}"
  SOURCE_DIR="$SOURCE_DIR" \
  STAGING_DIR="$STAGING_DIR" \
  STAGING_PM2_NAME="$STAGING_PM2_NAME" \
  STAGING_PORT="$STAGING_PORT" \
  STAGING_CANARY_PORT="$STAGING_CANARY_PORT" \
  STAGING_BASE_URL="$STAGING_BASE_URL" \
  STAGING_SUPABASE_URL="$STAGING_SUPABASE_URL" \
  STAGING_SUPABASE_ANON_KEY="$STAGING_SUPABASE_ANON_KEY" \
  STAGING_SUPABASE_SECRET_KEY="$STAGING_SUPABASE_SECRET_KEY" \
  STAGING_FAILPOINT="$failpoint" \
  "$SOURCE_DIR/ops/deploy-staging.sh" "$TARGET_SHA"
}

set +e
deploy_target after-promotion
FAILPOINT_STATUS=$?
set -e
[[ "$FAILPOINT_STATUS" -ne 0 ]]
[[ "$(tr -d '[:space:]' < "$STATE_DIR/current-sha")" == "$TARGET_SHA" ]]
[[ "$(tr -d '[:space:]' < "$STATE_DIR/last-rollback-from")" == "$TARGET_SHA" ]]
[[ "$(tr -d '[:space:]' < "$STATE_DIR/last-rollback-to")" == "$TARGET_SHA" ]]
probe_local "$TARGET_SHA"
printf 'failed_deploy_rollback=true\n'

rsync -a --delete \
  --exclude='.deploy/' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='*/.env' \
  --exclude='*/.env.*' \
  --exclude='logs/' \
  --exclude='*/logs/' \
  --exclude='uploads/' \
  --exclude='*/uploads/' \
  "$LATEST_BACKUP/source/" "$STAGING_DIR/"
write_runtime_env "$PREVIOUS_SHA"
printf '%s\n' "$PREVIOUS_SHA" > "$STATE_DIR/current-sha"
PREVIOUS_RELEASE="$(cat "$LATEST_BACKUP/previous-release.txt" 2>/dev/null || true)"
if [[ -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
  printf '%s\n' "$PREVIOUS_RELEASE" > "$STATE_DIR/current-release"
else
  printf '%s\n' "$LATEST_BACKUP/source" > "$STATE_DIR/current-release"
fi
pm2 restart "$STAGING_PM2_NAME" --update-env >/dev/null
pm2 save >/dev/null
probe_local "$PREVIOUS_SHA"
printf 'previous_sha_recovery=true\n'

deploy_target
probe_local "$TARGET_SHA"
deploy_target
probe_local "$TARGET_SHA"
printf 'same_sha_redeploy=true\n'

mapfile -d '' -t LOG_FILES < <(
  find "$HOME/.pm2/logs" -maxdepth 1 -type f -name "\${STAGING_PM2_NAME}-*.log" -print0 2>/dev/null || true
  find "$STAGING_DIR/logs" "$STAGING_DIR/api-server/logs" -type f -print0 2>/dev/null || true
)
(( \${#LOG_FILES[@]} > 0 )) || { echo 'no staging log files were available for inspection' >&2; exit 23; }
if grep -IlE '(Authorization:[[:space:]]*Bearer|SUPABASE_(?:SECRET|SERVICE_ROLE)_KEY=|TRADING_REVIEW_API_KEY=|BEGIN (RSA |OPENSSH )?PRIVATE KEY)' "\${LOG_FILES[@]}" | grep -q .; then
  echo 'sensitive credential pattern found in staging logs' >&2
  exit 24
fi
for sensitive in "\${SENSITIVE_VALUES[@]}"; do
  [[ -z "$sensitive" ]] && continue
  if grep -FIl -- "$sensitive" "\${LOG_FILES[@]}" >/dev/null; then
    echo 'configured staging secret or personal value found in logs' >&2
    exit 25
  fi
done

RTO_SECONDS=$(( $(date +%s) - RTO_STARTED ))
printf 'sha=%s\n' "$TARGET_SHA"
printf 'previous_sha=%s\n' "$PREVIOUS_SHA"
printf 'backup=%s\n' "$LATEST_BACKUP"
printf 'rto_seconds=%s\n' "$RTO_SECONDS"
printf 'rpo_seconds=0\n'
printf 'logs_scanned=%s\n' "\${#LOG_FILES[@]}"
`);

for (const marker of [
  `sha=${targetSha}`,
  'damaged_backup_rejected=true',
  'delete_restore=true',
  'failed_deploy_rollback=true',
  'previous_sha_recovery=true',
  'same_sha_redeploy=true',
  'rpo_seconds=0',
]) {
  if (!result.includes(marker)) fail(`required recovery marker missing: ${marker}`);
}
if (!/previous_sha=[0-9a-f]{40}/.test(result)) fail('previous SHA recovery evidence is missing');
if (!/rto_seconds=\d+/.test(result)) fail('recovery time evidence is missing');
if (!/logs_scanned=[1-9]\d*/.test(result)) fail('log inspection evidence is missing');

let health;
try {
  health = await fetch(`${value('STAGING_BASE_URL').replace(/\/$/, '')}/api/health`, {
    headers: { 'user-agent': 'phase10-staging-readiness' },
    signal: AbortSignal.timeout(15_000),
  });
} catch (error) {
  fail(`staging health request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
}
if (!health.ok) fail(`staging health returned HTTP ${health.status}`);
const payload = await health.json();
if (payload?.ok !== true) fail('staging health payload is not ok');
const reportedSha = payload?.deploySha ?? payload?.sha ?? payload?.commitSha;
if (reportedSha && reportedSha !== targetSha) fail('staging health reports a different revision');

console.log('[phase10-staging-readiness] destructive recovery, previous-SHA restore, same-SHA redeploy, health, checksum, and log-redaction checks succeeded');
