import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStockFlowEvidence } from './scanner-stock-flow-evidence.service';

test('US flow evidence aggregates latest FINRA facilities and keeps short-cover non-inferred', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ url, body });
    if (url.endsWith('/regShoDaily')) {
      return new Response(JSON.stringify([
        {
          tradeReportDate: '2026-09-24',
          securitiesInformationProcessorSymbolIdentifier: 'AAPL',
          shortParQuantity: 100,
          shortExemptParQuantity: 10,
          totalParQuantity: 400,
          reportingFacilityCode: 'NQTRF',
        },
        {
          tradeReportDate: '2026-09-24',
          securitiesInformationProcessorSymbolIdentifier: 'AAPL',
          shortParQuantity: 200,
          shortExemptParQuantity: 20,
          totalParQuantity: 600,
          reportingFacilityCode: 'NYTRF',
        },
        {
          tradeReportDate: '2026-09-23',
          securitiesInformationProcessorSymbolIdentifier: 'AAPL',
          shortParQuantity: 999,
          shortExemptParQuantity: 0,
          totalParQuantity: 1000,
        },
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/consolidatedShortInterest')) {
      return new Response(JSON.stringify([
        {
          settlementDate: '2026-09-15',
          symbolCode: 'AAPL',
          currentShortPositionQuantity: 1200,
          previousShortPositionQuantity: 1100,
          averageDailyVolumeQuantity: 400,
          daysToCoverQuantity: 3,
          changePercent: 9.09,
        },
        {
          settlementDate: '2026-08-31',
          symbolCode: 'AAPL',
          currentShortPositionQuantity: 1100,
          previousShortPositionQuantity: 1000,
          averageDailyVolumeQuantity: 390,
          daysToCoverQuantity: 2.82,
          changePercent: 10,
        },
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('UNEXPECTED_URL');
  };

  const result = await loadStockFlowEvidence(
    { market: 'US', symbol: 'aapl' },
    { fetchImpl, now: () => new Date('2026-09-26T08:00:00.000Z') },
  );

  assert.equal(calls.length, 2);
  assert.equal(result.status, 'READY');
  assert.equal(result.symbol, 'AAPL');
  assert.equal(result.shortSale.tradeDate, '2026-09-24');
  assert.equal(result.shortSale.shortVolume, 300);
  assert.equal(result.shortSale.totalVolume, 1000);
  assert.equal(result.shortSale.shortVolumeRatioPercent, 30);
  assert.equal(result.shortInterest.settlementDate, '2026-09-15');
  assert.equal(result.shortInterest.currentShortPosition, 1200);
  assert.equal(result.shortInterest.daysToCover, 3);
  assert.equal(result.shortCover.status, 'NOT_INFERRED');
  assert.equal(result.institutional.status, 'NOT_CONNECTED');
  assert.equal(result.safety.scoreImpact, 0);
  assert.equal(result.safety.rankImpact, 0);
  assert.equal(result.safety.directionImpact, 0);
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.safety.orderAllowed, false);
  assert.ok(calls.every((call) => JSON.stringify(call.body).includes('AAPL')));
});

test('US evidence is partial when one official FINRA dataset is unavailable', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/regShoDaily')) {
      return new Response(JSON.stringify([{
        tradeReportDate: '2026-09-24',
        securitiesInformationProcessorSymbolIdentifier: 'MSFT',
        shortParQuantity: 50,
        shortExemptParQuantity: 0,
        totalParQuantity: 200,
      }]), { status: 200 });
    }
    return new Response('{}', { status: 503 });
  };

  const result = await loadStockFlowEvidence({ market: 'US', symbol: 'MSFT' }, { fetchImpl });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.shortSale.status, 'READY');
  assert.equal(result.shortInterest.status, 'UNAVAILABLE');
  assert.ok(result.warnings.some((warning) => warning.includes('Short Interest')));
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
      { fetchImpl: async () => { calls += 1; return new Response('[]'); } },
    ),
    /미국 주식 심볼/,
  );
  assert.equal(calls, 0);
});
