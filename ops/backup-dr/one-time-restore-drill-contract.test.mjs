import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(
  new URL('../../.github/workflows/backup-dr-one-time-restore-drill.yml', import.meta.url),
  'utf8',
);
const policy = JSON.parse(await readFile(new URL('./policy.json', import.meta.url), 'utf8'));
const restore = await readFile(new URL('./restore-encrypted-postgres-backup-drill.mjs', import.meta.url), 'utf8');

for (const token of [
  'name: Backup DR One-Time Local Restore Drill',
  "startsWith(github.event.comment.body, '/run-encrypted-db-restore-drill ')",
  "github.event.issue.number == 23",
  "github.event.comment.user.login == github.repository_owner",
  "github.event.comment.author_association == 'OWNER'",
  'environment: production',
  'application-ci/verified',
  'browser-ui/verified',
  'database-rls/verified',
  'security-integration/verified',
  'ai-privacy/verified',
  'futures-public-network-smoke/verified',
  "workflow_id: 'production-deploy.yml'",
  '[BACKUP_DR_ONE_TIME_RESULT]',
  "run.data.name !== 'Backup DR One-Time Encrypted Create'",
  '.local/share/investment-platform/backups/postgres/$BACKUP_ID',
  'image: postgres:16',
  'backup_restore_drill_${GITHUB_RUN_ID}_${GITHUB_RUN_ATTEMPT}',
  'RESTORE_DRILL_EXECUTION_APPROVED: RESTORE_TO_LOCAL_EPHEMERAL',
  'RESTORE_DRILL_AGE_IDENTITY: ${{ secrets.BACKUP_AGE_IDENTITY }}',
  'ops/backup-dr/restore-encrypted-postgres-backup-drill.mjs',
  '[BACKUP_DR_LOGICAL_RESTORE_RESULT]',
  'restore_drill_executed: true',
  'restore_scope: LOCALHOST_EPHEMERAL_LOGICAL_ONLY',
  'checksum_verified: true',
  'logical_restore_verified: true',
  'ephemeral_local_database_mutation: true',
  'production_database_mutation: false',
  'production_credential_used: false',
  'provider_pitr_restore_verified: false',
  'storage_object_restore_verified: false',
  'offsite_restore_verified: false',
  'backup_material_uploaded_to_github: false',
  'schedule_activated: false',
  'production_deploy_executed: false',
  'private_trading_api: false',
  'live_trading: false',
  'real_order_count: 0',
  'dr_claim_scope: LOGICAL_DATABASE_RESTORE_EVIDENCED_ONLY',
  'for (const issue_number of [23, 838])',
]) {
  assert.ok(workflow.includes(token), `restore workflow missing safety/evidence token: ${token}`);
}

for (const prohibited of [
  'actions/upload-artifact',
  'secrets.PROD_DATABASE_URL',
  'secrets.PRODUCTION_DATABASE_URL',
  'secrets.POSTGRES_URL_NON_POOLING',
  'secrets.PROD_SUPABASE_DB_URL',
  'secrets.SUPABASE_DB_URL',
  'secrets.POSTGRES_URL',
  'secrets.DATABASE_URL',
  'BACKUP_DATABASE_URL',
  'pg_dump ',
  'copy-encrypted-backup-offsite.mjs',
  'rclone ',
  'git push',
  'contents: write',
  'createWorkflowDispatch',
  'REAL_ORDER',
  'AUTO_TRADING=true',
  'LIVE_TRADING=true',
]) {
  assert.ok(!workflow.includes(prohibited), `restore workflow contains prohibited authority: ${prohibited}`);
}

assert.ok(!/^\s*schedule\s*:/m.test(workflow), 'restore drill must never be scheduled');
assert.ok(!/^\s*workflow_dispatch\s*:/m.test(workflow), 'restore drill must not expose workflow_dispatch');
assert.ok(
  workflow.includes("/^\\/run-encrypted-db-restore-drill ([0-9a-fA-F]{40}) ([0-9a-fA-F]{40}) (postgres-production-[A-Za-z0-9_-]{8,100})$/"),
  'owner command must bind active Production SHA, exact current-main SHA, and exact backup id',
);
assert.ok(
  workflow.includes("test \"$(git rev-parse origin/main^{commit})\" = \"$SOURCE_SHA\""),
  'runtime must re-check exact current main before restore',
);
assert.ok(
  workflow.includes("[[ \"$EXPECTED_SHA256\" =~ ^[0-9a-f]{64}$ ]]"),
  'runtime must require an exact backup checksum from the creation receipt',
);
assert.ok(
  workflow.includes("test ! -L \"$REMOTE_DIR/$file\""),
  'remote backup bundle must reject symlink material',
);
assert.ok(
  workflow.includes("rm -rf -- \"$LOCAL_RESTORE_DIR\""),
  'runner backup material must be removed',
);
assert.ok(
  workflow.includes("rm -f -- ~/.ssh/id_ed25519"),
  'ephemeral SSH key material must be removed',
);
assert.ok(!/rm\s+-rf\s+--?\s+\/(?:opt|srv|var)\b/.test(workflow), 'workflow must not recursively delete Production/system paths');

assert.equal(policy?.restoreDrill?.required, true, 'policy must continue to require restore drills');
assert.equal(policy?.restoreDrill?.repositoryDefaultState, 'MISSING', 'default truth must stay MISSING until a real receipt exists');
assert.equal(policy?.executionControls?.actualRestoreAuthorized, false, 'repository default must not grant standing restore authority');
assert.equal(policy?.executionControls?.remoteDatabaseTargetsForbidden, true, 'remote DB restore targets must remain forbidden');
assert.equal(policy?.executionControls?.productionCredentialUseForbidden, true, 'Production DB credentials must remain forbidden during restore drill');

for (const token of [
  "approval !== 'RESTORE_TO_LOCAL_EPHEMERAL'",
  "['localhost', '127.0.0.1', '[::1]', '::1']",
  "/^backup_restore_drill_[a-z0-9_]{1,48}$/",
  'restore drill database must be empty before restore',
  "'--single-transaction'",
  "'--no-owner'",
  "'--no-privileges'",
  "targetScope: 'LOCALHOST_EPHEMERAL_ONLY'",
  'productionCredentialUsed: false',
  'logicalRestoreVerified: true',
  'providerPitrRestoreVerified: false',
  'storageObjectRestoreVerified: false',
]) {
  assert.ok(restore.includes(token), `restore implementation lost fail-closed token: ${token}`);
}

process.stdout.write('BACKUP_DR_ONE_TIME_RESTORE_CONTRACT_PASS\n');
