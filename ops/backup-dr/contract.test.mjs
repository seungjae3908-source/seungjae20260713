import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const policy = JSON.parse(await readFile(new URL('./policy.json', import.meta.url), 'utf8'));
const createBackup = await readFile(new URL('./create-encrypted-postgres-backup.mjs', import.meta.url), 'utf8');
const offsite = await readFile(new URL('./copy-encrypted-backup-offsite.mjs', import.meta.url), 'utf8');
const restore = await readFile(new URL('./restore-encrypted-postgres-backup-drill.mjs', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../../.github/workflows/backup-dr-contract.yml', import.meta.url), 'utf8');

assert.equal(policy.schemaVersion, 1);
assert.equal(policy.state, 'PREPARED_NOT_ACTIVE');
assert.equal(policy.publicRepositorySafety.backupPayloadMayBeCommittedToGit, false);
assert.equal(policy.publicRepositorySafety.backupPayloadMayBeUploadedAsPullRequestArtifact, false);
assert.equal(policy.publicRepositorySafety.plaintextBackupAtRestAllowed, false);
assert.equal(policy.databaseLogicalBackup.encryptionRequired, true);
assert.equal(policy.databaseLogicalBackup.encryptionScheme, 'age-x25519');
assert.equal(policy.databaseLogicalBackup.backupWriterHasDecryptionPrivateKey, false);
assert.deepEqual(policy.databaseLogicalBackup.retention, { daily: 7, weekly: 4, monthly: 3 });
assert.equal(policy.pointInTimeRecovery.repositoryDefaultState, 'UNVERIFIED');
assert.equal(policy.pointInTimeRecovery.providerEvidenceRequired, true);
assert.equal(policy.offsite.copyOnly, true);
assert.equal(policy.offsite.deleteAuthorityAllowedForBackupWriter, false);
assert.equal(policy.offsite.providerObjectLockOrEquivalentRequiredForVerified, true);
assert.equal(policy.restoreDrill.localhostEphemeralTargetOnly, true);
assert.equal(policy.restoreDrill.remoteDatabaseTargetsAllowed, false);
assert.equal(policy.uploadsAndStorageObjects.independentOfDatabaseBackup, true);
assert.equal(policy.evidenceVault.appendOnlyRequired, true);
assert.equal(policy.evidenceVault.immutableCopyRequired, true);
assert.equal(policy.evidenceVault.automatedDeletionAllowed, false);
assert.ok(policy.evidenceVault.minimumRetentionDays >= 365);
for (const requiredClass of ['PAPER', 'SHADOW', 'SETTLEMENT', 'PROFITABILITY_EVIDENCE', 'STRATEGY_HEALTH', 'PROMOTION', 'CHAMPION']) {
  assert.ok(policy.evidenceVault.classes.includes(requiredClass), `missing Evidence Vault class: ${requiredClass}`);
}
assert.equal(policy.integrity.algorithm, 'sha256');
assert.equal(policy.integrity.unknownMayBeTreatedAsPass, false);
assert.equal(policy.activation.automaticScheduleActive, false);
assert.equal(policy.activation.actualBackupExecutionAuthorized, false);
assert.equal(policy.activation.actualOffsiteUploadAuthorized, false);
assert.equal(policy.activation.actualRestoreAuthorized, false);

for (const token of [
  'BACKUP_EXECUTION_APPROVED',
  'CREATE_ENCRYPTED_BACKUP',
  'BACKUP_DATABASE_URL',
  'BACKUP_AGE_RECIPIENT',
  'BACKUP_EXPECTED_PROJECT_REF',
  'pg_dump',
  'age',
  '.dump.age',
  'plaintextAtRest: false',
]) {
  assert.ok(createBackup.includes(token), `backup creator missing contract token: ${token}`);
}
assert.ok(!createBackup.includes('writeFile(databaseUrlText'));
assert.ok(!createBackup.includes('console.log(databaseUrlText'));
assert.ok(!createBackup.includes('process.stdout.write(databaseUrlText'));

for (const token of [
  'OFFSITE_EXECUTION_APPROVED',
  'COPY_ENCRYPTED_BACKUP',
  'OFFSITE_DELETE_AUTHORITY',
  'OFFSITE_IMMUTABILITY_ATTESTED',
  "'copyto'",
  "'--immutable'",
  "'check'",
  'remoteChecksumVerified: true',
]) {
  assert.ok(offsite.includes(token), `off-site adapter missing contract token: ${token}`);
}
for (const prohibited of [
  /rclone\s+sync/i,
  /rclone\s+delete/i,
  /rclone\s+purge/i,
  /rclone\s+move/i,
  /aws\s+s3\s+sync[^\n]*--delete/i,
  /git\s+(add|commit|push)\b/i,
]) {
  assert.ok(!prohibited.test(offsite), `off-site adapter contains prohibited mutation: ${prohibited}`);
}

for (const token of [
  'RESTORE_DRILL_EXECUTION_APPROVED',
  'RESTORE_TO_LOCAL_EPHEMERAL',
  "['localhost', '127.0.0.1', '[::1]', '::1']",
  'backup_restore_drill_',
  "'--single-transaction'",
  "'--no-owner'",
  "'--no-privileges'",
  'logicalRestoreVerified: true',
  'providerPitrRestoreVerified: false',
  'storageObjectRestoreVerified: false',
]) {
  assert.ok(restore.includes(token), `restore drill missing contract token: ${token}`);
}
for (const prohibited of ['--clean', 'dropdb', 'DROP DATABASE', 'rm -rf /opt', 'rm -rf /srv']) {
  assert.ok(!restore.includes(prohibited), `restore drill contains prohibited target mutation: ${prohibited}`);
}

assert.ok(workflow.includes('permissions:\n  contents: read'));
assert.ok(workflow.includes('node --check ops/backup-dr/create-encrypted-postgres-backup.mjs'));
assert.ok(workflow.includes('node ops/backup-dr/contract.test.mjs'));
assert.ok(!/\bschedule\s*:/m.test(workflow));
assert.ok(!workflow.includes('actions/upload-artifact'));
assert.ok(!workflow.includes('secrets.'));
assert.ok(!workflow.includes('ssh '));
assert.ok(!workflow.includes('git push'));
assert.ok(!workflow.includes('contents: write'));

process.stdout.write('BACKUP_DR_CONTRACT_TESTS_PASS\n');
