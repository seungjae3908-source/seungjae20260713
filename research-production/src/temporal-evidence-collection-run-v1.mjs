// One hourly run of the crypto-futures temporal evidence collector.
//
// Wraps collectCryptoFuturesTemporalEvidenceV1 with what the systemd oneshot
// needs to be observable and safe to repeat:
//   - an exclusive lock so two runs (timer + manual) never both rewrite the
//     ledger; a busy run is DEFERRED (nothing written, exit 0), not a failure;
//   - a latest/ record written on EVERY outcome, including a run that failed
//     before collecting anything, so "did not run", "ran late", "ran and
//     partly failed" and "ran and failed closed" are distinct states for the
//     watchdog and the digest; the last complete run is carried forward.
// Public data only, no orders. executionAuthority NONE.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { acquireExclusiveFileLockV1 } from '../../market-prediction-lab/src/formula-auto-backtest-queue-v1.js';
import { collectCryptoFuturesTemporalEvidenceV1 } from './crypto-temporal-public-collector.mjs';
import { assertTemporalEvidenceLedgerV1, createTemporalEvidenceLedgerV1 } from './temporal-evidence-ledger.mjs';

export const TEMPORAL_COLLECTION_RUN_CONTRACT_V1 = 'crypto-futures-temporal-public-collection-run/v1';
export const TEMPORAL_COLLECTOR_BUSY_CODE_V1 = 'TEMPORAL_COLLECTOR_BUSY';

const SAFETY = Object.freeze({ publicDataOnly: true, privateApi: false, liveTrading: false, realOrders: false, historicalCurrentValueBackfill: false, executionAuthority: 'NONE' });
// App-owned storage the research state root must never point into.
const PROTECTED_ROOTS = Object.freeze(['/opt/stock-app-data', '/srv/stock-app', '/var/lib/stock-app']);

export function parseTemporalSymbolsV1(value) {
  const rows = [...new Set(String(value ?? 'BTCUSDT,ETHUSDT').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))];
  if (rows.length < 1 || rows.length > 20 || rows.some((x) => !/^[A-Z0-9]{3,30}$/u.test(x))) throw new Error('RESEARCH_TEMPORAL_CRYPTO_SYMBOLS invalid');
  return rows;
}

export function exactResearchShaV1(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error('RESEARCH_CODE_SHA must be exact 40-char SHA');
  return sha;
}

export function safeTemporalStateRootV1(value) {
  const root = resolve(String(value ?? '/var/lib/investment-research-production'));
  if (!isAbsolute(root)) throw new Error('state root must be absolute');
  for (const forbidden of PROTECTED_ROOTS) {
    if (root === forbidden || root.startsWith(`${forbidden}/`)) throw new Error('temporal research state overlaps protected app storage');
  }
  return root;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readLedger(path, researchSha) {
  const parsed = await readJson(path);
  if (parsed == null) return createTemporalEvidenceLedgerV1({ researchSha });
  assertTemporalEvidenceLedgerV1(parsed);
  return parsed;
}

/** Pure: the next latest/ record from the previous one and this run's outcome. */
export function nextTemporalCollectionRecordV1({ previous = null, status, nowMs, researchSha, failedCount = 0, results = [], observationCount = null, ledgerDigest = null, error = null }) {
  const prior = previous && typeof previous === 'object' ? previous : {};
  const complete = status === 'complete';
  const failed = status === 'partial_failure' || status === 'failed_closed';
  return {
    schemaVersion: 'crypto-futures-temporal-public-collection-v1',
    contract: TEMPORAL_COLLECTION_RUN_CONTRACT_V1,
    generatedAt: nowMs,
    researchSha,
    status,
    failedCount,
    results,
    error: error == null ? null : String(error).slice(0, 800),
    observationCount: observationCount ?? prior.observationCount ?? null,
    ledgerDigest: ledgerDigest ?? prior.ledgerDigest ?? null,
    // What a reader needs to tell "late" from "failing": when did it last
    // fully succeed, and how many runs in a row did not.
    lastCompleteAt: complete ? nowMs : prior.lastCompleteAt ?? null,
    lastAttemptAt: nowMs,
    consecutiveFailures: complete ? 0 : failed ? Number(prior.consecutiveFailures ?? 0) + 1 : Number(prior.consecutiveFailures ?? 0),
    safety: SAFETY,
  };
}

/**
 * Runs one collection under the collector lock. Returns { status, exitCode,
 * record } where exitCode follows the oneshot contract: 0 complete or
 * deferred, 1 partial_failure or failed_closed.
 */
export async function runTemporalEvidenceCollectionV1({
  stateRoot,
  researchSha,
  symbols = ['BTCUSDT', 'ETHUSDT'],
  longShortPeriod = '1h',
  collector = collectCryptoFuturesTemporalEvidenceV1,
  client,
  now = () => Date.now(),
  lockOptions = {},
} = {}) {
  const root = safeTemporalStateRootV1(stateRoot);
  const sha = exactResearchShaV1(researchSha);
  const ledgerPath = join(root, 'temporal-evidence', 'crypto-futures-ledger.json');
  const latestPath = join(root, 'latest', 'temporal-crypto-futures.json');
  const lockPath = join(root, 'temporal-evidence', 'collector.lock');
  let lock;
  try {
    lock = await acquireExclusiveFileLockV1(lockPath, { waitMs: 0, busyCode: TEMPORAL_COLLECTOR_BUSY_CODE_V1, ...lockOptions });
  } catch (error) {
    if (error?.code !== TEMPORAL_COLLECTOR_BUSY_CODE_V1) throw error;
    // Another collector run owns the ledger: this run writes nothing.
    return Object.freeze({ status: 'deferred_busy', exitCode: 0, lockHolderState: error.lockHolderState ?? null, record: null, executionAuthority: 'NONE' });
  }
  try {
    const nowMs = now();
    let previous = null;
    try { previous = await readJson(latestPath); } catch { previous = null; }
    let ledger;
    try {
      ledger = await readLedger(ledgerPath, sha);
    } catch (error) {
      // The ledger is unreadable or corrupt: never overwrite it, record the failure.
      const record = nextTemporalCollectionRecordV1({ previous, status: 'failed_closed', nowMs, researchSha: sha, error: `LEDGER_UNREADABLE:${String(error?.message ?? error)}` });
      await atomicJson(latestPath, record);
      return Object.freeze({ status: 'failed_closed', exitCode: 1, record, executionAuthority: 'NONE' });
    }
    let result;
    try {
      result = await collector({ ledger, symbols, longShortPeriod, producerSha: sha, ...(client ? { client } : {}) });
    } catch (error) {
      const record = nextTemporalCollectionRecordV1({ previous, status: 'failed_closed', nowMs, researchSha: sha, failedCount: symbols.length, error: String(error?.message ?? error) });
      await atomicJson(latestPath, record);
      return Object.freeze({ status: 'failed_closed', exitCode: 1, record, executionAuthority: 'NONE' });
    }
    await atomicJson(ledgerPath, result.ledger);
    const record = nextTemporalCollectionRecordV1({
      previous, status: result.status, nowMs, researchSha: sha, failedCount: result.failedCount, results: result.results,
      observationCount: result.ledger.observations.length, ledgerDigest: result.ledger.ledgerDigest,
    });
    await atomicJson(latestPath, record);
    return Object.freeze({ status: result.status, exitCode: result.status === 'complete' ? 0 : 1, record, executionAuthority: 'NONE' });
  } finally {
    await lock.release();
  }
}
