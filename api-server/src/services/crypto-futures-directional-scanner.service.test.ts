import test from 'node:test';
import assert from 'node:assert/strict';
import './crypto-futures-derivatives-evidence.service.test';
import {
  createCryptoFuturesDirectionalScannerService,
  type FuturesDirectionalRuntimeProviders,
  type FuturesDirectionalTicker,
} from './crypto-futures-directional-scanner.service';
import type { FuturesDirectionalDerivativesEvidence } from './crypto-futures-derivatives-evidence.service';
import type { FuturesDirectionalCandle } from './crypto-futures-directional-formula.service';

const FIXED_NOW = Date.UTC(2026, 7, 27, 0, 0, 0);

function ticker(symbol: string, price: number, changePercent: number, fundingRate: number): FuturesDirectionalTicker {
  return {
    symbol,
    name: symbol,
    price,
    changePercent,
    volume: 5_000_000,
    tradingValue: 50_000_000_000,
    bid: price * 0.9995,
    ask: price * 1.0005,
    fundingRate,
    openInterest: 10_000_000,
    timestamp: FIXED_NOW - 30_000,
  };
}

function trendCandles(direction: 'up' | 'down', count = 40): FuturesDirectionalCandle[] {
  const step = 15 * 60_000;
  return Array.from({ length: count }, (_, index) => {
    const base = direction === 'up' ? 100 + index * 0.5 : 120 - index;
    return {
      time: FIXED_NOW - (count - index) * step,
      open: direction === 'up' ? base - 0.2 : base + 0.4,
      high: base + 1,
      low: base - 1,
      close: base,
      volume: index === count - 1 ? 200_000 : 100_000,
      quoteVolume: 10_000_000,
    };
  });
}

function derivativesEvidence(symbol: string): FuturesDirectionalDerivativesEvidence {
  const markPrice = symbol === 'BTCUSDT' ? 120 : 80;
  const indexPrice = markPrice * 0.999;
  const basis = markPrice - indexPrice;
  return {
    symbol,
    status: 'READY',
    markPrice,
    indexPrice,
    fundingRate: symbol === 'BTCUSDT' ? -0.0007 : 0.0008,
    openInterest: 10_000_000,
    basis,
    basisPercent: (basis / indexPrice) * 100,
    observedAt: new Date(FIXED_NOW - 1000).toISOString(),
    positionTier: {
      symbol,
      source: 'bitget-public-position-tier',
      providerHost: 'api.bitget.com',
      endpoint: '/api/v3/market/position-tier',
      category: 'USDT-FUTURES',
      rows: [{ tier: 1, minTierValue: 0, maxTierValue: 200_000, leverage: 125, maintenanceMarginRate: 0.004 }],
      rawEvidenceSha256: 'a'.repeat(64),
      observedAt: new Date(FIXED_NOW - 1000).toISOString(),
      status: 'live',
      currentRuleOnly: true,
      historicalCoverageProven: false,
      publicDataOnly: true,
      privatePositionApiUsed: false,
      executionAuthority: 'NONE',
      warnings: [],
    },
    liquidationRiskStructure: {
      status: 'READY_FOR_CANONICAL_RISK_SIZING',
      canonicalModelId: 'BITGET_CLASSIC_SINGLE_ASSET_ISOLATED_TIERED_V2025_11_10',
      canonicalModelOwner: 'market-prediction-lab/src/crypto-futures-isolated-liquidation-model-v1.js',
      currentPublicTierEvidenceReady: true,
      positionSpecificLiquidationPrice: null,
      positionSpecificRiskRequiresCanonicalSizing: true,
      historicalCoverageProven: false,
    },
    blockers: [],
    warnings: [],
    dataSources: [
      'bitget-public:/api/v2/mix/market/symbol-price',
      'bitget-public:/api/v2/mix/market/current-fund-rate',
      'bitget-public:/api/v2/mix/market/open-interest',
      'derived:mark-price-minus-index-price',
      'bitget-public:/api/v3/market/position-tier',
    ],
    publicDataOnly: true,
    privatePositionApiUsed: false,
    executionAuthority: 'NONE',
  };
}

function providers(overrides: Partial<FuturesDirectionalRuntimeProviders> = {}): FuturesDirectionalRuntimeProviders {
  return {
    getUniverse: async () => ({
      source: 'bitget-public',
      providerErrorCount: 0,
      rows: [
        ticker('BTCUSDT', 120, 4, -0.0007),
        ticker('ETHUSDT', 80, -4, 0.0008),
      ],
    }),
    getCandles: async (symbol) => symbol === 'BTCUSDT' ? trendCandles('up') : trendCandles('down'),
    getDerivativesEvidence: async (symbol) => derivativesEvidence(symbol),
    now: () => FIXED_NOW,
    ...overrides,
  };
}

function request(view: 'LONG' | 'SHORT' | 'BOTH' = 'BOTH') {
  return {
    memberId: 'member-1',
    view,
    strategyMode: 'scalping' as const,
    timeframe: '15m',
    condition: 'trend' as const,
    cursor: 0,
    batchSize: 10,
    minimumScore: 0,
    maximumRiskScore: 100,
    limit: 10,
  };
}

test('futures directional runtime keeps LONG and SHORT in separate ranked lanes', async () => {
  const service = createCryptoFuturesDirectionalScannerService(providers());
  const result = await service.scan(request('BOTH'));

  assert.equal(result.ok, true);
  assert.equal(result.assetClass, 'coin_futures');
  assert.equal(result.requestedView, 'BOTH');
  assert.equal(result.cards.length, 0, 'BOTH never flattens two directions into one mixed ranking');
  assert.ok(result.lanes.long.cards.length > 0);
  assert.ok(result.lanes.short.cards.length > 0);
  assert.ok(result.lanes.long.cards.every((card) => card.direction === 'LONG'));
  assert.ok(result.lanes.short.cards.every((card) => card.direction === 'SHORT'));
  assert.equal(result.lanes.long.cards[0].symbol, 'BTCUSDT');
  assert.equal(result.lanes.short.cards[0].symbol, 'ETHUSDT');
  assert.equal(result.lanes.long.cards[0].action, 'LONG');
  assert.equal(result.lanes.short.cards[0].action, 'SHORT');
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
  assert.equal(result.liveTradingEnabled, false);
});

test('single-direction views expose only the selected lane and never invert the other lane', async () => {
  const service = createCryptoFuturesDirectionalScannerService(providers());
  const long = await service.scan(request('LONG'));
  const short = await service.scan(request('SHORT'));

  assert.ok(long.cards.length > 0 && long.cards.every((card) => card.direction === 'LONG'));
  assert.ok(short.cards.length > 0 && short.cards.every((card) => card.direction === 'SHORT'));
  assert.notDeepEqual(
    long.lanes.long.cards.map((card) => [card.symbol, card.score]),
    short.lanes.short.cards.map((card) => [card.symbol, card.score]),
  );
});

test('final qualifying futures cards expose all six derivatives evidence parts from public provenance', async () => {
  const service = createCryptoFuturesDirectionalScannerService(providers());
  const result = await service.scan(request('BOTH'));
  const long = result.lanes.long.cards.find((card) => card.symbol === 'BTCUSDT');
  assert.ok(long);
  for (const key of ['long-mark-price', 'long-index-price', 'long-funding', 'long-open-interest', 'long-basis', 'long-liquidation-risk']) {
    assert.equal(long.evidence.find((row) => row.key === key)?.status, 'matched');
  }
  assert.equal(long.warnings.includes('BLOCKED_DERIVATIVES_EVIDENCE'), false);
  assert.equal(long.strongSignalEligible, true);
});

test('missing liquidation tier/MMR evidence blocks Candidate promotion without weakening formula thresholds', async () => {
  const service = createCryptoFuturesDirectionalScannerService(providers({
    getDerivativesEvidence: async (symbol) => ({
      ...derivativesEvidence(symbol),
      status: 'BLOCKED_DERIVATIVES_EVIDENCE',
      positionTier: null,
      liquidationRiskStructure: {
        ...derivativesEvidence(symbol).liquidationRiskStructure,
        status: 'BLOCKED_DERIVATIVES_EVIDENCE',
        currentPublicTierEvidenceReady: false,
      },
      blockers: ['LIQUIDATION_RISK_TIER_MMR_EVIDENCE_MISSING'],
    }),
  }));
  const result = await service.scan(request('BOTH'));
  const btcLong = result.lanes.long.cards.find((card) => card.symbol === 'BTCUSDT');
  const ethShort = result.lanes.short.cards.find((card) => card.symbol === 'ETHUSDT');
  assert.ok(btcLong && ethShort);
  assert.equal(btcLong.strongSignalEligible, false);
  assert.equal(ethShort.strongSignalEligible, false);
  assert.equal(btcLong.signalState, 'WATCHING');
  assert.equal(btcLong.action, 'NONE');
  assert.equal(btcLong.pricePlan.entryZone, null);
  assert.equal(btcLong.pricePlan.stopLoss, null);
  assert.deepEqual(btcLong.pricePlan.targets, []);
  assert.equal(result.lanes.long.decision, 'NO_TRADE');
  assert.equal(result.lanes.short.decision, 'NO_TRADE');
  assert.ok(result.message.includes('BLOCKED_DERIVATIVES_EVIDENCE'));
});

test('detailed derivatives calls are bounded to preliminary qualifying symbols instead of the broad universe', async () => {
  const calls: string[] = [];
  const service = createCryptoFuturesDirectionalScannerService(providers({
    getDerivativesEvidence: async (symbol) => {
      calls.push(symbol);
      return derivativesEvidence(symbol);
    },
  }));
  await service.scan(request('BOTH'));
  assert.deepEqual(calls.sort(), ['BTCUSDT', 'ETHUSDT']);
});

test('futures directional runtime fails closed to NO_TRADE when public universe is unavailable', async () => {
  const service = createCryptoFuturesDirectionalScannerService(providers({
    getUniverse: async () => { throw new Error('provider down'); },
  }));
  const result = await service.scan(request('BOTH'));

  assert.equal(result.dataState, 'unavailable');
  assert.equal(result.lanes.long.decision, 'NO_TRADE');
  assert.equal(result.lanes.short.decision, 'NO_TRADE');
  assert.equal(result.cards.length, 0);
  assert.equal(result.failures[0]?.reason, 'provider_error');
  assert.equal(result.orderSubmitted, false);
});

test('futures directional runtime propagates caller abort instead of returning a late success', async () => {
  const controller = new AbortController();
  const service = createCryptoFuturesDirectionalScannerService(providers({
    getCandles: async (_symbol, _timeframe, signal) => await new Promise<FuturesDirectionalCandle[]>((_resolve, reject) => {
      const onAbort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  }));
  const pending = service.scan({ ...request('BOTH'), signal: controller.signal });
  setTimeout(() => controller.abort(new Error('test abort')), 10);
  await assert.rejects(pending, /test abort/);
});
