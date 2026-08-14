import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadMarketInformationCache,
  resetMarketInformationCacheForTests,
} from './public-market-http';
import { evaluateFourMarketReadiness } from './four-market-data-health.service';

function abortError(): Error {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

test('cold market cache loads isolate cancellation between concurrent requests', async () => {
  resetMarketInformationCacheForTests();
  const controller = new AbortController();
  let firstCalls = 0;
  let secondCalls = 0;

  const first = loadMarketInformationCache('race:cold', 60_000, 60_000, async () => {
    firstCalls += 1;
    return new Promise<string>((_resolve, reject) => {
      if (controller.signal.aborted) {
        reject(abortError());
        return;
      }
      controller.signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  });

  await Promise.resolve();

  const second = loadMarketInformationCache('race:cold', 60_000, 60_000, async () => {
    secondCalls += 1;
    return 'second-request-value';
  });
  const secondSettled = second.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  controller.abort();

  await assert.rejects(
    first,
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );

  const secondResult = await secondSettled;
  if (!secondResult.ok) throw secondResult.error;
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.value.value, 'second-request-value');
  assert.equal(secondResult.value.stale, false);
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);

  let unexpectedReloads = 0;
  const cached = await loadMarketInformationCache('race:cold', 60_000, 60_000, async () => {
    unexpectedReloads += 1;
    return 'unexpected';
  });
  assert.equal(cached.value, 'second-request-value');
  assert.equal(cached.stale, false);
  assert.equal(unexpectedReloads, 0);
});

test('market cache returns explicit last-good stale data when a cold refresh fails', async () => {
  resetMarketInformationCacheForTests();
  const first = await loadMarketInformationCache('fallback:last-good', 0, 0, async () => 'last-good');
  assert.equal(first.value, 'last-good');
  assert.equal(first.stale, false);

  const fallback = await loadMarketInformationCache('fallback:last-good', 0, 0, async () => {
    throw new Error('provider unavailable');
  });
  assert.equal(fallback.value, 'last-good');
  assert.equal(fallback.stale, true);
});

const NOW = '2026-08-14T00:00:00.000Z';

function evidence(args: {
  provider: 'TOSS' | 'UPBIT' | 'BITGET';
  capabilities: Parameters<typeof evaluateFourMarketReadiness>[0]['evidence']['capabilities'];
  costPolicyVersion?: string | null;
  fetchedAt?: string;
  dataQualityPassed?: boolean;
  provenance?: readonly string[];
}) {
  return {
    provider: args.provider,
    capabilities: args.capabilities,
    costPolicyVersion: args.costPolicyVersion === undefined ? 'COST-V1' : args.costPolicyVersion,
    fetchedAt: args.fetchedAt ?? NOW,
    dataQualityPassed: args.dataQualityPassed ?? true,
    provenance: args.provenance ?? ['official-or-validated-fixture'],
    publicOrStaticOnly: true,
  } as const;
}

test('four-market readiness rejects provider authority mismatch instead of falling back', () => {
  const result = evaluateFourMarketReadiness({
    market: 'KR_STOCK', stage: 'PAPER', direction: 'BUY', now: NOW,
    evidence: evidence({
      provider: 'UPBIT',
      capabilities: ['QUOTE', 'ORDERBOOK', 'TICK_SIZE', 'MIN_ORDER', 'SESSION_CALENDAR'],
    }),
  });
  assert.equal(result.status, 'BLOCKED_PROVIDER');
  assert.equal(result.providerAuthority, 'TOSS');
  assert.equal(result.ready, false);
});

test('stock historical research fails closed without point-in-time, corporate-action and session evidence', () => {
  const result = evaluateFourMarketReadiness({
    market: 'US_STOCK', stage: 'BACKTEST', direction: 'BUY', now: NOW,
    evidence: evidence({ provider: 'TOSS', capabilities: ['HISTORICAL_OHLCV', 'TICK_SIZE'] }),
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.deepEqual(result.missingCapabilities.sort(), ['CORPORATE_ACTIONS', 'POINT_IN_TIME_UNIVERSE', 'SESSION_CALENDAR'].sort());
});

test('cash markets never turn SHORT into a supported research direction', () => {
  const result = evaluateFourMarketReadiness({
    market: 'CRYPTO_SPOT', stage: 'SHADOW', direction: 'SHORT', now: NOW,
    evidence: evidence({ provider: 'UPBIT', capabilities: ['QUOTE', 'ORDERBOOK', 'TICK_SIZE', 'MIN_ORDER'] }),
  });
  assert.equal(result.status, 'DIRECTION_NOT_SUPPORTED');
  assert.equal(result.ready, false);
});

test('cash-market SELL is exit-only and requires an existing position', () => {
  const blocked = evaluateFourMarketReadiness({
    market: 'KR_STOCK', stage: 'PAPER', direction: 'SELL', reducingPosition: false, now: NOW,
    evidence: evidence({ provider: 'TOSS', capabilities: ['QUOTE', 'ORDERBOOK', 'TICK_SIZE', 'MIN_ORDER', 'SESSION_CALENDAR'] }),
  });
  assert.equal(blocked.status, 'DIRECTION_NOT_SUPPORTED');

  const exit = evaluateFourMarketReadiness({
    market: 'KR_STOCK', stage: 'PAPER', direction: 'SELL', reducingPosition: true, now: NOW,
    evidence: evidence({ provider: 'TOSS', capabilities: ['QUOTE', 'ORDERBOOK', 'TICK_SIZE', 'MIN_ORDER', 'SESSION_CALENDAR'] }),
  });
  assert.equal(exit.status, 'READY');
});

test('futures backtest requires funding history and contract specification', () => {
  const result = evaluateFourMarketReadiness({
    market: 'CRYPTO_FUTURES', stage: 'BACKTEST', direction: 'SHORT', now: NOW,
    evidence: evidence({ provider: 'BITGET', capabilities: ['HISTORICAL_OHLCV', 'TICK_SIZE', 'MIN_ORDER'] }),
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.missingCapabilities.includes('FUNDING_HISTORY'));
  assert.ok(result.missingCapabilities.includes('CONTRACT_SPEC'));
});

test('futures paper readiness accepts only complete Bitget public evidence and never grants live authority', () => {
  const result = evaluateFourMarketReadiness({
    market: 'CRYPTO_FUTURES', stage: 'PAPER', direction: 'LONG', now: NOW,
    evidence: evidence({
      provider: 'BITGET',
      capabilities: ['QUOTE', 'ORDERBOOK', 'TICK_SIZE', 'MIN_ORDER', 'CONTRACT_SPEC', 'MARK_PRICE', 'FUNDING_RATE', 'OPEN_INTEREST'],
    }),
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.privateTradingRequestAllowed, false);
  assert.equal(result.liveActivationAllowed, false);
});

test('missing cost policy and stale evidence are explicit blockers', () => {
  const unknownCost = evaluateFourMarketReadiness({
    market: 'CRYPTO_SPOT', stage: 'PAPER', direction: 'BUY', now: NOW,
    evidence: evidence({ provider: 'UPBIT', capabilities: ['QUOTE', 'ORDERBOOK', 'TICK_SIZE', 'MIN_ORDER'], costPolicyVersion: null }),
  });
  assert.equal(unknownCost.status, 'UNKNOWN_COST_POLICY');

  const stale = evaluateFourMarketReadiness({
    market: 'CRYPTO_SPOT', stage: 'SHADOW', direction: 'BUY', now: NOW, maxAgeMs: 60_000,
    evidence: evidence({
      provider: 'UPBIT', capabilities: ['QUOTE', 'ORDERBOOK', 'TICK_SIZE', 'MIN_ORDER'],
      fetchedAt: '2026-08-13T23:50:00.000Z',
    }),
  });
  assert.equal(stale.status, 'STALE_DATA');
});

test('auto-predeploy requires an explicit execution contract but still grants no live authority', () => {
  const missing = evaluateFourMarketReadiness({
    market: 'CRYPTO_SPOT', stage: 'AUTO_PREDEPLOY', direction: 'BUY', now: NOW,
    evidence: evidence({ provider: 'UPBIT', capabilities: ['QUOTE', 'ORDERBOOK', 'TICK_SIZE', 'MIN_ORDER'] }),
  });
  assert.equal(missing.status, 'BLOCKED_DATA');
  assert.ok(missing.missingCapabilities.includes('EXECUTION_CONTRACT'));

  const ready = evaluateFourMarketReadiness({
    market: 'CRYPTO_SPOT', stage: 'AUTO_PREDEPLOY', direction: 'BUY', now: NOW,
    evidence: evidence({ provider: 'UPBIT', capabilities: ['QUOTE', 'ORDERBOOK', 'TICK_SIZE', 'MIN_ORDER', 'EXECUTION_CONTRACT'] }),
  });
  assert.equal(ready.status, 'READY');
  assert.equal(ready.liveActivationAllowed, false);
});
