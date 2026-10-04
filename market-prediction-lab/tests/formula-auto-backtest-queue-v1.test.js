import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compiledMomentumFormula, compiledFuturesMomentumFormula } from './research-bundle-formula-fixture.js';
import {
  FORMULA_AUTO_BACKTEST_QUEUE_ITEM_CONTRACT_V1,
  evaluateFormulaAutoBacktestQueueItemV1,
  processFormulaAutoBacktestQueueV1,
} from '../src/formula-auto-backtest-queue-v1.js';

function candles() {
  const start = Date.UTC(2020, 0, 1);
  return Array.from({ length: 180 }, (_, index) => {
    const wave = Math.sin(index / 5) * 1.5;
    const base = 100 + index * 0.08 + wave;
    return {
      timestamp: start + index * 15 * 60_000,
      open: base,
      high: base + 1.2,
      low: Math.max(1, base - 1),
      close: base + (index % 7 === 0 ? 0.8 : 0.2),
      volume: index % 12 === 0 ? 2600 : 1000 + (index % 10) * 20,
    };
  });
}

function queueItem() {
  const { formula } = compiledMomentumFormula();
  const rows = candles();
  return {
    schemaVersion: 1,
    contract: FORMULA_AUTO_BACKTEST_QUEUE_ITEM_CONTRACT_V1,
    queuedAt: new Date().toISOString(),
    formulaCandidate: formula,
    dataset: {
      datasetIdentity: formula.provenance.datasetIdentity,
      datasetRole: 'TRAIN',
      market: formula.market,
      timeframe: formula.timeframe,
      direction: formula.direction,
      candleCount: rows.length,
      availableFields: [...formula.availableDataFields],
      backtestInput: {
        market: formula.market,
        symbol: 'AAPL',
        timeframe: formula.timeframe,
        side: 'long',
        candles: rows,
        initialCapital: 10_000,
        riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 },
        costModel: {
          entryFeeRate: 0.001,
          exitFeeRate: 0.001,
          taxRate: 0,
          slippageRate: 0.0005,
          spreadRate: 0.0002,
          latencyBars: 0,
          latencyDriftRate: 0,
        },
      },
      period: {
        startTime: rows[0].timestamp,
        endTime: rows.at(-1).timestamp,
        includeFinalHoldout: false,
      },
    },
  };
}


test('safe crypto futures LONG and SHORT formulas automatically reach canonical historical backtest instead of blanket HOLD', async () => {
  for (const direction of ['LONG', 'SHORT']) {
    const { formula } = compiledFuturesMomentumFormula({ direction });
    const rows = direction === 'LONG'
      ? candles()
      : candles().map((row, index, all) => ({ ...row, close: 220 - index * 0.08 + Math.sin(index / 5), open: 220 - index * 0.08 + Math.sin(index / 5), high: 222 - index * 0.08 + Math.sin(index / 5), low: 218 - index * 0.08 + Math.sin(index / 5) }));
    const item = {
      schemaVersion: 1,
      contract: FORMULA_AUTO_BACKTEST_QUEUE_ITEM_CONTRACT_V1,
      queuedAt: new Date().toISOString(),
      formulaCandidate: formula,
      dataset: {
        datasetIdentity: formula.provenance.datasetIdentity,
        datasetRole: 'TRAIN',
        market: formula.market,
        timeframe: formula.timeframe,
        direction: formula.direction,
        candleCount: rows.length,
        availableFields: [...formula.availableDataFields],
        backtestInput: {
          market: formula.market,
          symbol: 'BTCUSDT',
          timeframe: formula.timeframe,
          side: direction === 'SHORT' ? 'short' : 'long',
          candles: rows,
          fundingRates: [{ timestamp: rows[120].timestamp, rate: 0.0001 }],
          initialCapital: 10_000,
          riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 2 },
          costModel: {
            entryFeeRate: 0.0006, exitFeeRate: 0.0006, taxRate: 0,
            slippageRate: 0.0005, spreadRate: 0.0002, latencyBars: 0, latencyDriftRate: 0,
          },
        },
        period: {
          startTime: rows[0].timestamp,
          endTime: rows.at(-1).timestamp,
          includeFinalHoldout: false,
        },
      },
    };
    const result = await evaluateFormulaAutoBacktestQueueItemV1(item);
    assert.notEqual(result.reason, 'DERIVATIVES_SAFE_DSL_EVALUATOR_NOT_ENABLED');
    assert.ok(result.tournament);
    const historical = result.tournament.candidates.flatMap((candidate) => candidate.stageRecords ?? [])
      .find((stage) => stage.stage === 'HISTORICAL_BACKTEST');
    assert.ok(historical, direction);
    assert.equal(result.tournament.safety.executionAuthority, 'NONE');
  }
});

test('new safe formula automatically reaches the canonical one-pass historical backtest and stays HOLD without later evidence', async () => {
  const result = await evaluateFormulaAutoBacktestQueueItemV1(queueItem());
  assert.equal(result.state, 'HOLD');
  assert.equal(result.reason, 'MORE_CANONICAL_EVIDENCE_REQUIRED');
  assert.ok(result.tournament);
  assert.ok(result.tournament.candidates.length >= 1);
  const stages = result.tournament.candidates.flatMap((candidate) => candidate.stageRecords);
  assert.ok(stages.some((stage) => stage.stage === 'HISTORICAL_BACKTEST'));
  assert.equal(result.tournament.safety.executionAuthority, 'NONE');
  assert.equal(result.tournament.safety.orderSubmitted, false);
});

test('structurally invalid formula is excluded but never deleted', async () => {
  const item = structuredClone(queueItem());
  item.formulaCandidate.formulaHash = '0'.repeat(64);
  const result = await evaluateFormulaAutoBacktestQueueItemV1(item);
  assert.equal(result.state, 'EXCLUDE');
  assert.equal(result.tournament, null);
});

test('queue persists immutable audit results and repeated processing is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'formula-auto-backtest-'));
  const inbox = join(root, 'formula-backtest', 'inbox');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(inbox, { recursive: true }));
  await writeFile(join(inbox, 'candidate.json'), JSON.stringify(queueItem()), { encoding: 'utf8', mode: 0o600 });

  const first = await processFormulaAutoBacktestQueueV1({ stateRoot: root });
  assert.equal(first.scanned, 1);
  assert.equal(first.counts.HOLD, 1);
  assert.equal(first.deletionAllowed, false);
  assert.equal(first.executionAuthority, 'NONE');

  const resultFiles = (await readdir(join(root, 'formula-backtest', 'results'))).filter((name) => name.endsWith('.json'));
  assert.equal(resultFiles.length, 1);
  const stored = JSON.parse(await readFile(join(root, 'formula-backtest', 'results', resultFiles[0]), 'utf8'));
  assert.equal(stored.retainedForAudit, true);
  assert.equal(stored.deleted, false);
  assert.equal(stored.realOrder, false);

  const second = await processFormulaAutoBacktestQueueV1({ stateRoot: root });
  assert.equal(second.scanned, 1);
  const repeatedFiles = (await readdir(join(root, 'formula-backtest', 'results'))).filter((name) => name.endsWith('.json'));
  assert.deepEqual(repeatedFiles, resultFiles);
});
