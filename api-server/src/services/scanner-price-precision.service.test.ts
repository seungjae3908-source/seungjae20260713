import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bitgetContractPriceTick,
  krxPriceTick,
  roundPriceToTick,
  usNmsPriceTick,
} from './market-price-precision.service';
import { createCryptoPricePrecisionService } from './scanner-crypto-price-precision.service';
import type { ScannerResponse, ScannerSignalCard } from './scanner-signal.types';

function card(symbol: string, market: string): ScannerSignalCard {
  return {
    signalId: `signal:${symbol}`,
    assetClass: market === 'UPBIT_KRW' ? 'coin_spot' : 'coin_futures',
    market,
    exchange: market === 'UPBIT_KRW' ? 'UPBIT' : 'BITGET',
    symbol,
    name: symbol,
    currency: market === 'UPBIT_KRW' ? 'KRW' : 'USDT',
    assetType: market === 'UPBIT_KRW' ? 'CRYPTO_SPOT' : 'CRYPTO_FUTURES',
    listingStatus: 'LISTED',
    price: 100,
    changePercent: 1,
    direction: 'LONG',
    signalState: 'WATCHING',
    score: 82,
    confidence: 80,
    dataCompleteness: 100,
    riskScore: 20,
    riskLevel: 'LOW',
    liquidity: 1_000_000,
    volume: 100,
    tradingValue: 1_000_000,
    spreadPercent: 0.1,
    volatilityPercent: 2,
    matched: ['trend'],
    notMatched: [],
    unverified: [],
    evidence: [],
    pricePlan: {
      entryZone: { from: 99.96, to: 100.04 },
      invalidation: 98.91,
      stopLoss: 98.91,
      targets: [101.87, 102.43],
      riskReward: 1.7,
    },
    dataState: 'complete',
    dataSources: ['public-market'],
    observedAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-10T00:15:00.000Z',
    strongSignalEligible: true,
    warnings: [],
  };
}

function response(value: ScannerSignalCard): ScannerResponse {
  return {
    ok: true,
    requestId: 'precision-test',
    assetClass: value.assetClass,
    market: value.market,
    timeframe: '5m',
    cards: [value],
    alerts: [{
      idempotencyKey: 'alert-1',
      signalId: value.signalId,
      assetClass: value.assetClass,
      market: value.market,
      symbol: value.symbol,
      direction: value.direction,
      state: 'APPROVAL_PENDING',
      entryZone: value.pricePlan.entryZone,
      stopLoss: value.pricePlan.stopLoss,
      targets: value.pricePlan.targets,
      expiresAt: value.expiresAt,
      evidence: [],
      orderSubmitted: false,
      exchangeRequestSent: false,
    }],
    failures: [],
    execution: {
      requestedCount: 1,
      startedCount: 1,
      completedCount: 1,
      excludedCount: 0,
      providerErrorCount: 0,
      timeoutCount: 0,
      partial: false,
      timedOut: false,
      cancelled: false,
      duplicate: false,
      elapsedMs: 1,
      deadlineMs: 1000,
      itemTimeoutMs: 500,
      maxConcurrency: 1,
    },
    universe: {
      totalCount: 1,
      cursor: 0,
      nextCursor: null,
      source: 'test',
      partial: false,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: 'complete',
    message: 'complete',
    generatedAt: '2026-08-10T00:00:00.000Z',
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function onTick(value: number, tick: number): boolean {
  const quotient = value / tick;
  return Math.abs(quotient - Math.round(quotient)) < 1e-8;
}

test('KRX stock and ETF/ETN ticks follow market rules instead of decimal heuristics', () => {
  assert.equal(krxPriceTick(1_999, 'STOCK'), 1);
  assert.equal(krxPriceTick(2_000, 'STOCK'), 5);
  assert.equal(krxPriceTick(5_000, 'STOCK'), 10);
  assert.equal(krxPriceTick(20_000, 'STOCK'), 50);
  assert.equal(krxPriceTick(50_000, 'STOCK'), 100);
  assert.equal(krxPriceTick(200_000, 'STOCK'), 500);
  assert.equal(krxPriceTick(500_000, 'STOCK'), 1_000);
  assert.equal(krxPriceTick(1_234, 'ETF'), 5);
  assert.equal(krxPriceTick(543_210, 'ETN'), 5);
});

test('US tick rule fails closed after the amended Rule 612 assignment boundary', () => {
  const before = Date.UTC(2026, 7, 10);
  const after = Date.UTC(2026, 10, 2);
  assert.equal(usNmsPriceTick(100, before), 0.01);
  assert.equal(usNmsPriceTick(0.75, before), 0.0001);
  assert.equal(usNmsPriceTick(100, after), null);
});

test('Bitget contract precision and generic rounding use exact tick multiples', () => {
  assert.equal(bitgetContractPriceTick('2', '5'), 0.05);
  assert.equal(bitgetContractPriceTick('1', '1'), 0.1);
  assert.equal(bitgetContractPriceTick('bad', '1'), null);
  assert.equal(roundPriceToTick(65_123, 100), 65_100);
  assert.equal(roundPriceToTick(1.2345, 0.01), 1.23);
});

test('Upbit public tick_size snaps every exposed price-plan value with no private headers', async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const service = createCryptoPricePrecisionService(async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), authorization: headers.get('authorization') });
    return new Response(JSON.stringify([{ market: 'KRW-BTC', tick_size: '0.1' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const aligned = await service.align('spot', response(card('BTC', 'UPBIT_KRW')));
  const plan = aligned.cards[0].pricePlan;
  assert.match(calls[0]?.url ?? '', /^https:\/\/api\.upbit\.com\/v1\/orderbook\/instruments\?markets=KRW-BTC$/);
  assert.equal(calls[0]?.authorization, null);
  assert.ok(plan.entryZone);
  assert.ok(onTick(plan.entryZone!.from, 0.1));
  assert.ok(onTick(plan.entryZone!.to, 0.1));
  assert.ok(onTick(plan.stopLoss!, 0.1));
  assert.ok(plan.targets.every((value) => onTick(value, 0.1)));
  assert.ok((plan.riskReward ?? 0) > 0);
  assert.equal(aligned.cards[0].strongSignalEligible, true);
  assert.match(aligned.cards[0].dataSources.join(','), /upbit-public-orderbook-instruments/);
});

test('Bitget public contract config snaps futures plan to pricePlace and priceEndStep', async () => {
  const service = createCryptoPricePrecisionService(async (input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), null);
    assert.match(String(input), /^https:\/\/api\.bitget\.com\/api\/v2\/mix\/market\/contracts\?productType=USDT-FUTURES$/);
    return new Response(JSON.stringify({
      code: '00000',
      data: [{ symbol: 'BTCUSDT', pricePlace: '2', priceEndStep: '5' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const aligned = await service.align('futures', response(card('BTCUSDT', 'BITGET_USDT_FUTURES')));
  const plan = aligned.cards[0].pricePlan;
  assert.ok(plan.entryZone);
  assert.ok(onTick(plan.entryZone!.from, 0.05));
  assert.ok(onTick(plan.entryZone!.to, 0.05));
  assert.ok(onTick(plan.stopLoss!, 0.05));
  assert.ok(plan.targets.every((value) => onTick(value, 0.05)));
  assert.match(aligned.cards[0].dataSources.join(','), /bitget-public-contracts/);
});

test('missing precision metadata clears plan and approval-compatible eligibility instead of inventing a tick', async () => {
  const service = createCryptoPricePrecisionService(async () => new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  const aligned = await service.align('spot', response(card('BTC', 'UPBIT_KRW')));
  assert.equal(aligned.cards[0].pricePlan.entryZone, null);
  assert.equal(aligned.cards[0].pricePlan.stopLoss, null);
  assert.deepEqual(aligned.cards[0].pricePlan.targets, []);
  assert.equal(aligned.cards[0].pricePlan.riskReward, null);
  assert.equal(aligned.cards[0].strongSignalEligible, false);
  assert.equal(aligned.cards[0].signalState, 'DETECTED');
  assert.equal(aligned.execution.partial, true);
  assert.equal(aligned.dataState, 'partial');
  assert.deepEqual(aligned.alerts, []);
  assert.match(aligned.message, /시장 가격 단위/);
});

test('precision provider failure remains explicit partial provider error and does not leak old plan', async () => {
  const service = createCryptoPricePrecisionService(async () => {
    throw new Error('provider down');
  });
  const aligned = await service.align('futures', response(card('BTCUSDT', 'BITGET_USDT_FUTURES')));
  assert.equal(aligned.execution.providerErrorCount, 1);
  assert.equal(aligned.execution.partial, true);
  assert.equal(aligned.cards[0].pricePlan.riskReward, null);
  assert.equal(aligned.cards[0].strongSignalEligible, false);
  assert.deepEqual(aligned.alerts, []);
  assert.match(aligned.message, /공급자 응답이 없어/);
});
