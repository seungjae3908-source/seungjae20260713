#!/usr/bin/env node
// Read-only inspection of optional KR/US public stock snapshot files.
// A well-formed source label or completeUniverse=true is NOT proof of
// provenance, data rights, whole-universe coverage, or trading authority.
import { constants, realpathSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStockFeed } from '../src/lightweight-market-watch.mjs';

export const STOCK_PREFLIGHT_CONTRACT = 'public-stock-source-input-preflight-v1';
const MARKETS = Object.freeze(['KR_STOCK', 'US_STOCK']);
const MAX_BYTES = 4_000_000;
const NO_AUTHORITY = Object.freeze({
  independentProviderVerified: false,
  marketDataRightsVerified: false,
  fullUniverseVerified: false,
  continuous24hProven: false,
  profitabilityProven: false,
  paperExecutionProven: false,
  executionAuthority: 'NONE',
});
const empty = (market, status) => ({
  market, status, source: null, listedCount: null, observedCount: null,
});
const safeDirectory = (meta) => meta?.isDirectory() && (meta.mode & 0o022) === 0;
function validSourceRoot(root, nowMs) {
  return typeof root === 'string' && root.length > 1
    && root !== '/' && isAbsolute(root) && resolve(root) === root
    && Number.isFinite(nowMs) && nowMs > 0;
}
async function verifiedStockInputDirectory(root) {
  const stateDir = await lstat(root);
  if (!safeDirectory(stateDir)) throw new Error('UNSAFE_STOCK_ROOT');
  const directory = await lstat(join(root, 'market-watch-input'));
  if (!safeDirectory(directory) || directory.uid !== stateDir.uid)
    throw new Error('UNSAFE_STOCK_DIRECTORY');
  return directory;
}

async function readPrivateStockJson(path, directoryOwner) {
  const meta = await lstat(path);
  if (!meta.isFile() || meta.nlink !== 1 || meta.size < 1
    || meta.size > MAX_BYTES || (meta.mode & 0o022) !== 0
    || meta.uid !== directoryOwner) throw new Error('UNSAFE_STOCK_INPUT');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== meta.ino
      || opened.dev !== meta.dev || opened.size !== meta.size
      || opened.size > MAX_BYTES || (opened.mode & 0o022) !== 0
      || opened.uid !== directoryOwner) throw new Error('STOCK_INPUT_CHANGED');
    const contents = await handle.readFile({ encoding: 'utf8' });
    const after = await handle.stat();
    // An in-place overwrite can preserve the byte count and reset mtime.
    // ctime plus device, owner and mode must also survive the entire read.
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || after.ino !== opened.ino
      || after.dev !== opened.dev || after.nlink !== 1
      || after.uid !== directoryOwner || (after.mode & 0o022) !== 0)
      throw new Error('STOCK_INPUT_CHANGED');
    return JSON.parse(contents);
  } finally {
    await handle.close();
  }
}

// This is also the production watcher's only KR/US source read path.
 // Source format validation alone must never bypass file ownership, directory
 // permissions or in-place mutation checks verified by the preflight.
export async function readVerifiedStockSource(root, market, nowMs = Date.now()) {
  if (!validSourceRoot(root, nowMs) || !MARKETS.includes(market))
    throw new Error('STOCK_SOURCE_ARGUMENT_INVALID');
  const directory = await verifiedStockInputDirectory(root);
  const raw = await readPrivateStockJson(
    join(root, 'market-watch-input', market + '.json'), directory.uid,
  );
  return normalizeStockFeed(raw, market, nowMs);
}

export async function inspectStockInputs(root, nowMs = Date.now()) {
  if (!validSourceRoot(root, nowMs)) return {
    contract: STOCK_PREFLIGHT_CONTRACT, status: 'INVALID',
    markets: MARKETS.map(m => empty(m, 'INVALID')),
    ...NO_AUTHORITY,
  };
  const folder = join(root, 'market-watch-input');
  let directory;
  try {
    directory = await verifiedStockInputDirectory(root);
  } catch (error) {
    const missing = error?.code === 'ENOENT';
    return {
      contract: STOCK_PREFLIGHT_CONTRACT,
      status: missing ? 'INCOMPLETE' : 'INVALID',
      markets: MARKETS.map(m => empty(m, missing ? 'MISSING' : 'INVALID')),
      ...NO_AUTHORITY,
    };
  }
  const markets = [];
  for (const market of MARKETS) {
    try {
      const raw = await readPrivateStockJson(join(folder, market + '.json'), directory.uid);
      const quote = normalizeStockFeed(raw, market, nowMs);
      markets.push({
        market,
        // Preserve the untrusted producer's flag only as an unverified label:
        // the watch itself does NOT upgrade this to complete-market READY.
        status: raw.completeUniverse === true
          ? 'FRESH_COMPLETE_CLAIM_UNVERIFIED' : 'FRESH_SUBSET_UNVERIFIED',
        source: quote.source, listedCount: quote.listedCount,
        observedCount: quote.quotes.length,
      });
    } catch (error) {
      markets.push(empty(market, error?.code === 'ENOENT' ? 'MISSING'
        : error?.message === 'STOCK_PUBLIC_FEED_STALE' ? 'STALE' : 'INVALID'));
    }
  }
  return {
    contract: STOCK_PREFLIGHT_CONTRACT,
    status: markets.some(m => m.status === 'INVALID') ? 'INVALID'
      : markets.every(m => m.status.startsWith('FRESH_'))
        ? 'FORMAT_VALID_ONLY' : 'INCOMPLETE',
    markets,
    ...NO_AUTHORITY,
  };
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isDirectInvocation()) {
  inspectStockInputs(process.env.RESEARCH_STATE_ROOT ?? '').then(report => {
    process.stdout.write(JSON.stringify(report) + '\n');
    if (report.status === 'INVALID') process.exitCode = 2;
  }).catch(() => {
    process.stdout.write(JSON.stringify({
      contract: STOCK_PREFLIGHT_CONTRACT, status: 'INVALID',
      markets: MARKETS.map(m => empty(m, 'INVALID')),
      ...NO_AUTHORITY,
    }) + '\n');
    process.exitCode = 2;
  });
}
