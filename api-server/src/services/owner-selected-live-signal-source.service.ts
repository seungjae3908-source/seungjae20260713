import { CryptoSignalScannerService } from './crypto-signal-scanner.service';
import { StockSignalScannerService } from './stock-signal-scanner.service';
import {
  buildOwnerSelectedCryptoPricePlan,
  collectOwnerSelectedCryptoPublicEvidence,
} from './owner-selected-crypto-public-evidence.service';
import {
  OWNER_SELECTED_LIVE_STRATEGIES,
  evaluateOwnerSelectedCryptoStrategy,
  ownerSelectedStrategyEvidenceReady,
  type OwnerSelectedMarket,
  type OwnerSelectedStrategyId,
} from './owner-selected-live-strategy.service';
import type { ScannerSignalCard } from './scanner-signal.types';

export type OwnerSelectedLiveSignal = Readonly<{
  market: OwnerSelectedMarket;
  strategyId: OwnerSelectedStrategyId;
  card: ScannerSignalCard;
}>;

const cursors: Record<OwnerSelectedMarket, number> = {
  KR_STOCK: 0,
  US_STOCK: 0,
  CRYPTO_SPOT: 0,
  CRYPTO_FUTURES: 0,
};

function baseEligible(card: ScannerSignalCard) {
  return card.listingStatus === 'LISTED'
    && card.dataState !== 'stale'
    && card.dataState !== 'untrusted'
    && card.riskScore != null
    && card.riskScore <= 45
    && card.price > 0;
}

function eligible(card: ScannerSignalCard, strategyId: OwnerSelectedStrategyId) {
  const evidence = card.ownerSelectedStrategy;
  return ownerSelectedStrategyEvidenceReady(evidence)
    && evidence.strategyId === strategyId
    && baseEligible(card)
    && card.pricePlan.stopLoss != null
    && card.pricePlan.targets.length > 0
    && card.pricePlan.riskReward != null
    && card.pricePlan.riskReward >= 1.5;
}

function advance(market: OwnerSelectedMarket, nextCursor: number | null | undefined) {
  cursors[market] = nextCursor == null ? 0 : Math.max(0, nextCursor);
}

async function scanStock(
  market: 'KR_STOCK' | 'US_STOCK',
  signal?: AbortSignal,
): Promise<OwnerSelectedLiveSignal[]> {
  const strategyId = OWNER_SELECTED_LIVE_STRATEGIES[market];
  const response = await StockSignalScannerService.scan({
    memberId: 'owner-selected-live-strategy-source',
    market: market === 'KR_STOCK' ? 'KR' : 'US',
    indicators: market === 'KR_STOCK'
      ? ['거래량 급증', '거래대금 증가', '돌파 직전']
      : ['거래량 급증', '돌파 직전', '눌림목'],
    filters: {
      timeframe: '5m',
      maximumRiskScore: 45,
    },
    cursor: cursors[market],
    batchSize: 40,
    strategyMode: 'scalping',
    ownerSelectedStrategyId: strategyId,
    signal,
  });
  advance(market, response.universe.nextCursor);
  return response.cards
    .filter((card) => eligible(card, strategyId))
    .slice(0, 3)
    .map((card) => Object.freeze({ market, strategyId, card }));
}

async function evaluateCryptoCard(
  market: 'CRYPTO_SPOT' | 'CRYPTO_FUTURES',
  strategyId: OwnerSelectedStrategyId,
  card: ScannerSignalCard,
  signal?: AbortSignal,
): Promise<ScannerSignalCard | null> {
  const snapshot = await collectOwnerSelectedCryptoPublicEvidence({
    market,
    symbol: card.symbol,
    signal,
  });
  const evidence = evaluateOwnerSelectedCryptoStrategy({
    market,
    card,
    candles: snapshot.candles,
    context15m: snapshot.context15m,
    context60m: snapshot.context60m,
    flow: snapshot.flow,
    fundingRate: snapshot.fundingRate,
  });
  if (!ownerSelectedStrategyEvidenceReady(evidence) || evidence.strategyId !== strategyId) return null;

  const direction = evidence.direction === 'SHORT' ? 'SHORT' as const : 'LONG' as const;
  const plan = buildOwnerSelectedCryptoPricePlan({
    market,
    price: card.price,
    candles: snapshot.candles,
    direction,
  });
  if (plan.pricePlan.stopLoss == null
    || plan.pricePlan.targets.length === 0
    || plan.pricePlan.riskReward == null
    || plan.pricePlan.riskReward < 1.5) {
    return null;
  }

  const enriched: ScannerSignalCard = {
    ...card,
    signalId: `${card.signalId}:${strategyId}:${direction}`,
    direction,
    action: evidence.direction === 'BUY' ? 'BUY' : evidence.direction,
    signalState: 'WATCHING',
    strongSignalEligible: true,
    ownerSelectedStrategy: evidence,
    pricePlan: plan.pricePlan,
    volatilityPercent: plan.volatilityPercent,
    dataSources: [...new Set([
      ...card.dataSources,
      ...(snapshot.flow ? [snapshot.flow.provenance] : []),
      'owner-selected-public-multi-timeframe',
    ])],
  };
  return eligible(enriched, strategyId) ? enriched : null;
}

async function scanCrypto(
  market: 'CRYPTO_SPOT' | 'CRYPTO_FUTURES',
  signal?: AbortSignal,
): Promise<OwnerSelectedLiveSignal[]> {
  const strategyId = OWNER_SELECTED_LIVE_STRATEGIES[market];
  const response = await CryptoSignalScannerService.scan({
    memberId: 'owner-selected-live-strategy-source',
    market: market === 'CRYPTO_SPOT' ? 'spot' : 'futures',
    timeframe: '5m',
    condition: 'trend',
    cursor: cursors[market],
    batchSize: 8,
    strategyMode: 'scalping',
    maximumRiskScore: 45,
    signal,
  });
  advance(market, response.universe.nextCursor);

  const candidates = response.cards
    .filter(baseEligible)
    .slice(0, 4);
  const settled = await Promise.allSettled(
    candidates.map((card) => evaluateCryptoCard(market, strategyId, card, signal)),
  );
  return settled
    .flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : [])
    .slice(0, 3)
    .map((card) => Object.freeze({ market, strategyId, card }));
}

export async function scanOwnerSelectedLiveSignals(signal?: AbortSignal) {
  const settled = await Promise.allSettled([
    scanStock('KR_STOCK', signal),
    scanStock('US_STOCK', signal),
    scanCrypto('CRYPTO_SPOT', signal),
    scanCrypto('CRYPTO_FUTURES', signal),
  ]);
  const signals = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  return Object.freeze({
    scannedAt: new Date().toISOString(),
    signals: Object.freeze(signals),
    failures: Object.freeze(settled.flatMap((result, index) => result.status === 'rejected'
      ? [{
        market: (['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'] as const)[index],
        reason: result.reason instanceof Error ? result.reason.message : 'OWNER_SELECTED_SCAN_FAILED',
      }]
      : [])),
  });
}

export function resetOwnerSelectedLiveSignalCursorsForTests() {
  cursors.KR_STOCK = 0;
  cursors.US_STOCK = 0;
  cursors.CRYPTO_SPOT = 0;
  cursors.CRYPTO_FUTURES = 0;
}
