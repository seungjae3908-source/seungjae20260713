import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyOriginalMinutePreset, changeOriginalMinuteMarket, createOriginalMinuteClient, createOriginalMinuteForm,
  createOriginalMinuteRunController, EMPTY_ORIGINAL_MINUTE_RUN, normalizeOriginalMinuteForm,
  OriginalMinuteClientError, validateOriginalMinuteRun,
  type OriginalMinuteBacktestRequestV1, type OriginalMinuteBacktestRunV1, type OriginalMinuteClient, type OriginalMinuteRunState,
} from './original-minute-backtest.ts';
import { ORIGINAL_MINUTE_BACKTEST_SAFETY_V1, ORIGINAL_MINUTE_PRESETS_V1 } from '../../../packages/strategy-hypothesis/src/original-minute-backtest.js';

const NOW = Date.UTC(2026, 9, 11);
const RUN_ID = 'd84faec0-7b62-4ad5-9b3c-6673f33c5a01';
function selection(): OriginalMinuteBacktestRequestV1 {
  return normalizeOriginalMinuteForm({ ...createOriginalMinuteForm(NOW), startDate: '2025-01-01', endDate: '2025-01-31' }, NOW);
}
function run(status: OriginalMinuteBacktestRunV1['status'] = 'RUNNING', request = selection()): OriginalMinuteBacktestRunV1 {
  return {
    ...ORIGINAL_MINUTE_BACKTEST_SAFETY_V1, schemaVersion: 'original-minute-backtest-run-v1', runId: RUN_ID,
    selection: request, status, reason: status === 'BLOCKED_DATA' ? 'ORIGINAL_PERIOD_PRIVATE_SESSION_INDEX_UNAVAILABLE' : null,
    createdAtMs: NOW - 1000, finishedAtMs: ['RUNNING', 'CANCELLING'].includes(status) ? null : NOW,
    report: status === 'COMPLETED' ? {
      kind: 'PERIOD', status: 'SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY', symbol: request.symbol, timeframe: request.timeframe,
      direction: request.direction, selectedStartDate: request.startDate, selectedEndDate: request.endDate,
      sourceSessionsVerified: 31, modeledTradeCount: 4, modeledReturnPercent: 1.5, modeledNetPnlKRW: 15000,
      modeledCostKRW: 500, modeledMaxDrawdownPercent: 2, modeledEndingCapitalKRW: 1015000, modeledProfitReserveKRW: 0,
      modeledWins: 3, modeledLosses: 1, sessionClosePolicy: 'CLOSE_EACH_SOURCE_SESSION',
      horizonReturns: [1, 7, 30, 90, 180, 365, 1095, 1825, 3650].map((horizonDays) => ({
        horizonDays, requiredStartDate: new Date(Date.parse(`${request.endDate}T00:00:00Z`) - (horizonDays - 1) * 86_400_000).toISOString().slice(0, 10),
        status: horizonDays <= 31 ? 'MODELED_SOURCE_ONLY' : 'BLOCKED_DATA', modeledReturnPercent: horizonDays <= 31 ? 1.5 : null,
        reason: horizonDays <= 31 ? null : 'SELECTED_WINDOW_SHORTER_THAN_HORIZON',
      })),
      canonicalPaperResearchReview: { status: 'RESEARCH_HOLD', blockerCount: 1, blockers: ['INDEPENDENT_OOS_NOT_PROVEN'],
        canonicalProfitabilityStatus: 'RESEARCH_HOLD', canonicalPaperBridgeStatus: 'BLOCKED', canonicalPaperBridgeBlockers: ['PROFITABILITY_NOT_PROVEN'],
        paperAdmissionAllowed: false, executionAuthority: 'NONE' },
      independentOOSProven: false, independentFullCostProven: false, originalHistoricalSignalVerified: false,
      actualFillCount: null, profitabilityProven: false, paperCandidatePASS: false, executionAuthority: 'NONE',
    } : null,
    blockers: status === 'BLOCKED_DATA' ? ['ORIGINAL_PERIOD_PRIVATE_SESSION_INDEX_UNAVAILABLE'] : [],
    source: { evidenceScope: null, currentRosterDigestSha256: null, currentRosterObservedAtMs: null, historicalPITRosterChecked: false,
      sourceSessionIndexDigestSha256: null, sourceModelDigestSha256: null, sourceClass: null, fixtureOnly: null },
    coverage: { indexedPrivateSessions: null, verifiedNativeMinuteSessions: null, missingSourceDays: null, missingExpectedStockSessions: null, blockedDatesPreview: [], blockedDate: null },
  };
}
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const hasCode = (expected: string) => (error: unknown) => error instanceof OriginalMinuteClientError && error.code === expected;
const clone = <T>(value: T): any => structuredClone(value);
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; }); return { promise, resolve, reject }; }
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function harness(client: OriginalMinuteClient) {
  const states: OriginalMinuteRunState[] = [];
  const timers = new Map<number, () => void>(); let next = 0;
  const controller = createOriginalMinuteRunController({ client, onChange: state => states.push(state),
    schedule: fn => { const id = ++next; timers.set(id, fn); return id as unknown as ReturnType<typeof setTimeout>; },
    unschedule: id => { timers.delete(id as unknown as number); },
  });
  return { controller, states, timers, latest: () => states.at(-1) ?? EMPTY_ORIGINAL_MINUTE_RUN,
    async fire() { const entry = timers.entries().next().value; assert.ok(entry); timers.delete(entry[0]); entry[1](); await tick(); } };
}

test('calendar presets include one day and ten years without a three-year total cap', () => {
  const values = createOriginalMinuteForm(NOW);
  for (const preset of ORIGINAL_MINUTE_PRESETS_V1) assert.ok(normalizeOriginalMinuteForm(applyOriginalMinutePreset(values, preset), NOW));
  assert.equal(applyOriginalMinutePreset(values, '1d').startDate, values.endDate);
  assert.equal(applyOriginalMinutePreset(values, '10y').startDate, '2016-10-11');
});
test('form converts displayed percent values once and retains explicit zero-cost assumptions', () => {
  const values = createOriginalMinuteForm(NOW);
  values.costPercent.entryFeeRate = '0.06'; values.costPercent.slippageRate = '0.05';
  const request = normalizeOriginalMinuteForm(values, NOW);
  assert.equal(request.costModel.entryFeeRate, 0.0006); assert.equal(request.costModel.slippageRate, 0.0005);
  assert.equal(request.costModel.exitFeeRate, 0); assert.equal(request.riskFraction, 0.01);
  assert.equal(request.strategy.stopPercent, 1); assert.equal(request.initialCapitalKRW, 1000000);
});
test('changing to cash removes SHORT, leverage, funding and unsupported stock daily selection', () => {
  const values = changeOriginalMinuteMarket(createOriginalMinuteForm(NOW), 'CRYPTO_FUTURES');
  values.direction = 'SHORT'; values.leverage = '7'; values.timeframe = '1d'; values.costPercent.fundingRatePerSession = '0.1';
  for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT'] as const) {
    const changed = changeOriginalMinuteMarket(values, market);
    assert.equal(changed.direction, 'LONG'); assert.equal(changed.leverage, '1'); assert.equal(changed.costPercent.fundingRatePerSession, '0');
    if (market !== 'CRYPTO_SPOT') assert.equal(changed.timeframe, '5m');
    assert.equal(changed.fxRateKRWPerQuote, market === 'US_STOCK' ? '' : '1');
  }
});
test('non-KRW FX and blank cost fields are required rather than silently set to zero', () => {
  assert.throws(() => normalizeOriginalMinuteForm(changeOriginalMinuteMarket(createOriginalMinuteForm(NOW), 'US_STOCK'), NOW), hasCode('ORIGINAL_MINUTE_NUMBER_INPUT_REQUIRED'));
  const values = createOriginalMinuteForm(NOW); values.costPercent.taxRate = '';
  assert.throws(() => normalizeOriginalMinuteForm(values, NOW), hasCode('ORIGINAL_MINUTE_NUMBER_INPUT_REQUIRED'));
});
test('invalid dates, cash SHORT and stock 1d are rejected before any API call', async () => {
  let calls = 0; const client = createOriginalMinuteClient(async () => { calls += 1; return jsonResponse(run(), 202); });
  for (const mutation of [{ startDate: '2025-02-31' }, { direction: 'SHORT' }, { market: 'KR_STOCK', symbol: '005930', timeframe: '1d' }]) {
    await assert.rejects(client.start({ ...selection(), ...mutation } as OriginalMinuteBacktestRequestV1), TypeError);
  }
  assert.equal(calls, 0);
});
test('fixed manual endpoints retain exact strategy/cost/FX selection and never send source paths', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = createOriginalMinuteClient(async (url, init) => { calls.push({ url: String(url), init }); return jsonResponse(run(init?.method === 'DELETE' ? 'CANCELLED' : 'RUNNING'), init?.method === 'POST' ? 202 : 200); });
  await client.start(selection()); await client.get(RUN_ID, selection()); await client.cancel(RUN_ID, selection());
  assert.deepEqual(calls.map(call => [call.url, call.init?.method]), [
    ['/api/backtests/original-minute/runs', 'POST'], [`/api/backtests/original-minute/runs/${RUN_ID}`, 'GET'], [`/api/backtests/original-minute/runs/${RUN_ID}`, 'DELETE'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), selection());
  assert.equal(calls[0].init?.redirect, 'error'); assert.equal(calls[0].init?.cache, 'no-store');
  assert.equal(calls[1].init?.body, undefined);
});
test('UUID path validation rejects a URL or filesystem path without fetching', async () => {
  let calls = 0; const client = createOriginalMinuteClient(async () => { calls += 1; return jsonResponse(run()); });
  await assert.rejects(client.get('../../private/keys', selection()), hasCode('ORIGINAL_MINUTE_RUN_ID_INVALID')); assert.equal(calls, 0);
});
test('job safety flags are exact and include nullable actual opportunity and fill fields', () => {
  for (const [key, value] of Object.entries(ORIGINAL_MINUTE_BACKTEST_SAFETY_V1)) {
    const changed = clone(run()); changed[key] = value === null ? 0 : value === false ? true : value === true ? false : value === 0 ? 1 : 'PAPER';
    assert.throws(() => validateOriginalMinuteRun(changed, selection()), hasCode('ORIGINAL_MINUTE_SAFETY_CONTRACT_INVALID'), key);
  }
});
test('response must match every selected parameter, including costs and FX', () => {
  const mutations = [
    (job: any) => { job.selection.startDate = '2025-01-02'; }, (job: any) => { job.selection.symbol = 'KRW-ETH'; },
    (job: any) => { job.selection.strategy.fast = 3; }, (job: any) => { job.selection.costModel.entryFeeRate = 0.001; },
    (job: any) => { job.selection.riskFraction = 0.02; }, (job: any) => { job.selection.initialCapitalKRW = 2000000; },
  ];
  for (const mutate of mutations) { const changed = clone(run()); mutate(changed); assert.throws(() => validateOriginalMinuteRun(changed, selection()), hasCode('ORIGINAL_MINUTE_SELECTION_MISMATCH')); }
  const us = changeOriginalMinuteMarket(createOriginalMinuteForm(NOW), 'US_STOCK'); us.fxRateKRWPerQuote = '1300';
  const request = normalizeOriginalMinuteForm(us, NOW); const changed = clone(run('RUNNING', request)); changed.selection.fxRateKRWPerQuote = 1400;
  assert.throws(() => validateOriginalMinuteRun(changed, request), hasCode('ORIGINAL_MINUTE_SELECTION_MISMATCH'));
});
test('BLOCKED_DATA preserves null unknown values and rejects an injected partial result', () => {
  const blocked = validateOriginalMinuteRun(run('BLOCKED_DATA'), selection());
  assert.equal(blocked.report, null); assert.equal(blocked.coverage.missingSourceDays, null); assert.equal(blocked.actualFillCount, null);
  assert.equal(blocked.coverage.missingExpectedStockSessions, null);
  assert.throws(() => validateOriginalMinuteRun({ ...blocked, report: run('COMPLETED').report }, selection()), hasCode('ORIGINAL_MINUTE_RESPONSE_INVALID'));
});
test('COMPLETED model report retains RESEARCH_HOLD and blocked long horizons stay null', () => {
  const completed = validateOriginalMinuteRun(run('COMPLETED'), selection());
  assert.equal(completed.report?.canonicalPaperResearchReview.status, 'RESEARCH_HOLD');
  assert.equal(completed.report?.horizonReturns.at(-1)?.modeledReturnPercent, null);
  for (const mutate of [
    (job: any) => { job.report.profitabilityProven = true; },
    (job: any) => { job.report.horizonReturns[3].modeledReturnPercent = 0; },
    (job: any) => { job.report.selectedEndDate = '2025-01-30'; },
    (job: any) => { job.report.modeledCostKRW = NaN; },
    (job: any) => { job.report.canonicalPaperResearchReview.paperAdmissionAllowed = true; },
  ]) { const changed = clone(completed); mutate(changed); assert.throws(() => validateOriginalMinuteRun(changed, selection()), OriginalMinuteClientError); }
});
test('source fixture declaration is retained and unsafe source/body strings are rejected', () => {
  const fixture = clone(run('COMPLETED')); fixture.source.sourceClass = 'TEST_FIXTURE'; fixture.source.fixtureOnly = true;
  assert.equal(validateOriginalMinuteRun(fixture, selection()).source.fixtureOnly, true);
  for (const mutate of [
    (job: any) => { job.reason = '/private/archive SECRET'; }, (job: any) => { job.source.sourceClass = '/private/archive'; },
    (job: any) => { job.blockers = ['Bearer SENSITIVE_TEST_TOKEN']; },
    (job: any) => { job.source.currentRosterObservedAtMs = Number.MAX_SAFE_INTEGER; },
  ]) { const changed = clone(run()); mutate(changed); assert.throws(() => validateOriginalMinuteRun(changed, selection()), OriginalMinuteClientError); }
});
test('HTTP failures are status-normalized without reflecting error bodies or credentials', async () => {
  for (const [status, expected] of [[401, 'ORIGINAL_MINUTE_LOGIN_REQUIRED'], [403, 'ORIGINAL_MINUTE_ADMIN_REQUIRED'], [429, 'ORIGINAL_MINUTE_RUN_BUSY'], [500, 'ORIGINAL_MINUTE_SERVICE_ERROR']] as const) {
    const client = createOriginalMinuteClient(async () => new Response('/private/path SENSITIVE_TEST_TOKEN', { status }));
    await assert.rejects(client.start(selection()), error => hasCode(expected)(error) && !String(error).includes('SENSITIVE_TEST_TOKEN'));
  }
});
test('response bounds and fatal UTF-8 reject invalid JSON transport before rendering', async () => {
  const responses = [
    new Response('{}', { status: 202, headers: { 'Content-Type': 'application/json', 'Content-Length': '300000' } }),
    new Response(' '.repeat(262145), { status: 202, headers: { 'Content-Type': 'application/json' } }),
    new Response(new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]), { status: 202, headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const response of responses) await assert.rejects(createOriginalMinuteClient(async () => response).start(selection()), hasCode('ORIGINAL_MINUTE_RESPONSE_INVALID'));
});
test('timeout includes the entire streamed response body and cancels a stalled reader', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } }),
    { status: 202, headers: { 'Content-Type': 'application/json' } });
  const client = createOriginalMinuteClient(async () => response, { timeoutMs: 20 });
  await assert.rejects(client.start(selection()), hasCode('ORIGINAL_MINUTE_REQUEST_TIMED_OUT')); assert.equal(cancelled, true);
});
test('manual lifecycle starts one POST, reads only that run, and stops polling at completion', async () => {
  const pending = deferred<OriginalMinuteBacktestRunV1>(); let starts = 0; let reads = 0;
  const h = harness({ start: async () => { starts += 1; return pending.promise; }, get: async () => { reads += 1; return run('COMPLETED'); }, cancel: async () => run('CANCELLED') });
  assert.equal(starts, 0); const first = h.controller.start(selection()); await h.controller.start(selection()); assert.equal(starts, 1);
  pending.resolve(run()); await first; assert.equal(h.timers.size, 1); await h.fire();
  assert.equal(reads, 1); assert.equal(starts, 1); assert.equal(h.latest().run?.status, 'COMPLETED'); assert.equal(h.timers.size, 0); h.controller.dispose();
});
test('selection reset clears prior results and cancels a late POST acceptance without rendering it', async () => {
  const pending = deferred<OriginalMinuteBacktestRunV1>(); let cancellations = 0;
  const h = harness({ start: async () => pending.promise, get: async () => run(), cancel: async () => { cancellations += 1; return run('CANCELLED'); } });
  const first = h.controller.start(selection()); h.controller.reset(); pending.resolve(run()); await first;
  assert.equal(cancellations, 1); assert.deepEqual(h.latest(), EMPTY_ORIGINAL_MINUTE_RUN); assert.equal(h.timers.size, 0); h.controller.dispose();
});
test('cancel during POST waits for its run id and then issues one DELETE', async () => {
  const pending = deferred<OriginalMinuteBacktestRunV1>(); let cancellations = 0;
  const h = harness({ start: async () => pending.promise, get: async () => run(), cancel: async () => { cancellations += 1; return run('CANCELLED'); } });
  const first = h.controller.start(selection()); await h.controller.cancel(); assert.equal(h.latest().cancelling, true); assert.equal(cancellations, 0);
  pending.resolve(run()); await first; assert.equal(cancellations, 1); assert.equal(h.latest().run?.status, 'CANCELLED'); assert.equal(h.timers.size, 0); h.controller.dispose();
});
test('cancel invalidates a late polling response so COMPLETED cannot replace CANCELLED', async () => {
  const pending = deferred<OriginalMinuteBacktestRunV1>(); let pollSignal: AbortSignal | undefined;
  const h = harness({ start: async () => run(), get: async (_id, _selection, signal) => { pollSignal = signal; return pending.promise; }, cancel: async () => run('CANCELLED') });
  await h.controller.start(selection()); const refresh = h.controller.refresh(); await h.controller.cancel();
  assert.equal(pollSignal?.aborted, true); pending.resolve(run('COMPLETED')); await refresh;
  assert.equal(h.latest().run?.status, 'CANCELLED'); assert.equal(h.timers.size, 0); h.controller.dispose();
});
test('poll failure stops repeated network calls and manual refresh can recover', async () => {
  let reads = 0;
  const h = harness({ start: async () => run(), get: async () => { reads += 1; if (reads === 1) throw new OriginalMinuteClientError('ORIGINAL_MINUTE_NETWORK_UNAVAILABLE'); return run('COMPLETED'); }, cancel: async () => run('CANCELLED') });
  await h.controller.start(selection()); await h.fire(); assert.equal(h.latest().errorCode, 'ORIGINAL_MINUTE_NETWORK_UNAVAILABLE');
  assert.equal(h.timers.size, 0); assert.equal(reads, 1); await h.controller.refresh(); assert.equal(h.latest().run?.status, 'COMPLETED'); h.controller.dispose();
});
test('disposal aborts an in-flight read and never updates an unmounted panel', async () => {
  const pending = deferred<OriginalMinuteBacktestRunV1>(); let pollSignal: AbortSignal | undefined;
  const h = harness({ start: async () => run(), get: async (_id, _selection, signal) => { pollSignal = signal; return pending.promise; }, cancel: async () => run('CANCELLED') });
  await h.controller.start(selection()); const refresh = h.controller.refresh(); const before = h.states.length;
  h.controller.dispose(); pending.resolve(run('COMPLETED')); await refresh; await tick();
  assert.equal(pollSignal?.aborted, true); assert.equal(h.states.length, before); assert.equal(h.timers.size, 0);
});
