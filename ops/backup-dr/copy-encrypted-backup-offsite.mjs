#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

function fail(message, code = 1) {
  process.stderr.write(`[backup-dr-offsite] ${message}\n`);
  process.exit(code);
}

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) fail(`${name} is required`, 2);
  return value;
}

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
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

const approval = requiredEnv('OFFSITE_EXECUTION_APPROVED');
if (approval !== 'COPY_ENCRYPTED_BACKUP') {
  fail('explicit OFFSITE_EXECUTION_APPROVED=COPY_ENCRYPTED_BACKUP is required', 3);
}
if (requiredEnv('OFFSITE_DELETE_AUTHORITY') !== 'false') {
  fail('backup writer must not have delete authority', 4);
}
if (requiredEnv('OFFSITE_IMMUTABILITY_ATTESTED') !== 'true') {
  fail('provider Object Lock / immutability must be attested before copy', 5);
}

const remoteBase = requiredEnv('OFFSITE_REMOTE_BASE').replace(/\/+$/, '');
if (!/^[A-Za-z0-9._-]+:[^\r\n]+$/.test(remoteBase)) {
  fail('OFFSITE_REMOTE_BASE must be a bounded rclone remote path', 6);
}

const encryptedPath = path.resolve(String(process.argv[2] ?? ''));
if (!encryptedPath.endsWith('.dump.age')) {
  fail('argument must be an encrypted .dump.age backup', 7);
}
const checksumPath = `${encryptedPath}.sha256`;
const manifestPath = `${encryptedPath}.json`;
for (const file of [encryptedPath, checksumPath, manifestPath]) {
  const fileStat = await stat(file).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size <= 0) fail(`required backup bundle file missing: ${path.basename(file)}`, 8);
}

const checksumText = await readFile(checksumPath, 'utf8');
const expectedChecksum = checksumText.trim().split(/\s+/)[0] ?? '';
if (!/^[0-9a-f]{64}$/.test(expectedChecksum)) fail('checksum file is invalid', 9);
const actualChecksum = await sha256File(encryptedPath);
if (actualChecksum !== expectedChecksum) fail('local encrypted backup checksum mismatch', 10);

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest?.encrypted !== true || manifest?.plaintextAtRest !== false || manifest?.sha256 !== actualChecksum) {
  fail('backup manifest encryption/integrity contract mismatch', 11);
}

const localDir = path.dirname(encryptedPath);
const files = [encryptedPath, checksumPath, manifestPath];
for (const file of files) {
  const name = path.basename(file);
  await run('rclone', [
    'copyto',
    file,
    `${remoteBase}/${name}`,
    '--immutable',
    '--checksum',
    '--no-traverse',
  ], `off-site copy ${name}`);

  await run('rclone', [
    'check',
    localDir,
    remoteBase,
    '--include',
    name,
    '--one-way',
    '--download',
  ], `off-site checksum verification ${name}`);
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  backupId: String(manifest.backupId ?? path.basename(encryptedPath)),
  offsiteCopyComplete: true,
  encryptedPayloadOnly: true,
  localChecksumVerified: true,
  remoteChecksumVerified: true,
  immutableCopyMode: true,
  providerObjectLockAttested: true,
  deleteAuthority: false,
  syncAuthority: false,
  purgeAuthority: false,
}, null, 2)}\n`);
