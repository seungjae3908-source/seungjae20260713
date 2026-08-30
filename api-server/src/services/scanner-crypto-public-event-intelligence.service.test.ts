import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichCryptoScannerCardsWithPublicEventContext,
} from './scanner-crypto-public-event-intelligence.service';
import type { MarketInformationResponse } from './market-information.contract';
import type { ScannerSignalCard } from './scanner-signal.types';

const NOW = '2026-08-28T12:00:00.000Z';

function card(symbol: string, market: 'spot' | 'futures', overrides: Partial<ScannerSignalCard> = {}): ScannerSignalCard {
  return {
    signalId: `sig-${symbol}`,
    assetClass: market === 'spot' ? 'coin_spot' : 'coin_futures',
    market: market === 'spot' ? 'UPBIT_KRW' : 'BITGET_USDT_FUTURES',
    exchange: market === 'spot' ? 'UPBIT' : 'BITGET',
    symbol,
    name: symbol,
    currency: market === 'spot' ? 'KRW' : 'USDT',
    assetType: market === 'spot' ? 'CRYPTO_SPOT' : 'CRYPTO_FUTURES',
    listingStatus: 'LISTED',
    price: 100,
    changePercent: 1,
    direction: 'LONG',
    action: 'LONG',
    signalState: 'CANDIDATE',
    score: 88,
    confidence: 82,
    dataCompleteness: 95,
    riskScore: 20,
    riskLevel: 'LOW',
    liquidity: 1_000_000,
    volume: 10_000,
    tradingValue: 1_000_000,
    spreadPercent: 0.1,
    volatilityPercent: 2,
    matched: [],
    notMatched: [],
    unverified: [],
    evidence: [],
    pricePlan: { entryZone: { from: 99, to: 100 }, invalidation: 95, stopLoss: 95, targets: [107, 110], riskReward: 1.5 },
    dataState: 'complete',
    dataSources: ['public'],
    observedAt: NOW,
    expiresAt: '2026-08-28T12:30:00.000Z',
    strongSignalEligible: true,
    warnings: [],
    signalGrade: 'A',
    ...overrides,
  };
}

function response(market: 'spot' | 'futures'): MarketInformationResponse {
  const room = market === 'spot' ? 'coins-spot' as const : 'coins-futures' as const;
  const symbol = market === 'spot' ? 'BTC' : 'BTCUSDT';
  const rankingMeta = {
    provider: market === 'spot' ? 'Upbit' : 'Bitget',
    source: market === 'spot' ? 'Upbit 공식 공개 Quotation API' : 'Bitget 공식 공개 USDT-FUTURES market API',
    market,
    assetType: market === 'spot' ? 'coin-spot' as const : 'coin-futures' as const,
    currency: market === 'spot' ? 'KRW' as const : 'USDT' as const,
    providerUpdatedAt: NOW,
    observedAt: NOW,
    fetchedAt: NOW,
    marketTimeZone: market === 'spot' ? 'Asia/Seoul' : 'UTC',
    marketStatus: '24H' as const,
    isDelayed: false,
    isStale: false,
    partial: false,
    unavailableFields: [],
    errorCode: null,
    retryable: false,
  };
  const unsupportedMeta = { ...rankingMeta, provider: null, source: null };
  const newsMeta = {
    ...rankingMeta,
    provider: null,
    source: null,
    unavailableFields: ['all'],
    errorCode: 'COIN_NEWS_PROVIDER_NOT_CONNECTED',
  };
  const derivativeMeta = {
    ...rankingMeta,
    provider: market === 'futures' ? 'Bitget' : null,
    source: market === 'futures' ? 'Bitget 공개 long-short·liquidation API' : null,
  };
  return {
    ok: true,
    room,
    market,
    assetType: market === 'spot' ? 'coin-spot' : 'coin-futures',
    currency: market === 'spot' ? 'KRW' : 'USDT',
    fetchedAt: NOW,
    partial: true,
    sections: {
      indices: { status: 'unsupported', data: [], meta: unsupportedMeta, message: null },
      rankings: {
        status: 'ready',
        data: [{
          symbol,
          name: symbol,
          exchange: market === 'spot' ? 'UPBIT' : 'BITGET',
          currency: market === 'spot' ? 'KRW' : 'USDT',
          price: 100,
          changePercent: 1,
          high24h: 105,
          low24h: 95,
          volume24h: 10_000,
          tradingValue24h: 1_000_000,
          marketCap: null,
          warning: market === 'spot',
          tradingStatus: market === 'spot' ? 'ACTIVE' : 'normal',
          fundingRatePercent: market === 'futures' ? 0.01 : null,
          nextFundingAt: null,
          openInterest: market === 'futures' ? 123_456 : null,
          rangeVolatility24hPercent: 10,
          providerUpdatedAt: NOW,
        }],
        meta: rankingMeta,
        message: null,
      },
      sectors: { status: 'unsupported', data: [], meta: unsupportedMeta, message: null },
      news: { status: 'unavailable', data: [], meta: newsMeta, message: 'not connected' },
      disclosures: { status: 'unsupported', data: [], meta: unsupportedMeta, message: null },
      derivatives: {
        status: market === 'futures' ? 'ready' : 'unsupported',
        data: market === 'futures'
          ? {
            referenceSymbol: 'BTCUSDT',
            longRatio: 0.55,
            shortRatio: 0.45,
            longShortRatio: 1.22,
            ratioObservedAt: NOW,
            liquidations: [
              { symbol: 'BTCUSDT', side: 'long', price: 99, amount: 12, occurredAt: NOW },
              { symbol: 'ETHUSDT', side: 'short', price: 3000, amount: 2, occurredAt: NOW },
            ],
          }
          : { referenceSymbol: 'BTCUSDT', longRatio: null, shortRatio: null, longShortRatio: null, ratioObservedAt: null, liquidations: [] },
        meta: derivativeMeta,
        message: null,
      },
    },
    requestPolicy: {
      publicMarketDataOnly: true,
      privateExchangeRequests: 0,
      accountRequests: 0,
      balanceRequests: 0,
      positionRequests: 0,
      orderRequests: 0,
      cancelRequests: 0,
      aiRequests: 0,
    },
  };
}

test('Upbit public warning is attached as evidence-only context without changing scanner authority', async () => {
  const original = card('BTC', 'spot');
  const [result] = await enrichCryptoScannerCardsWithPublicEventContext([original], {
    market: 'spot',
    loader: async () => response('spot'),
    budgetMs: 500,
  });
  assert.equal(result.score, original.score);
  assert.equal(result.direction, original.direction);
  assert.deepEqual(result.pricePlan, original.pricePlan);
  assert.equal(result.strongSignalEligible, original.strongSignalEligible);
  assert.equal(result.cryptoPublicEventContext.status, 'READY');
  assert.equal(result.cryptoPublicEventContext.marketWarning, true);
  assert.equal(result.cryptoPublicEventContext.events[0]?.kind, 'EXCHANGE_WARNING');
  assert.equal(result.cryptoPublicEventContext.verifiedCoinNews.connected, false);
  assert.ok(result.cryptoPublicEventContext.warnings.includes('COIN_NEWS_PROVIDER_NOT_CONNECTED'));
  assert.equal(result.cryptoPublicEventContext.safety.scoreImpact, 0);
  assert.equal(result.cryptoPublicEventContext.safety.aiRequests, 0);
  assert.equal(result.cryptoPublicEventContext.safety.privateExchangeRequests, 0);
  assert.equal(result.cryptoPublicEventContext.safety.executionAuthority, 'NONE');
});

test('Bitget public liquidation prints and raw ratio are attached without converting them into direction or probability', async () => {
  const original = card('BTCUSDT', 'futures', { direction: 'SHORT', action: 'SHORT', score: 84 });
  const [result] = await enrichCryptoScannerCardsWithPublicEventContext([original], {
    market: 'futures',
    loader: async () => response('futures'),
    budgetMs: 500,
  });
  assert.equal(result.score, 84);
  assert.equal(result.direction, 'SHORT');
  assert.equal(result.cryptoPublicEventContext.status, 'READY');
  assert.equal(result.cryptoPublicEventContext.derivatives?.longShortRatio, 1.22);
  assert.equal(result.cryptoPublicEventContext.events.length, 1);
  assert.equal(result.cryptoPublicEventContext.events[0]?.kind, 'PUBLIC_LIQUIDATION');
  assert.equal(result.cryptoPublicEventContext.events[0]?.side, 'long');
  assert.equal(result.cryptoPublicEventContext.events[0]?.price, 99);
  assert.equal(result.cryptoPublicEventContext.safety.directionImpact, 0);
  assert.equal(result.cryptoPublicEventContext.safety.pricePlanImpact, 0);
});

test('only final bounded candidates receive public event context and one room load is reused', async () => {
  let calls = 0;
  const rows = [card('BTC', 'spot'), card('ETH', 'spot'), card('XRP', 'spot')];
  const output = await enrichCryptoScannerCardsWithPublicEventContext(rows, {
    market: 'spot',
    maxCandidates: 2,
    loader: async () => { calls += 1; return response('spot'); },
    budgetMs: 500,
  });
  assert.equal(calls, 1);
  assert.notEqual(output[0].cryptoPublicEventContext.status, 'NOT_RUN');
  assert.notEqual(output[1].cryptoPublicEventContext.status, 'NOT_RUN');
  assert.equal(output[2].cryptoPublicEventContext.status, 'NOT_RUN');
  assert.equal(output[2].cryptoPublicEventContext.reason, 'SCANNER_EVIDENCE_BUDGET_NOT_SELECTED');
});

test('unsafe request-policy evidence fails closed without mutating the card', async () => {
  const unsafe = response('futures');
  unsafe.requestPolicy.privateExchangeRequests = 1 as never;
  const original = card('BTCUSDT', 'futures');
  const [result] = await enrichCryptoScannerCardsWithPublicEventContext([original], {
    market: 'futures', loader: async () => unsafe, budgetMs: 500,
  });
  assert.equal(result.score, original.score);
  assert.equal(result.cryptoPublicEventContext.status, 'NOT_AVAILABLE');
  assert.equal(result.cryptoPublicEventContext.reason, 'CRYPTO_PUBLIC_EVENT_UNSAFE_REQUEST_POLICY');
  assert.equal(result.cryptoPublicEventContext.events.length, 0);
});

test('provider timeout/unavailable is explicit and never fabricates an event', async () => {
  const [result] = await enrichCryptoScannerCardsWithPublicEventContext([card('BTC', 'spot')], {
    market: 'spot',
    budgetMs: 50,
    loader: async (_room, signal) => await new Promise<MarketInformationResponse>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  assert.equal(result.cryptoPublicEventContext.status, 'TIMEOUT');
  assert.equal(result.cryptoPublicEventContext.events.length, 0);
  assert.equal(result.cryptoPublicEventContext.marketWarning, null);
});
