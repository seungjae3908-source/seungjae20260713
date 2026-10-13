/**
 * Offline, create-only, DORMANT Telegram standalone release preparation.
 * This builds a sealable candidate directory from a verified exact checkout.
 * It NEVER uses the Production app root, runs the worker, performs network
 * requests, edits a service/PM2/environment/ledger, or sends Bot messages.
 * A separately approved production operation must verify and install it.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/u;
const FIXED_FILES = Object.freeze([
  'api-server/dist/telegram-isolated-worker.mjs',
  'ops/telegram-legacy-owner-runtime-proof.mjs',
  'ops/run-telegram-isolated-worker.sh',
]);
const MAX_BYTES = Object.freeze([64 * 1024 * 1024, 128 * 1024, 128 * 1024]);

function refuse(code) { throw new Error(code); }
function ensureSafeRegularFile(filename, maxBytes) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      info.size === 0 || info.size > maxBytes) refuse('TELEGRAM_PREPARE_SOURCE_UNSAFE');
  return info;
}
function sha256(filename) {
  const h = createHash('sha256');
  h.update(fs.readFileSync(filename));
  return h.digest('hex');
}
function writeSynced(filename, bytes, mode = 0o600) {
  const fd = fs.openSync(filename, 'wx', mode);
  try {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
    let written = 0;
    while (written < buf.length) written += fs.writeSync(fd, buf, written, buf.length - written);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function syncDir(folder) {
  const fd = fs.openSync(folder, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function inside(parent, target) {
  const rel = path.relative(parent, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** Produces a fail-closed, non-running release; returns sanitized metadata. */
export function prepareTelegramIsolatedRelease({ checkedOutSha, checkoutRoot, destination }) {
  if (typeof checkedOutSha !== 'string' || !SHA.test(checkedOutSha) ||
      typeof checkoutRoot !== 'string' || typeof destination !== 'string' ||
      !path.isAbsolute(checkoutRoot) || !path.isAbsolute(destination)) {
    refuse('TELEGRAM_PREPARE_INVALID_ARGUMENTS');
  }
  const checkout = fs.realpathSync(checkoutRoot);
  const dir = path.resolve(destination);
  const parent = path.dirname(dir);
  if (dir === '/' || dir === '/opt/stock-app' || dir.startsWith('/opt/stock-app/') ||
      inside(checkout, dir) || inside(dir, checkout) ||
      !fs.existsSync(parent) || fs.lstatSync(parent).isSymbolicLink() ||
      fs.realpathSync(parent) !== parent) {
    refuse('TELEGRAM_PREPARE_UNSAFE_DESTINATION');
  }
  if (fs.existsSync(dir)) refuse('TELEGRAM_PREPARE_DESTINATION_EXISTS');
  const actual = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (actual !== checkedOutSha) refuse('TELEGRAM_PREPARE_SOURCE_SHA_MISMATCH');
  const fingerprints = FIXED_FILES.map((rel, i) => {
    const source = path.join(checkout, rel);
    if (!inside(checkout, fs.realpathSync(source))) refuse('TELEGRAM_PREPARE_SOURCE_UNSAFE');
    const info = ensureSafeRegularFile(source, MAX_BYTES[i]);
    return { rel, source, size: info.size, digest: sha256(source) };
  });

  // Atomic publication isn't necessary for an inactive candidate: the exact
  // marker is written LAST, so any crash yields a non-startable directory.
  // mkdir is exclusive; on conflict we never delete another operator's work.
  fs.mkdirSync(dir, { mode: 0o700 });
  let finished = false;
  try {
    for (const folder of ['api-server', 'api-server/dist', 'ops', '.deploy']) {
      fs.mkdirSync(path.join(dir, folder), { mode: 0o700 });
    }
    for (const f of fingerprints) {
      const dest = path.join(dir, f.rel);
      writeSynced(dest, fs.readFileSync(f.source), f.rel.endsWith('.sh') ? 0o700 : 0o600);
      if (sha256(dest) !== f.digest) refuse('TELEGRAM_PREPARE_COPY_DIGEST_MISMATCH');
    }
    const manifest = fingerprints.map(f => f.digest + '  ' + f.rel).join('\n') + '\n';
    writeSynced(path.join(dir, '.deploy/telegram-sha256.manifest'), manifest);
    const receipt = Object.freeze({
      schemaVersion: 'telegram-isolated-dormant-package-v1',
      sha: checkedOutSha,
      mode: 'PREPARE_ONLY',
      workerStarted: false,
      productionAppChanged: false,
      pm2Restarts: 0,
      telegramMessages: 0,
      financialMutations: 0,
      paths: fingerprints.map(f => f.rel),
    });
    writeSynced(path.join(dir, '.deploy/preparation.json'), JSON.stringify(receipt) + '\n');
    for (const name of ['api-server/dist', 'api-server', 'ops', '.deploy']) syncDir(path.join(dir, name));
    // Do not create a SHA marker on any failed or partial packaging path.
    writeSynced(path.join(dir, '.deploy/current-sha'), checkedOutSha + '\n');
    syncDir(path.join(dir, '.deploy'));
    syncDir(dir);
    syncDir(parent);
    finished = true;
    return receipt;
  } finally {
    // Leave an incomplete directory visibly quarantined: no SHA marker means
    // the isolated launcher rejects it. Never remove another party's path.
    if (!finished) {
      try { fs.writeFileSync(path.join(dir, '.deploy/PREPARATION_INCOMPLETE'), 'FAIL_CLOSED\n', { flag: 'wx', mode: 0o600 }); } catch {}
    }
  }
}

const mainPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (mainPath === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) refuse('TELEGRAM_PREPARE_USAGE_SHA_CHECKOUT_DESTINATION');
  const result = prepareTelegramIsolatedRelease({
    checkedOutSha: process.argv[2], checkoutRoot: process.argv[3], destination: process.argv[4],
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}
