import { scannerCandidateHardFilterReasons } from './scanner-candidate-ranking.service';
import type {
  ScannerDiscoveryCard,
  ScannerDiscoverySummary,
  ScannerSignalCard,
} from './scanner-signal.types';

const DEFAULT_DISCOVERY_LIMIT = 40;
const MAX_DISCOVERY_LIMIT = 100;

function finite(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function directionAllowed(card: ScannerSignalCard): card is ScannerSignalCard & { direction: 'LONG' | 'SHORT' } {
  if (card.direction === 'NEUTRAL') return false;
  return card.assetClass === 'coin_futures' || card.direction === 'LONG';
}

function discoveryCard(card: ScannerSignalCard): ScannerDiscoveryCard {
  return Object.freeze({
    signalId: card.signalId,
    assetClass: card.assetClass,
    market: card.market,
    exchange: card.exchange,
    symbol: card.symbol,
    name: card.name,
    currency: card.currency,
    assetType: card.assetType,
    price: card.price,
    changePercent: card.changePercent,
    direction: card.direction as 'LONG' | 'SHORT',
    score: card.score,
    confidence: card.confidence,
    dataCompleteness: card.dataCompleteness,
    riskScore: card.riskScore,
    riskLevel: card.riskLevel,
    liquidity: card.liquidity,
    volume: card.volume,
    tradingValue: card.tradingValue,
    spreadPercent: card.spreadPercent,
    volatilityPercent: card.volatilityPercent,
    matched: [...card.matched].slice(0, 8),
    unverified: [...card.unverified].slice(0, 8),
    dataState: card.dataState,
    dataSources: [...card.dataSources],
    observedAt: card.observedAt,
    expiresAt: card.expiresAt,
    strategyMode: card.strategyMode,
    warnings: [...card.warnings].slice(0, 8),
    discoveryOnly: true,
    paperEligible: false,
    autoTradeEligible: false,
    executionAuthority: 'NONE',
    tradingBlockers: ['DISCOVERY_ONLY', 'PROFITABILITY_EVIDENCE_NOT_ATTESTED'],
  });
}

export function buildScannerDiscoveryView(
  cards: ScannerSignalCard[],
  options: { tradeReviewCount: number; limit?: number },
): ScannerDiscoverySummary {
  const limit = Math.max(1, Math.min(MAX_DISCOVERY_LIMIT, Math.floor(options.limit ?? DEFAULT_DISCOVERY_LIMIT)));
  const eligible = cards
    .filter(directionAllowed)
    .filter((card) => scannerCandidateHardFilterReasons(card).length === 0)
    .sort((left, right) => right.score - left.score
      || right.confidence - left.confidence
      || finite(right.tradingValue) - finite(left.tradingValue)
      || left.symbol.localeCompare(right.symbol));
  const selected = eligible.slice(0, limit).map(discoveryCard);
  return Object.freeze({
    status: eligible.length > 0 ? 'DISCOVERY_CANDIDATES' : 'VALID_ZERO_DISCOVERY',
    candidateCount: eligible.length,
    returnedCount: selected.length,
    limit,
    truncated: eligible.length > selected.length,
    cards: Object.freeze(selected),
    tradeReviewCount: Math.max(0, Math.floor(options.tradeReviewCount)),
    executionAuthority: 'NONE',
    orderSubmissionAllowed: false,
    paperOrderAllowed: false,
    autoTradeAllowed: false,
  });
}
