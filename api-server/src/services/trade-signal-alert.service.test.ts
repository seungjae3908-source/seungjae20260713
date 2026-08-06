import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyScannerSignalObservation,
  createDetectedScannerSignal,
  startNextScannerSignalCycle,
  type ScannerSignalObservation,
} from './trade-signal-lifecycle.service';
import { collectScannerReadyAlerts, deriveScannerReadyAlert } from './trade-signal-alert.service';

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

function signal() {
  return createDetectedScannerSignal({
    ownerId: 'member-1',
    signalId: 'signal-1',
    market: 'KR',
    symbol: '005930',
    timeframe: '15m',
    signalAt: new Date(NOW - 5_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    observation: observation(),
  }, NOW);
}

test('READY alert is emitted once per owner, market, symbol, timeframe and cycle', () => {
  const detected = signal();
  const watching = applyScannerSignalObservation(detected, observation(), NOW);
  const ready = applyScannerSignalObservation(watching, observation(), NOW + 1_000);
  const first = collectScannerReadyAlerts([{ previous: watching, current: ready }], new Set(), NOW + 1_000);
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].orderSubmitted, false);
  assert.equal(first.alerts[0].exchangeRequestSent, false);
  const duplicate = collectScannerReadyAlerts([{ previous: ready, current: ready }], first.deliveredKeys, NOW + 2_000);
  assert.equal(duplicate.alerts.length, 0);
});

test('stale, partial, expired, weakened and invalidated signals never alert', () => {
  const base = signal();
  const states = ['WEAKENED', 'INVALIDATED', 'EXPIRED'] as const;
  for (const state of states) {
    assert.equal(deriveScannerReadyAlert(null, { ...base, state }, new Set(), NOW), null);
  }
  assert.equal(deriveScannerReadyAlert(null, { ...base, state: 'READY_FOR_APPROVAL', dataState: 'partial' }, new Set(), NOW), null);
  assert.equal(deriveScannerReadyAlert(null, { ...base, state: 'READY_FOR_APPROVAL', expiresAt: new Date(NOW).toISOString() }, new Set(), NOW), null);
});

test('new cycle can emit one new alert while the previous cycle remains rejected', () => {
  const detected = signal();
  const watching = applyScannerSignalObservation(detected, observation(), NOW);
  const ready = applyScannerSignalObservation(watching, observation(), NOW + 1_000);
  const first = collectScannerReadyAlerts([{ previous: watching, current: ready }], new Set(), NOW + 1_000);
  const weakened = applyScannerSignalObservation(ready, observation({ approvalCandidate: false }), NOW + 2_000);
  const cycle2 = startNextScannerSignalCycle(weakened, observation(), NOW + 3_000);
  const watching2 = applyScannerSignalObservation(cycle2, observation(), NOW + 4_000);
  const ready2 = applyScannerSignalObservation(watching2, observation(), NOW + 5_000);
  const second = collectScannerReadyAlerts([{ previous: watching2, current: ready2 }], first.deliveredKeys, NOW + 5_000);
  assert.equal(second.alerts.length, 1);
  assert.equal(second.alerts[0].cycle, 2);
  assert.notEqual(second.alerts[0].id, first.alerts[0].id);
});

test('different users and markets have isolated alert keys', () => {
  const base = { ...signal(), state: 'READY_FOR_APPROVAL' as const };
  const member2 = deriveScannerReadyAlert(null, { ...base, ownerId: 'member-2' }, new Set(), NOW);
  const us = deriveScannerReadyAlert(null, { ...base, market: 'US' }, new Set(), NOW);
  assert.ok(member2);
  assert.ok(us);
  assert.notEqual(member2.id, us.id);
});
