import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compiledFuturesMomentumFormula, compiledMomentumFormula } from '../../market-prediction-lab/tests/research-bundle-formula-fixture.js';
import {
  assertAutonomousResearchDossierV1,
  createAutonomousResearchDossierV1,
  loadAutonomousResearchNextDirectiveV1,
  runAutonomousResearchClosedLoopV1,
  stageAutonomousResearchDossierV1,
} from '../src/autonomous-research-closed-loop-v1.mjs';

const SHA = 'a'.repeat(40);
const OBSERVED_AT = '2026-10-14T00:10:00.000Z';

function candles({ falling = false } = {}) {
  const start = Date.parse('2020-09-01T00:00:00.000Z');
  return Array.from({ length: 220 }, (_, index) => {
    const direction = falling ? -1 : 1;
    const base = 200 + direction * index * 0.05 + Math.sin(index / 4) * 2;
    return {
      timestamp: start + index * 15 * 60_000,
      open: base,
      high: base + 1.2,
      low: base - 1.2,
      close: base + Math.sin(index / 3) * 0.3,
      volume: index % 9 === 0 ? 2_800 : 1_000 + index,
    };
  });
}

function source(index = 1) {
  return {
    sourceId: `github:public-strategy-${index}`,
    sourceType: 'GITHUB_OPEN_SOURCE',
    canonicalUrl: `https://github.com/example/research/blob/${'b'.repeat(40)}/strategy-${index}.py`,
    title: `Public strategy ${index}`,
    authors: [`Author ${index}`],
    publishedAt: '2026-01-01T00:00:00.000Z',
    retrievedAt: '2026-10-14T00:00:00.000Z',
    sourceRevision: 'b'.repeat(40),
    contentSha256: String(index).repeat(64),
    license: {
      status: 'GPL-3.0',
      canonicalUrl: `https://github.com/example/research/blob/${'b'.repeat(40)}/LICENSE`,
      contentSha256: 'f'.repeat(64),
    },
    rules: {
      entry: ['A public closed-candle condition is satisfied.'],
      exit: ['The public source defines an exit condition.'],
      risk: ['The source warns that results require independent testing.'],
      claimedPerformance: [],
      limitations: ['Test fixture proves orchestration only, not economic performance.'],
    },
    accessVerified: true,
    httpStatus: 200,
  };
}

function queueItem({ futures = false, falling = futures } = {}) {
  const compiled = futures ? compiledFuturesMomentumFormula({ direction: 'LONG' }) : compiledMomentumFormula();
  const rows = candles({ falling });
  const formula = compiled.formula;
  return {
    schemaVersion: 1,
    contract: 'research-formula-auto-backtest-queue-item/v1',
    queuedAt: OBSERVED_AT,
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
        symbol: futures ? 'BTCUSDT' : 'AAPL',
        timeframe: formula.timeframe,
        side: 'long',
        candles: rows,
        ...(futures ? { fundingRates: [{ timestamp: rows[120].timestamp, rate: 0.0001 }] } : {}),
        initialCapital: 10_000,
        riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 0.5, leverage: futures ? 2 : 1 },
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
      period: { startTime: rows[0].timestamp, endTime: rows.at(-1).timestamp, includeFinalHoldout: false },
    },
  };
}

function dossier({ index, classification = 'DECLARED_VARIANT', formulaQueueItem = queueItem() } = {}) {
  return createAutonomousResearchDossierV1({
    researchCodeSha: SHA,
    discoveredAt: `2026-10-14T00:0${index}:00.000Z`,
    sourceEvidence: source(index),
    strategy: {
      strategyId: `public-strategy-${index}`,
      family: index === 1 ? 'UNREPRESENTABLE_PUBLIC_RULE' : index === 2 ? 'MOMENTUM_RVOL' : 'FUTURES_MOMENTUM_RVOL',
      classification,
      novelty: index === 1 ? 'NOVEL_FAMILY' : 'NOVEL_VARIANT',
      market: formulaQueueItem?.formulaCandidate?.market ?? 'CRYPTO_SPOT',
      timeframe: formulaQueueItem?.formulaCandidate?.timeframe ?? '1h',
      direction: formulaQueueItem?.formulaCandidate?.direction ?? 'LONG',
      transformations: classification === 'ORIGINAL_RULES' ? [] : ['Canonical ATR/target/time exits replace source-specific execution rules.'],
      unresolvedRules: classification === 'RESEARCH_HYPOTHESIS' ? ['The source rule is outside the current safe DSL.'] : [],
    },
    formulaQueueItem: classification === 'RESEARCH_HYPOTHESIS' ? null : formulaQueueItem,
  });
}

test('closed loop continues from an unrepresentable source to two distinct real queue executions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autonomous-research-loop-'));
  try {
    const rows = [
      dossier({ index: 1, classification: 'RESEARCH_HYPOTHESIS', formulaQueueItem: null }),
      dossier({ index: 2, formulaQueueItem: queueItem() }),
      dossier({ index: 3, formulaQueueItem: queueItem({ futures: true }) }),
    ];
    for (const row of rows) await stageAutonomousResearchDossierV1({ stateRoot: root, dossier: row });

    const result = await runAutonomousResearchClosedLoopV1({
      stateRoot: root,
      researchCodeSha: SHA,
      maximumStrategiesPerCycle: 4,
      now: () => OBSERVED_AT,
    });
    const state = JSON.parse(await readFile(join(root, 'autonomous-research', 'releases', SHA, 'state.json'), 'utf8'));
    assert.equal(result.discoveredStrategyCount, 3);
    assert.equal(result.completedStrategyCount, 3);
    assert.equal(result.formulaGeneratedCount, 2);
    assert.equal(result.actualBacktestCount, 2, JSON.stringify(state.records));
    assert.equal(result.researchHypothesisCount, 1);
    assert.equal(result.queueExecutions, 2);
    assert.equal(result.deferredThisCycle, 0);
    assert.equal(result.waitingForFuturePaperSignalBlocksResearch, false);
    assert.equal(result.runtimeActivated, false);
    assert.equal(result.executionAuthority, 'NONE');

    assert.equal(state.records[0].disposition, 'IMPROVE');
    assert.equal(state.records[0].reason, 'FORMULA_NOT_SAFELY_REPRESENTABLE');
    assert.deepEqual(state.records.slice(1).map((row) => row.lifecycle.slice(0, 3)), [
      ['DISCOVERED', 'FORMULA_READY', 'BACKTESTING'],
      ['DISCOVERED', 'FORMULA_READY', 'BACKTESTING'],
    ]);
    assert.notEqual(state.records[1].strategyIdentityDigest, state.records[2].strategyIdentityDigest);
    assert.equal(state.records.slice(1).every((row) => row.metrics != null), true);

    const directive = await loadAutonomousResearchNextDirectiveV1({ stateRoot: root, researchCodeSha: SHA });
    assert.equal(directive.selectionPolicy.continueResearch, true);
    assert.equal(directive.selectionPolicy.sameIdentityRetryAllowed, false);
    assert.equal(directive.selectionPolicy.paperWaitingBlocksResearch, false);
    assert.equal(directive.safety.executionAuthority, 'NONE');
    assert.ok(directive.failureCodes.includes('FORMULA_NOT_SAFELY_REPRESENTABLE'));

    const repeated = await runAutonomousResearchClosedLoopV1({
      stateRoot: root,
      researchCodeSha: SHA,
      maximumStrategiesPerCycle: 4,
      now: () => '2026-10-14T00:20:00.000Z',
    });
    assert.equal(repeated.attemptedThisCycle, 0);
    assert.equal(repeated.queueExecutions, 0);
    assert.equal(repeated.completedStrategyCount, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dossier binds source content, declared transformations and formula identity against tampering', () => {
  const row = dossier({ index: 2 });
  assert.equal(assertAutonomousResearchDossierV1(row), row);
  assert.throws(() => assertAutonomousResearchDossierV1({
    ...row,
    sourceEvidence: { ...row.sourceEvidence, contentSha256: 'e'.repeat(64) },
  }), /AUTONOMOUS_RESEARCH_DOSSIER_INVALID/);
  assert.throws(() => assertAutonomousResearchDossierV1({ ...row, unexpectedAuthority: true }),
    /AUTONOMOUS_RESEARCH_DOSSIER_INVALID/);
  assert.throws(() => createAutonomousResearchDossierV1({
    researchCodeSha: SHA,
    discoveredAt: OBSERVED_AT,
    sourceEvidence: { ...source(2), httpStatus: 404 },
    strategy: row.strategy,
    formulaQueueItem: queueItem(),
  }), /SOURCE_ACCESS_NOT_ACTUALLY_VERIFIED/);
});

test('a target beyond the shared queue batch remains resumable instead of stopping research', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autonomous-research-deferred-'));
  try {
    await stageAutonomousResearchDossierV1({ stateRoot: root, dossier: dossier({ index: 2 }) });
    const result = await runAutonomousResearchClosedLoopV1({
      stateRoot: root,
      researchCodeSha: SHA,
      maximumStrategiesPerCycle: 1,
      now: () => OBSERVED_AT,
      processQueue: async () => ({ status: 'BOUNDED_BATCH_ADVANCED' }),
    });
    assert.equal(result.attemptedThisCycle, 1);
    assert.equal(result.queueExecutions, 1);
    assert.equal(result.deferredThisCycle, 1);
    assert.equal(result.completedStrategyCount, 0);
    assert.equal(result.remainingStrategyCount, 1);
    assert.equal(result.nextAction, 'CONTINUE_STAGED_RESEARCH');
    assert.equal(result.executionAuthority, 'NONE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a new dossier cannot replay an already failed strategy, dataset and parameter identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autonomous-research-duplicate-'));
  try {
    const item = queueItem({ falling: true });
    const first = dossier({ index: 2, formulaQueueItem: item });
    await stageAutonomousResearchDossierV1({ stateRoot: root, dossier: first });
    const initial = await runAutonomousResearchClosedLoopV1({
      stateRoot: root, researchCodeSha: SHA, maximumStrategiesPerCycle: 1, now: () => OBSERVED_AT,
    });
    assert.equal(initial.completedStrategyCount, 1);
    assert.equal(initial.paperRegisteredCount, 0);

    const replay = createAutonomousResearchDossierV1({
      researchCodeSha: SHA,
      discoveredAt: '2026-10-14T00:11:00.000Z',
      sourceEvidence: source(2),
      strategy: {
        strategyId: 'public-strategy-2', family: 'MOMENTUM_RVOL', classification: 'DECLARED_VARIANT',
        novelty: 'NOVEL_VARIANT', market: item.formulaCandidate.market,
        timeframe: item.formulaCandidate.timeframe, direction: item.formulaCandidate.direction,
        transformations: ['Canonical ATR/target/time exits replace source-specific execution rules.'],
        unresolvedRules: [],
      },
      formulaQueueItem: item,
    });
    assert.equal(replay.strategy.strategyIdentityDigest, first.strategy.strategyIdentityDigest);
    assert.notEqual(replay.dossierDigest, first.dossierDigest);
    await stageAutonomousResearchDossierV1({ stateRoot: root, dossier: replay });
    const repeated = await runAutonomousResearchClosedLoopV1({
      stateRoot: root, researchCodeSha: SHA, maximumStrategiesPerCycle: 1,
      now: () => '2026-10-14T00:12:00.000Z',
    });
    const state = JSON.parse(await readFile(join(root, 'autonomous-research', 'releases', SHA, 'state.json'), 'utf8'));
    assert.equal(repeated.queueExecutions, 0);
    assert.equal(state.records.at(-1).reason, 'AUTOMATIC_SAME_IDENTITY_RETRY_BLOCKED');
    assert.deepEqual(state.records.at(-1).lifecycle, ['DISCOVERED', 'DUPLICATE_BLOCKED']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
