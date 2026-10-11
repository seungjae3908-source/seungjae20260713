import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AuthenticatedRequest } from '../middleware/auth';
import { createOriginalMinuteBacktestsRouterV1 } from './original-minute-backtests';
import { createOriginalMinuteBacktestServiceV1 } from '../services/original-minute-backtest.service';
import { ORIGINAL_MINUTE_BACKTEST_SAFETY_V1 } from '../../../packages/strategy-hypothesis/src/original-minute-backtest.js';
import { normalizePublicNativeCryptoRosterV1 } from '../../../market-prediction-lab/src/public-native-crypto-roster-v1.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ENDPOINT = '/api/backtests/original-minute/runs';
const SELECTION = Object.freeze({ market: 'CRYPTO_SPOT', symbol: 'KRW-BTC',
  startDate: '2026-09-18', endDate: '2026-09-18', timeframe: '5m', direction: 'LONG' });
type Service = ReturnType<typeof createOriginalMinuteBacktestServiceV1>;

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(ok => { resolve = ok; });
  return { promise, resolve };
}
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'original-minute-http-'));
  chmodSync(root, 0o700);
  mkdirSync(join(root, 'archive'), { mode: 0o700 });
  const observedAtMs = Date.parse('2026-09-20T00:00:00Z');
  const payload = [{ market: 'KRW-BTC', market_event: { warning: false, caution: {} } }];
  const rawResponseText = JSON.stringify(payload);
  const rawResponseSha256 = createHash('sha256').update(rawResponseText).digest('hex');
  const roster = normalizePublicNativeCryptoRosterV1({ market: 'CRYPTO_SPOT', payload, observedAtMs, rawResponseSha256 });
  writeFileSync(join(root, 'CRYPTO_SPOT-roster.json'), JSON.stringify({
    status: 'CURRENT_SOURCE_ROSTER_CAPTURED_ONLY', roster, rawResponseText, rawResponseSha256,
    requestStartedAtMs: observedAtMs - 10, responseReceivedAtMs: observedAtMs, httpStatus: 200,
  }), { mode: 0o600 });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function blockedResult(input: Record<string, any>) {
  return { schemaVersion: 'four-market-original-minute-period-v1', status: 'BLOCKED_DATA',
    reason: 'ORIGINAL_PERIOD_PRIVATE_SESSION_INDEX_UNAVAILABLE', market: input.market, symbol: input.symbol,
    selectedStartDate: input.researchWindow?.startDate, selectedEndDate: input.researchWindow?.endDate,
    evidenceScope: input.evidenceScope, historicalPITRosterChecked: false,
    sourceOnlyMode: true, historicalMemberLifespanSelfAttestedNotIndependentlyVerified: false,
    historicalTradingAvailabilityVerified: false, sessionClosePolicy: 'CLOSE_EACH_SOURCE_SESSION',
    currentRosterDigestSha256: input.expectedCurrentRosterDigestSha256,
    currentRosterObservedAtMs: input.currentRosterCapture?.roster?.observedAtMs,
    indexedPrivateSessions: null, verifiedNativeMinuteSessions: null,
    modeledTradeCount: null, modeledReturnPercent: null, ...ORIGINAL_MINUTE_BACKTEST_SAFETY_V1 };
}
async function withServer(service: Service) {
  const app = express();
  app.use(express.json({ limit: '128kb' }));
  // Fixtures model the already authenticated parent router. No credentials,
  // remote identity service, database, exchange or order adapter are involved.
  app.use((req: AuthenticatedRequest, _res, next) => {
    const role = req.header('x-fixture-role');
    if (!role || role === 'anonymous') return next();
    const admin = role === 'admin';
    req.member = {
      id: req.header('x-fixture-owner') || OWNER,
      login_name: 'test', display_name: 'test',
      role: admin ? 'admin' : 'user', membership_level: admin ? 'admin' : 'regular',
      status: 'approved', is_active: true,
    };
    next();
  });
  app.use('/api', createOriginalMinuteBacktestsRouterV1(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve); server.once('error', reject);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: async () => {
    service.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
const headers = (owner = OWNER, role = 'admin') => ({ 'content-type': 'application/json',
  'x-fixture-role': role, 'x-fixture-owner': owner });
async function safeJson(response: Response) {
  const text = await response.text();
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
  assert.doesNotMatch(text, /(?:\/private\/fixture|\/tmp\/original-minute-http-|SENSITIVE_TEST_TOKEN|Bearer test-secret|rawResponseText|minuteBars|stack\")/i);
  return JSON.parse(text) as Record<string, any>;
}
function assertSafety(run: Record<string, any>) {
  for (const [key, value] of Object.entries(ORIGINAL_MINUTE_BACKTEST_SAFETY_V1)) assert.equal(run[key], value, key);
}
async function start(base: string, request: unknown = SELECTION, owner = OWNER) {
  return fetch(base + ENDPOINT, { method: 'POST', headers: headers(owner), body: JSON.stringify(request) });
}
async function poll(base: string, runId: string, wanted = ['COMPLETED', 'BLOCKED_DATA', 'CANCELLED', 'TIMED_OUT', 'FAILED']) {
  for (let i = 0; i < 300; i++) {
    const response = await fetch(`${base}${ENDPOINT}/${runId}`, { headers: headers() });
    assert.equal(response.status, 200);
    const run = await safeJson(response);
    if (wanted.includes(run.status)) return run;
    await delay(5);
  }
  assert.fail('HTTP run did not finish within the local test budget');
}

test('original minute HTTP requires authenticated administrators before source or engine access', async () => {
  let calls = 0;
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: '', now: () => NOW,
    runPeriod: async input => { calls++; return blockedResult(input); } });
  const http = await withServer(service);
  try {
    const id = '33333333-3333-4333-8333-333333333333';
    for (const [method, path] of [['POST', ENDPOINT], ['GET', `${ENDPOINT}/${id}`], ['DELETE', `${ENDPOINT}/${id}`]]) {
      for (const [role, code] of [['anonymous', 401], ['member', 403]] as const) {
        const response = await fetch(http.base + path, { method, headers: headers(OWNER, role),
          ...(method === 'POST' ? { body: JSON.stringify(SELECTION) } : {}) });
        assert.equal(response.status, code, `${method}: ${role}`);
        const denied = await safeJson(response);
        if (code === 403) assert.deepEqual(denied, { error: 'ADMIN_REQUIRED' });
        else {
          assert.ok(typeof denied.code === 'string');
          assertSafety(denied);
        }
      }
    }
    assert.equal(calls, 0);
  } finally { await http.close(); }
});

test('admin HTTP creates a private model job; missing KR and US data stay null with no execution credit', async () => {
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: '', now: () => NOW });
  const http = await withServer(service);
  try {
    for (const [market, symbol] of [['KR_STOCK', '005930'], ['US_STOCK', 'AAPL']]) {
      const response = await start(http.base, { ...SELECTION, market, symbol,
        ...(market === 'US_STOCK' ? { fxRateKRWPerQuote: 1300 } : {}) });
      assert.equal(response.status, 202);
      assert.match(response.headers.get('cache-control') ?? '', /no-store/);
      assert.match(response.headers.get('vary') ?? '', /Authorization/i);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const started = await safeJson(response);
      assert.equal(started.schemaVersion, 'original-minute-backtest-run-v1');
      assert.equal(started.selection.market, market);
      assert.equal(started.report, null);
      assertSafety(started);
      const done = await poll(http.base, started.runId);
      assert.equal(done.status, 'BLOCKED_DATA');
      assert.equal(done.report, null);
      assert.equal(done.netProfitPct, null);
      assert.equal(done.actualMarketWideOpportunityCount, null);
      assertSafety(done);
    }
  } finally { await http.close(); }
});

test('HTTP rejects unknown nested fields, caller roots, providers, execution settings and invalid selections', async () => {
  let calls = 0;
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: '', now: () => NOW,
    runPeriod: async input => { calls++; return blockedResult(input); } });
  const http = await withServer(service);
  try {
    for (const request of [
      [], { ...SELECTION, root: '/private/fixture' },
      { ...SELECTION, sourceRoot: '/private/fixture' }, { ...SELECTION, archiveRoot: '/private/fixture' },
      { ...SELECTION, sourceSessions: [] }, { ...SELECTION, manifest: {} },
      { ...SELECTION, apiKey: 'SENSITIVE_TEST_TOKEN' }, { ...SELECTION, orderSubmitted: true },
      { ...SELECTION, executionAuthority: 'PAPER' }, { ...SELECTION, sourceOnlyMode: false },
      { ...SELECTION, strategy: { kind: 'EMA_TREND', sourceCode: 'arbitrary script' } },
      { ...SELECTION, costModel: { entryFeeRate: 0, credentials: 'SENSITIVE_TEST_TOKEN' } },
      { ...SELECTION, costModel: { taxRate: '0' } },
      { ...SELECTION, startDate: '2026-02-30' }, { ...SELECTION, startDate: '2026-09-19' },
      { ...SELECTION, symbol: '../KRW-BTC' }, { ...SELECTION, direction: 'SHORT' },
      { ...SELECTION, market: 'US_STOCK', symbol: 'AAPL' },
    ]) {
      const response = await start(http.base, request);
      assert.equal(response.status, 400, JSON.stringify(request));
      const body = await safeJson(response);
      assert.match(body.code, /^ORIGINAL_MINUTE_[A-Z_]+$/);
      assertSafety(body);
    }
    assert.equal(calls, 0);
  } finally { await http.close(); }
});

test('HTTP query parameters cannot override source paths or job selection and DELETE bodies cannot inject controls', async () => {
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: '', now: () => NOW });
  const http = await withServer(service);
  try {
    for (const query of ['?root=%2Fprivate%2Ffixture', '?market=CRYPTO_SPOT', '?market=CRYPTO_SPOT&market=KR_STOCK']) {
      const response = await fetch(http.base + ENDPOINT + query, { method: 'POST', headers: headers(), body: JSON.stringify(SELECTION) });
      assert.equal(response.status, 400);
      assertSafety(await safeJson(response));
    }
    const accepted = await start(http.base);
    assert.equal(accepted.status, 202);
    const runId = (await safeJson(accepted)).runId;
    await poll(http.base, runId);
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${http.base}${ENDPOINT}/${runId}?sourceRoot=%2Fprivate%2Ffixture`, { method, headers: headers() });
      assert.equal(response.status, 400, method);
      assertSafety(await safeJson(response));
    }
    const injected = await fetch(`${http.base}${ENDPOINT}/${runId}`, { method: 'DELETE', headers: headers(),
      body: JSON.stringify({ executionAuthority: 'LIVE' }) });
    assert.equal(injected.status, 400);
    assertSafety(await safeJson(injected));
  } finally { await http.close(); }
});

test('HTTP long period and current-capture identity survive start→poll; another owner cannot observe or cancel', async () => {
  const f = fixtureRoot();
  const entered = deferred();
  const held = deferred();
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW,
    runPeriod: async input => { entered.resolve(input); return held.promise; } });
  const http = await withServer(service);
  try {
    const response = await start(http.base, { ...SELECTION, startDate: '2016-09-19', timeframe: '1m' });
    assert.equal(response.status, 202);
    const started = await safeJson(response);
    const input = await entered.promise;
    assert.deepEqual(input.researchWindow, { startDate: '2016-09-19', endDate: '2026-09-18' });
    assert.equal(input.timeframe, '1m');
    assert.equal(input.root, join(f.root, 'archive'));
    assert.equal(input.currentRosterCapture.roster.historicalUniverseComplete, false);
    for (const method of ['GET', 'DELETE']) {
      const denied = await fetch(`${http.base}${ENDPOINT}/${started.runId}`, { method, headers: headers(OTHER) });
      assert.equal(denied.status, 404, method);
      assertSafety(await safeJson(denied));
    }
    const own = await safeJson(await fetch(`${http.base}${ENDPOINT}/${started.runId}`, { headers: headers() }));
    assert.equal(own.status, 'RUNNING');
    assert.equal(own.selection.startDate, '2016-09-19');
    assertSafety(own);
    held.resolve(blockedResult(input));
    const done = await poll(http.base, started.runId);
    assert.equal(done.status, 'BLOCKED_DATA');
    assert.equal(done.report, null);
    assertSafety(done);
  } finally { held.resolve({}); await http.close(); f.cleanup(); }
});

test('HTTP busy and cancellation preserve one active engine until its underlying work settles', async () => {
  const f = fixtureRoot();
  const entered = deferred();
  const held = deferred();
  let calls = 0;
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW,
    runPeriod: async input => { calls++; entered.resolve(input); return calls === 1 ? held.promise : blockedResult(input); } });
  const http = await withServer(service);
  try {
    const response = await start(http.base);
    assert.equal(response.status, 202);
    const started = await safeJson(response);
    const input = await entered.promise;
    const busy = await start(http.base, SELECTION, OTHER);
    assert.equal(busy.status, 409);
    const busyBody = await safeJson(busy);
    assert.equal(busyBody.code, 'ORIGINAL_MINUTE_REPLAY_BUSY');
    assertSafety(busyBody);
    const cancelled = await fetch(`${http.base}${ENDPOINT}/${started.runId}`, { method: 'DELETE', headers: headers() });
    assert.equal(cancelled.status, 200);
    const cancelling = await safeJson(cancelled);
    assert.equal(cancelling.status, 'CANCELLING');
    assert.equal(input.signal.aborted, true);
    assertSafety(cancelling);
    assert.equal((await start(http.base)).status, 409);
    held.resolve({ ...blockedResult(input), executionAuthority: 'LIVE', profitabilityProven: true });
    const done = await poll(http.base, started.runId, ['CANCELLED']);
    assert.equal(done.report, null);
    assertSafety(done);
    const next = await start(http.base);
    assert.equal(next.status, 202);
    const retry = await safeJson(next);
    assert.notEqual(retry.runId, started.runId);
    assert.equal((await poll(http.base, retry.runId)).status, 'BLOCKED_DATA');
    assert.equal(calls, 2);
  } finally { held.resolve({}); await http.close(); f.cleanup(); }
});

test('HTTP expired and unknown run IDs are indistinguishable from another owner’s results', async () => {
  let now = NOW;
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: '', now: () => now, resultTtlMs: 1000 });
  const http = await withServer(service);
  try {
    const started = await safeJson(await start(http.base));
    await poll(http.base, started.runId);
    now += 1001;
    for (const id of [started.runId, '33333333-3333-4333-8333-333333333333']) {
      for (const method of ['GET', 'DELETE']) {
        const missing = await fetch(`${http.base}${ENDPOINT}/${id}`, { method, headers: headers() });
        assert.equal(missing.status, 404);
        const body = await safeJson(missing);
        assert.ok(typeof body.code === 'string');
        assertSafety(body);
      }
    }
  } finally { await http.close(); }
});

test('HTTP polling exposes a fixed failed job instead of runner paths, credentials or a fabricated zero return', async () => {
  const f = fixtureRoot();
  const service = createOriginalMinuteBacktestServiceV1({ sourceRoot: f.root, now: () => NOW,
    runPeriod: async () => { throw new Error('/private/fixture/provider.json Bearer test-secret SENSITIVE_TEST_TOKEN'); } });
  const http = await withServer(service);
  try {
    const response = await start(http.base);
    assert.equal(response.status, 202);
    const started = await safeJson(response);
    const failed = await poll(http.base, started.runId);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.reason, 'ORIGINAL_MINUTE_REPLAY_FAILED');
    assert.equal(failed.report, null);
    assert.equal(failed.netProfitPct, null);
    assertSafety(failed);
  } finally { await http.close(); f.cleanup(); }
});
