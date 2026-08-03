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
assert(!deployScript.includes('ecosystem.staging.cjs'), 'legacy CJS PM2 config must not return');
assert(
  deployScript.includes("JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))"),
  'generated PM2 JSON must be parsed before it is handed to PM2',
);
assert(
  deployScript.includes('pm2 startOrReload "$PM2_CONFIG" --only "$STAGING_PM2_NAME" --update-env'),
  'isolated staging PM2 process must start or reload from the verified JSON config',
);

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
  '[staging-deploy-contract] PM2 JSON compatibility and first-deploy rollback ordering verified',
);
