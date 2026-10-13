#!/usr/bin/env node
// Read-only local diagnostic. No HTTP, DB, provider keys, scheduled work or orders.
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { summarizeLightweightMarketWatch } from '../src/lightweight-market-watch-readback.mjs';

const MAX_BYTES = 64 * 1024;
async function readLatest(stateRoot) {
  const path = join(stateRoot, 'latest', 'lightweight-market-watch.json');
  let stat;
  try { stat = await lstat(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('WATCH_DIAGNOSTIC_LSTAT_FAILURE');
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES
    || stat.size < 1 || (stat.mode & 0o022) !== 0) {
    throw new Error('WATCH_DIAGNOSTIC_UNSAFE_FILE');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== stat.ino
      || current.dev !== stat.dev || current.size > MAX_BYTES
      || current.nlink !== 1 || (current.mode & 0o022) !== 0)
      throw new Error('WATCH_DIAGNOSTIC_FILE_CHANGED');
    const contents = await handle.readFile({ encoding: 'utf8' });
    try { return JSON.parse(contents); }
    catch { throw new Error('WATCH_DIAGNOSTIC_JSON_INVALID'); }
  } finally {
    await handle.close();
  }
}

async function main() {
  const rawRoot = process.env.RESEARCH_STATE_ROOT ?? '';
  if (!rawRoot || !isAbsolute(rawRoot) || resolve(rawRoot) !== rawRoot)
    throw new Error('WATCH_DIAGNOSTIC_ABSOLUTE_ROOT_REQUIRED');
  const expectedSha = process.env.RESEARCH_CODE_SHA ?? null;
  if (expectedSha !== null && !/^[0-9a-f]{40}$/.test(expectedSha))
    throw new Error('WATCH_DIAGNOSTIC_PINNED_SHA_INVALID');
  const status = summarizeLightweightMarketWatch(
    await readLatest(rawRoot), Date.now(), expectedSha,
  );
  process.stdout.write(JSON.stringify(status) + '\n');
}

main().catch(() => {
  // Never log a provider error, private state filename, API secret, or stack.
  process.stdout.write(JSON.stringify(summarizeLightweightMarketWatch({
    schemaVersion: 'INVALID_LOCAL_FILE',
  })) + '\n');
  process.exitCode = 2;
});
