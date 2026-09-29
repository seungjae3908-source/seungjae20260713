import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildResearchOverview, createResearchDashboardServer } from '../server.mjs';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function reportDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function v3Summary(overrides = {}) {
  const body = {
    schemaVersion: 'public-forward-liquidity-v3-authoritative-independence-summary-v1',
    producerSha: '1'.repeat(40),
    upstreamIngestRunId: '33935833024',
    upstreamIngestArtifactId: '9960130145',
    upstreamIngestArtifactDigest: '2'.repeat(64),
    sourceInventoryDigest: '3'.repeat(64),
    targetSlotIndex: 48,
    genuineScheduledSlotN: 15,
    rawAcceptedN: 335,
    effectiveIndependentN: 15,
    independentBuyN: 10,
    independentSellN: 5,
    independenceAuditDigest: '4'.repeat(64),
    independentSplitSourceDigest: '5'.repeat(64),
    v3IndependentSplitIndexDigest: '6'.repeat(64),
    frozenSplitCounts: {
      TRAIN: 15,
      TRAIN_BUY: 10,
      TRAIN_SELL: 5,
      VALIDATION: 0,
      VALIDATION_BUY: 0,
      VALIDATION_SELL: 0,
      OOS: 0,
      OOS_BUY: 0,
      OOS_SELL: 0,
    },
    frozenV3SplitIndexPresent: true,
    v2SplitReceiptPresent: false,
    oosOutcomeCredit: 0,
    calibrationArtifactProduced: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceComplete: 0,
    executionAuthority: 'NONE',
    ...overrides,
  };
  return { ...body, reportDigest: reportDigest(body) };
}

function candidatePerformance(overrides = {}) {
  const candidateId = `phase3-candidate:sha256:${'7'.repeat(64)}`;
  const parameterDigest = '8'.repeat(64);
  return {
    schemaVersion: 'frozen-candidate-performance-reader-v1',
    status: 'PRESENT',
    FIRST_ZERO: 'FULL_COST_EVIDENCE_NOT_READY',
    reason: 'FULL_COST_EVIDENCE_NOT_READY',
    candidateId,
    strategyId: 'strategy-alpha',
    freezeTimestamp: '2026-09-13T00:00:00.000Z',
    identity14Verified: true,
    identity: {
      candidateId, strategyFamily: 'trend', strategyId: 'strategy-alpha', strategyVersion: 'v1',
      parameterHash: parameterDigest, parameterDigest, researchCodeSha: '9'.repeat(40),
      costPolicyVersion: 'cost-v1', executionPolicyVersion: 'paper-v1', market: 'CRYPTO_FUTURES',
      provider: 'bitget', symbol: 'BTCUSDT', timeframe: '15m', sidePolicy: 'LONG', accountMode: 'PAPER',
    },
    provenance: {
      evidenceClass: 'PRODUCTION_AUTHORITATIVE', sourceOwner: 'phase4-existing-owner-runtime-caller-v1',
      fixture: false, synthetic: false, replay: false, backfill: false, manual: false,
    },
    fullCostEvidence: {
      fullCostReady: false,
      components: Object.fromEntries(['commission', 'tax', 'spread', 'slippage', 'funding', 'latency', 'liquidityImpact', 'partialFillImpact']
        .map((key) => [key, { state: 'UNKNOWN', valuePercent: null, provenance: null }])),
    },
    effectiveIndependentMarketN: 15,
    candidateMatchedN: 3,
    LONG_SIGNAL_N: 1,
    SHORT_SIGNAL_N: 1,
    NO_TRADE_N: 1,
    Entry_N: 1,
    Position_N: 1,
    PositionObservation_N: 2,
    Settlement_N: 1,
    TRAIN_N: 3,
    VALIDATION_N: 0,
    OOS_N: 0,
    WIN_N: 1,
    LOSS_N: 0,
    BREAKEVEN_N: 0,
    WIN_RATE: 1,
    AVG_WIN: 12,
    AVG_LOSS: null,
    PAYOFF_RATIO: null,
    GROSS_EXPECTANCY: 12,
    PF: null,
    MDD: 0,
    MFE: 2.1,
    MAE: -0.4,
    TIME_TO_EXIT: 60_000,
    Gross_PnL: 12,
    Net_PnL: null,
    FULL_COST_READY: false,
    NET_ALPHA_PROVEN: false,
    PROFITABILITY_PROVEN: false,
    TRAIN_DIAGNOSTIC_ONLY: true,
    VALIDATION_COMPLETE: false,
    OOS_COMPLETE: false,
    sampleCredit: 0,
    executionRealismCredit: 0,
    profitabilityCredit: 0,
    backfillCredit: 0,
    replayCredit: 0,
    syntheticCredit: 0,
    manualEconomicCredit: 0,
    executionAuthority: 'NONE',
    LIVE_TRADING: false,
    AUTO_TRADING: false,
    REAL_ORDER_ENABLED: false,
    PRIVATE_TRADING_API_ALLOWED: false,
    realOrderCount: 0,
    cancelCount: 0,
    amendCount: 0,
    transferCount: 0,
    withdrawalCount: 0,
    ...overrides,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'research-dashboard-'));
  await mkdir(join(root, 'latest'), { recursive: true });
  await mkdir(join(root, 'forward', 'paper', 'status'), { recursive: true });
  await mkdir(join(root, 'forward', 'paper', 'state'), { recursive: true });
  await mkdir(join(root, 'forward', 'liquidity'), { recursive: true });
  const now = Date.now();
  await writeFile(join(root, 'latest', 'forward.json'), JSON.stringify({
    status: 'complete', cycleId: 'cycle-1', researchSha: 'a'.repeat(40), generatedAt: now,
    concurrency: 1, taskCount: 2, successCount: 2, blockedDataCount: 0, failedCount: 0,
    results: [{ id: 'paper-forward', status: 'success', durationMs: 1000 }, { id: 'shadow-forward', status: 'success', durationMs: 2000 }],
  }));
  await writeFile(join(root, 'latest', 'temporal-crypto-futures.json'), JSON.stringify({
    schemaVersion: 'crypto-futures-temporal-public-collection-v1',
    generatedAt: now,
    researchSha: 'a'.repeat(40),
    status: 'complete',
    failedCount: 0,
    results: [
      { symbol: 'BTCUSDT', status: 'success', observedCount: 3, appendedCount: 2 },
      { symbol: 'ETHUSDT', status: 'success', observedCount: 3, appendedCount: 3 },
    ],
    observationCount: 42,
    ledgerDigest: 'c'.repeat(64),
    safety: {
      publicDataOnly: true,
      privateApi: false,
      liveTrading: false,
      realOrders: false,
      historicalCurrentValueBackfill: false,
      executionAuthority: 'NONE',
    },
  }));
  await writeFile(join(root, 'latest', 'research-factory.json'), JSON.stringify({
    schemaVersion: 1,
    contract: 'research-factory-runtime-status/v1',
    generatedAt: new Date(now).toISOString(),
    researchSha: 'a'.repeat(40),
    status: 'BLOCKED_POLICY_MISSING',
    firstZero: 'HUMAN_APPROVED_ADAPTIVE_POLICY_MISSING',
    policy: {
      present: false,
      valid: false,
      policyDigest: null,
      approvalEvidenceId: null,
      approvedAt: null,
    },
    dataFactory: { readyMarketCount: 0, blockedMarketCount: 4 },
    canonicalAdaptive: {
      readyProfileCount: null,
      blockedProfileCount: null,
      runtimeStatus: null,
      nextFirstZero: 'HUMAN_APPROVED_ADAPTIVE_POLICY_MISSING',
    },
    controlPlaneDigest: 'd'.repeat(64),
    diagnostic: null,
    safety: {
      runtimeExecutionAttempted: false,
      runtimeActivationAllowed: false,
      scheduleMutationAllowed: false,
      deploymentAllowed: false,
      databaseMutationAllowed: false,
      secretMutationAllowed: false,
      liveTrading: false,
      autoTrading: false,
      privateTradingApi: false,
      realOrder: false,
      profitabilityClaim: false,
      executionAuthority: 'NONE',
    },
  }));
  await writeFile(join(root, 'forward', 'paper', 'status', 'runtime-status.json'), JSON.stringify({
    status: 'running', scheduleActive: true, allProvidersReady: true,
    publicForwardEvidenceAccumulating: true, paperTradeOutcomeAccumulating: true,
    privateRequestCount: 0, financialMutationCount: 0, orderCount: 0, liveTrading: false, orderAuthority: false,
    lanes: [{ market: 'KR', status: 'ready' }, { market: 'US', status: 'ready' }],
  }));
  await writeFile(join(root, 'forward', 'paper', 'state', 'recurring-paper-loop.json'), JSON.stringify({
    cycles: [{ id: 1 }], samples: [], positions: [{ id: 1 }], settlements: [{ id: 1 }, { id: 2 }],
  }));
  await writeFile(join(root, 'forward', 'shadow-summary.json'), JSON.stringify({ groups: {
    rule0: {
      total: 5, settled: 3, pending: 2,
      candidate: {
        predictionHealth: { collapsed: false }, macroF1: .51, balancedAccuracy: .55,
        perClass: { bullish: { recall: .4 }, neutral: { recall: .5 }, bearish: { recall: 0 } },
      },
    },
  }}));
  await writeFile(join(root, 'forward', 'shadow-state.json'), JSON.stringify({
    bucket: { records: [{ status: 'settled' }, { status: 'settled' }, { status: 'pending' }] },
    groups: {
      'crypto-futures-15m': {
        canonicalEvidence: {
          handoff: {
            strategyHealthHandoff: {
              schemaVersion: 'prediction-lab-strategy-health-shadow-handoff-v1',
              strategyIdentityDigest: 'a'.repeat(64),
              evidenceDigest: 'b'.repeat(64),
              executionAuthority: 'NONE',
            },
          },
        },
      },
    },
  }));
  await writeFile(
    join(root, 'forward', 'liquidity', 'v3-authoritative-independence-summary.json'),
    JSON.stringify(v3Summary()),
  );
  await writeFile(
    join(root, 'forward', 'paper', 'status', 'candidate-performance.json'),
    JSON.stringify(candidatePerformance()),
  );
  return root;
}

test('overview exposes only summarized read-only research evidence', async () => {
  const root = await fixture();
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.safety.readOnlyDashboard, true);
  assert.equal(overview.safety.authorityEvidenceComplete, true);
  assert.equal(overview.safety.forbiddenAuthorityObserved, false);
  assert.equal(overview.paper.runtime.privateRequestCount, 0);
  assert.equal(overview.paper.runtime.liveTrading, false);
  assert.equal(overview.paper.ledger.settlementCount, 2);
  assert.equal(overview.shadow.records.settledRecords, 2);
  assert.equal(overview.shadow.groups[0].collapsed, false);
  assert.equal(overview.shadow.groups[0].bearRecall, 0);
  assert.equal(overview.shadow.canonicalHandoffs.length, 1);
  assert.equal(overview.shadow.canonicalHandoffs[0].group, 'crypto-futures-15m');
  assert.equal(overview.shadow.canonicalHandoffs[0].handoff.evidenceDigest, 'b'.repeat(64));
  assert.equal(overview.research.liquidityIndependence.status, 'PRESENT');
  assert.equal(overview.research.liquidityIndependence.effectiveIndependentN, 15);
  assert.equal(overview.research.liquidityIndependence.independentBuyN, 10);
  assert.equal(overview.research.liquidityIndependence.independentSellN, 5);
  assert.equal(overview.research.liquidityIndependence.frozenSplitCounts.TRAIN, 15);
  assert.equal(overview.research.liquidityIndependence.frozenSplitCounts.OOS, 0);
  assert.equal(overview.paper.candidatePerformance.status, 'PRESENT');
  assert.equal(overview.paper.candidatePerformance.effectiveIndependentMarketN, 15);
  assert.equal(overview.paper.candidatePerformance.candidateMatchedN, 3);
  assert.equal(overview.paper.candidatePerformance.Entry_N, 1);
  assert.equal(overview.paper.candidatePerformance.Position_N, 1);
  assert.equal(overview.paper.candidatePerformance.Settlement_N, 1);
  assert.equal(overview.paper.candidatePerformance.Net_PnL, null);
  assert.equal(overview.paper.candidatePerformance.PROFITABILITY_PROVEN, false);
  assert.deepEqual(overview.paper.candidatePerformance.promotionIdentity, {
    candidateId: `phase3-candidate:sha256:${'7'.repeat(64)}`,
    strategyId: 'strategy-alpha',
    strategyVersion: 'v1',
    parameterHash: '8'.repeat(64),
    researchCodeSha: '9'.repeat(40),
    market: 'CRYPTO_FUTURES',
    timeframe: '15m',
    sidePolicy: 'LONG',
    accountMode: 'PAPER',
    costPolicyVersion: 'cost-v1',
    executionPolicyVersion: 'paper-v1',
  });
  assert.equal(Object.hasOwn(overview.paper.candidatePerformance.promotionIdentity, 'provider'), false);
  assert.equal(Object.hasOwn(overview.paper.candidatePerformance.promotionIdentity, 'symbol'), false);
  assert.equal(JSON.stringify(overview.paper.candidatePerformance.promotionIdentity).includes('/var/'), false);
  assert.equal(overview.dataFactory.temporalCryptoFutures.present, true);
  assert.equal(overview.dataFactory.temporalCryptoFutures.status, 'complete');
  assert.equal(overview.dataFactory.temporalCryptoFutures.observationCount, 42);
  assert.equal(overview.dataFactory.temporalCryptoFutures.failedCount, 0);
  assert.equal(overview.dataFactory.temporalCryptoFutures.results[0].symbol, 'BTCUSDT');
  assert.equal(Object.hasOwn(overview.dataFactory.temporalCryptoFutures.results[0], 'error'), false);
  assert.equal(overview.factory.present, true);
  assert.equal(overview.factory.status, 'BLOCKED_POLICY_MISSING');
  assert.equal(overview.factory.firstZero, 'HUMAN_APPROVED_ADAPTIVE_POLICY_MISSING');
  assert.equal(overview.factory.policyPresent, false);
  assert.equal(overview.factory.readyMarketCount, 0);
  assert.equal(overview.factory.blockedMarketCount, 4);
  assert.equal(overview.factory.readyProfileCount, null);
  assert.equal(overview.factory.controlPlaneDigest, 'd'.repeat(64));
  assert.equal(overview.profitability.proven, false);
});

test('missing Factory runtime summary stays MISSING without fabricating policy or readiness counts', async () => {
  const root = await fixture();
  await rm(join(root, 'latest', 'research-factory.json'));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.factory.present, false);
  assert.equal(overview.factory.status, 'MISSING');
  assert.equal(overview.factory.policyPresent, null);
  assert.equal(overview.factory.readyMarketCount, null);
  assert.equal(overview.factory.readyProfileCount, null);
});

test('unsafe Factory runtime status fails closed and leaks no diagnostic text or partial counts', async () => {
  const root = await fixture();
  const path = join(root, 'latest', 'research-factory.json');
  const status = JSON.parse(await readFile(path, 'utf8'));
  status.safety.runtimeExecutionAttempted = true;
  status.diagnostic = 'secret internal runtime diagnostic';
  await writeFile(path, JSON.stringify(status));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.research.status, 'attention');
  assert.equal(overview.factory.present, true);
  assert.equal(overview.factory.status, 'INVALID');
  assert.equal(overview.factory.readyMarketCount, null);
  assert.equal(overview.factory.controlPlaneDigest, null);
  assert.equal(JSON.stringify(overview).includes('secret internal runtime diagnostic'), false);
});

test('missing temporal collector summary stays explicit MISSING without inventing zero observations', async () => {
  const root = await fixture();
  await rm(join(root, 'latest', 'temporal-crypto-futures.json'));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.dataFactory.temporalCryptoFutures.present, false);
  assert.equal(overview.dataFactory.temporalCryptoFutures.status, 'MISSING');
  assert.equal(overview.dataFactory.temporalCryptoFutures.observationCount, null);
  assert.equal(overview.dataFactory.temporalCryptoFutures.failedCount, null);
});

test('unsafe or inconsistent temporal summary fails closed and leaks no provider error text', async () => {
  const root = await fixture();
  const path = join(root, 'latest', 'temporal-crypto-futures.json');
  const summary = JSON.parse(await readFile(path, 'utf8'));
  summary.safety.privateApi = true;
  summary.results[0].error = 'secret provider diagnostic';
  await writeFile(path, JSON.stringify(summary));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.research.status, 'attention');
  assert.equal(overview.dataFactory.temporalCryptoFutures.present, true);
  assert.equal(overview.dataFactory.temporalCryptoFutures.status, 'INVALID');
  assert.equal(overview.dataFactory.temporalCryptoFutures.observationCount, null);
  assert.equal(JSON.stringify(overview).includes('secret provider diagnostic'), false);
});

test('partial temporal symbol failure is visible as attention without exposing raw errors', async () => {
  const root = await fixture();
  const path = join(root, 'latest', 'temporal-crypto-futures.json');
  const summary = JSON.parse(await readFile(path, 'utf8'));
  summary.status = 'partial_failure';
  summary.failedCount = 1;
  summary.results[1] = { symbol: 'ETHUSDT', status: 'failed', observedCount: 0, appendedCount: 0, error: 'temporary upstream failure' };
  await writeFile(path, JSON.stringify(summary));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.research.status, 'attention');
  assert.equal(overview.dataFactory.temporalCryptoFutures.status, 'partial_failure');
  assert.equal(overview.dataFactory.temporalCryptoFutures.failedCount, 1);
  assert.equal(JSON.stringify(overview).includes('temporary upstream failure'), false);
});

test('missing candidate performance remains UNKNOWN rather than borrowing market N or ledger totals', async () => {
  const root = await fixture();
  await rm(join(root, 'forward', 'paper', 'status', 'candidate-performance.json'));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.paper.candidatePerformance.status, 'MISSING');
  assert.equal(overview.paper.candidatePerformance.candidateMatchedN, null);
  assert.equal(overview.paper.candidatePerformance.Entry_N, null);
  assert.equal(overview.paper.candidatePerformance.Settlement_N, null);
  assert.equal(overview.paper.candidatePerformance.Gross_PnL, null);
  assert.equal(overview.paper.candidatePerformance.Net_PnL, null);
  assert.equal(overview.research.liquidityIndependence.effectiveIndependentN, 15);
});

test('candidate performance authority escalation invalidates every economic metric', async () => {
  const root = await fixture();
  const path = join(root, 'forward', 'paper', 'status', 'candidate-performance.json');
  await writeFile(path, JSON.stringify(candidatePerformance({ PROFITABILITY_PROVEN: true })));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.research.status, 'attention');
  assert.equal(overview.paper.candidatePerformance.status, 'INVALID');
  assert.equal(overview.paper.candidatePerformance.candidateMatchedN, null);
  assert.equal(overview.paper.candidatePerformance.Gross_PnL, null);
  assert.equal(overview.paper.candidatePerformance.PROFITABILITY_PROVEN, false);
});

test('candidate performance fixture provenance and impossible lifecycle fail closed', async () => {
  const root = await fixture();
  const path = join(root, 'forward', 'paper', 'status', 'candidate-performance.json');
  await writeFile(path, JSON.stringify(candidatePerformance({ Position_N: 2 })));
  let candidate = (await buildResearchOverview({ stateRoot: root })).paper.candidatePerformance;
  assert.equal(candidate.status, 'INVALID');
  assert.equal(candidate.Position_N, null);

  await writeFile(path, JSON.stringify(candidatePerformance({
    provenance: { ...candidatePerformance().provenance, sourceOwner: 'test-fixture-loader' },
  })));
  candidate = (await buildResearchOverview({ stateRoot: root })).paper.candidatePerformance;
  assert.equal(candidate.status, 'INVALID');
  assert.equal(candidate.candidateMatchedN, null);
});

test('missing V3 independence summary stays missing instead of becoming historical seven or zero', async () => {
  const root = await fixture();
  await rm(join(root, 'forward', 'liquidity', 'v3-authoritative-independence-summary.json'));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.research.liquidityIndependence.present, false);
  assert.equal(overview.research.liquidityIndependence.status, 'MISSING');
  assert.equal(overview.research.liquidityIndependence.effectiveIndependentN, null);
  assert.equal(overview.research.liquidityIndependence.independentBuyN, null);
  assert.equal(overview.research.liquidityIndependence.independentSellN, null);
});

test('tampered V3 independence summary is invalidated and cannot leak partial counts', async () => {
  const root = await fixture();
  const path = join(root, 'forward', 'liquidity', 'v3-authoritative-independence-summary.json');
  const summary = JSON.parse(await readFile(path, 'utf8'));
  summary.effectiveIndependentN = 7;
  await writeFile(path, JSON.stringify(summary));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.research.status, 'attention');
  assert.equal(overview.research.liquidityIndependence.present, true);
  assert.equal(overview.research.liquidityIndependence.status, 'INVALID');
  assert.equal(overview.research.liquidityIndependence.effectiveIndependentN, null);
});

test('digest-valid downstream authority escalation is still rejected', async () => {
  const root = await fixture();
  const path = join(root, 'forward', 'liquidity', 'v3-authoritative-independence-summary.json');
  await writeFile(path, JSON.stringify(v3Summary({ fullCostReady: true })));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.research.liquidityIndependence.status, 'INVALID');
  assert.equal(overview.research.liquidityIndependence.fullCostReady, null);
  assert.equal(overview.profitability.proven, false);
});

test('missing runtime safety evidence stays missing instead of becoming zero or false', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forward', 'paper', 'status', 'runtime-status.json'), JSON.stringify({
    status: 'running', scheduleActive: true, allProvidersReady: true,
    publicForwardEvidenceAccumulating: true, paperTradeOutcomeAccumulating: true,
    lanes: [{ market: 'KR', status: 'ready' }],
  }));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.paper.runtime.privateRequestCount, null);
  assert.equal(overview.paper.runtime.financialMutationCount, null);
  assert.equal(overview.paper.runtime.orderCount, null);
  assert.equal(overview.paper.runtime.liveTrading, null);
  assert.equal(overview.paper.runtime.orderAuthority, null);
  assert.equal(overview.paper.runtime.safetyEvidenceComplete, false);
  assert.equal(overview.safety.authorityEvidenceComplete, false);
  assert.equal(overview.safety.forbiddenAuthorityObserved, false);
  assert.equal(overview.research.status, 'safety_evidence_incomplete');
});

test('missing ledger and shadow arrays stay missing instead of becoming zero', async () => {
  const root = await fixture();
  await writeFile(join(root, 'forward', 'paper', 'state', 'recurring-paper-loop.json'), JSON.stringify({ version: 1 }));
  await writeFile(join(root, 'forward', 'shadow-state.json'), JSON.stringify({ bucket: { status: 'empty-shape' } }));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.paper.ledger.cycleCount, null);
  assert.equal(overview.paper.ledger.positionCount, null);
  assert.equal(overview.paper.ledger.settlementCount, null);
  assert.equal(overview.shadow.records.totalRecords, null);
  assert.equal(overview.shadow.records.settledRecords, null);
  assert.equal(overview.shadow.records.pendingRecords, null);
});

test('dashboard refuses write methods', async () => {
  const root = await fixture();
  const server = createResearchDashboardServer({ stateRoot: root, publicRoot: join(process.cwd(), 'public') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/research/overview`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal((await response.json()).error, 'read_only_dashboard');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('health endpoint declares zero trading authority', async () => {
  const root = await fixture();
  const server = createResearchDashboardServer({ stateRoot: root, publicRoot: join(process.cwd(), 'public') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.readOnly, true);
    assert.equal(body.liveTrading, false);
    assert.equal(body.privateApi, false);
    assert.equal(body.orderAuthority, false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('development diagnostic Factory blockers remain visible without leaking diagnostic text', async () => {
  const root = await fixture();
  const path = join(root, 'latest', 'research-factory.json');
  const value = JSON.parse(await readFile(path, 'utf8'));
  Object.assign(value, {
    status: 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING',
    firstZero: 'DEVELOPMENT_DIAGNOSTIC_REQUIRED',
    controlPlaneDigest: null,
    diagnostic: 'missingProfileCount=1;profiles=CRYPTO_FUTURES:SHORT',
  });
  Object.assign(value.policy, {
    present: true,
    valid: true,
    policyDigest: 'e'.repeat(64),
  });
  Object.assign(value.canonicalAdaptive, {
    readyProfileCount: 1,
    blockedProfileCount: 11,
    runtimeStatus: 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING',
    nextFirstZero: 'DEVELOPMENT_DIAGNOSTIC_REQUIRED',
  });
  await writeFile(path, JSON.stringify(value));
  const overview = await buildResearchOverview({ stateRoot: root });
  assert.equal(overview.factory.status, 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING');
  assert.equal(overview.factory.firstZero, 'DEVELOPMENT_DIAGNOSTIC_REQUIRED');
  assert.equal(overview.factory.readyProfileCount, 1);
  assert.equal(overview.factory.blockedProfileCount, 11);
  assert.equal(JSON.stringify(overview).includes('missingProfileCount'), false);
  assert.equal(JSON.stringify(overview).includes('CRYPTO_FUTURES:SHORT'), false);
});
