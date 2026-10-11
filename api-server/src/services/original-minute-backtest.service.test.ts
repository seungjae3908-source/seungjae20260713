import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createOriginalMinuteBacktestServiceV1 } from './original-minute-backtest.service';
import { ORIGINAL_MINUTE_BACKTEST_SAFETY_V1 } from '../../../packages/strategy-hypothesis/src/original-minute-backtest.js';
import { normalizePublicNativeCryptoRosterV1 } from '../../../market-prediction-lab/src/public-native-crypto-roster-v1.js';
import { persistResearchMinuteSessionV1 } from '../../../market-prediction-lab/src/research-minute-archive-v1.js';
import { runFourMarketOriginalMinutePeriodV1 } from '../../../market-prediction-lab/src/four-market-original-minute-period-v1.js';
import { digestPITMembershipRowsV1 } from '../../../market-prediction-lab/src/historical-pit-venue-universe-gate-v1.js';

// These are generated test data, never retained exchange prices or PIT evidence.
const DAY = 86_400_000;
const D = Date.parse('2026-09-18T00:00:00Z');
const NOW = Date.parse('2026-10-12T12:00:00Z');
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SELECTION = Object.freeze({ market: 'CRYPTO_SPOT', symbol: 'KRW-BTC',
  startDate: '2026-09-18', endDate: '2026-09-18', timeframe: '5m', direction: 'LONG' });
const TERMINAL = ['COMPLETED', 'BLOCKED_DATA', 'CANCELLED', 'TIMED_OUT', 'FAILED'];
type Service = ReturnType<typeof createOriginalMinuteBacktestServiceV1>;

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const privateJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });

function makeCapture(market = 'CRYPTO_SPOT', symbol = market === 'CRYPTO_SPOT' ? 'KRW-BTC' : 'BTCUSDT') {
  const payload = market === 'CRYPTO_SPOT'
    ? [{ market: symbol, market_event: { warning: true, caution: { TRADING_VOLUME_SOARING: true } } }]
    : { code: '00000', data: [{ symbol, baseCoin: symbol.slice(0, -4), quoteCoin: 'USDT',
      symbolStatus: 'normal', symbolType: 'perpetual', isRwa: 'NO' }] };
  const rawResponseText = JSON.stringify(payload);
  const rawResponseSha256 = hash(rawResponseText);
  const observedAtMs = D + 2 * DAY;
  const roster = normalizePublicNativeCryptoRosterV1({ market, payload, observedAtMs, rawResponseSha256 });
  return { status: 'CURRENT_SOURCE_ROSTER_CAPTURED_ONLY', roster, rawResponseText,
    rawResponseSha256, requestStartedAtMs: observedAtMs - 10, responseReceivedAtMs: observedAtMs, httpStatus: 200 };
}
function fixtureRoot(market = 'CRYPTO_SPOT', symbol?: string) {
  const root = mkdtempSync(join(tmpdir(), 'original-minute-service-'));
  chmodSync(root, 0o700);
  mkdirSync(join(root, 'archive'), { mode: 0o700 });
  const capture = makeCapture(market, symbol);
  privateJson(join(root, `${market}-roster.json`), capture);
  return { root, capture, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function blockedResult(input: Record<string, any>, reason = 'ORIGINAL_PERIOD_PRIVATE_SESSION_INDEX_UNAVAILABLE') {
  return { schemaVersion: 'four-market-original-minute-period-v1', status: 'BLOCKED_DATA', reason,
    market: input.market, symbol: input.symbol, selectedStartDate: input.researchWindow?.startDate,
    selectedEndDate: input.researchWindow?.endDate, evidenceScope: input.evidenceScope,
    currentRosterDigestSha256: input.expectedCurrentRosterDigestSha256,
    currentRosterObservedAtMs: input.currentRosterCapture?.roster?.observedAtMs,
    sourceOnlyMode: true, historicalMemberLifespanSelfAttestedNotIndependentlyVerified: false,
    historicalTradingAvailabilityVerified: false, sessionClosePolicy: 'CLOSE_EACH_SOURCE_SESSION',
    historicalPITRosterChecked: false, indexedPrivateSessions: null, verifiedNativeMinuteSessions: null,
    modeledTradeCount: null, modeledReturnPercent: null, modeledNetPnlKRW: null,
    ...ORIGINAL_MINUTE_BACKTEST_SAFETY_V1 };
}
function assertSafety(run: any) {
  assert.equal(run.schemaVersion, 'original-minute-backtest-run-v1');
  for (const [key, value] of Object.entries(ORIGINAL_MINUTE_BACKTEST_SAFETY_V1)) {
    assert.equal(run[key], value, key);
  }
  const text = JSON.stringify(run);
  assert.doesNotMatch(text, /(?:\/private\/fixture|\/tmp\/original-minute-service-|SENSITIVE_TEST_TOKEN|Bearer test-secret|sourceRoot|rawResponseText|minuteBars|stack\")/i);
}
async function waitRun(service: Service, runId: string, wanted = TERMINAL, ownerId = OWNER) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const run = service.get(ownerId, runId);
    assert.ok(run, 'run must remain present before its configured expiry');
    if (wanted.includes(run.status)) return run;
    await delay(5);
  }
  assert.fail(`run did not reach ${wanted.join('/')} within 2 seconds`);
}
async function waitEntered(entered: ReturnType<typeof deferred>) {
  await Promise.race([entered.promise, delay(2_000).then(() => assert.fail('period runner was not entered'))]);
}
function busy(error: any) {
  assert.equal(error?.status, 409);
  assert.equal(error?.code, 'ORIGINAL_MINUTE_REPLAY_BUSY');
  return true;
}
async function persistCrypto(root: string, market: 'CRYPTO_SPOT' | 'CRYPTO_FUTURES', symbol: string, missingMinute = false) {
  const venue = market === 'CRYPTO_SPOT' ? 'UPBIT_KRW' : 'BITGET_USDT_FUTURES';
  const sourceId = market === 'CRYPTO_SPOT'
    ? 'UPBIT_PUBLIC_REST_RETROSPECTIVE_1M' : 'BITGET_PUBLIC_V2_RETROSPECTIVE_1M';
  const minuteBars = Array.from({ length: 1440 }, (_, i) => {
    const open = 100 + i * 0.01 + Math.sin(i / 9);
    const close = 100 + (i + 1) * 0.01 + Math.sin((i + 1) / 9);
    return { market, venue, symbol, sourceId, timestampMs: D + i * 60_000, availableAtMs: D + 2 * DAY,
      open, high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1, close, volume: 100 + i };
  });
  if (missingMinute) minuteBars.splice(17, 1);
  return persistResearchMinuteSessionV1({ root: join(root, 'archive'), source: { market, venue, symbol, sourceId,
    session: { startMs: D, endMs: D + DAY, kind: 'UTC_24H', timeZone: 'UTC',
      calendarSourceId: 'RETROSPECTIVE_UTC_DAY_NOT_INDEPENDENT_PIT_PROOF' },
    minuteBars, sourceMinuteRowsSha256: hash(JSON.stringify(minuteBars)), asOfMs: D + 3 * DAY } });
}

test('valid extreme cost assumptions cannot publish contradictory exhausted-capital and net-loss metrics', async () => {
  const f = fixtureRoot('CRYPTO_FUTURES', 'BTCUSDT');
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW });
  try {
    await persistCrypto(f.root, 'CRYPTO_FUTURES', 'BTCUSDT');
    const started = await service.start(OWNER, { ...SELECTION, market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT',
      leverage: 7, riskFraction: 0.1, fxRateKRWPerQuote: 1400,
      costModel: { entryFeeRate: 0.19, exitFeeRate: 0.19, slippageRate: 0.19,
        spreadRate: 0.19, latencyRate: 0.19, taxRate: 0.19, fundingRatePerSession: 0.19 } });
    const done = await waitRun(service, started.runId);
    assert.equal(done.status, 'BLOCKED_DATA');
    assert.equal(done.reason, 'ORIGINAL_MINUTE_MODEL_EQUITY_RECONCILIATION_FAILED');
    assert.equal(done.report, null);
    assertSafety(done);
  } finally { service.dispose(); f.cleanup(); }
});

test('stock session gaps survive the adapter even when a partial day is present and missing-day count is zero', async () => {
  const f = fixtureRoot();
  privateJson(join(f.root, 'KR_STOCK-pit-manifest.json'), { sourceClass: 'TEST_FIXTURE' });
  privateJson(join(f.root, 'KR_STOCK-stock-calendar.json'), { market: 'KR_STOCK' });
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW,
    runPeriod: async input => ({ ...blockedResult(input, 'STOCK_EXPECTED_ORIGINAL_SESSION_MISSING'),
      sourceOnlyMode: false, currentRosterDigestSha256: null, currentRosterObservedAtMs: null,
      missingSourceDays: 0, missingExpectedStockSessions: 2 }) });
  try {
    const started = await service.start(OWNER, { ...SELECTION, market: 'KR_STOCK', symbol: '005930' });
    const done = await waitRun(service, started.runId);
    assert.equal(done.status, 'BLOCKED_DATA');
    assert.equal(done.coverage.missingSourceDays, 0);
    assert.equal(done.coverage.missingExpectedStockSessions, 2);
    assert.equal(done.report, null);
    assertSafety(done);
  } finally { service.dispose(); f.cleanup(); }
});

test('generated KR and US regular-session PIT fixtures reach the existing PERIOD engine through fixed private files and remain TEST_FIXTURE HOLD', async t => {
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('stock fixture replay must stay offline'); });
  for (const [market, symbol, venue, timeZone, startMs] of [
    ['KR_STOCK', '005930', 'KRX', 'Asia/Seoul', D],
    ['US_STOCK', 'AAPL', 'US_SIP', 'America/New_York', D + 13.5 * 60 * 60_000],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), 'original-minute-stock-fixture-'));
    chmodSync(root, 0o700);
    mkdirSync(join(root, 'archive'), { mode: 0o700 });
    const sourceId = 'TEST_ONLY_PRIVATE_ORIGINAL_1M';
    const session = { startMs, endMs: startMs + 390 * 60_000, kind: 'REGULAR', timeZone,
      calendarSourceId: 'TEST_PRIVATE_HISTORIC_SESSION_NOT_OFFICIAL' };
    const minuteBars = Array.from({ length: 390 }, (_, index) => {
      const open = 100 + 0.02 * index + Math.sin(index / 9);
      const close = 100 + 0.02 * (index + 1) + Math.sin((index + 1) / 9);
      return { market, venue, symbol, sourceId, timestampMs: startMs + index * 60_000,
        availableAtMs: D + 2 * DAY, open, close, high: Math.max(open, close) + 0.1,
        low: Math.min(open, close) - 0.1, volume: 100 + index };
    });
    // The removed row is deliberately synthetic and only exercises the
    // TEST_FIXTURE contract. Neither file asserts a real historical universe.
    const memberships = [
      { symbol, listedAtMs: D - 150 * DAY, removedAtMs: null, halts: [],
        sourceId: 'TEST_HISTORIC_ROSTER', evidenceSha256: 'a'.repeat(64) },
      { symbol: 'DELISTED', listedAtMs: D - 140 * DAY, removedAtMs: D - 120 * DAY, halts: [],
        sourceId: 'TEST_HISTORIC_ROSTER', evidenceSha256: 'a'.repeat(64) },
    ];
    const manifest = { schemaVersion: 'historical-venue-pit-roster-v1', market, venue,
      sourceClass: 'TEST_FIXTURE', testOnly: true, sourceId: 'TEST_HISTORIC_ROSTER',
      coverageStartMs: D - 300 * DAY, coverageEndMs: D + DAY, retrievedAtMs: D + 2 * DAY,
      allListedAndRemovedAttested: true, suspensionsAttested: true, relistedIdentifiersResolved: true,
      memberships, rawMembershipDigestSha256: digestPITMembershipRowsV1(memberships) };
    const stockCalendar = { market, tradingDates: ['2026-09-18'], sessions: [{
      tradingDateLocal: '2026-09-18', startMs, endMs: session.endMs, kind: 'REGULAR', timeZone,
    }] };
    privateJson(join(root, `${market}-pit-manifest.json`), manifest);
    privateJson(join(root, `${market}-stock-calendar.json`), stockCalendar);
    let inputSeen: Record<string, any> | undefined;
    let periodSeen: Record<string, any> | undefined;
    const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: root, now: () => NOW,
      runPeriod: async input => { inputSeen = input; periodSeen = await runFourMarketOriginalMinutePeriodV1(input); return periodSeen; } });
    try {
      const archived = await persistResearchMinuteSessionV1({ root: join(root, 'archive'), source: {
        market, venue, symbol, sourceId, session, minuteBars,
        sourceMinuteRowsSha256: hash(JSON.stringify(minuteBars)), asOfMs: D + 3 * DAY,
      } });
      assert.match(archived.sourceDigestSha256, /^[a-f0-9]{64}$/);
      const fx = market === 'KR_STOCK' ? 1 : 1400;
      // Explicit test assumptions, not historical tax schedules or FX evidence.
      const costs = { entryFeeRate: 0.0001, exitFeeRate: 0.0001, spreadRate: 0.0001,
        slippageRate: 0.0001, latencyRate: 0, taxRate: market === 'KR_STOCK' ? 0.002 : 0.0001,
        fundingRatePerSession: 0 };
      const started = await service.start(OWNER, { ...SELECTION, market, symbol, direction: 'LONG',
        leverage: 1, fxRateKRWPerQuote: fx, costModel: costs });
      const done = await waitRun(service, started.runId);
      assert.equal(done.status, 'COMPLETED', `${market}: ${done.reason}`);
      assert.ok(inputSeen && periodSeen && done.report);
      assert.deepEqual(inputSeen.manifest, manifest);
      assert.deepEqual(inputSeen.stockCalendar, stockCalendar);
      assert.equal(inputSeen.root, join(root, 'archive'));
      assert.equal(inputSeen.currentRosterCapture, undefined);
      assert.equal(inputSeen.direction, 'LONG');
      assert.equal(inputSeen.fxRateKRWPerQuote, fx);
      assert.deepEqual(inputSeen.costModel, costs);
      assert.equal(new Date(stockCalendar.sessions[0].endMs).toISOString(), market === 'KR_STOCK'
        ? '2026-09-18T06:30:00.000Z' : '2026-09-18T20:00:00.000Z');
      assert.equal(periodSeen.fixtureOnly, true);
      assert.equal(periodSeen.historicalPITUniverseIndependentlyVerified, false);
      assert.equal(periodSeen.officialStockCalendarIndependentlyVerified, false);
      assert.equal(done.source.evidenceScope, 'HISTORICAL_PIT_ROSTER');
      assert.equal(done.source.sourceClass, 'TEST_FIXTURE');
      assert.equal(done.source.fixtureOnly, true);
      assert.equal(done.source.historicalPITRosterChecked, true);
      assert.equal(done.source.currentRosterDigestSha256, null);
      assert.equal(done.source.currentRosterObservedAtMs, null);
      for (const key of ['sourceSessionIndexDigestSha256', 'sourceModelDigestSha256'] as const) {
        assert.match(done.source[key] ?? '', /^[a-f0-9]{64}$/);
        assert.equal(done.source[key], periodSeen[key]);
      }
      assert.equal(done.coverage.indexedPrivateSessions, 1);
      assert.equal(done.coverage.verifiedNativeMinuteSessions, 1);
      assert.equal(done.report.kind, 'PERIOD');
      assert.equal(done.report.symbol, symbol);
      assert.equal(done.report.direction, 'LONG');
      assert.equal(done.report.sourceSessionsVerified, 1);
      assert.ok(Number.isFinite(done.report.modeledReturnPercent));
      assert.equal(done.report.modeledReturnPercent, periodSeen.modeledReturnPercent);
      assert.equal(done.report.modeledCostKRW, periodSeen.modeledCostKRW);
      assert.equal(done.report.canonicalPaperResearchReview.status, 'RESEARCH_HOLD');
      assert.equal(done.report.canonicalPaperResearchReview.paperAdmissionAllowed, false);
      assert.equal(done.report.paperCandidatePASS, false);
      assert.equal(done.report.independentOOSProven, false);
      assert.equal(JSON.stringify(done).includes(root), false);
      assertSafety(done);
    } finally { service.dispose(); rmSync(root, { recursive: true, force: true }); }
  }
  assert.equal(fetches, 0);
});

test('original minute service rejects caller source, credential, execution and nested cost fields before reading data', async () => {
  let calls = 0;
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: '', now: () => NOW,
    runPeriod: async input => { calls++; return blockedResult(input); } });
  try {
    for (const fields of [
      { sourceRoot: '/private/fixture' }, { root: '/private/fixture' }, { archiveRoot: '/private/fixture' },
      { manifest: {} }, { currentRosterCapture: makeCapture() }, { sourceSessions: [] },
      { asOfMs: NOW }, { deadlineMs: NOW + DAY }, { cursorStartMs: D }, { maximumCandles: 20_000 },
      { executionAuthority: 'PAPER' }, { apiKey: 'SENSITIVE_TEST_TOKEN' }, { orderSubmitted: true },
      { strategy: { kind: 'EMA_TREND', evaluate: 'process.env' } },
      { costModel: { providerToken: 'SENSITIVE_TEST_TOKEN' } },
      { costModel: { entryFeeRate: { value: 0 } } }, { costModel: { fundingRatePerSession: 0.001 } },
    ]) {
      await assert.rejects(service.start(OWNER, { ...SELECTION, ...fields }),
        (error: any) => error instanceof TypeError && /^ORIGINAL_MINUTE_[A-Z_]+$/.test(error.message),
        JSON.stringify(Object.keys(fields)));
    }
    assert.equal(calls, 0);
  } finally { service.dispose(); }
});

test('original minute service enforces market direction, explicit FX, valid dates and bounded numeric assumptions', async () => {
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: '', now: () => NOW });
  try {
    for (const nonObject of [null, [], 'CRYPTO_SPOT', 1]) {
      await assert.rejects(service.start(OWNER, nonObject), TypeError);
    }
    for (const request of [
      { ...SELECTION, direction: 'SHORT' }, { ...SELECTION, leverage: 2 },
      { ...SELECTION, startDate: '2026-02-30' }, { ...SELECTION, endDate: '2026-09-17' },
      { ...SELECTION, endDate: '2027-01-01' }, { ...SELECTION, symbol: '../../etc/passwd' },
      { ...SELECTION, costModel: { exitFeeRate: Number.NaN } },
      { ...SELECTION, market: 'US_STOCK', symbol: 'AAPL' },
      { ...SELECTION, market: 'KR_STOCK', symbol: '005930', timeframe: '1d' },
      { ...SELECTION, market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', fxRateKRWPerQuote: 1300, leverage: 7.5 },
    ]) await assert.rejects(service.start(OWNER, request), TypeError);
  } finally { service.dispose(); }
});

test('missing sources across all four markets remain BLOCKED_DATA with null modeled returns', async () => {
  let calls = 0;
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: '', now: () => NOW,
    runPeriod: async input => { calls++; return blockedResult(input); } });
  try {
    for (const [market, symbol] of [['KR_STOCK', '005930'], ['US_STOCK', 'AAPL'],
      ['CRYPTO_SPOT', 'KRW-BTC'], ['CRYPTO_FUTURES', 'BTCUSDT']]) {
      const run = await service.start(OWNER, { ...SELECTION, market, symbol,
        ...(['US_STOCK', 'CRYPTO_FUTURES'].includes(market) ? { fxRateKRWPerQuote: 1300 } : {}) });
      const done = await waitRun(service, run.runId);
      assert.equal(done.status, 'BLOCKED_DATA', market);
      assert.equal(done.report, null);
      assert.equal(done.netProfitPct, null);
      assertSafety(done);
    }
    assert.equal(calls, 0);
  } finally { service.dispose(); }
});

test('fixed private roster capture is SHA-bound and long selections reach the existing PERIOD engine unchanged', async () => {
  const f = fixtureRoot();
  const entered = deferred();
  const held = deferred();
  let inputSeen: Record<string, any> | undefined;
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW,
    runPeriod: async input => { inputSeen = input; entered.resolve(input); return held.promise; } });
  try {
    const selection = { ...SELECTION, startDate: '2016-09-19', endDate: '2026-09-18', timeframe: '1m' };
    const started = await service.start(OWNER, selection);
    assert.match(started.runId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
    await waitEntered(entered);
    assert.ok(inputSeen);
    assert.deepEqual(inputSeen.researchWindow, { startDate: selection.startDate, endDate: selection.endDate });
    assert.equal(inputSeen.timeframe, '1m');
    assert.equal(inputSeen.root, join(f.root, 'archive'));
    assert.equal(inputSeen.asOfMs, NOW);
    assert.equal(inputSeen.evidenceScope, 'CURRENT_PROVIDER_ROSTER_SOURCE_ONLY');
    assert.deepEqual(inputSeen.currentRosterCapture, f.capture);
    assert.equal(inputSeen.expectedCurrentRosterDigestSha256, f.capture.roster.rosterDigestSha256);
    assert.equal(inputSeen.currentRosterCapture.roster.historicalUniverseComplete, false);
    assert.deepEqual(inputSeen.currentRosterCapture.roster.warningSymbols, ['KRW-BTC']);
    assert.equal(inputSeen.manifest, undefined);
    assert.equal(inputSeen.maximumCandles, undefined);
    assert.equal(inputSeen.maximumDurationDays, undefined);
    assert.ok(inputSeen.signal instanceof AbortSignal);
    held.resolve(blockedResult(inputSeen));
    const done = await waitRun(service, started.runId);
    assert.deepEqual(done.selection.startDate, selection.startDate);
    assert.deepEqual(done.selection.endDate, selection.endDate);
    assert.equal(done.status, 'BLOCKED_DATA');
    assertSafety(done);
  } finally { held.resolve({}); service.dispose(); f.cleanup(); }
});

test('private source reader rejects roster-byte substitution, normalized-only captures and wrong market identity', async () => {
  const f = fixtureRoot();
  let calls = 0;
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW,
    runPeriod: async input => { calls++; return blockedResult(input); } });
  try {
    const rawChanged = JSON.parse(JSON.stringify(f.capture));
    rawChanged.rawResponseText = rawChanged.rawResponseText.replace('true', 'false');
    for (const value of [rawChanged, f.capture.roster, makeCapture('CRYPTO_FUTURES'),
      { ...f.capture, rawResponseSha256: 'f'.repeat(64) }]) {
      privateJson(join(f.root, 'CRYPTO_SPOT-roster.json'), value);
      const run = await service.start(OWNER, SELECTION);
      const done = await waitRun(service, run.runId);
      assert.equal(done.status, 'BLOCKED_DATA');
      assert.equal(done.report, null);
      assertSafety(done);
    }
    assert.equal(calls, 0);
  } finally { service.dispose(); f.cleanup(); }
});

test('private source reader requires private files and refuses symlinks and multiply linked files', async () => {
  const f = fixtureRoot();
  const file = join(f.root, 'CRYPTO_SPOT-roster.json');
  const peer = join(f.root, 'other-roster.json');
  let calls = 0;
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW,
    runPeriod: async input => { calls++; return blockedResult(input); } });
  const blocked = async () => {
    const started = await service.start(OWNER, SELECTION);
    const done = await waitRun(service, started.runId);
    assert.equal(done.status, 'BLOCKED_DATA');
    assert.equal(done.report, null);
    assertSafety(done);
  };
  try {
    chmodSync(file, 0o644); await blocked();
    chmodSync(file, 0o600); chmodSync(f.root, 0o755); await blocked();
    chmodSync(f.root, 0o700);
    rmSync(file); privateJson(peer, f.capture); symlinkSync(peer, file); await blocked();
    rmSync(file); linkSync(peer, file); await blocked();
    assert.equal(calls, 0);
  } finally { service.dispose(); f.cleanup(); }
});

test('missing stock PIT and session-calendar files cannot be replaced by a crypto capture', async () => {
  const f = fixtureRoot();
  let calls = 0;
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW,
    runPeriod: async input => { calls++; return blockedResult(input); } });
  try {
    for (const [market, symbol] of [['KR_STOCK', '005930'], ['US_STOCK', 'AAPL']]) {
      const started = await service.start(OWNER, { ...SELECTION, market, symbol,
        ...(market === 'US_STOCK' ? { fxRateKRWPerQuote: 1300 } : {}) });
      const done = await waitRun(service, started.runId);
      assert.equal(done.status, 'BLOCKED_DATA');
      assert.equal(done.report, null);
      assert.equal(done.source.historicalPITRosterChecked, false);
      assertSafety(done);
    }
    assert.equal(calls, 0);
  } finally { service.dispose(); f.cleanup(); }
});

test('owner isolation and cancellation retain execution capacity until the original engine settles', async () => {
  const f = fixtureRoot();
  const entered = deferred();
  const held = deferred();
  let calls = 0;
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW,
    runPeriod: async input => { calls++; entered.resolve(input); return calls === 1 ? held.promise : blockedResult(input); } });
  try {
    const started = await service.start(OWNER, SELECTION);
    const input = await entered.promise;
    assert.equal(service.get(OTHER, started.runId), null);
    assert.equal(service.cancel(OTHER, started.runId), null);
    assert.equal(service.get(OWNER, started.runId)?.status, 'RUNNING');
    await assert.rejects(service.start(OTHER, SELECTION), busy);
    const cancelling = service.cancel(OWNER, started.runId);
    assert.equal(cancelling?.status, 'CANCELLING');
    assert.equal(input.signal.aborted, true);
    assertSafety(cancelling);
    await assert.rejects(service.start(OWNER, SELECTION), busy);
    held.resolve({ ...blockedResult(input), profitabilityProven: true, executionAuthority: 'LIVE' });
    const done = await waitRun(service, started.runId, ['CANCELLED']);
    assert.equal(done.report, null);
    assertSafety(done);
    const next = await service.start(OTHER, SELECTION);
    assert.notEqual(next.runId, started.runId);
    assert.equal((await waitRun(service, next.runId, TERMINAL, OTHER)).status, 'BLOCKED_DATA');
    assert.equal(calls, 2);
  } finally { held.resolve({}); service.dispose(); f.cleanup(); }
});

test('deadline abort stays fail closed while an uncooperative period runner still owns capacity', async () => {
  const f = fixtureRoot();
  const entered = deferred();
  const held = deferred();
  let calls = 0;
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW, maxRunMs: 40,
    runPeriod: async input => { calls++; entered.resolve(input); return calls === 1 ? held.promise : blockedResult(input); } });
  try {
    const started = await service.start(OWNER, SELECTION);
    const input = await entered.promise;
    const timeout = await waitRun(service, started.runId, ['CANCELLING']);
    assert.equal(input.signal.aborted, true);
    assert.equal(timeout.reason, 'ORIGINAL_MINUTE_REPLAY_TIME_BUDGET_EXCEEDED');
    assert.equal(timeout.finishedAtMs, null);
    assert.equal(timeout.report, null);
    assertSafety(timeout);
    await assert.rejects(service.start(OTHER, SELECTION), busy);
    held.resolve(blockedResult(input));
    assert.equal((await waitRun(service, started.runId, ['TIMED_OUT'])).status, 'TIMED_OUT');
    const next = await service.start(OTHER, SELECTION);
    assert.equal((await waitRun(service, next.runId, TERMINAL, OTHER)).status, 'BLOCKED_DATA');
  } finally { held.resolve({}); service.dispose(); f.cleanup(); }
});

test('finished results expire and bounded storage evicts old results without sharing owners', async () => {
  const f = fixtureRoot();
  let now = NOW;
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => now,
    resultTtlMs: 1000, maxStoredRuns: 2, runPeriod: async input => blockedResult(input) });
  try {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = await service.start(OWNER, SELECTION);
      await waitRun(service, run.runId);
      ids.push(run.runId);
      now += 10;
    }
    assert.equal(service.get(OWNER, ids[0]), null);
    assert.ok(service.get(OWNER, ids[1]));
    assert.ok(service.get(OWNER, ids[2]));
    assert.equal(service.get(OTHER, ids[2]), null);
    now += 1001;
    assert.equal(service.get(OWNER, ids[1]), null);
    assert.equal(service.get(OWNER, ids[2]), null);
    assert.equal(service.cancel(OWNER, ids[2]), null);
  } finally { service.dispose(); f.cleanup(); }
});

test('unknown runner exceptions expose only a fixed failure code and release capacity', async () => {
  const f = fixtureRoot();
  let calls = 0;
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW,
    runPeriod: async input => {
      if (++calls === 1) throw new Error('/private/fixture/provider.txt Bearer test-secret SENSITIVE_TEST_TOKEN');
      return blockedResult(input);
    } });
  try {
    const started = await service.start(OWNER, SELECTION);
    const failed = await waitRun(service, started.runId);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.reason, 'ORIGINAL_MINUTE_REPLAY_FAILED');
    assert.equal(failed.report, null);
    assertSafety(failed);
    const retry = await service.start(OWNER, SELECTION);
    assert.equal((await waitRun(service, retry.runId)).status, 'BLOCKED_DATA');
  } finally { service.dispose(); f.cleanup(); }
});

test('forged profitable and executable runner output is never admitted or reflected', async () => {
  const f = fixtureRoot();
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW,
    runPeriod: async input => {
      const valid = await runFourMarketOriginalMinutePeriodV1(input);
      assert.equal(valid.status, 'SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY');
      return { ...valid, reason: '/private/fixture SENSITIVE_TEST_TOKEN', modeledReturnPercent: 999,
        profitabilityProven: true, OOSPassCount: 100, trueMarketWideRecall: 1, actualFillCount: 100,
        paperAdmissionAllowed: true, executionAuthority: 'LIVE', automaticPaperExecution: true,
        orderSubmitted: true, realOrders: true, providerGETCount: 50, apiKey: 'SENSITIVE_TEST_TOKEN',
        canonicalPaperResearchReview: { status: 'PASS', paperAdmissionAllowed: true } };
    } });
  try {
    await persistCrypto(f.root, 'CRYPTO_SPOT', 'KRW-BTC');
    const started = await service.start(OWNER, SELECTION);
    const done = await waitRun(service, started.runId);
    assert.notEqual(done.status, 'COMPLETED');
    assert.equal(done.report, null);
    assertSafety(done);
  } finally { service.dispose(); f.cleanup(); }
});

test('actual generated original archives run through existing PERIOD and retain source-only HOLD for spot and native Han futures', async t => {
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('source requests are prohibited in local replay'); });
  for (const [market, symbol] of [['CRYPTO_SPOT', 'KRW-BTC'], ['CRYPTO_FUTURES', '龙虾USDT']] as const) {
    const f = fixtureRoot(market, symbol);
    const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW,
      runPeriod: async input => ({ ...await runFourMarketOriginalMinutePeriodV1(input),
        sourceRoot: '/private/fixture', apiKey: 'SENSITIVE_TEST_TOKEN', minuteBars: [{ private: true }] }) });
    try {
      await persistCrypto(f.root, market, symbol);
      const started = await service.start(OWNER, { ...SELECTION, market, symbol,
        ...(market === 'CRYPTO_FUTURES' ? { direction: 'SHORT', leverage: 2, fxRateKRWPerQuote: 1300 } : {}),
        strategy: { kind: 'EMA_TREND', fast: 2, slow: 5, stopPercent: 0.8, targetPercent: 1.4 },
        costModel: { entryFeeRate: 0.0006, exitFeeRate: 0.0006, spreadRate: 0.0004, slippageRate: 0.0006,
          latencyRate: 0.0001, taxRate: 0, fundingRatePerSession: market === 'CRYPTO_FUTURES' ? 0.0001 : 0 } });
      const done = await waitRun(service, started.runId);
      assert.equal(done.status, 'COMPLETED', `${market}: ${done.reason}`);
      assert.ok(done.report);
      assert.equal(done.report.symbol, symbol);
      assert.equal(done.report.kind, 'PERIOD');
      assert.equal(done.report.status, 'SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY');
      assert.equal(done.report.sourceSessionsVerified, 1);
      assert.ok(Number.isFinite(done.report.modeledReturnPercent));
      assert.ok(done.report.modeledTradeCount >= 0);
      assert.ok(done.report.modeledCostKRW >= 0);
      assert.equal(done.report.sessionClosePolicy, 'CLOSE_EACH_SOURCE_SESSION');
      assert.equal(done.report.canonicalPaperResearchReview.status, 'RESEARCH_HOLD');
      assert.equal(done.report.canonicalPaperResearchReview.paperAdmissionAllowed, false);
      assert.equal(done.report.paperCandidatePASS, false);
      assert.equal(done.report.independentOOSProven, false);
      assert.equal(done.source.evidenceScope, 'CURRENT_PROVIDER_ROSTER_SOURCE_ONLY');
      assert.equal(done.source.currentRosterDigestSha256, f.capture.roster.rosterDigestSha256);
      assert.equal(done.source.historicalPITRosterChecked, false);
      assert.equal(done.coverage.verifiedNativeMinuteSessions, 1);
      assertSafety(done);
    } finally { service.dispose(); f.cleanup(); }
  }
  assert.equal(fetches, 0);
});

test('one missing original minute blocks the whole requested session without zero-return substitution', async () => {
  const f = fixtureRoot();
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW });
  try {
    await persistCrypto(f.root, 'CRYPTO_SPOT', 'KRW-BTC', true);
    const started = await service.start(OWNER, SELECTION);
    const done = await waitRun(service, started.runId);
    assert.equal(done.status, 'BLOCKED_DATA');
    assert.equal(done.report, null);
    assert.equal(done.netProfitPct, null);
    assert.match(done.reason ?? '', /GAP|INCOMPLETE|BLOCKED/);
    assertSafety(done);
  } finally { service.dispose(); f.cleanup(); }
});

test('one stored day cannot satisfy a longer selected period or manufacture missing-day opportunities', async () => {
  const f = fixtureRoot();
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW });
  try {
    await persistCrypto(f.root, 'CRYPTO_SPOT', 'KRW-BTC');
    const started = await service.start(OWNER, { ...SELECTION, startDate: '2016-09-19', timeframe: '1m' });
    const done = await waitRun(service, started.runId);
    assert.equal(done.status, 'BLOCKED_DATA');
    assert.equal(done.selection.startDate, '2016-09-19');
    assert.equal(done.report, null);
    assert.equal(done.actualMarketWideOpportunityCount, null);
    assert.ok((done.coverage.missingSourceDays ?? 0) > 366);
    assertSafety(done);
  } finally { service.dispose(); f.cleanup(); }
});
