import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyScannerSignalObservation,
  createDetectedScannerSignal,
  scannerSignalIdentity,
  startNextScannerSignalCycle,
  validateScannerSignalApproval,
  type ScannerSignalLifecycle,
  type ScannerSignalObservation,
  type ScannerSignalState,
} from './trade-signal-lifecycle.service';

const NOW = Date.parse('2026-08-06T07:00:00.000Z');

function observation(overrides: Partial<ScannerSignalObservation> = {}): ScannerSignalObservation {
  return {
    approvalCandidate: true,
    coreConditionsMaintained: true,
    dataState: 'complete',
    observedAt: new Date(NOW).toISOString(),
    score: 82,
    confidence: 78,
    riskScore: 24,
    dataCompleteness: 96,
    chaseRisk: 'LOW',
    reason: 'SIGNAL_OBSERVED',
    ...overrides,
  };
}

function detected(overrides: Partial<ScannerSignalLifecycle> = {}): ScannerSignalLifecycle {
  const signal = createDetectedScannerSignal({
    ownerId: 'member-1',
    signalId: 'signal-1',
    market: 'KR',
    symbol: '005930',
    timeframe: '15m',
    signalAt: new Date(NOW - 5_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    observation: observation(),
  }, NOW);
  return { ...signal, ...overrides };
}

function state(signal: ScannerSignalLifecycle, target: ScannerSignalState) {
  return { ...signal, state: target };
}

test('DETECTED transitions to WATCHING and WATCHING transitions to READY_FOR_APPROVAL', () => {
  const watching = applyScannerSignalObservation(detected(), observation(), NOW);
  assert.equal(watching.state, 'WATCHING');
  const ready = applyScannerSignalObservation(watching, observation(), NOW + 1_000);
  assert.equal(ready.state, 'READY_FOR_APPROVAL');
  assert.equal(ready.orderSubmitted, false);
  assert.equal(ready.exchangeRequestSent, false);
  assert.equal(validateScannerSignalApproval(ready, 1, NOW + 1_000).allowed, true);
});

test('WATCHING and READY can weaken without creating an order side effect', () => {
  for (const previous of ['WATCHING', 'READY_FOR_APPROVAL'] as const) {
    const weakened = applyScannerSignalObservation(
      state(detected(), previous),
      observation({ approvalCandidate: false, reason: 'SIGNAL_SCORE_WEAKENED' }),
      NOW,
    );
    assert.equal(weakened.state, 'WEAKENED');
    assert.equal(validateScannerSignalApproval(weakened, weakened.cycle, NOW).allowed, false);
    assert.equal(weakened.orderSubmitted, false);
    assert.equal(weakened.exchangeRequestSent, false);
  }
});

test('WATCHING and READY invalidate on partial stale unavailable or broken core data', () => {
  const failures: ScannerSignalObservation[] = [
    observation({ dataState: 'partial', reason: 'PARTIAL' }),
    observation({ dataState: 'stale', reason: 'STALE' }),
    observation({ dataState: 'unavailable', reason: 'UNAVAILABLE' }),
    observation({ coreConditionsMaintained: false, reason: 'CORE_BROKEN' }),
  ];
  for (const previous of ['WATCHING', 'READY_FOR_APPROVAL'] as const) {
    for (const failure of failures) {
      const result = applyScannerSignalObservation(state(detected(), previous), failure, NOW);
      assert.equal(result.state, 'INVALIDATED');
      assert.equal(result.orderSubmitted, false);
      assert.equal(result.exchangeRequestSent, false);
    }
  }
});

test('WATCHING and READY expire when the signal deadline passes', () => {
  for (const previous of ['WATCHING', 'READY_FOR_APPROVAL'] as const) {
    const result = applyScannerSignalObservation(
      state(detected({ expiresAt: new Date(NOW).toISOString() }), previous),
      observation(),
      NOW,
    );
    assert.equal(result.state, 'EXPIRED');
    assert.equal(validateScannerSignalApproval(result, result.cycle, NOW).reason, 'SCANNER_SIGNAL_EXPIRED');
  }
});

test('INVALIDATED and EXPIRED never return to READY_FOR_APPROVAL', () => {
  for (const terminal of ['INVALIDATED', 'EXPIRED'] as const) {
    const original = state(detected(), terminal);
    const result = applyScannerSignalObservation(original, observation(), NOW);
    assert.equal(result.state, terminal);
    assert.equal(result.history, original.history);
    assert.equal(validateScannerSignalApproval(result, result.cycle, NOW).allowed, false);
  }
});

test('WEAKENED requires an explicit new cycle before it can become ready again', () => {
  const weakened = state(detected(), 'WEAKENED');
  assert.equal(applyScannerSignalObservation(weakened, observation(), NOW).state, 'WEAKENED');
  const next = startNextScannerSignalCycle(weakened, observation(), NOW);
  assert.equal(next.cycle, 2);
  assert.equal(next.state, 'DETECTED');
  const watching = applyScannerSignalObservation(next, observation(), NOW + 1_000);
  const ready = applyScannerSignalObservation(watching, observation(), NOW + 2_000);
  assert.equal(ready.state, 'READY_FOR_APPROVAL');
  assert.equal(validateScannerSignalApproval(ready, 1, NOW + 2_000).reason, 'SCANNER_PREVIOUS_CYCLE_REJECTED');
  assert.equal(validateScannerSignalApproval(ready, 2, NOW + 2_000).allowed, true);
});

test('market, symbol, timeframe, owner and signal form a stable isolation key', () => {
  assert.equal(scannerSignalIdentity(detected()), 'member-1|KR|005930|15m|signal-1');
  assert.notEqual(scannerSignalIdentity(detected({ ownerId: 'member-2' })), scannerSignalIdentity(detected()));
  assert.notEqual(scannerSignalIdentity(detected({ market: 'US' })), scannerSignalIdentity(detected()));
});

test('invalid observation timestamps fail closed', () => {
  const stale = applyScannerSignalObservation(
    state(detected(), 'WATCHING'),
    observation({ observedAt: new Date(NOW - 60_001).toISOString() }),
    NOW,
  );
  assert.equal(stale.state, 'INVALIDATED');
  const future = applyScannerSignalObservation(
    state(detected(), 'WATCHING'),
    observation({ observedAt: new Date(NOW + 60_001).toISOString() }),
    NOW,
  );
  assert.equal(future.state, 'INVALIDATED');
});
