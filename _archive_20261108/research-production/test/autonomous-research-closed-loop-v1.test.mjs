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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentLockIdentityV1 } from '../../market-prediction-lab/src/formula-auto-backtest-queue-v1.js';
import { processFormulaAutoBacktestQueueV1 } from '../../market-prediction-lab/src/formula-auto-backtest-queue-v1.js';
import { buildTaskPlan } from '../src/engine.mjs';
import { formulaBacktestProducerOutboxV1, formulaBacktestQueueRootV1 } from '../src/autonomous-research-closed-loop-v1.mjs';
import { createResearchFailureObservationV1 } from '../../market-prediction-lab/src/autonomous-alpha-factory-phase3-v1.js';
import { appendResearchFailureObservationV1, createResearchFailureMemoryV1 } from '../src/research-failure-memory.mjs';


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

// ---------- formula queue + durable memory contract (moved from formula-queue-durable-contract-v1.test.mjs) ----------
// Block-scoped so its helpers never clash with the tests above.
{
const LAB = resolve(dirname(fileURLToPath(import.meta.url)), '../../market-prediction-lab');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const OBSERVED_AT = '2026-10-14T00:10:00.000Z';

function candles() {
  const start = Date.parse('2020-09-01T00:00:00.000Z');
  return Array.from({ length: 220 }, (_, index) => {
    const base = 200 + index * 0.05 + Math.sin(index / 4) * 2;
    return { timestamp: start + index * 15 * 60_000, open: base, high: base + 1.2, low: base - 1.2,
      close: base + Math.sin(index / 3) * 0.3, volume: index % 9 === 0 ? 2_800 : 1_000 + index };
  });
}

function queueItem() {
  const formula = compiledMomentumFormula().formula;
  const rows = candles();
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
        market: formula.market, symbol: 'AAPL', timeframe: formula.timeframe, side: 'long', candles: rows,
        initialCapital: 10_000,
        riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 0.5, leverage: 1 },
        costModel: { entryFeeRate: 0.001, exitFeeRate: 0.001, taxRate: 0, slippageRate: 0.0005, spreadRate: 0.0002, latencyBars: 0, latencyDriftRate: 0 },
      },
      period: { startTime: rows[0].timestamp, endTime: rows.at(-1).timestamp, includeFinalHoldout: false },
    },
  };
}

function dossier(researchCodeSha, index = 2) {
  return createAutonomousResearchDossierV1({
    researchCodeSha,
    discoveredAt: `2026-10-14T00:0${index}:00.000Z`,
    sourceEvidence: {
      sourceId: `github:public-strategy-${index}`,
      sourceType: 'GITHUB_OPEN_SOURCE',
      canonicalUrl: `https://github.com/example/research/blob/${'c'.repeat(40)}/strategy-${index}.py`,
      title: `Public strategy ${index}`,
      authors: [`Author ${index}`],
      publishedAt: '2026-01-01T00:00:00.000Z',
      retrievedAt: '2026-10-14T00:00:00.000Z',
      sourceRevision: 'c'.repeat(40),
      contentSha256: String(index).repeat(64),
      license: { status: 'GPL-3.0', canonicalUrl: `https://github.com/example/research/blob/${'c'.repeat(40)}/LICENSE`, contentSha256: 'f'.repeat(64) },
      rules: {
        entry: ['A public closed-candle condition is satisfied.'],
        exit: ['The public source defines an exit condition.'],
        risk: ['The source warns that results require independent testing.'],
        claimedPerformance: [],
        limitations: ['Test fixture proves orchestration only, not economic performance.'],
      },
      accessVerified: true,
      httpStatus: 200,
    },
    strategy: {
      strategyId: `public-strategy-${index}`,
      family: 'MOMENTUM_RVOL',
      classification: 'DECLARED_VARIANT',
      novelty: 'NOVEL_VARIANT',
      market: 'US_STOCK',
      timeframe: queueItem().formulaCandidate.timeframe,
      direction: 'LONG',
      transformations: ['Canonical ATR/target/time exits replace source-specific execution rules.'],
      unresolvedRules: [],
    },
    formulaQueueItem: queueItem(),
  });
}

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'formula-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function runForwardConsumer(task) {
  // Exactly the environment the hourly forward profile gives the child.
  return spawnSync(process.execPath, task.args, { cwd: LAB, encoding: 'utf8', env: { PATH: process.env.PATH, ...task.env } });
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

test('contract: producer outbox and forward consumer resolve the same release queue', async (t) => {
  const root = await tempRoot(t);
  const plan = buildTaskPlan({ profile: 'forward', stateRoot: root, researchSha: SHA_A, env: {} });
  const task = plan.find((row) => row.id === 'formula-backtest-queue');
  assert.equal(task.env.FORMULA_BACKTEST_STATE_ROOT, formulaBacktestQueueRootV1(root, SHA_A));

  // Producer stages, but the queue is "busy" this tick: input stays in the outbox.
  const row = dossier(SHA_A);
  await stageAutonomousResearchDossierV1({ stateRoot: root, dossier: row });
  let seenQueueRoot = null;
  const first = await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA_A, now: () => OBSERVED_AT,
    processQueue: async ({ stateRoot }) => { seenQueueRoot = stateRoot; throw new Error('FORMULA_QUEUE_BUSY'); } });
  assert.equal(seenQueueRoot, task.env.FORMULA_BACKTEST_STATE_ROOT, 'closed loop consumes the same root');
  assert.equal(first.deferredThisCycle, 1);
  const outbox = await readdir(formulaBacktestProducerOutboxV1(root, SHA_A));
  assert.deepEqual(outbox, [`${row.producerInput.itemDigest}.json`]);

  // The hourly forward consumer now picks the producer's record up.
  const run = runForwardConsumer(task);
  assert.notEqual(run.status, 1, run.stderr);
  const summary = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.notEqual(summary.stagedIntake.status, 'MISSING_PRODUCER_OUTBOX');
  assert.equal(summary.stagedIntake.imported, 1);
  assert.equal(summary.scanned, 1);
  const results = await readdir(join(formulaBacktestQueueRootV1(root, SHA_A), 'formula-backtest', 'results'));
  assert.deepEqual(results, [`${row.producerInput.itemDigest}.json`]);
  // Published for Paper and the dashboard.
  const published = JSON.parse(await readFile(join(root, 'latest', 'formula-backtest-queue.json'), 'utf8'));
  assert.equal(published.scanned, 1);
  assert.equal(published.counts.PASS + published.counts.HOLD + published.counts.RESERVE + published.counts.EXCLUDE, 1);

  // A restart of the consumer does not re-import or re-evaluate.
  const again = JSON.parse(runForwardConsumer(task).stdout.trim().split('\n').at(-1));
  assert.equal(again.stagedIntake.imported, 0);
  assert.equal(again.stagedIntake.alreadyQueued, 1);
  assert.equal((await readdir(join(formulaBacktestQueueRootV1(root, SHA_A), 'formula-backtest', 'results'))).length, 1);

  // The closed loop resumes the dossier from the consumer's cached result.
  const resumed = await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA_A, now: () => OBSERVED_AT });
  assert.equal(resumed.completedStrategyCount, 1);
  assert.equal(resumed.actualBacktestCount, 1);
});

async function lockFile(path, holder) {
  const self = await currentLockIdentityV1();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ ...self, token: 'held-token', acquiredAt: 1, ...holder }), { mode: 0o600 });
}

test('contract: a live queue holder is never taken over; the forward runner defers with exit 2 and publishes nothing', async (t) => {
  const root = await tempRoot(t);
  const plan = buildTaskPlan({ profile: 'forward', stateRoot: root, researchSha: SHA_A, env: {} });
  const task = plan.find((row) => row.id === 'formula-backtest-queue');
  const lock = join(task.env.FORMULA_BACKTEST_STATE_ROOT, 'formula-backtest', 'queue.lock');
  // This test process is alive: its lock must hold however old it is.
  await lockFile(lock, { acquiredAt: 0 });
  await assert.rejects(processFormulaAutoBacktestQueueV1({ stateRoot: task.env.FORMULA_BACKTEST_STATE_ROOT, researchCodeSha: SHA_A, lockWaitMs: 0 }),
    (error) => error.code === 'FORMULA_QUEUE_BUSY' && error.lockHolderState === 'ALIVE');
  const run = runForwardConsumer(task);
  assert.equal(run.status, 2, run.stderr);
  const summary = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(summary.status, 'DEFERRED_QUEUE_BUSY');
  assert.equal(summary.automationReadiness, 'BLOCKED_DATA_QUEUE_BUSY');
  assert.equal(summary.executionAuthority, 'NONE');
  await assert.rejects(readFile(join(root, 'latest', 'formula-backtest-queue.json'), 'utf8'), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, 'held-token', 'the holder lock is untouched');
});

test('contract: a crashed holder (pid gone, or pid reused by another process) is reclaimed; normal completion releases', async (t) => {
  const root = await tempRoot(t);
  const queueRoot = formulaBacktestQueueRootV1(root, SHA_A);
  const lock = join(queueRoot, 'formula-backtest', 'queue.lock');
  await lockFile(lock, { pid: 4_194_303, startTicks: '1' });
  const first = await processFormulaAutoBacktestQueueV1({ stateRoot: queueRoot, researchCodeSha: SHA_A, lockWaitMs: 0 });
  assert.equal(first.scanned, 0);
  await assert.rejects(readFile(lock, 'utf8'), { code: 'ENOENT' }, 'released after a normal run');
  // Same pid as a running process but a different start time: a recycled pid.
  await lockFile(lock, { startTicks: '1' });
  await processFormulaAutoBacktestQueueV1({ stateRoot: queueRoot, researchCodeSha: SHA_A, lockWaitMs: 0 });
  await assert.rejects(readFile(lock, 'utf8'), { code: 'ENOENT' });
});

test('contract: a lock from another host or an unknown boot is never reclaimed automatically', async (t) => {
  const root = await tempRoot(t);
  const queueRoot = formulaBacktestQueueRootV1(root, SHA_A);
  const lock = join(queueRoot, 'formula-backtest', 'queue.lock');
  for (const holder of [{ host: 'another-host', pid: 4_194_303 }, { bootId: null, pid: 4_194_303 }, { contract: undefined, host: undefined }]) {
    await lockFile(lock, holder);
    await assert.rejects(processFormulaAutoBacktestQueueV1({ stateRoot: queueRoot, researchCodeSha: SHA_A, lockWaitMs: 0 }),
      (error) => error.code === 'FORMULA_QUEUE_BUSY' && error.lockHolderState === 'UNKNOWN', JSON.stringify(holder));
  }
});

test('contract: an old-release producer record is never admitted into a new release queue', async (t) => {
  const root = await tempRoot(t);
  const row = dossier(SHA_A);
  await stageAutonomousResearchDossierV1({ stateRoot: root, dossier: row });
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA_A, now: () => OBSERVED_AT,
    processQueue: async () => { throw new Error('FORMULA_QUEUE_BUSY'); } });
  // Release B's consumer reads only release B's queue.
  const planB = buildTaskPlan({ profile: 'forward', stateRoot: root, researchSha: SHA_B, env: {} });
  const run = runForwardConsumer(planB.find((task) => task.id === 'formula-backtest-queue'));
  const summary = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(summary.stagedIntake.status, 'MISSING_PRODUCER_OUTBOX');
  assert.equal(summary.scanned, 0);
  assert.equal(summary.paperRegisteredCount, 0);
});

test('durable: failure memory and duplicate prevention survive a release change without rewriting old files', async (t) => {
  const root = await tempRoot(t);
  const row = dossier(SHA_A);
  // Release A records a real failure for this strategy identity (the legacy,
  // release-scoped layout written by the previous code).
  const releaseA = join(root, 'autonomous-research', 'releases', SHA_A);
  await mkdir(releaseA, { recursive: true, mode: 0o700 });
  const failure = createResearchFailureObservationV1({
    strategyIdentityDigest: row.strategy.strategyIdentityDigest,
    stage: 'HISTORICAL_BACKTEST', status: 'FAIL', failureCodes: ['INSUFFICIENT_SAMPLE'],
    observedAt: OBSERVED_AT, evidence: { itemDigest: row.producerInput.itemDigest },
  });
  const legacyMemory = appendResearchFailureObservationV1(createResearchFailureMemoryV1({ researchSha: SHA_A }), failure);
  const legacyText = `${JSON.stringify(legacyMemory, null, 2)}\n`;
  await writeFile(join(releaseA, 'failure-memory.json'), legacyText, { mode: 0o600 });

  // After the deploy, release B is offered the same strategy again.
  await stageAutonomousResearchDossierV1({ stateRoot: root, dossier: dossier(SHA_B) });
  let queueCalls = 0;
  const result = await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA_B, now: () => OBSERVED_AT,
    processQueue: async () => { queueCalls += 1; } });
  assert.equal(queueCalls, 0, 'the identity that failed in release A is not re-run');
  assert.equal(result.actualBacktestCount, 0);
  assert.ok(result.durableFailureObservationCount >= 1);
  const stateB = JSON.parse(await readFile(join(root, 'autonomous-research', 'releases', SHA_B, 'state.json'), 'utf8'));
  assert.deepEqual(stateB.records[0].lifecycle, ['DISCOVERED', 'DUPLICATE_BLOCKED']);
  const directive = JSON.parse(await readFile(join(root, 'latest', 'autonomous-research-next-directive.json'), 'utf8'));
  assert.ok(directive.failureCodes.includes('INSUFFICIENT_SAMPLE'));
  // Durable store exists; the legacy file was not rewritten.
  const durable = JSON.parse(await readFile(join(root, 'autonomous-research', 'durable', 'failure-memory.json'), 'utf8'));
  assert.equal(durable.observations.length, 1);
  assert.equal(sha256(await readFile(join(releaseA, 'failure-memory.json'), 'utf8')), sha256(legacyText));

  // A third release still sees it, from the durable store alone.
  const SHA_C = 'd'.repeat(40);
  await rm(join(releaseA, 'failure-memory.json'));
  await stageAutonomousResearchDossierV1({ stateRoot: root, dossier: dossier(SHA_C) });
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA_C, now: () => OBSERVED_AT,
    processQueue: async () => { queueCalls += 1; } });
  assert.equal(queueCalls, 0);
});

test('durable: a failure recorded through the operator ingest store blocks the same identity; a lock error is recognised by its code', async (t) => {
  const root = await tempRoot(t);
  const row = dossier(SHA_A);
  // bin/research-failure-memory-ingest.mjs writes here, outside any release.
  const ingestDir = join(root, 'failure-memory');
  await mkdir(ingestDir, { recursive: true, mode: 0o700 });
  const failure = createResearchFailureObservationV1({
    strategyIdentityDigest: row.strategy.strategyIdentityDigest,
    stage: 'HISTORICAL_BACKTEST', status: 'FAIL', failureCodes: ['INSUFFICIENT_SAMPLE'],
    observedAt: OBSERVED_AT, evidence: { itemDigest: row.producerInput.itemDigest },
  });
  const ingested = appendResearchFailureObservationV1(createResearchFailureMemoryV1({ researchSha: SHA_A }), failure);
  const ingestText = `${JSON.stringify(ingested, null, 2)}\n`;
  await writeFile(join(ingestDir, 'research-failure-memory.json'), ingestText, { mode: 0o600 });
  await stageAutonomousResearchDossierV1({ stateRoot: root, dossier: row });
  let queueCalls = 0;
  const result = await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA_A, now: () => OBSERVED_AT,
    processQueue: async () => { queueCalls += 1; } });
  assert.equal(queueCalls, 0, 'the ingested failure blocks the identity');
  assert.equal(result.durableFailureObservationCount, 1);
  assert.equal(sha256(await readFile(join(ingestDir, 'research-failure-memory.json'), 'utf8')), sha256(ingestText), 'ingest store never rewritten');

  // A busy queue signalled only through the error code (message differs) still defers.
  const other = dossier(SHA_A, 3);
  await stageAutonomousResearchDossierV1({ stateRoot: root, dossier: other });
  const deferred = await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA_A, now: () => OBSERVED_AT,
    processQueue: async () => { throw Object.assign(new Error('queue held by forward consumer'), { code: 'FORMULA_QUEUE_BUSY' }); } });
  assert.equal(deferred.deferredThisCycle, 1);
  assert.equal(deferred.actualBacktestCount, 0);
});

test('durable: an identity completed (not failed) by an earlier release is not re-run either', async (t) => {
  const root = await tempRoot(t);
  await stageAutonomousResearchDossierV1({ stateRoot: root, dossier: dossier(SHA_A) });
  const a = await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA_A, now: () => OBSERVED_AT });
  assert.equal(a.actualBacktestCount, 1);
  // Make release A's record a non-failure (BACKTEST_CANDIDATE) with no failure
  // memory anywhere, so only the prior-release completion can block it.
  const statePath = join(root, 'autonomous-research', 'releases', SHA_A, 'state.json');
  const stateA = JSON.parse(await readFile(statePath, 'utf8'));
  const records = stateA.records.map((record) => ({ ...record, disposition: 'BACKTEST_CANDIDATE' }));
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  const core = { schemaVersion: 1, contract: stateA.contract, researchCodeSha: SHA_A, createdAt: stateA.createdAt, updatedAt: stateA.updatedAt, records, safety: stateA.safety };
  await writeFile(statePath, JSON.stringify({ ...core, stateDigest: sha256(JSON.stringify(canonical(core))) }), { mode: 0o600 });
  for (const path of [join(root, 'autonomous-research', 'releases', SHA_A, 'failure-memory.json'), join(root, 'autonomous-research', 'durable', 'failure-memory.json')]) {
    await writeFile(path, JSON.stringify(createResearchFailureMemoryV1({ researchSha: SHA_A })), { mode: 0o600 });
  }
  await stageAutonomousResearchDossierV1({ stateRoot: root, dossier: dossier(SHA_B) });
  let queueCalls = 0;
  const b = await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA_B, now: () => OBSERVED_AT,
    processQueue: async () => { queueCalls += 1; } });
  assert.equal(queueCalls, 0);
  assert.equal(b.priorReleaseRecordCount, 1);
  const stateB = JSON.parse(await readFile(join(root, 'autonomous-research', 'releases', SHA_B, 'state.json'), 'utf8'));
  assert.equal(stateB.records[0].reason, 'COMPLETED_IN_PRIOR_RELEASE');
});

test('durable: a concurrent closed loop defers (nothing written) and the cycle reports a wait, not a failure', async (t) => {
  const root = await tempRoot(t);
  const lock = join(root, 'autonomous-research', 'durable', 'closed-loop.lock');
  await lockFile(lock, {});
  const deferred = await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA_A, now: () => OBSERVED_AT });
  assert.equal(deferred.status, 'DEFERRED_DURABLE_STATE_BUSY');
  assert.equal(deferred.lockHolderState, 'ALIVE');
  await assert.rejects(readFile(join(root, 'latest', 'autonomous-research-closed-loop.json'), 'utf8'), { code: 'ENOENT' });
  const { runAutonomousResearchCycleV2 } = await import('../src/autonomous-research-cycle-v2.mjs');
  const cycle = await runAutonomousResearchCycleV2({ stateRoot: root, researchCodeSha: SHA_A, env: {}, now: () => OBSERVED_AT, verifiedSourceCatalog: [],
    runShockLane: async () => ({ status: 'COMPLETE' }), runProviderLane: async () => ({ status: 'COMPLETE' }) });
  assert.equal(cycle.status, 'DEFERRED_DURABLE_STATE_BUSY');
  // A crashed holder is reclaimed and the loop runs.
  await lockFile(lock, { pid: 4_194_303, startTicks: '1' });
  const result = await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA_A, now: () => OBSERVED_AT });
  assert.equal(result.completedStrategyCount, 0);
  assert.equal(result.deferred, undefined);
  await assert.rejects(readFile(lock, 'utf8'), { code: 'ENOENT' });
});

test('coordinator treats a deferred closed loop as a wait (exit 75), never success or failure', async () => {
  const source = await readFile(new URL('../bin/autonomous-research-coordinator-v2.mjs', import.meta.url), 'utf8');
  assert.match(source, /'DEFERRED_DURABLE_STATE_BUSY'\]\.includes\(cycle\?\.status\)/u);
  assert.match(source, /process\.exitCode = failed \? 1 : unavailable \? 75 : 0/u);
});

test('durable: an identity that succeeded in an earlier release is blocked but stays a success; same-family new identities still run', async (t) => {
  const root = await tempRoot(t);
  await stageAutonomousResearchDossierV1({ stateRoot: root, dossier: dossier(SHA_A) });
  await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA_A, now: () => OBSERVED_AT });
  const statePath = join(root, 'autonomous-research', 'releases', SHA_A, 'state.json');
  const stateA = JSON.parse(await readFile(statePath, 'utf8'));
  const records = stateA.records.map((record) => ({ ...record, disposition: 'BACKTEST_CANDIDATE' }));
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  const core = { schemaVersion: 1, contract: stateA.contract, researchCodeSha: SHA_A, createdAt: stateA.createdAt, updatedAt: stateA.updatedAt, records, safety: stateA.safety };
  await writeFile(statePath, JSON.stringify({ ...core, stateDigest: sha256(JSON.stringify(canonical(core))) }), { mode: 0o600 });
  for (const path of [join(root, 'autonomous-research', 'releases', SHA_A, 'failure-memory.json'), join(root, 'autonomous-research', 'durable', 'failure-memory.json')]) {
    await writeFile(path, JSON.stringify(createResearchFailureMemoryV1({ researchSha: SHA_A })), { mode: 0o600 });
  }
  // Release B: the same identity again, plus a different identity of the same family.
  await stageAutonomousResearchDossierV1({ stateRoot: root, dossier: dossier(SHA_B, 2) });
  await stageAutonomousResearchDossierV1({ stateRoot: root, dossier: dossier(SHA_B, 3) });
  const queued = [];
  const b = await runAutonomousResearchClosedLoopV1({ stateRoot: root, researchCodeSha: SHA_B, now: () => OBSERVED_AT,
    processQueue: async (args) => { queued.push(args.stateRoot); } });
  assert.equal(queued.length, 1, 'the new same-family identity is still evaluated');
  const stateB = JSON.parse(await readFile(join(root, 'autonomous-research', 'releases', SHA_B, 'state.json'), 'utf8'));
  const blocked = stateB.records.find((record) => record.reason === 'COMPLETED_IN_PRIOR_RELEASE');
  assert.equal(blocked.disposition, 'DUPLICATE_BLOCKED');
  assert.deepEqual(blocked.blockedBy, { kind: 'PRIOR_RELEASE', priorOutcome: 'SUCCESS', priorDisposition: 'BACKTEST_CANDIDATE',
    priorReleaseSha: SHA_A, priorDossierDigest: records[0].dossierDigest });
  assert.equal(b.dispositions.IMPROVE, 0, 'a prior success is not counted as a failure');
  assert.equal(b.duplicateBlockedCount, 1);
  const directive = JSON.parse(await readFile(join(root, 'latest', 'autonomous-research-next-directive.json'), 'utf8'));
  assert.equal(directive.failedFamilies.includes('MOMENTUM_RVOL'), false, 'a succeeded family is not a failed family');
});

test('a deferred first loop followed by a completed second loop reports the completed outcome', async (t) => {
  const root = await tempRoot(t);
  const { runAutonomousResearchCycleV2 } = await import('../src/autonomous-research-cycle-v2.mjs');
  let calls = 0;
  const runLoop = async () => {
    calls += 1;
    if (calls === 1) return { status: 'DEFERRED_DURABLE_STATE_BUSY', deferred: true };
    return { discoveredStrategyCount: 1, completedStrategyCount: 1, formulaGeneratedCount: 1, actualBacktestCount: 1, paperRegisteredCount: 0,
      actualPaperEntryCount: 0, actualPaperExitCount: 0, failureObservationCount: 0, dispositions: { BACKTEST_CANDIDATE: 0, IMPROVE: 1, REJECT: 0 },
      continueResearch: true, waitingForFuturePaperSignalBlocksResearch: false };
  };
  const cycle = await runAutonomousResearchCycleV2({ stateRoot: root, researchCodeSha: SHA_A, env: {}, now: () => OBSERVED_AT, runLoop,
    runDiscovery: async () => ({ status: 'DOSSIER_STAGED', directiveConsumed: true, actualProviderCalls: {}, actualSourceFetches: {} }),
    runShockLane: async () => ({ status: 'COMPLETE' }), runProviderLane: async () => ({ status: 'COMPLETE' }) });
  assert.equal(calls, 2);
  assert.equal(cycle.status, 'COMPLETE');
  assert.equal(cycle.actualBacktestCount, 1);
});
}
