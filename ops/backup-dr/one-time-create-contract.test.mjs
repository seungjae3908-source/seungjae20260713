import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../../.github/workflows/backup-dr-one-time-create.yml', import.meta.url), 'utf8');

for (const token of [
  'name: Backup DR One-Time Encrypted Create',
  "startsWith(github.event.comment.body, '/run-encrypted-db-backup ')",
  'environment: production',
  'application-ci/verified',
  'browser-ui/verified',
  'database-rls/verified',
  'security-integration/verified',
  'ai-privacy/verified',
  'futures-public-network-smoke/verified',
  "workflow_id: 'production-deploy.yml'",
  'ops/backup-dr/create-encrypted-postgres-backup.mjs',
  'BACKUP_EXECUTION_APPROVED: CREATE_ENCRYPTED_BACKUP',
  'BACKUP_AGE_RECIPIENT',
  'BACKUP_EXPECTED_PROJECT_REF',
  '.local/share/investment-platform/backups/postgres/',
  'github_backup_artifact_uploaded: false',
  'offsite_copy_executed: false',
  'restore_drill_executed: false',
  'schedule_activated: false',
  'production_deploy_executed: false',
  'database_mutation: false',
  'real_order_count: 0',
]) {
  assert.ok(workflow.includes(token), `one-time backup workflow missing safety token: ${token}`);
}

for (const prohibited of [
  'actions/upload-artifact',
  'copy-encrypted-backup-offsite.mjs',
  'restore-encrypted-postgres-backup-drill.mjs',
  'rclone ',
  'pg_restore',
  'dropdb',
  'DROP DATABASE',
  'git push',
  'contents: write',
  'createWorkflowDispatch',
  '/opt/stock-app/backups',
  '/srv/seungjae-staging/backups',
]) {
  assert.ok(!workflow.includes(prohibited), `one-time backup workflow contains prohibited authority: ${prohibited}`);
}

assert.ok(!/^\s*schedule\s*:/m.test(workflow), 'one-time backup workflow must not have a schedule trigger');
assert.ok(!/^\s*workflow_dispatch\s*:/m.test(workflow), 'one-time backup workflow must not expose workflow_dispatch');
assert.ok(workflow.includes("case \"$PARTIAL\" in .local/share/investment-platform/backups/postgres/.partial-*)"));
assert.ok(workflow.includes('rm -rf -- "$PARTIAL"'), 'failure cleanup must be bounded to the known partial directory');
assert.ok(!/rm\s+-rf\s+--?\s+\/(?:opt|srv|var)\b/.test(workflow), 'must not recursively delete application/system paths');
assert.ok(workflow.includes('rm -rf -- "$LOCAL_BACKUP_DIR"'), 'ephemeral runner backup must be removed');
assert.ok(!workflow.includes('BACKUP_DR_ONE_TIME_RESULT]\nsource_sha: ${process.env.BACKUP_DATABASE_URL}'));

process.stdout.write('BACKUP_DR_ONE_TIME_CREATE_CONTRACT_PASS\n');
