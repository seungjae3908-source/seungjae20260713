import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESEARCH_CENTER_READONLY_CONTRACT,
  sanitizeResearchCenterOverview,
  sanitizeMarketWatchReadback,
  sanitizeMarketWatchCadenceReadback,
} from './research-center-readonly-contract.service.ts';

const SHA = '1111111111111111111111111111111111111111';

function liquidityIndependence() {
  return {
    present: true,
    status: 'PRESENT',
    schemaVersion: 'public-forward-liquidity-v3-authoritative-independence-summary-v1',
    producerSha: SHA,
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
    oosOutcomeCredit: 0,
    calibrationArtifactProduced: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceComplete: 0,
    executionAuthority: 'NONE',
    reportDigest: '7'.repeat(64),
  };
}

function candidatePerformance() {
  return {
    present: true,
    status: 'PRESENT',
    schemaVersion: 'frozen-candidate-performance-reader-v1',
    FIRST_ZERO: 'FULL_COST_EVIDENCE_NOT_READY',
    reason: 'FULL_COST_EVIDENCE_NOT_READY',
    candidateId: `phase3-candidate:sha256:${'8'.repeat(64)}`,
    strategyId: 'strategy-alpha',
    freezeTimestamp: '2026-09-13T00:00:00.000Z',
    identity14Verified: true,
    promotionIdentity: {
      candidateId: `phase3-candidate:sha256:${'8'.repeat(64)}`,
      strategyId: 'strategy-alpha',
      strategyVersion: 'v1',
      parameterHash: '9'.repeat(64),
      researchCodeSha: SHA,
      market: 'CRYPTO_FUTURES',
      timeframe: '15m',
      sidePolicy: 'LONG',
      accountMode: 'PAPER',
      costPolicyVersion: 'internal-cost-v1',
      executionPolicyVersion: 'internal-execution-v1',
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
    executionAuthority: 'NONE',
  };
}

function validOverview() {
  return {
    schemaVersion: 'research-dashboard-overview-v1',
    generatedAt: 1_800_000_000_000,
    state: { present: true, latestCycleAt: 1_799_999_999_000 },
    safety: {
      readOnlyDashboard: true,
      liveTrading: false,
      privateApi: false,
      orderAuthority: false,
      authorityEvidenceComplete: true,
      forbiddenAuthorityObserved: false,
    },
    research: {
      status: 'collecting',
      failedTasks: 0,
      blockedDataTasks: 0,
      cycles: [{
        profile: 'forward',
        present: true,
        status: 'success',
        cycleId: 'cycle-1',
        researchSha: SHA,
        generatedAt: 1_799_999_999_000,
        concurrency: 1,
        taskCount: 1,
        successCount: 1,
        blockedDataCount: 0,
        failedCount: 0,
        tasks: [{ id: 'canonical-task', status: 'success', durationMs: 15, startedAt: null, endedAt: null, timedOut: false }],
      }],
      liquidityIndependence: liquidityIndependence(),
    },
    dataFactory: {
      temporalCryptoFutures: {
        present: true,
        status: 'complete',
        generatedAt: 1_799_999_999_500,
        researchSha: SHA,
        failedCount: 0,
        observationCount: 42,
        ledgerDigest: 'c'.repeat(64),
        results: [
          { symbol: 'BTCUSDT', status: 'success', observedCount: 3, appendedCount: 2 },
          { symbol: 'ETHUSDT', status: 'success', observedCount: 3, appendedCount: 3 },
        ],
      },
    },
    factory: {
      present: true,
      status: 'BLOCKED_POLICY_MISSING',
      generatedAt: 1_799_999_999_750,
      researchSha: SHA,
      firstZero: 'HUMAN_APPROVED_ADAPTIVE_POLICY_MISSING',
      policyPresent: false,
      policyValid: false,
      policyDigest: null,
      readyMarketCount: 0,
      blockedMarketCount: 4,
      readyProfileCount: null,
      blockedProfileCount: null,
      runtimeStatus: null,
      nextFirstZero: 'HUMAN_APPROVED_ADAPTIVE_POLICY_MISSING',
      controlPlaneDigest: 'd'.repeat(64),
    },
    paper: {
      runtime: {
        present: true,
        status: 'not_started',
        cycleId: null,
        scheduleActive: false,
        allProvidersReady: null,
        publicForwardEvidenceAccumulating: null,
        paperTradeOutcomeAccumulating: null,
        privateRequestCount: 0,
        financialMutationCount: 0,
        orderCount: 0,
        liveTrading: false,
        orderAuthority: false,
        safetyEvidenceComplete: true,
        lanes: [],
      },
      ledger: { present: true, cycleCount: 1, sampleCount: 0, positionCount: 0, settlementCount: 0 },
      candidatePerformance: candidatePerformance(),
    },
    shadow: {
      groups: [],
      records: { present: false, totalRecords: null, settledRecords: null, pendingRecords: null },
    },
    profitability: { proven: false, status: 'evidence_collection', note: 'Evidence only.' },
  };
}

function marketWatch() {
  return {
    contract: 'lightweight-market-watch-readback/v1',
    status: 'PARTIAL', present: true, researchSha: SHA,
    observedAt: 1_800_000_000_000, ageMs: 30000,
    marketCoverageCount: 2,
    markets: [
      { market: 'KR_STOCK', status: 'BLOCKED_PUBLIC_STOCK_FEED_MISSING',
        source: 'NONE', listedCount: 0, observedCount: 0, newCandidates: 0,
        executionAuthority: 'NONE' },
      { market: 'US_STOCK', status: 'BLOCKED_PUBLIC_STOCK_FEED_MISSING',
        source: 'NONE', listedCount: 0, observedCount: 0, newCandidates: 0,
        executionAuthority: 'NONE' },
      { market: 'CRYPTO_SPOT', status: 'READY', source: 'UPBIT_PUBLIC_TICKERS',
        listedCount: 15, observedCount: 15, newCandidates: 2,
        executionAuthority: 'NONE', rawAccount: 'secret' },
      { market: 'CRYPTO_FUTURES', status: 'READY', source: 'BITGET_PUBLIC_TICKERS',
        listedCount: 15, observedCount: 15, newCandidates: 1,
        executionAuthority: 'NONE' },
    ],
    cyclesToday: 110, candidatesToday: 12, cyclesSinceRelease: 210,
    prospectiveSampleStudy: {
      status: 'PUBLIC_PRICE_OBSERVATION_ONLY', pendingCount: 3,
      observedCoarseToday: 4, blockedToday: 2, untrackedThisCycle: 1,
      economicEvidenceCredit: 0, paperCredit: 0, oosCredit: 0,
      privateRawSymbol: 'SECRET_SYMBOL',
    },
    continuous24hProven: false, formulaCandidateProduced: false,
    oosProven: false, paperExecutionProven: false,
    profitabilityProven: false, executionAuthority: 'NONE',
    filesystemPath: '/root/research-private',
  };
}
test('market watch readback is explicitly MISSING and never invents real 24h uptime', () => {
  const v = sanitizeMarketWatchReadback(null);
  assert.equal(v.status, 'MISSING');
  assert.equal(v.continuous24hProven, false);
  assert.equal(v.paperExecutionProven, false);
});
test('market watch readback passes only bounded public aggregate counts', () => {
  const actual = sanitizeMarketWatchReadback(marketWatch());
  assert.equal(actual.status, 'PARTIAL');
  assert.equal(actual.marketCoverageCount, 2);
  assert.equal(actual.markets.length, 4);
  assert.equal(actual.oosProven, false);
  assert.equal(actual.prospectiveSampleStudy?.observedCoarseToday, 4);
  assert.equal(actual.prospectiveSampleStudy?.pendingCount, 3);
  assert.equal(actual.executionAuthority, 'NONE');
  const encoded = JSON.stringify(actual);
  assert.equal(encoded.includes('rawAccount'), false);
  assert.equal(encoded.includes('SECRET_SYMBOL'), false);
  assert.equal(encoded.includes('/root/research-private'), false);
  const full = validOverview();
  Object.assign(full.dataFactory, { lightweightMarketWatch: marketWatch() });
  const sanitized = sanitizeResearchCenterOverview(full);
  assert.ok(sanitized);
  const factory = sanitized.dataFactory as {
    lightweightMarketWatch: { status: string; marketCoverageCount: number },
  };
  assert.equal(factory.lightweightMarketWatch.status, 'PARTIAL');
  assert.equal(factory.lightweightMarketWatch.marketCoverageCount, 2);
});
test('coarse sample study cannot claim economic success, infinite counts or orders', () => {
  const base = marketWatch();
  assert.equal(sanitizeMarketWatchReadback({
    ...base, prospectiveSampleStudy: { ...base.prospectiveSampleStudy, economicEvidenceCredit: 1 },
  }).status, 'INVALID');
  assert.equal(sanitizeMarketWatchReadback({
    ...base, prospectiveSampleStudy: { ...base.prospectiveSampleStudy, pendingCount: 1025 },
  }).status, 'INVALID');
  assert.equal(sanitizeMarketWatchReadback({
    ...base, prospectiveSampleStudy: { ...base.prospectiveSampleStudy, paperCredit: 1 },
  }).status, 'INVALID');
  assert.equal(sanitizeMarketWatchReadback({
    ...base, prospectiveSampleStudy: { ...base.prospectiveSampleStudy, status: 'OOS_PASS' },
  }).status, 'INVALID');
});

function watchCadence() {
  return {
    contract: 'public-watch-cadence-admin-readback-v1',
    status: 'PUBLIC_CADENCE_OBSERVED', present: true,
    sampleCount: 720, duplicateRows: 1, maxGapMs: 120000,
    latestAgeMs: 90000, hostHoldCycles: 0, hostThrottledCycles: 0,
    blockedDataCycles: 0, allFourMarketReadyCycles: 0, filesRead: 2,
    cadenceWindowObserved: true,
    continuous24hProven: false, completeFourMarketCoverageProven: false,
    economicEvidenceCredit: 0, oosCredit: 0, paperCredit: 0,
    profitabilityProven: false, formulaCandidateProduced: false,
    executionAuthority: 'NONE', rawPath: '/private/research/cadence',
  };
}

test('market watch cadence is read-only, aggregate-only and never a 24h SLA claim', () => {
  assert.equal(sanitizeMarketWatchCadenceReadback(null).status, 'MISSING');
  const actual = sanitizeMarketWatchCadenceReadback(watchCadence());
  assert.equal(actual.status, 'PUBLIC_CADENCE_OBSERVED');
  assert.equal(actual.sampleCount, 720);
  assert.equal(actual.maxGapMs, 120000);
  assert.equal(actual.allFourMarketReadyCycles, 0);
  assert.equal(actual.cadenceWindowObserved, true);
  assert.equal(actual.continuous24hProven, false);
  assert.equal(actual.completeFourMarketCoverageProven, false);
  assert.equal(actual.executionAuthority, 'NONE');
  assert.equal(actual.economicEvidenceCredit, 0);
  assert.equal(JSON.stringify(actual).includes('rawPath'), false);
  assert.equal(JSON.stringify(actual).includes('/private/'), false);

  const overview = validOverview();
  Object.assign(overview.dataFactory, { lightweightMarketWatchCadence: watchCadence() });
  const result = sanitizeResearchCenterOverview(overview);
  assert.ok(result);
  const dto = result.dataFactory as { lightweightMarketWatchCadence: { status: string; sampleCount: number } };
  assert.equal(dto.lightweightMarketWatchCadence.status, 'PUBLIC_CADENCE_OBSERVED');
  assert.equal(dto.lightweightMarketWatchCadence.sampleCount, 720);
});

test('market watch cadence rejects forged uptime, profits, orders and impossible counters', () => {
  for (const item of [
    { continuous24hProven: true },
    { completeFourMarketCoverageProven: true },
    { paperCredit: 1 },
    { oosCredit: 1 },
    { economicEvidenceCredit: 1 },
    { executionAuthority: 'LIVE' },
    { profitabilityProven: true },
    { sampleCount: -1 },
    { sampleCount: 60 },
    { maxGapMs: 800000 },
    { hostHoldCycles: 1 },
    { status: 'OOS_PASS' },
    { cadenceWindowObserved: false },
  ]) {
    const x = sanitizeMarketWatchCadenceReadback({ ...watchCadence(), ...item });
    assert.equal(x.status, 'INVALID');
    assert.equal(x.continuous24hProven, false);
    assert.equal(x.executionAuthority, 'NONE');
  }
  const interrupted = sanitizeMarketWatchCadenceReadback({
    ...watchCadence(), status: 'INCOMPLETE_OR_INTERRUPTED',
    cadenceWindowObserved: false, sampleCount: 15, hostHoldCycles: 1,
  });
  assert.equal(interrupted.status, 'INCOMPLETE_OR_INTERRUPTED');
  assert.equal(interrupted.cadenceWindowObserved, false);
});

test('market watch readback rejects forged orders, full coverage, counts and paths', () => {
  const x = marketWatch();
  assert.equal(sanitizeMarketWatchReadback({ ...x, executionAuthority: 'LIVE' }).status, 'INVALID');
  assert.equal(sanitizeMarketWatchReadback({ ...x, continuous24hProven: true }).status, 'INVALID');
  assert.equal(sanitizeMarketWatchReadback({ ...x, marketCoverageCount: 4, status: 'OBSERVING' }).status, 'INVALID');
  assert.equal(sanitizeMarketWatchReadback({ ...x, markets: x.markets.map((m, i) =>
    i === 2 ? { ...m, status: 'READY', source: '/etc/secret' } : m) }).status, 'INVALID');
  assert.equal(sanitizeMarketWatchReadback({ ...x, markets: x.markets.map((m, i) =>
    i === 3 ? { ...m, market: 'US_STOCK' } : m) }).status, 'INVALID');
});


test('Research Center contract publishes a GET-only, authority-free allowlisted DTO', () => {
  const input = validOverview();
  Object.assign(input, {
    accessToken: 'ghp_should-never-leak',
    stateRoot: '/var/lib/private-research',
    accountId: 'private-account-id',
  });
  Object.assign(input.paper.runtime, { credential: 'secret', publisherAccount: 'private' });
  Object.assign(input.paper.candidatePerformance, { accountId: 'private-account-id' });
  Object.assign(input.factory, {
    statePath: '/var/lib/private-research/factory.json',
    diagnostic: 'secret internal diagnostic',
  });
  Object.assign(input.research.liquidityIndependence, {
    artifactDownloadUrl: 'https://example.test/private-artifact',
    statePath: '/var/lib/private-research/v3.json',
  });
  const result = sanitizeResearchCenterOverview(input);
  assert.ok(result);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('ghp_should-never-leak'), false);
  assert.equal(serialized.includes('/var/lib/private-research'), false);
  assert.equal(serialized.includes('private-account-id'), false);
  assert.equal(serialized.includes('credential'), false);
  assert.equal(serialized.includes('artifactDownloadUrl'), false);
  assert.equal(serialized.includes('secret internal diagnostic'), false);
  assert.equal(serialized.includes('promotionIdentity'), false);
  assert.equal(serialized.includes('internal-cost-v1'), false);
  assert.equal(serialized.includes('internal-execution-v1'), false);
  const research = result.research as { liquidityIndependence: { effectiveIndependentN: number; independentBuyN: number; independentSellN: number } };
  assert.equal(research.liquidityIndependence.effectiveIndependentN, 15);
  assert.equal(research.liquidityIndependence.independentBuyN, 10);
  assert.equal(research.liquidityIndependence.independentSellN, 5);
  const dataFactory = result.dataFactory as { temporalCryptoFutures: { observationCount: number; failedCount: number; results: Array<{ symbol: string }> } };
  assert.equal(dataFactory.temporalCryptoFutures.observationCount, 42);
  assert.equal(dataFactory.temporalCryptoFutures.failedCount, 0);
  assert.equal(dataFactory.temporalCryptoFutures.results[0]?.symbol, 'BTCUSDT');
  const factory = result.factory as {
    status: string;
    firstZero: string;
    policyPresent: boolean;
    readyMarketCount: number;
    blockedMarketCount: number;
    readyProfileCount: null;
    controlPlaneDigest: string;
  };
  assert.equal(factory.status, 'BLOCKED_POLICY_MISSING');
  assert.equal(factory.firstZero, 'HUMAN_APPROVED_ADAPTIVE_POLICY_MISSING');
  assert.equal(factory.policyPresent, false);
  assert.equal(factory.readyMarketCount, 0);
  assert.equal(factory.blockedMarketCount, 4);
  assert.equal(factory.readyProfileCount, null);
  assert.equal(factory.controlPlaneDigest, 'd'.repeat(64));
  const paper = result.paper as { candidatePerformance: { candidateMatchedN: number; VALIDATION_N: number; Net_PnL: null } };
  assert.equal(paper.candidatePerformance.candidateMatchedN, 3);
  assert.equal(paper.candidatePerformance.VALIDATION_N, 0);
  assert.equal(paper.candidatePerformance.Net_PnL, null);
  assert.deepEqual(RESEARCH_CENTER_READONLY_CONTRACT.methods, ['GET']);
  assert.equal(RESEARCH_CENTER_READONLY_CONTRACT.executionAuthority, 'NONE');
});

test('older dashboard payloads without independence evidence remain backward-compatible and missing', () => {
  const input = validOverview();
  delete (input.research as { liquidityIndependence?: unknown }).liquidityIndependence;
  const result = sanitizeResearchCenterOverview(input)!;
  const research = result.research as { liquidityIndependence: { status: string; present: boolean; effectiveIndependentN: number | null } };
  assert.equal(research.liquidityIndependence.status, 'MISSING');
  assert.equal(research.liquidityIndependence.present, false);
  assert.equal(research.liquidityIndependence.effectiveIndependentN, null);
});

test('older dashboard payloads without Data Factory evidence remain explicit MISSING', () => {
  const input = validOverview();
  delete (input as { dataFactory?: unknown }).dataFactory;
  const result = sanitizeResearchCenterOverview(input)!;
  const dataFactory = result.dataFactory as { temporalCryptoFutures: { present: boolean; status: string; observationCount: null } };
  assert.equal(dataFactory.temporalCryptoFutures.present, false);
  assert.equal(dataFactory.temporalCryptoFutures.status, 'MISSING');
  assert.equal(dataFactory.temporalCryptoFutures.observationCount, null);
});

test('Data Factory DTO rejects private/tampered fields and impossible symbol counts', () => {
  const unsafe = validOverview();
  Object.assign(unsafe.dataFactory.temporalCryptoFutures, {
    statePath: '/var/lib/private-research/temporal.json',
    token: 'ghp_should-never-leak',
  });
  const sanitized = sanitizeResearchCenterOverview(unsafe)!;
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes('/var/lib/private-research'), false);
  assert.equal(serialized.includes('ghp_should-never-leak'), false);

  const invalid = validOverview();
  invalid.dataFactory.temporalCryptoFutures.results[0]!.appendedCount = 4;
  assert.equal(sanitizeResearchCenterOverview(invalid), null);
});

test('older dashboard payloads without Factory runtime remain explicit MISSING', () => {
  const input = validOverview();
  delete (input as { factory?: unknown }).factory;
  const result = sanitizeResearchCenterOverview(input)!;
  const factory = result.factory as {
    present: boolean;
    status: string;
    policyPresent: null;
    readyMarketCount: null;
    readyProfileCount: null;
  };
  assert.equal(factory.present, false);
  assert.equal(factory.status, 'MISSING');
  assert.equal(factory.policyPresent, null);
  assert.equal(factory.readyMarketCount, null);
  assert.equal(factory.readyProfileCount, null);
});

test('Factory runtime tamper fails browser DTO closed instead of leaking partial readiness', () => {
  const invalidPolicy = validOverview();
  (invalidPolicy.factory as { policyDigest: string | null }).policyDigest = 'e'.repeat(64);
  assert.equal(sanitizeResearchCenterOverview(invalidPolicy), null);

  const malformed = validOverview();
  (malformed.factory as { readyProfileCount: number | null }).readyProfileCount = -1;
  assert.equal(sanitizeResearchCenterOverview(malformed), null);
});

test('older dashboard payloads without candidate performance remain UNKNOWN and do not borrow ledger counts', () => {
  const input = validOverview();
  delete (input.paper as { candidatePerformance?: unknown }).candidatePerformance;
  const result = sanitizeResearchCenterOverview(input)!;
  const paper = result.paper as { candidatePerformance: { status: string; candidateMatchedN: null; Settlement_N: null } };
  assert.equal(paper.candidatePerformance.status, 'MISSING');
  assert.equal(paper.candidatePerformance.candidateMatchedN, null);
  assert.equal(paper.candidatePerformance.Settlement_N, null);
});

test('candidate performance tamper fails the browser-facing DTO closed', () => {
  const input = validOverview();
  input.paper.candidatePerformance = { ...candidatePerformance(), NET_ALPHA_PROVEN: true };
  assert.equal(sanitizeResearchCenterOverview(input), null);

  const inconsistent = validOverview();
  inconsistent.paper.candidatePerformance = { ...candidatePerformance(), LONG_SIGNAL_N: 3 };
  assert.equal(sanitizeResearchCenterOverview(inconsistent), null);

  const impossible = validOverview();
  impossible.paper.candidatePerformance = { ...candidatePerformance(), Position_N: 2 };
  assert.equal(sanitizeResearchCenterOverview(impossible), null);

  const invalidCost = validOverview();
  const performance = candidatePerformance();
  (performance.fullCostEvidence.components as Record<string, {
    state: string; valuePercent: number | null; provenance: string | null;
  }>).commission = {
    state: 'UNKNOWN', valuePercent: 0, provenance: null,
  };
  invalidCost.paper.candidatePerformance = performance;
  assert.equal(sanitizeResearchCenterOverview(invalidCost), null);

  const privatePath = validOverview();
  Object.assign(privatePath.paper.candidatePerformance, { statePath: '/var/lib/private-research/candidate.json' });
  assert.equal(sanitizeResearchCenterOverview(privatePath), null);
});

test('Research Center contract fails closed on unsafe authority, malformed SHA, and filesystem text', () => {
  const unsafe = validOverview();
  unsafe.safety.liveTrading = true;
  assert.equal(sanitizeResearchCenterOverview(unsafe), null);

  const wrongSha = validOverview();
  wrongSha.research.cycles[0]!.researchSha = 'wrong-sha';
  assert.equal(sanitizeResearchCenterOverview(wrongSha), null);

  const wrongIndependenceSha = validOverview();
  wrongIndependenceSha.research.liquidityIndependence.producerSha = 'wrong-sha';
  assert.equal(sanitizeResearchCenterOverview(wrongIndependenceSha), null);

  const pathLeak = validOverview();
  pathLeak.research.cycles[0]!.tasks[0]!.id = 'C:\\Users\\owner\\secret.json';
  assert.equal(sanitizeResearchCenterOverview(pathLeak), null);
});

test('invalid independence evidence carries no partial sample counts', () => {
  const input = validOverview();
  input.research.liquidityIndependence = {
    ...liquidityIndependence(),
    present: true,
    status: 'INVALID',
  };
  const result = sanitizeResearchCenterOverview(input)!;
  const research = result.research as { liquidityIndependence: { status: string; effectiveIndependentN: number | null; independentBuyN: number | null } };
  assert.equal(research.liquidityIndependence.status, 'INVALID');
  assert.equal(research.liquidityIndependence.effectiveIndependentN, null);
  assert.equal(research.liquidityIndependence.independentBuyN, null);
});

test('measured zero counts remain zero while unavailable counts remain null', () => {
  const result = sanitizeResearchCenterOverview(validOverview())!;
  const paper = result.paper as { ledger: { sampleCount: number | null; positionCount: number | null }; candidatePerformance: { VALIDATION_N: number | null; Net_PnL: number | null } };
  const shadow = result.shadow as { records: { totalRecords: number | null } };
  const research = result.research as { liquidityIndependence: { frozenSplitCounts: { VALIDATION: number | null; OOS: number | null } } };
  assert.equal(paper.ledger.sampleCount, 0);
  assert.equal(paper.ledger.positionCount, 0);
  assert.equal(paper.candidatePerformance.VALIDATION_N, 0);
  assert.equal(paper.candidatePerformance.Net_PnL, null);
  assert.equal(shadow.records.totalRecords, null);
  assert.equal(research.liquidityIndependence.frozenSplitCounts.VALIDATION, 0);
  assert.equal(research.liquidityIndependence.frozenSplitCounts.OOS, 0);
});

test('development diagnostic Factory blockers pass the browser allowlist without raw diagnostic leakage', () => {
  const input = validOverview();
  Object.assign(input.factory, {
    status: 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING',
    firstZero: 'DEVELOPMENT_DIAGNOSTIC_REQUIRED',
    policyPresent: true,
    policyValid: true,
    policyDigest: 'e'.repeat(64),
    readyProfileCount: 1,
    blockedProfileCount: 11,
    runtimeStatus: 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING',
    nextFirstZero: 'DEVELOPMENT_DIAGNOSTIC_REQUIRED',
    controlPlaneDigest: null,
    diagnostic: 'profile ids must not cross browser boundary',
  });
  const result = sanitizeResearchCenterOverview(input)!;
  const factory = result.factory as {
    status: string;
    firstZero: string;
    readyProfileCount: number;
    blockedProfileCount: number;
  };
  assert.equal(factory.status, 'BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING');
  assert.equal(factory.firstZero, 'DEVELOPMENT_DIAGNOSTIC_REQUIRED');
  assert.equal(factory.readyProfileCount, 1);
  assert.equal(factory.blockedProfileCount, 11);
  assert.equal(JSON.stringify(result).includes('profile ids must not cross browser boundary'), false);
});


test('formula queue readback allows only diagnostic TRAIN without Paper or OOS promotion', () => {
  const input = validOverview();
  Object.assign(input.research, {
    formulaBacktest: {
      present: true,
      status: 'TRAIN_ONLY',
      inboxCount: 5,
      scanned: 2,
      counts: { PASS: 0, HOLD: 2, RESERVE: 0, EXCLUDE: 0 },
      paperRegisteredCount: 0,
      producerBound: false,
      paperConsumerBound: false,
      validationComplete: false,
      oosComplete: false,
      fullCostReady: false,
      liveTrading: false,
      autoTrading: false,
      executionAuthority: 'NONE',
      firstBlocker: 'FORMULA_QUEUE_PRODUCER_AND_OOS_UNATTESTED',
      filePath: '/var/lib/secret-paper',
      itemDigest: 'secret-nonpublic-digest',
    },
  });
  const result = sanitizeResearchCenterOverview(input)!;
  const formula = (result.research as { formulaBacktest: Record<string, unknown> }).formulaBacktest;
  assert.equal(formula.status, 'TRAIN_ONLY');
  assert.equal(formula.scanned, 2);
  assert.equal(formula.paperRegisteredCount, 0);
  assert.equal(formula.oosComplete, false);
  assert.equal(formula.paperConsumerBound, false);
  assert.equal(JSON.stringify(result).includes('secret-nonpublic-digest'), false);
  assert.equal(JSON.stringify(result).includes('/var/lib/secret-paper'), false);
});

test('formula queue proof injection and forged stored PASS remain INVALID', () => {
  const input = validOverview();
  const diagnostic = {
    present: true,
    status: 'TRAIN_ONLY',
    inboxCount: 2,
    scanned: 1,
    counts: { PASS: 0, HOLD: 1, RESERVE: 0, EXCLUDE: 0 },
    paperRegisteredCount: 0,
    producerBound: false,
    paperConsumerBound: false,
    validationComplete: false,
    oosComplete: false,
    fullCostReady: false,
    liveTrading: false,
    autoTrading: false,
    executionAuthority: 'NONE',
    firstBlocker: 'FORMULA_QUEUE_PRODUCER_AND_OOS_UNATTESTED',
  };
  for (const mutation of [
    { ...diagnostic, counts: { PASS: 1, HOLD: 0, RESERVE: 0, EXCLUDE: 0 } },
    { ...diagnostic, paperRegisteredCount: 1 },
    { ...diagnostic, producerBound: true },
    { ...diagnostic, executionAuthority: 'LIVE', liveTrading: true },
    { ...diagnostic, validationComplete: true, oosComplete: true, fullCostReady: true },
  ]) {
    Object.assign(input.research, { formulaBacktest: mutation });
    const result = sanitizeResearchCenterOverview(input)!;
    const formula = (result.research as { formulaBacktest: { status: string; scanned: number | null; executionAuthority: string } }).formulaBacktest;
    assert.equal(formula.status, 'INVALID');
    assert.equal(formula.scanned, null);
    assert.equal(formula.executionAuthority, 'NONE');
  }
});
