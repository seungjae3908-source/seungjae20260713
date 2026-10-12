import test from 'node:test';
import assert from 'node:assert/strict';
import { assessMinuteCollectorPacingPreflightV1 as plan }
  from '../src/four-market-minute-pacing-preflight-v1.mjs';

const NOW = Date.parse('2026-10-12T10:00:00.000Z');
const manifest = (spot, futures, stocks = 0) => ({
  schemaVersion: 'research-minute-backfill-scope/v1',
  ranges: [
    ...Array.from({ length: spot }, (_, i) => ({
      market: 'CRYPTO_SPOT', symbol: 'T' + String(i).padStart(4, '0'),
      mode: 'CONTINUOUS', startMs: NOW,
    })),
    ...Array.from({ length: futures }, (_, i) => ({
      market: 'CRYPTO_FUTURES', symbol: 'Q' + String(i).padStart(4, '0') + 'USDT',
      mode: 'CONTINUOUS', startMs: NOW,
    })),
    ...Array.from({ length: stocks }, (_, i) => ({
      market: 'KR_STOCK', symbol: 'S' + String(i).padStart(6, '0'),
      mode: 'CONTINUOUS', startMs: NOW,
    })),
  ],
});

test('original 16/5-minute budget is insufficient for 760 continuously traded crypto symbols', () => {
  const x = plan({ manifest: manifest(294, 466) });
  assert.equal(x.capacity.dailyRequired, 9120);
  assert.equal(x.capacity.dailyAvailable, 4608);
  assert.equal(x.capacity.requiredWithHeadroom, 10944);
  assert.equal(x.minimumActionsPerCycleWithHeadroom, 38);
  assert.equal(x.maxSequentialActionsWithReserve, 23);
  assert.equal(x.proposedSequentialWorstCaseMs, 132_500);
  assert.ok(x.reasons.includes('CONTINUOUS_DAY_CAPTURE_RATE_INSUFFICIENT'));
  assert.equal(x.actionable, false);
  assert.equal(x.providerCalls, 0);
  assert.equal(x.executionAuthority, 'NONE');
});

test('38/5-minute arithmetic throughput alone exceeds bounded 210-second worker', () => {
  const x = plan({ manifest: manifest(294, 466), proposedActionsPerCycle: 38 });
  assert.equal(x.capacity.status, 'CAPACITY_MODEL_POSSIBLE');
  assert.equal(x.proposedSequentialWorstCaseMs, 315_100);
  assert.equal(x.usableSequentialWorkerMs, 195_000);
  assert.equal(x.theoreticalConcurrentSlots, 2);
  assert.ok(x.reasons.includes('SEQUENTIAL_WORKER_DEADLINE_EXCEEDED'));
  assert.ok(x.reasons.includes('EXISTING_WORKER_HARD_CAP_NOT_CHANGED'));
  assert.equal(x.currentTimerActivated, false);
  assert.equal(x.sharedIpBudgetVerified, false);
  assert.equal(x.continuous24hProven, false);
});

test('2-minute timer arithmetic is not an automatic deadline or IP quota pass', () => {
  const x = plan({ manifest: manifest(294, 466), cycleMinutes: 2 });
  assert.equal(x.minimumActionsPerCycleWithHeadroom, 16);
  assert.equal(x.capacity.status, 'CAPACITY_MODEL_POSSIBLE');
  assert.equal(x.usableSequentialWorkerMs, 105_000);
  assert.ok(x.reasons.includes('SEQUENTIAL_WORKER_DEADLINE_EXCEEDED'));
  assert.equal(x.status, 'OPERATOR_REVIEW_REQUIRED');
  assert.equal(x.filesWritten, 0);
});

test('hypothetically shorter requests cannot manufacture quota or 24h readiness', () => {
  const x = plan({ manifest: manifest(294, 466),
    proposedActionsPerCycle: 38, worstCaseRequestMs: 1000 });
  assert.equal(x.capacity.status, 'CAPACITY_MODEL_POSSIBLE');
  assert.equal(x.reasons.includes('SEQUENTIAL_WORKER_DEADLINE_EXCEEDED'), false);
  assert.ok(x.reasons.includes('PUBLIC_PROVIDER_SHARED_IP_BUDGET_NOT_ATTESTED'));
  assert.equal(x.actionable, false);
  assert.equal(x.hostCapacityVerified, false);
  assert.equal(x.profitabilityProven, false);
});

test('stock sources never inherit crypto 24h timing assumptions', () => {
  const x = plan({ manifest: manifest(2, 2, 1) });
  assert.equal(x.capacity.status, 'STOCK_SESSION_NOT_MODELLED');
  assert.ok(x.reasons.includes('STOCK_EXCHANGE_SESSION_AND_LICENSE_BUDGET_NOT_MODELLED'));
  assert.equal(x.licensedStockSourceVerified, false);
});

test('unsupported, oversized or inconsistent task budgets cannot pass as safe', () => {
  for (const bad of [
    { proposedActionsPerCycle: -1 },
    { cycleMinutes: 7 },
    { worstCaseRequestMs: Number.NaN },
    { requestSpacingMs: -1 },
    { safeShutdownReserveMs: 250000 },
    { lockChildTimeoutMs: 10_000, safeShutdownReserveMs: 11_000 },
    { proposedActionsPerCycle: 1.2 },
    { headroomPercent: -5 },
  ]) assert.throws(() => plan({ manifest: manifest(1, 0), ...bad }),
    /MINUTE_PACING_PREFLIGHT_/);
});
