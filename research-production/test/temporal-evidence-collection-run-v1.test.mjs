import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireExclusiveFileLockV1 } from '../../market-prediction-lab/src/formula-auto-backtest-queue-v1.js';
import {
  nextTemporalCollectionRecordV1,
  parseTemporalSymbolsV1,
  runTemporalEvidenceCollectionV1,
  safeTemporalStateRootV1,
} from '../src/temporal-evidence-collection-run-v1.mjs';
import { appendTemporalEvidenceV1, createTemporalEvidenceLedgerV1 } from '../src/temporal-evidence-ledger.mjs';

const SHA = 'a'.repeat(40);
const T0 = Date.UTC(2026, 9, 18, 5, 5);

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'temporal-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function collectorOf(outcome) {
  return async ({ ledger, symbols, producerSha }) => {
    if (outcome === 'throw') throw new Error('BITGET_HTTP_503');
    let current = ledger;
    const results = [];
    for (const [index, symbol] of symbols.entries()) {
      const fail = outcome === 'partial' && index === symbols.length - 1;
      if (!fail) {
        current = appendTemporalEvidenceV1(current, { market: 'CRYPTO_FUTURES', symbol, feature: 'fundingRate', value: 0.0001, observedAt: T0, availableAt: T0 + 1,
          recordedAt: T0 + 1, source: 'test', producerSha, publicDataOnly: true, synthetic: false, replay: false, backfill: false, manual: false });
      }
      results.push({ symbol, status: fail ? 'failed' : 'success', observedCount: fail ? 0 : 1, appendedCount: fail ? 0 : 1 });
    }
    const failedCount = results.filter((row) => row.status === 'failed').length;
    return { schemaVersion: 'crypto-futures-temporal-public-collection-v1', status: failedCount ? 'partial_failure' : 'complete', failedCount, results, ledger: current };
  };
}

test('record folds the previous run forward: failures count up until a complete run resets them', () => {
  const first = nextTemporalCollectionRecordV1({ previous: null, status: 'complete', nowMs: T0, researchSha: SHA, observationCount: 2, ledgerDigest: 'd' });
  assert.equal(first.consecutiveFailures, 0);
  assert.equal(first.lastCompleteAt, T0);
  const second = nextTemporalCollectionRecordV1({ previous: first, status: 'partial_failure', nowMs: T0 + 3_600_000, researchSha: SHA, failedCount: 1, observationCount: 3, ledgerDigest: 'e' });
  assert.equal(second.consecutiveFailures, 1);
  assert.equal(second.lastCompleteAt, T0, 'last complete run carried forward');
  const third = nextTemporalCollectionRecordV1({ previous: second, status: 'failed_closed', nowMs: T0 + 7_200_000, researchSha: SHA, error: 'x' });
  assert.equal(third.consecutiveFailures, 2);
  assert.equal(third.observationCount, 3, 'count from the last successful write is kept, not nulled');
  assert.equal(third.ledgerDigest, 'e');
  const fourth = nextTemporalCollectionRecordV1({ previous: third, status: 'complete', nowMs: T0 + 10_800_000, researchSha: SHA, observationCount: 4, ledgerDigest: 'f' });
  assert.equal(fourth.consecutiveFailures, 0);
  assert.equal(fourth.lastCompleteAt, T0 + 10_800_000);
  assert.equal(fourth.safety.executionAuthority, 'NONE');
});

test('a run writes the ledger and a latest record; a partial failure exits 1 but keeps what it collected', async (t) => {
  const root = await tempRoot(t);
  const symbols = ['BTCUSDT', 'ETHUSDT'];
  const ok = await runTemporalEvidenceCollectionV1({ stateRoot: root, researchSha: SHA, symbols, collector: collectorOf('complete'), now: () => T0 });
  assert.equal(ok.status, 'complete');
  assert.equal(ok.exitCode, 0);
  const latest = JSON.parse(await readFile(join(root, 'latest', 'temporal-crypto-futures.json'), 'utf8'));
  assert.equal(latest.status, 'complete');
  assert.equal(latest.observationCount, 2);
  assert.equal(latest.lastCompleteAt, T0);
  const partial = await runTemporalEvidenceCollectionV1({ stateRoot: root, researchSha: SHA, symbols: ['BTCUSDT', 'SOLUSDT'], collector: collectorOf('partial'), now: () => T0 + 3_600_000 });
  assert.equal(partial.status, 'partial_failure');
  assert.equal(partial.exitCode, 1);
  assert.equal(partial.record.consecutiveFailures, 1);
  assert.equal(partial.record.lastCompleteAt, T0);
  const ledger = JSON.parse(await readFile(join(root, 'temporal-evidence', 'crypto-futures-ledger.json'), 'utf8'));
  assert.equal(ledger.observations.length, 2, 'duplicates are not re-appended; the failed symbol added nothing');
});

test('a run that fails before collecting still leaves a latest record, and never overwrites a corrupt ledger', async (t) => {
  const root = await tempRoot(t);
  const thrown = await runTemporalEvidenceCollectionV1({ stateRoot: root, researchSha: SHA, collector: collectorOf('throw'), now: () => T0 });
  assert.equal(thrown.status, 'failed_closed');
  assert.equal(thrown.exitCode, 1);
  const latest = JSON.parse(await readFile(join(root, 'latest', 'temporal-crypto-futures.json'), 'utf8'));
  assert.equal(latest.status, 'failed_closed');
  assert.match(latest.error, /BITGET_HTTP_503/u);
  assert.equal(latest.consecutiveFailures, 1);
  assert.equal(latest.lastCompleteAt, null);
  // Corrupt ledger: reported, untouched.
  await mkdir(join(root, 'temporal-evidence'), { recursive: true });
  await writeFile(join(root, 'temporal-evidence', 'crypto-futures-ledger.json'), '{"schemaVersion":"wrong"}');
  const corrupt = await runTemporalEvidenceCollectionV1({ stateRoot: root, researchSha: SHA, collector: collectorOf('complete'), now: () => T0 + 60_000 });
  assert.equal(corrupt.status, 'failed_closed');
  assert.match(corrupt.record.error, /^LEDGER_UNREADABLE:/u);
  assert.equal(await readFile(join(root, 'temporal-evidence', 'crypto-futures-ledger.json'), 'utf8'), '{"schemaVersion":"wrong"}');
  assert.equal(corrupt.record.consecutiveFailures, 2);
});

test('a second run while the collector lock is held is deferred: exit 0 and nothing written', async (t) => {
  const root = await tempRoot(t);
  const lock = await acquireExclusiveFileLockV1(join(root, 'temporal-evidence', 'collector.lock'));
  try {
    let collected = 0;
    const deferred = await runTemporalEvidenceCollectionV1({ stateRoot: root, researchSha: SHA, now: () => T0, collector: async () => { collected += 1; throw new Error('must not run'); } });
    assert.equal(deferred.status, 'deferred_busy');
    assert.equal(deferred.exitCode, 0);
    assert.equal(deferred.lockHolderState, 'ALIVE');
    assert.equal(collected, 0);
    await assert.rejects(readFile(join(root, 'latest', 'temporal-crypto-futures.json')), /ENOENT/u);
  } finally {
    await lock.release();
  }
  const after = await runTemporalEvidenceCollectionV1({ stateRoot: root, researchSha: SHA, collector: collectorOf('complete'), now: () => T0 + 1_000 });
  assert.equal(after.status, 'complete');
});

test('inputs: symbols and the state root are validated; app storage is never a research state root', () => {
  assert.deepEqual(parseTemporalSymbolsV1(' btcusdt, ETHUSDT ,btcusdt'), ['BTCUSDT', 'ETHUSDT']);
  assert.throws(() => parseTemporalSymbolsV1('bad-symbol'), /RESEARCH_TEMPORAL_CRYPTO_SYMBOLS invalid/u);
  assert.throws(() => safeTemporalStateRootV1('/opt/stock-app-data/research'), /protected app storage/u);
  assert.equal(safeTemporalStateRootV1('/var/lib/investment-research-production'), '/var/lib/investment-research-production');
  assert.equal(createTemporalEvidenceLedgerV1({ researchSha: SHA }).executionAuthority, 'NONE');
});
