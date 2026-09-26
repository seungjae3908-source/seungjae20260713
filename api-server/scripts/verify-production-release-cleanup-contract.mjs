import { readFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const root = path.basename(cwd) === 'api-server' ? path.resolve(cwd, '..') : path.resolve(cwd);
const deploy = await readFile(path.join(root, 'ops/deploy-production.sh'), 'utf8');

const assert = (condition, message) => {
  if (!condition) throw new Error(`[production-release-cleanup] ${message}`);
};

assert(
  deploy.includes("RELEASE_ROOT=\"${RELEASE_ROOT:-/opt/stock-app-releases}\""),
  'release workspace must remain outside LIVE_DIR',
);
assert(
  deploy.includes("BACKUP_ROOT=\"${BACKUP_ROOT:-/opt/stock-app-backups}\""),
  'rollback backups must remain outside LIVE_DIR',
);
assert(
  deploy.includes("--exclude='/releases/'"),
  'source synchronization must preserve the top-level LIVE_DIR/releases runtime-retention directory',
);
assert(
  !deploy.includes('rm -rf -- \"$LIVE_DIR/releases\"'),
  'source synchronization must not directly delete LIVE_DIR/releases',
);
assert(
  !deploy.includes('find \"$LIVE_DIR/releases\"'),
  'deploy must not silently take ownership of legacy runtime release retention',
);
assert(
  deploy.includes('sync_source_tree \"$LIVE_DIR\" \"$BACKUP_DIR/source\"'),
  'rollback snapshot must continue to use the canonical source-sync helper',
);
assert(
  deploy.includes('sync_source_tree \"$RELEASE_DIR\" \"$LIVE_DIR\"'),
  'promotion must continue to use the canonical source-sync helper',
);
assert(
  deploy.includes("mapfile -t OLD_BACKUPS < <(find \"$BACKUP_ROOT\" -mindepth 1 -maxdepth 1 -type d"),
  'backup retention must remain explicit and scoped to BACKUP_ROOT',
);
assert(
  deploy.includes("awk 'NR>3 {print $2}'"),
  'backup retention must continue to keep the newest three snapshots',
);
assert(deploy.includes('restore_backup'), 'automatic rollback must remain intact');

console.log('Production release cleanup contract verified.');
console.log('- LIVE_DIR/releases is protected from rsync --delete source synchronization');
console.log('- release workspace and rollback backups remain outside LIVE_DIR');
console.log('- backup retention remains scoped to BACKUP_ROOT and keeps the newest three snapshots');
console.log('- canary promotion and rollback continue to share the canonical sync helper');
