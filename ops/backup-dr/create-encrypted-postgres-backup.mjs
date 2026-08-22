#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

process.umask(0o077);

function fail(message, code = 1) {
  process.stderr.write(`[backup-dr] ${message}\n`);
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

const approval = requiredEnv('BACKUP_EXECUTION_APPROVED');
if (approval !== 'CREATE_ENCRYPTED_BACKUP') {
  fail('explicit BACKUP_EXECUTION_APPROVED=CREATE_ENCRYPTED_BACKUP is required', 3);
}

const databaseUrlText = requiredEnv('BACKUP_DATABASE_URL');
const recipient = requiredEnv('BACKUP_AGE_RECIPIENT');
const expectedProjectRef = requiredEnv('BACKUP_EXPECTED_PROJECT_REF').toLowerCase();
const outputDir = path.resolve(requiredEnv('BACKUP_OUTPUT_DIR'));
const sourceLabel = String(process.env.BACKUP_SOURCE_LABEL ?? 'production').trim();

if (!/^age1[0-9a-z]{20,}$/i.test(recipient)) {
  fail('BACKUP_AGE_RECIPIENT must be an age X25519 public recipient', 4);
}
if (!/^[a-z0-9-]{6,64}$/.test(expectedProjectRef)) {
  fail('BACKUP_EXPECTED_PROJECT_REF is invalid', 5);
}
if (!/^[a-z0-9_-]{2,32}$/i.test(sourceLabel)) {
  fail('BACKUP_SOURCE_LABEL is invalid', 6);
}

const cwd = path.resolve(process.cwd());
if (outputDir === cwd || outputDir.startsWith(`${cwd}${path.sep}`)) {
  fail('backup output must not be inside the checked-out repository', 7);
}
for (const forbidden of ['/opt/stock-app', '/srv/seungjae-staging']) {
  if (outputDir === forbidden || outputDir.startsWith(`${forbidden}/`)) {
    fail('backup output must not be stored inside an application deployment tree', 8);
  }
}

let parsed;
try {
  parsed = new URL(databaseUrlText);
} catch {
  fail('BACKUP_DATABASE_URL is not a valid URL', 9);
}
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
  fail('BACKUP_DATABASE_URL must use postgres/postgresql', 10);
}

const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
const user = decodeURIComponent(parsed.username || '');
const password = decodeURIComponent(parsed.password || '');
if (!parsed.hostname || !database || !user || !password) {
  fail('BACKUP_DATABASE_URL is incomplete', 11);
}
const identityMatches = parsed.hostname.toLowerCase().includes(expectedProjectRef)
  || user.toLowerCase().includes(`.${expectedProjectRef}`);
if (!identityMatches) {
  fail('database identity does not match BACKUP_EXPECTED_PROJECT_REF', 12);
}

const baseEnv = { ...process.env };
for (const key of Object.keys(baseEnv)) {
  if (key.startsWith('BACKUP_') || key.startsWith('PG')) delete baseEnv[key];
}
const pgEnv = {
  ...baseEnv,
  PGHOST: parsed.hostname,
  PGPORT: parsed.port || '5432',
  PGUSER: user,
  PGPASSWORD: password,
  PGDATABASE: database,
  PGCONNECT_TIMEOUT: '10',
  PGAPPNAME: 'investment-platform-backup-dr',
};
const sslmode = parsed.searchParams.get('sslmode');
if (sslmode) pgEnv.PGSSLMODE = sslmode;

await mkdir(outputDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const nonce = randomUUID().slice(0, 8);
const stem = `postgres-${sourceLabel}-${stamp}-${nonce}`;
const finalPath = path.join(outputDir, `${stem}.dump.age`);
const partialPath = `${finalPath}.partial`;
const checksumPath = `${finalPath}.sha256`;
const manifestPath = `${finalPath}.json`;

let completed = false;
let failure = null;
try {
  const age = spawn('age', ['--encrypt', '--recipient', recipient, '--output', partialPath], {
    env: baseEnv,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const pgDump = spawn('pg_dump', [
    '--format=custom',
    '--compress=6',
    '--no-owner',
    '--no-privileges',
    '--lock-wait-timeout=5s',
    `--dbname=${database}`,
  ], {
    env: pgEnv,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  pgDump.stdout.pipe(age.stdin);
  await Promise.all([
    childResult(pgDump, 'pg_dump'),
    childResult(age, 'age encryption'),
  ]);

  const partialStat = await stat(partialPath);
  if (!partialStat.isFile() || partialStat.size <= 0) {
    throw new Error('encrypted backup is empty');
  }
  await rename(partialPath, finalPath);
  const encryptedStat = await stat(finalPath);
  const checksum = await sha256File(finalPath);
  const projectIdentityFingerprint = createHash('sha256')
    .update(expectedProjectRef)
    .digest('hex')
    .slice(0, 16);

  const manifest = {
    schemaVersion: 1,
    backupId: stem,
    sourceLabel,
    createdAt: new Date().toISOString(),
    bytes: encryptedStat.size,
    sha256: checksum,
    encryption: 'age-x25519',
    encrypted: true,
    plaintextAtRest: false,
    projectIdentityFingerprint,
    ownerPrivilegesStored: false,
    offsiteVerified: false,
    providerObjectLockVerified: false,
    restoreVerified: false,
    pitrVerified: null,
  };

  await writeFile(checksumPath, `${checksum}  ${path.basename(finalPath)}\n`, { mode: 0o600, flag: 'wx' });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  completed = true;

  process.stdout.write(`BACKUP_CREATED=true\n`);
  process.stdout.write(`backup_id=${stem}\n`);
  process.stdout.write(`encrypted=true\nplaintext_at_rest=false\n`);
  process.stdout.write(`sha256=${checksum}\nbytes=${encryptedStat.size}\n`);
  process.stdout.write(`offsite_verified=false\nrestore_verified=false\npitr_verified=UNVERIFIED\n`);
} catch (error) {
  failure = error instanceof Error ? error.message : 'backup creation failed';
} finally {
  if (!completed) {
    await unlink(partialPath).catch(() => {});
  }
}
if (failure) fail(failure, 20);
