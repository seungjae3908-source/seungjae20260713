import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadStockFlowEvidence,
  resetStockFlowProviderStateForTests,
} from './scanner-stock-flow-evidence.service';

const credentials = { clientId: 'finra-client-test', clientSecret: 'finra-secret-test' };

test('US flow evidence uses FINRA OAuth, aggregates latest facilities and keeps short-cover non-inferred', async () => {
  resetStockFlowProviderStateForTests();
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get('authorization');
    const bodyText = String(init?.body ?? '');
    const body = bodyText ? JSON.parse(bodyText) : null;
    calls.push({ url, authorization, body });

    if (url.includes('/oauth2/access_token')) {
      assert.equal(
        authorization,
        `Basic ${Buffer.from('finra-client-test:finra-secret-test').toString('base64')}`,
      );
      return new Response(JSON.stringify({
        access_token: 'finra-access-token-test',
        token_type: 'Bearer',
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    assert.equal(authorization, 'Bearer finra-access-token-test');
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
    {
      fetchImpl,
      finraCredentials: credentials,
      now: () => new Date('2026-09-26T08:00:00.000Z'),
    },
  );

  assert.equal(calls.length, 3);
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
  assert.ok(calls.slice(1).every((call) => JSON.stringify(call.body).includes('AAPL')));
  assert.doesNotMatch(JSON.stringify(result), /finra-secret-test|finra-access-token-test/);
});

test('US evidence is partial when one authenticated FINRA dataset is unavailable', async () => {
  resetStockFlowProviderStateForTests();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/oauth2/access_token')) {
      return new Response(JSON.stringify({ access_token: 'partial-token', expires_in: 3600 }), { status: 200 });
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer partial-token');
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

  const result = await loadStockFlowEvidence(
    { market: 'US', symbol: 'MSFT' },
    { fetchImpl, finraCredentials: credentials },
  );
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.shortSale.status, 'READY');
  assert.equal(result.shortInterest.status, 'UNAVAILABLE');
  assert.ok(result.warnings.some((warning) => warning.includes('Short Interest')));
});

test('US flow evidence stays NOT_CONNECTED and makes zero calls without FINRA OAuth credentials', async () => {
  resetStockFlowProviderStateForTests();
  let calls = 0;
  const result = await loadStockFlowEvidence(
    { market: 'US', symbol: 'AAPL' },
    {
      finraCredentials: null,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('must not call');
      },
    },
  );

  assert.equal(calls, 0);
  assert.equal(result.status, 'NOT_CONNECTED');
  assert.equal(result.shortSale.status, 'NOT_CONNECTED');
  assert.equal(result.shortInterest.status, 'NOT_CONNECTED');
  assert.ok(result.warnings.some((warning) => warning.includes('OAuth')));
});

test('FINRA OAuth failure is explicit UNAVAILABLE without leaking credentials', async () => {
  resetStockFlowProviderStateForTests();
  let calls = 0;
  const result = await loadStockFlowEvidence(
    { market: 'US', symbol: 'NVDA' },
    {
      finraCredentials: credentials,
      fetchImpl: async (_input, init) => {
        calls += 1;
        assert.match(new Headers(init?.headers).get('authorization') ?? '', /^Basic /);
        return new Response('{}', { status: 401 });
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.shortSale.status, 'UNAVAILABLE');
  assert.equal(result.shortInterest.status, 'UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(result), /finra-client-test|finra-secret-test/);
});

test('KR flow evidence fails closed without an approved KRX provider and makes zero network calls', async () => {
  resetStockFlowProviderStateForTests();
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
  resetStockFlowProviderStateForTests();
  let calls = 0;
  await assert.rejects(
    loadStockFlowEvidence(
      { market: 'US', symbol: 'AAPL$BAD' },
      {
        finraCredentials: credentials,
        fetchImpl: async () => {
          calls += 1;
          return new Response('[]');
        },
      },
    ),
    /미국 주식 심볼/,
  );
  assert.equal(calls, 0);
});
