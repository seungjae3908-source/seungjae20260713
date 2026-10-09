import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compiledMomentumFormula, compiledFuturesMomentumFormula } from './research-bundle-formula-fixture.js';
import {
  FORMULA_AUTO_BACKTEST_QUEUE_ITEM_CONTRACT_V1,
  FORMULA_PAPER_STRATEGY_REGISTRY_CONTRACT_V1,
  buildFormulaPaperStrategyRegistryV1,
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

test('only PASS research survivors enter the Paper strategy registry and never trade immediately', () => {
  const { formula } = compiledMomentumFormula();
  const generatedCandidate = {
    generatedCandidateId: 'generated-paper-pass-v1',
    formulaCandidateId: formula.candidateId,
    formulaHash: formula.formulaHash,
    parameterIdentity: 'a'.repeat(64),
    selectedParameters: Object.fromEntries(formula.parameterSpace.map((row) => [row.name, row.min])),
    safety: { executionAuthority: 'NONE' },
  };
  const survivor = {
    formulaCandidate: formula,
    generatedCandidate,
    formulaCandidateId: formula.candidateId,
    generatedCandidateId: generatedCandidate.generatedCandidateId,
    strategyHash: formula.formulaHash,
    parameterIdentity: generatedCandidate.parameterIdentity,
    strategyFamily: formula.strategyFamily,
    market: formula.market,
    timeframe: formula.timeframe,
    direction: formula.direction,
    researchSurvivor: true,
    failure: null,
    tradingAuthority: false,
    safety: { executionAuthority: 'NONE' },
  };
  const pass = {
    state: 'PASS',
    itemDigest: 'b'.repeat(64),
    evaluatedAt: new Date().toISOString(),
    tournamentId: 'tournament-pass-v1',
    tournament: { candidates: [survivor] },
  };
  const registry = buildFormulaPaperStrategyRegistryV1([
    pass,
    { ...pass, state: 'HOLD' },
    { ...pass, state: 'RESERVE' },
    { ...pass, state: 'EXCLUDE' },
  ], { researchCodeSha: 'c'.repeat(40) });
  assert.equal(registry.contract, FORMULA_PAPER_STRATEGY_REGISTRY_CONTRACT_V1);
  assert.equal(registry.entryCount, 1);
  assert.equal(registry.researchCodeSha, 'c'.repeat(40));
  assert.equal(registry.entries[0].researchCodeSha, 'c'.repeat(40));
  assert.equal(registry.entries[0].paperState, 'REGISTERED_WAITING_FUTURE_SIGNAL');
  assert.equal(registry.entries[0].futureSignalRequired, true);
  assert.equal(registry.entries[0].canonicalPaperAdmissionRequired, true);
  assert.equal(registry.entries[0].directTradeOnBacktestPass, false);
  assert.equal(registry.entries[0].executionAuthority, 'NONE');
  assert.deepEqual(registry.rejectedSourceStates, ['HOLD', 'RESERVE', 'EXCLUDE']);
  assert.equal(registry.realOrder, false);
});

test('queue persists immutable audit results and repeated processing is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'formula-auto-backtest-'));
  const inbox = join(root, 'formula-backtest', 'inbox');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(inbox, { recursive: true }));
  await writeFile(join(inbox, 'candidate.json'), JSON.stringify(queueItem()), { encoding: 'utf8', mode: 0o600 });

  const first = await processFormulaAutoBacktestQueueV1({ stateRoot: root, researchCodeSha: 'd'.repeat(40) });
  assert.equal(first.scanned, 1);
  assert.equal(first.counts.HOLD, 1);
  assert.equal(first.deletionAllowed, false);
  assert.equal(first.executionAuthority, 'NONE');
  assert.equal(first.paperRegisteredCount, 0);
  const paperRegistry = JSON.parse(await readFile(join(root, 'latest', 'formula-paper-strategy-registry.json'), 'utf8'));
  assert.equal(paperRegistry.contract, FORMULA_PAPER_STRATEGY_REGISTRY_CONTRACT_V1);
  assert.equal(paperRegistry.entryCount, 0);
  assert.equal(paperRegistry.researchCodeSha, 'd'.repeat(40));
  assert.equal(paperRegistry.executionAuthority, 'NONE');

  const resultFiles = (await readdir(join(root, 'formula-backtest', 'results'))).filter((name) => name.endsWith('.json'));
  assert.equal(resultFiles.length, 1);
  const stored = JSON.parse(await readFile(join(root, 'formula-backtest', 'results', resultFiles[0]), 'utf8'));
  assert.equal(stored.retainedForAudit, true);
  assert.equal(stored.deleted, false);
  assert.equal(stored.realOrder, false);

  const second = await processFormulaAutoBacktestQueueV1({ stateRoot: root, researchCodeSha: 'd'.repeat(40) });
  assert.equal(second.scanned, 1);
  const repeatedFiles = (await readdir(join(root, 'formula-backtest', 'results'))).filter((name) => name.endsWith('.json'));
  assert.deepEqual(repeatedFiles, resultFiles);
});

test('bounded queue rotates across older files without starvation and preserves durable results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'formula-auto-backtest-rotation-'));
  const inbox = join(root, 'formula-backtest', 'inbox');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(inbox, { recursive: true }));
  const oldItem = queueItem();
  const newItem = queueItem();
  newItem.queuedAt = new Date(Date.now() + 1000).toISOString();
  await writeFile(join(inbox, 'a-old.json'), JSON.stringify(oldItem));
  await writeFile(join(inbox, 'z-new.json'), JSON.stringify(newItem));
  const sha = 'e'.repeat(40);
  const first = await processFormulaAutoBacktestQueueV1({ stateRoot: root, maximumItems: 1, researchCodeSha: sha });
  assert.equal(first.scanned, 1);
  assert.equal(first.inboxCount, 2);
  assert.equal(first.lastProcessedFileName, 'a-old.json');
  const next = await processFormulaAutoBacktestQueueV1({ stateRoot: root, maximumItems: 1, researchCodeSha: sha });
  assert.equal(next.scanned, 1);
  assert.equal(next.lastProcessedFileName, 'z-new.json');
  assert.equal((await readdir(join(root, 'formula-backtest', 'results'))).length, 2);
  const replay = await processFormulaAutoBacktestQueueV1({ stateRoot: root, maximumItems: 1, researchCodeSha: sha });
  assert.equal(replay.lastProcessedFileName, 'a-old.json');
  assert.equal((await readdir(join(root, 'formula-backtest', 'results'))).length, 2);
});

test('unattested OOS or cost stage claims in TRAIN queue cannot create a Paper PASS', async () => {
  const item = queueItem();
  item.dataset.stageEvidence = {
    oos: { status: 'PASS', value: 999 },
    walkForward: { status: 'PASS', value: 999 },
    costStress: { status: 'PASS', value: 999 },
  };
  const result = await evaluateFormulaAutoBacktestQueueItemV1(item);
  assert.equal(result.state, 'EXCLUDE');
  assert.equal(result.reason, 'FORMULA_QUEUE_UNATTESTED_STAGE_EVIDENCE_FORBIDDEN');
  assert.equal(result.tournament, null);
});

test('invalid batch size fails rather than silently dropping queued candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'formula-auto-backtest-limit-'));
  await assert.rejects(
    processFormulaAutoBacktestQueueV1({ stateRoot: root, maximumItems: 0 }),
    /FORMULA_QUEUE_BATCH_LIMIT_INVALID/,
  );
  await assert.rejects(
    processFormulaAutoBacktestQueueV1({ stateRoot: root, maximumItems: 51 }),
    /FORMULA_QUEUE_BATCH_LIMIT_INVALID/,
  );
});


test('clock-skew tolerance never admits candles or periods occurring in the actual future', async () => {
  const itemWithFutureCandle = queueItem();
  itemWithFutureCandle.queuedAt = new Date(Date.now() + 120_000).toISOString();
  itemWithFutureCandle.dataset.backtestInput.candles.at(-1).timestamp = Date.now() + 60_000;
  const futureCandle = await evaluateFormulaAutoBacktestQueueItemV1(itemWithFutureCandle);
  assert.equal(futureCandle.state, 'EXCLUDE');
  assert.equal(futureCandle.reason, 'FORMULA_QUEUE_CANDLE_TIME_INVALID_OR_FUTURE');
  const itemWithFutureWindow = queueItem();
  itemWithFutureWindow.queuedAt = new Date(Date.now() + 120_000).toISOString();
  itemWithFutureWindow.dataset.period.endTime = Date.now() + 60_000;
  const futureWindow = await evaluateFormulaAutoBacktestQueueItemV1(itemWithFutureWindow);
  assert.equal(futureWindow.state, 'EXCLUDE');
  assert.equal(futureWindow.reason, 'FORMULA_QUEUE_PERIOD_INVALID_OR_FUTURE');
});

test('forged cached PASS and substituted item digest never become Paper candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'formula-auto-backtest-cache-integrity-'));
  const inbox = join(root, 'formula-backtest', 'inbox');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(inbox, { recursive: true }));
  await writeFile(join(inbox, 'candidate.json'), JSON.stringify(queueItem()));
  const researchCodeSha = '8'.repeat(40);
  const first = await processFormulaAutoBacktestQueueV1({ stateRoot: root, researchCodeSha });
  assert.equal(first.paperRegisteredCount, 0);
  const [resultFile] = (await readdir(join(root, 'formula-backtest', 'results'))).filter((name) => name.endsWith('.json'));
  assert.ok(resultFile);
  const resultPath = join(root, 'formula-backtest', 'results', resultFile);
  const original = JSON.parse(await readFile(resultPath, 'utf8'));

  for (const counterfeit of [
    { ...original, state: 'PASS', researchSurvivorCount: 1 },
    { ...original, itemDigest: 'f'.repeat(64) },
    { ...original, executionAuthority: 'LIVE', liveTrading: true },
  ]) {
    await writeFile(resultPath, JSON.stringify(counterfeit));
    await assert.rejects(
      processFormulaAutoBacktestQueueV1({ stateRoot: root, researchCodeSha }),
      /FORMULA_QUEUE_CACHED_RESULT_UNSAFE/,
    );
    const registry = JSON.parse(await readFile(join(root, 'latest', 'formula-paper-strategy-registry.json'), 'utf8'));
    assert.equal(registry.entryCount, 0);
    assert.equal(registry.executionAuthority, 'NONE');
  }
  await writeFile(resultPath, JSON.stringify(original));
  const repeated = await processFormulaAutoBacktestQueueV1({ stateRoot: root, researchCodeSha });
  assert.equal(repeated.counts.HOLD, 1);
  assert.equal(repeated.paperRegisteredCount, 0);
});

test('cached registry cannot disable future signal and canonical Paper admission guards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'formula-auto-backtest-registry-integrity-'));
  const inbox = join(root, 'formula-backtest', 'inbox');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(inbox, { recursive: true }));
  await writeFile(join(inbox, 'candidate.json'), JSON.stringify(queueItem()));
  const researchCodeSha = '7'.repeat(40);
  await processFormulaAutoBacktestQueueV1({ stateRoot: root, researchCodeSha });
  const registryPath = join(root, 'latest', 'formula-paper-strategy-registry.json');
  const original = JSON.parse(await readFile(registryPath, 'utf8'));
  const manipulated = {
    source: 'FORMULA_AUTO_BACKTEST_PASS',
    registryId: 'a'.repeat(64),
    itemDigest: 'b'.repeat(64),
    researchCodeSha,
    paperState: 'REGISTERED_WAITING_FUTURE_SIGNAL',
    futureSignalRequired: false,
    freshPublicEvidenceRequired: true,
    canonicalPaperAdmissionRequired: true,
    simulationAuthorityRequired: true,
    enabledForPaperEvaluation: true,
    retainedForAudit: true,
    liveTrading: false,
    autoTrading: false,
    realOrder: false,
    privateTradingApi: false,
    directTradeOnBacktestPass: false,
    executionAuthority: 'NONE',
  };
  await writeFile(registryPath, JSON.stringify({ ...original, entries: [manipulated], entryCount: 1 }));
  await assert.rejects(
    processFormulaAutoBacktestQueueV1({ stateRoot: root, researchCodeSha }),
    /FORMULA_QUEUE_PRIOR_REGISTRY_ENTRY_UNSAFE/,
  );
  await writeFile(registryPath, JSON.stringify(original));
  const replay = await processFormulaAutoBacktestQueueV1({ stateRoot: root, researchCodeSha });
  assert.equal(replay.paperRegisteredCount, 0);
});
