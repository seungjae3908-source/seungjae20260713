#!/usr/bin/env node
// Read-only inspection of optional KR/US public stock snapshot files.
// A well-formed source label or completeUniverse=true is NOT proof of
// provenance, data rights, whole-universe coverage, or trading authority.
import { constants } from 'node:fs';
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
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ino !== opened.ino || after.nlink !== 1)
      throw new Error('STOCK_INPUT_CHANGED');
    return JSON.parse(contents);
  } finally {
    await handle.close();
  }
}

export async function inspectStockInputs(root, nowMs = Date.now()) {
  const validRoot = typeof root === 'string' && root.length > 1
    && root !== '/' && isAbsolute(root) && resolve(root) === root
    && Number.isFinite(nowMs) && nowMs > 0;
  if (!validRoot) return {
    contract: STOCK_PREFLIGHT_CONTRACT, status: 'INVALID',
    markets: MARKETS.map(m => empty(m, 'INVALID')),
    ...NO_AUTHORITY,
  };
  const folder = join(root, 'market-watch-input');
  let directory;
  try {
    const stateDir = await lstat(root);
    if (!safeDirectory(stateDir)) throw new Error('UNSAFE_STOCK_ROOT');
    directory = await lstat(folder);
    if (!safeDirectory(directory) || directory.uid !== stateDir.uid)
      throw new Error('UNSAFE_STOCK_DIRECTORY');
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
        status: quote.status === 'READY'
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
