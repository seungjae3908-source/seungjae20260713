import { CryptoSignalScannerService } from './crypto-signal-scanner.service';
import { StockSignalScannerService } from './stock-signal-scanner.service';
import {
  OWNER_SELECTED_LIVE_STRATEGIES,
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

function eligible(card: ScannerSignalCard, strategyId: OwnerSelectedStrategyId) {
  const evidence = card.ownerSelectedStrategy;
  return ownerSelectedStrategyEvidenceReady(evidence)
    && evidence.strategyId === strategyId
    && card.listingStatus === 'LISTED'
    && card.dataState !== 'stale'
    && card.dataState !== 'untrusted'
    && card.riskScore != null
    && card.riskScore <= 45
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
    ownerSelectedStrategyId: strategyId,
    signal,
  });
  advance(market, response.universe.nextCursor);
  return response.cards
    .filter((card) => eligible(card, strategyId))
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
