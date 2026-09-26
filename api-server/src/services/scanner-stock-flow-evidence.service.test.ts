import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadStockFlowEvidence,
  stockFlowCandidateTradeDatesForTests,
} from './scanner-stock-flow-evidence.service';

const file = (date: string, symbol: string, shortVolume: number, shortExempt: number, totalVolume: number) =>
  [
    'Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market',
    `${date}|${symbol}|${shortVolume}|${shortExempt}|${totalVolume}|B,Q,N`,
    'Total Rows:1',
  ].join('\n');

test('US flow evidence reads the latest public FINRA Consolidated NMS daily file without credentials', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.method, 'GET');
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    assert.match(url, /CNMSshvol20260925\.txt$/);
    return new Response(file('20260925', 'AAPL', 300, 30, 1000), {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  };

  const result = await loadStockFlowEvidence(
    { market: 'US', symbol: 'aapl' },
    {
      fetchImpl,
      now: () => new Date('2026-09-26T12:00:00.000Z'),
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.symbol, 'AAPL');
  assert.equal(result.shortSale.status, 'READY');
  assert.equal(result.shortSale.tradeDate, '2026-09-25');
  assert.equal(result.shortSale.shortVolume, 300);
  assert.equal(result.shortSale.shortExemptVolume, 30);
  assert.equal(result.shortSale.totalVolume, 1000);
  assert.equal(result.shortSale.shortVolumeRatioPercent, 30);
  assert.equal(result.shortInterest.status, 'NOT_CONNECTED');
  assert.equal(result.shortInterest.currentShortPosition, null);
  assert.equal(result.shortCover.status, 'NOT_INFERRED');
  assert.equal(result.institutional.status, 'NOT_CONNECTED');
  assert.equal(result.safety.scoreImpact, 0);
  assert.equal(result.safety.rankImpact, 0);
  assert.equal(result.safety.directionImpact, 0);
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.safety.orderAllowed, false);
  assert.match(result.sources[0].url, /cdn\.finra\.org\/equity\/regsho\/daily\/CNMSshvol20260925\.txt$/);
  assert.ok(result.warnings.some((warning) => warning.includes('Short Interest')));
});

test('US daily-file lookup falls back across non-published trade dates without fabricating zero', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('CNMSshvol20260928.txt')) return new Response('not found', { status: 404 });
    if (url.endsWith('CNMSshvol20260925.txt')) {
      return new Response(file('20260925', 'MSFT', 50, 0, 200), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };

  const result = await loadStockFlowEvidence(
    { market: 'US', symbol: 'MSFT' },
    {
      fetchImpl,
      now: () => new Date('2026-09-29T00:00:00.000Z'),
    },
  );

  assert.equal(calls.length, 2);
  assert.match(calls[0], /20260928/);
  assert.match(calls[1], /20260925/);
  assert.equal(result.shortSale.status, 'READY');
  assert.equal(result.shortSale.tradeDate, '2026-09-25');
  assert.equal(result.shortSale.shortVolumeRatioPercent, 25);
  assert.equal(result.shortInterest.status, 'NOT_CONNECTED');
});

test('US evidence remains unavailable when no recent public daily file contains the symbol', async () => {
  let calls = 0;
  const result = await loadStockFlowEvidence(
    { market: 'US', symbol: 'NVDA' },
    {
      fetchImpl: async () => {
        calls += 1;
        return new Response('not found', { status: 404 });
      },
      now: () => new Date('2026-09-26T12:00:00.000Z'),
    },
  );
  assert.equal(calls, 7);
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.shortSale.status, 'UNAVAILABLE');
  assert.equal(result.shortSale.shortVolume, null);
  assert.equal(result.shortInterest.status, 'NOT_CONNECTED');
  assert.ok(result.warnings.some((warning) => warning.includes('종목 근거')));
});

test('same-day FINRA file is not requested before the 18:00 America/New_York publication boundary', () => {
  const dates = stockFlowCandidateTradeDatesForTests(new Date('2026-09-28T15:00:00.000Z'));
  assert.equal(dates[0], '20260925');
  assert.ok(!dates.includes('20260928'));
});

test('KR flow evidence fails closed without an approved KRX provider and makes zero network calls', async () => {
  let calls = 0;
  const result = await loadStockFlowEvidence(
    { market: 'KR', symbol: '005930' },
    { fetchImpl: async () => { calls += 1; throw new Error('must not call'); } },
  );

  assert.equal(calls, 0);
  assert.equal(result.status, 'NOT_CONNECTED');
  assert.equal(result.shortSale.status, 'NOT_CONNECTED');
  assert.equal(result.institutional.status, 'NOT_CONNECTED');
  assert.equal(result.foreignFlow.status, 'NOT_CONNECTED');
  assert.equal(result.shortCover.status, 'NOT_INFERRED');
  assert.equal(result.safety.executionAuthority, 'NONE');
});

test('invalid symbols fail before any provider call', async () => {
  let calls = 0;
  await assert.rejects(
    loadStockFlowEvidence(
      { market: 'US', symbol: 'AAPL$BAD' },
      {
        fetchImpl: async () => {
          calls += 1;
          return new Response('not reached');
        },
      },
    ),
    /미국 주식 심볼/,
  );
  assert.equal(calls, 0);
});
