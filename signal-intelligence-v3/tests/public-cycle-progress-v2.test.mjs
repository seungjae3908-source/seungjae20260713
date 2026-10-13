import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicCyclePageDecision,
  currentPublicCyclePublication,
  publicDataQualityDiagnostic,
  publicExecutionEvidence,
  publicMarketSummary,
} from '../src/public-cycle-progress-v2.mjs';

function page(overrides = {}) {
  return { cards: [], failures: [], outcome: 'VALID_ZERO_SIGNAL', dataState: 'complete',
    universe: { source: 'krx-symbol-master', totalCount: 2000, cursor: 0, nextCursor: 5, partial: false, stale: false },
    execution: { requestedCount: 5, startedCount: 5, completedCount: 5, providerErrorCount: 0, timeoutCount: 0,
      partial: false, timedOut: false, cancelled: false, duplicate: false }, ...overrides };
}

test('incomplete roster rotates only a fully completed research page; it cannot publish candidates', () => {
  const p = page(); p.universe.partial = true;
  assert.deepEqual(publicCyclePageDecision(p, 'KR_STOCK', 0), {
    status: 'BLOCKED_DATA', nextCursor: 5, blockedObservationOnly: true, reason: 'BLOCKED_RESEARCH_ROTATION_ONLY',
  });
  p.execution.completedCount = 4;
  assert.equal(publicCyclePageDecision(p, 'KR_STOCK', 0).nextCursor, 0);
  p.execution.completedCount = 5; p.execution.providerErrorCount = 1;
  assert.equal(publicCyclePageDecision(p, 'KR_STOCK', 0).nextCursor, 0);
});

test('cursor jumps, unknown/cross-market rosters, premature end and stale pages fail closed', () => {
  for (const mutate of [p => p.universe.nextCursor = 6, p => p.universe.nextCursor = null,
    p => p.universe.source = 'upbit-public', p => p.universe.stale = true,
    p => p.execution.timeoutCount = 1, p => p.failures.push({ reason: 'provider_error' })]) {
    const p = page(); mutate(p);
    const result = publicCyclePageDecision(p, 'KR_STOCK', 0);
    assert.equal(result.nextCursor, 0); assert.notEqual(result.status, 'VALID_NO_TRADE');
  }
  const p = page(); p.universe.cursor = 1995; p.universe.nextCursor = null;
  assert.equal(publicCyclePageDecision(p, 'KR_STOCK', 1995).nextCursor, 0);
  p.universe.cursor = 2000; p.execution.requestedCount = p.execution.startedCount = p.execution.completedCount = 0;
  assert.equal(publicCyclePageDecision(p, 'KR_STOCK', 2005).reason, 'ROSTER_SHRUNK_RESTART');
});

test('invalid candle evidence may progress research but never becomes a valid no-trade or candidate page', () => {
  const p = page({ failures: [{ reason: 'invalid_data' }], dataState: 'untrusted' });
  assert.equal(publicCyclePageDecision(p, 'KR_STOCK', 0).status, 'BLOCKED_DATA');
  assert.equal(publicCyclePageDecision(p, 'KR_STOCK', 0).nextCursor, 5);
  p.outcome = 'CANDIDATES_AVAILABLE';
  assert.equal(publicCyclePageDecision(p, 'KR_STOCK', 0).status, 'SEARCH_FAILURE');
});

test('legacy crypto execution evidence counts completed public data without inventing invalid rows', () => {
  assert.deepEqual(publicExecutionEvidence({ completedCount: 10 }, []), {
    providerAcceptedCount: 10,
    dataSuccessCount: 10,
    insufficientDataCount: 0,
    filteredByStrategyCount: 0,
    staleCount: 0,
  });
  assert.deepEqual(publicExecutionEvidence({ completedCount: 5 }, [
    { reason: 'invalid_data' }, { reason: 'provider_error' },
  ]), {
    providerAcceptedCount: 5,
    dataSuccessCount: 4,
    insufficientDataCount: 1,
    filteredByStrategyCount: 0,
    staleCount: 0,
  });
});

test('explicit producer counters take precedence and malformed counters fail to conservative values', () => {
  assert.deepEqual(publicExecutionEvidence({
    completedCount: 8,
    providerAcceptedCount: 7,
    dataSuccessCount: 6,
    insufficientDataCount: 1,
    filteredByStrategyCount: 2,
    staleCount: 3,
  }, [{ reason: 'invalid_data' }]), {
    providerAcceptedCount: 7,
    dataSuccessCount: 6,
    insufficientDataCount: 1,
    filteredByStrategyCount: 2,
    staleCount: 3,
  });
  assert.deepEqual(publicExecutionEvidence({ completedCount: -1 }, [{ reason: 'invalid_data' }]), {
    providerAcceptedCount: 0,
    dataSuccessCount: 0,
    insufficientDataCount: 0,
    filteredByStrategyCount: 0,
    staleCount: 0,
  });
});

test('public quality diagnostics retain rejection codes after ranking removes cards', () => {
  const result = publicDataQualityDiagnostic([
    { dataQuality: { state: 'DATA_UNTRUSTED', issues: [{ code: 'MISSING_CANDLE' }, { code: 'MISSING_CANDLE' }] } },
    { dataQuality: { state: 'DEGRADED', issues: [{ code: 'ABNORMAL_SPIKE' }] } },
    { dataQuality: { state: 'TRUSTED', issues: [] } },
  ], 'provider evidence');
  assert.deepEqual(result, {
    evaluatedCards: 3,
    trustedCards: 1,
    degradedCards: 1,
    untrustedCards: 1,
    issueCounts: { MISSING_CANDLE: 2, ABNORMAL_SPIKE: 1 },
    message: 'provider evidence',
  });
});

test('market summary distinguishes provider-gated rosters and quality-blocked completed pages', () => {
  const providerPages = ['A', 'B', 'C'].map(() => ({ status: 'BLOCKED_PROVIDER', totalUniverse: 4007,
    pageExecution: { requestedCount: 0, dataSuccessCount: 0 }, scannedCards: 0 }));
  assert.deepEqual(publicMarketSummary(providerPages).providerGatedCount, 4007);
  assert.deepEqual(publicMarketSummary(providerPages).dataBlockedCount, 4007);

  const qualityPages = [
    { status: 'VALID_NO_TRADE', totalUniverse: 295, pageExecution: { requestedCount: 5, dataSuccessCount: 5 }, scannedCards: 0 },
    { status: 'BLOCKED_DATA', totalUniverse: 295, pageExecution: { requestedCount: 5, dataSuccessCount: 5 }, scannedCards: 0 },
  ];
  const summary = publicMarketSummary(qualityPages);
  assert.equal(summary.queriedCount, 5);
  assert.equal(summary.dataSuccessCount, 5);
  assert.equal(summary.qualityBlockedCount, 5);
  assert.equal(summary.dataBlockedCount, 5);
  assert.equal(summary.normalNoSignalLaneCount, 1);
  assert.equal(summary.blockedLaneCount, 1);
});

function snapshot() {
  const markets = { KR: ['KR_STOCK', 'krx-symbol-master'], US: ['US_STOCK', 'nasdaq-trader-public-directory'],
    SPOT: ['CRYPTO_SPOT', 'upbit-public'], FUTURES: ['CRYPTO_FUTURES', 'bitget-public'] };
  const profiles = {
    KR: ['SCALPING_5M', 'SWING_60M', 'MID_LONG_1D'],
    US: ['SCALPING_5M', 'SWING_60M', 'MID_LONG_1D'],
    SPOT: ['SCALPING_15M', 'SWING_4H', 'MID_LONG_4H'],
    FUTURES: ['SCALPING_5M', 'SWING_60M', 'MID_LONG_4H'],
  };
  const coverage = Object.entries(markets).flatMap(([prefix, [market, source]]) =>
    profiles[prefix].map(p => ({
      laneId: `${prefix}_${p}`, market, sourceCycleId: 'now', status: 'VALID_NO_TRADE', universeSource: source,
      rosterId: 'a'.repeat(64),
      universePartial: false, universeStale: false, universeProviderErrors: 0, responseDataState: 'complete',
      providerErrors: 0, timeouts: 0, cursorBefore: 0, cursorAfter: 5, totalUniverse: 2000,
      pageExecution: { requestedCount: 5, startedCount: 5, completedCount: 5, failuresObserved: 0,
        partial: false, timedOut: false, cancelled: false },
    })));
  const rows = ['now', 'old'].map(cycle => ({ id: cycle, market: 'KR_STOCK',
    provenance: { laneId: 'KR_SCALPING_5M', cursor: 0, sourceCycleId: cycle, rosterId: 'a'.repeat(64) } }));
  return { rosterBindingVersion: 1, sourceCycleId: 'now', coverage, rows, lists: { krBuy: rows }, events: rows.map(r => ({ id: r.id })) };
}

test('retained historical rows cannot be reissued as current signals or events even at the same cursor', () => {
  const s = snapshot();
  const result = currentPublicCyclePublication(s);
  assert.equal(result.currentPageReady, true);
  assert.deepEqual(result.lists.krBuy.map(r => r.id), ['now']);
  assert.deepEqual(result.events.map(r => r.id), ['now']);
  s.coverage[0].universePartial = true;
  assert.equal(currentPublicCyclePublication(s).currentPageReady, false);
  assert.deepEqual(currentPublicCyclePublication(s).lists.krBuy, []);
  s.coverage[0] = s.coverage[1];
  assert.deepEqual(currentPublicCyclePublication(s).events, []);
});

test('a changed or previously unbound roster restarts the cursor without publishing a page', () => {
  const p = page(); p.universe.rosterId = 'a'.repeat(64); p.universe.cursor = 20; p.universe.nextCursor = 25;
  assert.equal(publicCyclePageDecision(p, 'KR_STOCK', 20, 'a'.repeat(64)).nextCursor, 25);
  for (const previous of [null, 'b'.repeat(64)]) {
    const decision = publicCyclePageDecision(p, 'KR_STOCK', 20, previous);
    assert.equal(decision.nextCursor, 0); assert.equal(decision.status, 'BLOCKED_DATA');
    assert.equal(decision.reason, 'ROSTER_CHANGED_RESTART');
  }
  delete p.universe.rosterId;
  assert.equal(publicCyclePageDecision(p, 'KR_STOCK', 20, 'a'.repeat(64)).reason, 'ROSTER_ID_UNAVAILABLE');
});

test('current publication requires current roster binding, not just matching cycle and numeric cursor', () => {
  const s = snapshot(); s.rows[0].provenance.rosterId = 'b'.repeat(64);
  assert.deepEqual(currentPublicCyclePublication(s).events, []);
  delete s.rosterBindingVersion;
  assert.equal(currentPublicCyclePublication(s).currentPageReady, false);
  assert.deepEqual(currentPublicCyclePublication(s).lists.krBuy, []);
});
