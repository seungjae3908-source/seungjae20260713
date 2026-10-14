import assert from 'node:assert/strict';
import test from 'node:test';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
import {
  appendPublicQaCycle,
  externalPilotSignalStatistics,
  publicQaCycleObservation,
} from './external-strategy-pilot-statistics.service';

const nowMs = Date.parse('2026-10-14T03:00:00.000Z');

function report(observationKind: string, state = 'BLOCKED_COST') {
  return {
    schemaVersion: 'upbit-external-strategy-pilot-public-qa-v1',
    serviceSha: 'a'.repeat(40),
    completedAt: '2026-10-14T02:00:00.000Z',
    market: 'CRYPTO_SPOT',
    observationKind,
    actualPublicData: observationKind === 'LIVE_PUBLIC_MARKET',
    strategyId: 'TREND_PULLBACK_REACCEL_V1',
    symbolsRequested: ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'],
    totals: { naturalCandidateCount: 1, providerSuccessCount: 3, providerFailureCount: 0 },
    rows: [{ schemaVersion: 'external-strategy-pilot-producer-result-v1',
      observationKind: 'LIVE_PUBLIC_MARKET', state, handoffEntryCount: 0,
      blockers: state === 'BLOCKED_COST' ? ['UPBIT_PILOT_COST_POLICY_REQUIRED'] : [] }],
  };
}

test('only genuine live public observations enter the 30-day signal history', () => {
  assert.equal(publicQaCycleObservation(report('HISTORICAL_REPLAY')), null);
  const history = appendPublicQaCycle(null, report('LIVE_PUBLIC_MARKET'), nowMs);
  assert.equal(history.observations.length, 1);
  assert.equal(history.observations[0]?.naturalSignals, 1);
  assert.equal(history.observations[0]?.costPolicyBlocked, 1);
  assert.equal(history.observations[0]?.eligibleCandidates, 0);
});

test('statistics distinguish missing observations from a measured zero and join durable worker admissions', () => {
  const history = appendPublicQaCycle(null, report('LIVE_PUBLIC_MARKET', 'READY'), nowMs);
  const plan = { id: 'p1', accountMode: 'live', strategyId: 'TREND_PULLBACK_REACCEL_V1', executionMode: 'automatic',
    reduceOnly: false, signalReasons: ['ADMISSION_PATH:EXTERNAL_STRATEGY_PILOT'], exchange: 'upbit',
    market: 'KRW', createdAt: '2026-10-14T02:15:00.000Z' } as TradingPlan;
  const order = { id: 'o1', planId: 'p1', state: 'FILLED', updatedAt: '2026-10-14T02:20:00.000Z' } as TradingOrder;
  const stats = externalPilotSignalStatistics({ history, plans: [plan], orders: [order], nowMs });
  assert.equal(stats.byMarket.crypto_spot['1d'].naturalSignals, 1);
  assert.equal(stats.byMarket.crypto_spot['1d'].workerAdmissions, 1);
  assert.equal(stats.byMarket.crypto_spot['1d'].actualLiveTrades, 1);
  assert.equal(stats.byMarket.crypto_futures['1d'].naturalSignals, null);
  assert.equal(stats.byMarket.crypto_futures['1d'].publicObservationAvailable, false);
  assert.equal(stats.replayAndFixtureExcluded, true);
});
