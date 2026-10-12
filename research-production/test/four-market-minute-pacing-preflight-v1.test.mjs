import test from 'node:test';
import assert from 'node:assert/strict';
import { assessMinuteCollectorPacingPreflightV1 as plan,
  assessMinuteDualVenuePacingPreflightV1 as dual }
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
      market: 'KR_STOCK', symbol: 'S' + String(i).padStart(5, '0'),
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
  assert.equal(x.alternatePage200Scenario.dailyRequiredPages, 6080);
  assert.equal(x.alternatePage200Scenario.dailyRequiredWithHeadroom, 7296);
  assert.equal(x.alternatePage200Scenario.minActionsPerCycleWithHeadroom, 26);
  assert.equal(x.alternatePage200Scenario.sequentialWorstCaseRequiredMs, 215_500);
  assert.equal(x.alternatePage200Scenario.minTheoreticalConcurrentSlots, 2);
  assert.equal(x.alternatePage200Scenario.activeArchivePageMinutes, 120);
  assert.equal(x.alternatePage200Scenario.status, 'HYPOTHETICAL_NOT_EXECUTABLE');
  assert.equal(x.alternatePage200Scenario.hardCapWouldBlock, true);
  assert.equal(x.alternatePage200Scenario.worstCaseDeadlineWouldBlock, true);
  assert.equal(x.alternatePage200Scenario.enabled, false);
  assert.equal(x.alternatePage200Scenario.providerCalls, 0);
  assert.equal(x.alternatePage200Scenario.executionAuthority, 'NONE');
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

test('backfill from declared origin is disclosed separately from 24h steady-state', () => {
  const m = manifest(1, 0);
  m.ranges.push({
    market: 'CRYPTO_SPOT', symbol: 'T0000', mode: 'BACKFILL',
    startMs: NOW - 1440 * 60_000, endMs: NOW,
  });
  const x = plan({ manifest: m });
  assert.equal(x.capacity.dailyRequired, 12);
  assert.equal(x.declaredBackfillRanges, 1);
  assert.equal(x.declaredBackfillPagesFromOrigin, 12);
  assert.equal(x.alternatePage200Scenario.declaredBackfillPagesFromOrigin, 8);
  assert.equal(x.backfillQueueCursorAndCurrentOutstandingPagesNotInspected, true);
  assert.equal(x.actionable, false);
  assert.equal(x.providerCalls, 0);
});

test('2-minute, 200-page model may be arithmetically possible but never authorized', () => {
  const x = plan({ manifest: manifest(294, 466), cycleMinutes: 2 });
  assert.equal(x.alternatePage200Scenario.minActionsPerCycleWithHeadroom, 11);
  assert.equal(x.alternatePage200Scenario.sequentialWorstCaseRequiredMs, 91_000);
  assert.equal(x.alternatePage200Scenario.hardCapWouldBlock, false);
  assert.equal(x.alternatePage200Scenario.worstCaseDeadlineWouldBlock, false);
  assert.equal(x.alternatePage200Scenario.enabled, false);
  assert.equal(x.alternatePage200Scenario.hostCapacityVerified, false);
  assert.equal(x.alternatePage200Scenario.continuityAndGapSemanticsVerified, false);
});

test('manifest duplicate / forged backfill fails closed before capacity numbers', () => {
  const m = manifest(1, 0);
  assert.throws(() => plan({manifest: { ...m, ranges: [m.ranges[0],m.ranges[0]] }}),
    /MINUTE_QUEUE_DUPLICATE_SYMBOL/);
  assert.throws(() => plan({manifest: { ...m, ranges: [...m.ranges,
    {market:'CRYPTO_SPOT',symbol:'BTC',mode:'BACKFILL',
      startMs:NOW,endMs:NOW-60_000}] }}),/MINUTE_QUEUE_RANGE_INVALID/);
});


test('opt-in 180m source budget is distinct from untouched 120m queue', () => {
  const m={...manifest(294,466),pageWindowMinutes:180};
  const x=plan({manifest:m});
  assert.equal(x.activeManifestPageMinutes,180);
  assert.equal(x.capacity.windowMinutes,180);
  assert.equal(x.capacity.dailyRequired,6080);
  assert.equal(x.capacity.dailyAvailable,4608);
  assert.equal(x.capacity.requiredWithHeadroom,7296);
  assert.equal(x.capacity.minActionsPerCycleWithHeadroom,26);
  assert.equal(x.alternatePage200Scenario.activeArchivePageMinutes,180);
  assert.equal(x.alternatePage200Scenario.maxOptionalArchivePageMinutes,180);
  assert.equal(x.alternatePage200Scenario.enabled,false);
  assert.ok(x.reasons.includes('CONTINUOUS_DAY_CAPTURE_RATE_INSUFFICIENT'));
  assert.equal(x.actionable,false);
  assert.equal(x.providerCalls,0);
  assert.equal(x.executionAuthority,'NONE');
});
test('opt-in 180m backfill origin estimate never becomes real cursor progress',()=>{
  const m={...manifest(1,0),pageWindowMinutes:180};
  m.ranges.push({market:'CRYPTO_SPOT',symbol:'T0000',mode:'BACKFILL',
    startMs:NOW-360*60_000,endMs:NOW});
  const x=plan({manifest:m});
  assert.equal(x.declaredBackfillRanges,1);
  assert.equal(x.declaredBackfillPagesFromOrigin,2);
  assert.equal(x.alternatePage200Scenario.declaredBackfillPagesFromOrigin,2);
  assert.equal(x.backfillQueueCursorAndCurrentOutstandingPagesNotInspected,true);
  assert.equal(x.currentTimerActivated,false);
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


test('dual independent venue forecast fits 760 dense 180m roster on paper, but never enables',()=>{
  const input={...manifest(294,466),pageWindowMinutes:180};
  const v=dual({manifest:input});
  assert.equal(v.status,'DRAFT_THEORETICAL_ONLY');
  assert.equal(v.modeledCapacityPossible,true);
  assert.equal(v.modeledTotalActionsPerCycle,32);
  assert.equal(v.modeledWallClockWorstCaseMs,132_500);
  assert.equal(v.conservativeUsableWorkerMs,195_000);
  assert.equal(v.maxConcurrentIndependentProviders,2);
  assert.deepEqual(v.lanes.map(l=>l.dailyRequired),[2352,3728]);
  assert.deepEqual(v.lanes.map(l=>l.minimumActionsPerCycleWithHeadroom),[10,16]);
  assert.equal(v.actionable,false);
  assert.equal(v.workerEnabled,false);
  assert.equal(v.hostAttested,false);
  assert.equal(v.providerCalls,0);
  assert.equal(v.filesWritten,0);
  assert.equal(v.executionAuthority,'NONE');
});
test('dual lane model refuses 120m dense futures and stock/license shortcuts',()=>{
  const old=dual({manifest:manifest(294,466)});
  assert.equal(old.modeledCapacityPossible,false);
  assert.ok(old.reasons.includes('SINGLE_VENUE_RATE_CAPACITY_INSUFFICIENT'));
  const stocks=dual({manifest:manifest(2,2,1)});
  assert.equal(stocks.stockRanges,1);
  assert.equal(stocks.modeledCapacityPossible,false);
  assert.ok(stocks.reasons.includes('STOCK_SOURCE_SESSIONS_AND_LICENSE_NOT_MODELLED'));
});
test('dual lane model does not invent a budget for an empty, slow or forged venue',()=>{
  const one=dual({manifest:manifest(1,0)});
  assert.equal(one.modeledCapacityPossible,false);
  assert.ok(one.reasons.includes('BOTH_INDEPENDENT_CRYPTO_PROVIDERS_REQUIRED'));
  const slow=dual({manifest:{...manifest(294,466),pageWindowMinutes:180},
    worstCaseRequestMs:15_000});
  assert.equal(slow.modeledCapacityPossible,false);
  assert.ok(slow.reasons.includes('SINGLE_VENUE_DEADLINE_EXCEEDED'));
  for(const input of [{perVenueActionsPerCycle:17},{perVenueActionsPerCycle:0},
    {worstCaseRequestMs:Number.NaN},{cycleMinutes:7},
    {safeShutdownReserveMs:220_000}]) {
    assert.throws(()=>dual({manifest:manifest(1,1),...input}),/MINUTE_DUAL_/);
  }
});
