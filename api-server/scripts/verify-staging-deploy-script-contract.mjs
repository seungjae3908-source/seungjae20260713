import { readFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const root = path.basename(cwd) === 'api-server' ? path.resolve(cwd, '..') : path.resolve(cwd);
const deployScript = await readFile(path.join(root, 'ops/deploy-staging.sh'), 'utf8');
const stagingWorkflow = await readFile(path.join(root, '.github/workflows/staging-readiness.yml'), 'utf8');

const assert = (condition, message) => {
  if (!condition) throw new Error(`[staging-deploy-contract] ${message}`);
};

assert(
  deployScript.includes('PM2_CONFIG="$STAGING_DIR/api-server/ecosystem.staging.json"'),
  'PM2 must use the server-compatible JSON ecosystem file',
);
assert(
  deployScript.includes('PM2_LAUNCHER="$STAGING_DIR/api-server/run-staging.sh"'),
  'PM2 must use a dedicated runtime launcher',
);
assert(!deployScript.includes('ecosystem.staging.cjs'), 'legacy CJS PM2 config must not return');
assert(
  deployScript.includes("exec node --enable-source-maps '--env-file=.env.staging' ./dist/index.mjs"),
  'runtime launcher must load the protected staging env file directly with Node',
);
assert(
  deployScript.includes("script: './run-staging.sh'"),
  'PM2 config must execute the dedicated runtime launcher',
);
assert(
  deployScript.includes("interpreter: '/bin/bash'"),
  'PM2 config must execute the launcher with Bash',
);
assert(
  !deployScript.includes("node_args: ['--enable-source-maps', '--env-file=.env.staging']"),
  'PM2 must not receive the env-file flags through the incompatible node_args array',
);
assert(
  deployScript.includes("JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))"),
  'generated PM2 JSON must be parsed before it is handed to PM2',
);
assert(
  deployScript.includes('pm2 startOrReload "$PM2_CONFIG" --only "$STAGING_PM2_NAME" --update-env'),
  'isolated staging PM2 process must start or reload from the verified JSON config',
);
assert(
  deployScript.includes('pm2 logs "$STAGING_PM2_NAME" --lines 120 --nostream'),
  'failed live verification must expose bounded PM2 diagnostics without printing environment values',
);

assert(
  deployScript.includes('STAGING_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256="${STAGING_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256:-}"'),
  'snapshot-v2 publisher binding must enter through one explicit staging-only digest input',
);
assert(
  deployScript.includes("[[ \"$STAGING_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256\" =~ ^[0-9a-f]{64}$ ]]"),
  'snapshot-v2 publisher binding must fail closed unless it is a lowercase SHA-256 digest',
);
assert(
  deployScript.includes('PAPER_STATE_DIR="$STATE_DIR/paper-forward"'),
  'snapshot-v2 state directory must remain below the protected staging deploy state',
);
assert(
  deployScript.includes('PAPER_STATE_SNAPSHOT_PATH="$PAPER_STATE_DIR/paper-state-v2.json"'),
  'snapshot-v2 must use one canonical JSON shared path',
);
assert(
  deployScript.includes('install -d -m 700 "$PAPER_STATE_DIR"'),
  'snapshot-v2 shared directory must be created with owner-only permissions',
);
for (const marker of [
  "printf 'PAPER_FORWARD_PAPER_STATE_SNAPSHOT_PATH=%s\\n' \"$PAPER_STATE_SNAPSHOT_PATH\"",
  "printf 'PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256=%s\\n' \"$STAGING_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256\"",
  "printf 'PAPER_FORWARD_PAPER_STATE_MAXIMUM_AGE_MS=%s\\n' \"$PAPER_STATE_MAXIMUM_AGE_MS\"",
  'PAPER_FORWARD_PAPER_STATE_SNAPSHOT_PATH="$PAPER_STATE_SNAPSHOT_PATH"',
  'PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256="$STAGING_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256"',
]) {
  assert(deployScript.includes(marker), `snapshot-v2 runtime binding is missing marker: ${marker}`);
}
assert(
  !deployScript.includes('STAGING_ADMIN_EMAIL') && !deployScript.includes('STAGING_ADMIN_PASSWORD'),
  'the remote deploy script must never receive staging account credentials',
);
assert(
  !deployScript.includes('PAPER_FORWARD_SCHEDULE_ACTIVE=true'),
  'snapshot-v2 staging config must not activate the Paper schedule',
);

for (const marker of [
  'Resolve snapshot-v2 publisher binding without disclosing identity',
  "createHash('sha256').update(userId, 'utf8').digest('hex')",
  '::add-mask::${userId}',
  '::add-mask::${accessToken}',
  '::add-mask::${digest}',
  'publisher_sha256=${digest}',
  'STAGING_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256: ${{ steps.paper_publisher.outputs.publisher_sha256 }}',
  'snapshot-v2 shared path configured',
  'snapshot-v2 exact publisher binding configured',
  'Paper schedule remains inactive',
]) {
  assert(stagingWorkflow.includes(marker), `staging workflow snapshot-v2 contract is missing marker: ${marker}`);
}
assert(
  stagingWorkflow.includes('Staging admin authentication failed with HTTP ${response.status}; snapshot binding not configured'),
  'publisher identity resolution must fail closed without returning an authentication payload',
);
for (const forbidden of [
  'console.log(userId)',
  'console.log(accessToken)',
  'JSON.stringify(body, null, 2)',
  'PAPER_FORWARD_SCHEDULE_ACTIVE=true',
]) {
  assert(!stagingWorkflow.includes(forbidden), `staging workflow must not contain unsafe snapshot-v2 marker: ${forbidden}`);
}

const liveProbe = deployScript.indexOf(
  'if ! probe_health_url "http://127.0.0.1:$STAGING_PORT/api/health"',
);
const liveDiagnostics = deployScript.indexOf('print_live_diagnostics', liveProbe);
const liveFailure = deployScript.indexOf("fail 'live staging health check failed' 20", liveProbe);
assert(liveProbe >= 0, 'live staging health probe is missing');
assert(liveDiagnostics > liveProbe, 'live failure must print diagnostics');
assert(liveFailure > liveDiagnostics, 'diagnostics must be printed before live health failure exits');

const restoreStart = deployScript.indexOf('restore_backup() {');
const removeRuntimeEnv = deployScript.indexOf(
  'rm -f "$STAGING_DIR/api-server/.env.staging"',
  restoreStart,
);
const restoreSnapshot = deployScript.indexOf(
  'sync_snapshot_tree "$BACKUP_DIR/source" "$STAGING_DIR"',
  restoreStart,
);
assert(restoreStart >= 0, 'restore_backup function is missing');
assert(removeRuntimeEnv > restoreStart, 'rollback must remove the protected runtime env file');
assert(restoreSnapshot > removeRuntimeEnv, 'runtime env removal must happen before snapshot restoration');
assert(
  deployScript.includes("--exclude='.deploy/'"),
  'deploy synchronization must preserve the snapshot-v2 shared path under .deploy',
);

console.log(
  '[staging-deploy-contract] PM2 compatibility, snapshot-v2 exact-account binding, protected shared path, redaction, schedule-off, diagnostics, and rollback ordering verified',
);
