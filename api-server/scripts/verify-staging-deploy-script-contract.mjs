import { readFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const root = path.basename(cwd) === 'api-server' ? path.resolve(cwd, '..') : path.resolve(cwd);
const deployScript = await readFile(path.join(root, 'ops/deploy-staging.sh'), 'utf8');

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
  deployScript.includes("exec node --enable-source-maps --env-file=.env.staging ./dist/index.mjs"),
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

console.log(
  '[staging-deploy-contract] PM2 launcher compatibility, diagnostics, and first-deploy rollback ordering verified',
);
