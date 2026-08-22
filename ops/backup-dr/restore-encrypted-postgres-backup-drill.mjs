#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

process.umask(0o077);

function fail(message, code = 1) {
  process.stderr.write(`[backup-dr-restore] ${message}\n`);
  process.exit(code);
}

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) fail(`${name} is required`, 2);
  return value;
}

function childResult(child, label) {
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error(`${label} could not start`)));
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal || code || 'unknown'})`));
    });
  });
}

async function sha256File(file) {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

const approval = requiredEnv('RESTORE_DRILL_EXECUTION_APPROVED');
if (approval !== 'RESTORE_TO_LOCAL_EPHEMERAL') {
  fail('explicit RESTORE_DRILL_EXECUTION_APPROVED=RESTORE_TO_LOCAL_EPHEMERAL is required', 3);
}
const targetUrlText = requiredEnv('RESTORE_DRILL_DATABASE_URL');
const ageIdentity = requiredEnv('RESTORE_DRILL_AGE_IDENTITY');
const encryptedPath = path.resolve(String(process.argv[2] ?? ''));
if (!encryptedPath.endsWith('.dump.age')) fail('argument must be an encrypted .dump.age backup', 4);

let target;
try {
  target = new URL(targetUrlText);
} catch {
  fail('RESTORE_DRILL_DATABASE_URL is invalid', 5);
}
if (!['postgres:', 'postgresql:'].includes(target.protocol)) fail('restore target must be PostgreSQL', 6);
if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(target.hostname)) {
  fail('restore drill target must be localhost only', 7);
}
const database = decodeURIComponent(target.pathname.replace(/^\/+/, ''));
if (!/^backup_restore_drill_[a-z0-9_]{1,48}$/.test(database)) {
  fail('restore drill database name must use backup_restore_drill_ prefix', 8);
}
const user = decodeURIComponent(target.username || '');
const password = decodeURIComponent(target.password || '');
if (!user || !password) fail('restore drill connection must include an isolated credential', 9);

const checksumPath = `${encryptedPath}.sha256`;
const manifestPath = `${encryptedPath}.json`;
for (const file of [encryptedPath, checksumPath, manifestPath]) {
  const fileStat = await stat(file).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size <= 0) fail(`required backup bundle file missing: ${path.basename(file)}`, 10);
}
const expectedChecksum = (await readFile(checksumPath, 'utf8')).trim().split(/\s+/)[0] ?? '';
if (!/^[0-9a-f]{64}$/.test(expectedChecksum)) fail('checksum file is invalid', 11);
const actualChecksum = await sha256File(encryptedPath);
if (actualChecksum !== expectedChecksum) fail('encrypted backup checksum mismatch', 12);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest?.encrypted !== true || manifest?.plaintextAtRest !== false || manifest?.sha256 !== actualChecksum) {
  fail('backup manifest encryption/integrity contract mismatch', 13);
}

const baseEnv = { ...process.env };
for (const key of Object.keys(baseEnv)) {
  if (key.startsWith('RESTORE_') || key.startsWith('BACKUP_') || key.startsWith('PG')) delete baseEnv[key];
}
const pgEnv = {
  ...baseEnv,
  PGHOST: target.hostname === '[::1]' ? '::1' : target.hostname,
  PGPORT: target.port || '5432',
  PGUSER: user,
  PGPASSWORD: password,
  PGDATABASE: database,
  PGCONNECT_TIMEOUT: '5',
  PGAPPNAME: 'investment-platform-backup-restore-drill',
};
const sslmode = target.searchParams.get('sslmode');
if (sslmode) pgEnv.PGSSLMODE = sslmode;

function scalarQuery(sql) {
  const result = spawnSync('psql', [
    '-X', '--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1',
  ], {
    env: pgEnv,
    input: sql,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) fail('localhost restore-drill PostgreSQL preflight failed', 14);
  return String(result.stdout ?? '').trim();
}

const beforeCount = Number(scalarQuery(`
SELECT count(*)
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema');
`));
if (!Number.isInteger(beforeCount) || beforeCount !== 0) {
  fail('restore drill database must be empty before restore', 15);
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'backup-restore-identity-'));
const identityPath = path.join(tempDir, 'age-identity.txt');
try {
  await writeFile(identityPath, `${ageIdentity}\n`, { mode: 0o600, flag: 'wx' });

  const age = spawn('age', ['--decrypt', '--identity', identityPath, encryptedPath], {
    env: baseEnv,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const pgRestore = spawn('pg_restore', [
    '--exit-on-error',
    '--single-transaction',
    '--no-owner',
    '--no-privileges',
    `--dbname=${database}`,
  ], {
    env: pgEnv,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  age.stdout.pipe(pgRestore.stdin);
  await Promise.all([
    childResult(age, 'age decryption'),
    childResult(pgRestore, 'pg_restore'),
  ]);

  const afterCount = Number(scalarQuery(`
SELECT count(*)
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema');
`));
  if (!Number.isInteger(afterCount) || afterCount <= 0) {
    fail('restore completed without observable restored tables', 16);
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    backupId: String(manifest.backupId ?? path.basename(encryptedPath)),
    checksumVerified: true,
    targetScope: 'LOCALHOST_EPHEMERAL_ONLY',
    targetDatabasePrefixVerified: true,
    destructiveCleanUsed: false,
    productionCredentialUsed: false,
    logicalRestoreVerified: true,
    restoredTableCount: afterCount,
    providerPitrRestoreVerified: false,
    storageObjectRestoreVerified: false,
  }, null, 2)}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : 'restore drill failed', 20);
} finally {
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
}
