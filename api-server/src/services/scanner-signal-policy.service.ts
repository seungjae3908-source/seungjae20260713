import { createHash } from 'node:crypto';
import type { CatalogEntry } from '../data/catalog';
import type { Candle } from '../sample/types';
import type { ScanCard } from './signal.service';
import type { ScannerUniverseEntry } from './scanner-universe.service';
import type {
  ScannerDataState,
  ScannerEvidence,
  ScannerPricePlan,
  ScannerSignalCard,
  ScannerSignalDirection,
} from './scanner-signal.types';

const FACTOR_WEIGHTS: Record<string, number> = {
  trend: 18,
  volume: 12,
  liquidity: 10,
  technical: 18,
  news: 10,
  financial: 12,
  market: 8,
  risk: 12,
};

const STATUS_COMPLETENESS: Record<string, number> = {
  ok: 1,
  delayed: 0.65,
  stale: 0.35,
  insufficient: 0.2,
  unavailable: 0,
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sourceForCondition(label: string): string {
  if (label.includes('뉴스')) return 'news-provider';
  if (label.includes('공시') || label.includes('기관') || label.includes('외국인')) return 'disclosure-risk-provider';
  if (label.includes('PER') || label.includes('PBR') || label.includes('ROE') || label.includes('저평가')) return 'financial-provider';
  if (label.includes('거래량')) return 'market-candles-volume';
  if (label.includes('거래대금') || label === '시총') return 'market-quote';
  return 'market-candles-technical';
}

function factorForCondition(label: string): string {
  if (label.includes('뉴스')) return 'news';
  if (label.includes('공시') || label.includes('기관') || label.includes('외국인')) return 'risk';
  if (label.includes('PER') || label.includes('PBR') || label.includes('ROE') || label.includes('저평가')) return 'financial';
  if (label.includes('거래량')) return 'volume';
  if (label.includes('거래대금') || label === '시총') return 'liquidity';
  return 'technical';
}

function mapDataState(value: ScanCard['dataState']): ScannerDataState {
  if (value === 'ok') return 'complete';
  if (value === 'stale') return 'stale';
  if (value === 'insufficient') return 'insufficient';
  if (value === 'unavailable') return 'unavailable';
  return 'partial';
}

function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < 2) return null;
  const rows = candles.slice(-Math.min(candles.length, period + 1));
  const ranges: number[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index];
    const previous = rows[index - 1];
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }
  return ranges.length
    ? ranges.reduce((sum, value) => sum + value, 0) / ranges.length
    : null;
}

function pricePlan(
  price: number,
  candles: Candle[],
  direction: ScannerSignalDirection,
  currency: string,
): { plan: ScannerPricePlan; volatilityPercent: number | null } {
  const currentAtr = atr(candles);
  if (!(price > 0) || currentAtr == null || !(currentAtr > 0) || candles.length < 20 || direction === 'NEUTRAL') {
    return {
      plan: { entryZone: null, invalidation: null, stopLoss: null, targets: [], riskReward: null },
      volatilityPercent: currentAtr != null && price > 0 ? round(currentAtr / price * 100) : null,
    };
  }

  const recent = candles.slice(-20);
  const support = Math.min(...recent.map((row) => row.low));
  const resistance = Math.max(...recent.map((row) => row.high));
  const digits = currency === 'KRW' ? 0 : price >= 1 ? 4 : 8;
  const format = (value: number) => round(Math.max(0, value), digits);
  if (direction === 'LONG') {
    const stop = Math.min(support - currentAtr * 0.1, price - Math.max(currentAtr * 1.25, price * 0.01));
    const risk = price - stop;
    if (!(risk > 0)) {
      return {
        plan: { entryZone: null, invalidation: null, stopLoss: null, targets: [], riskReward: null },
        volatilityPercent: round(currentAtr / price * 100),
      };
    }
    const target1 = Math.max(resistance, price + risk * 1.5);
    const target2 = price + risk * 2.2;
    return {
      plan: {
        entryZone: { from: format(Math.max(support, price - currentAtr * 0.35)), to: format(price) },
        invalidation: format(stop),
        stopLoss: format(stop),
        targets: [format(target1), format(target2)],
        riskReward: round((target1 - price) / risk),
      },
      volatilityPercent: round(currentAtr / price * 100),
    };
  }

  const stop = Math.max(resistance + currentAtr * 0.1, price + Math.max(currentAtr * 1.25, price * 0.01));
  const risk = stop - price;
  if (!(risk > 0)) {
    return {
      plan: { entryZone: null, invalidation: null, stopLoss: null, targets: [], riskReward: null },
      volatilityPercent: round(currentAtr / price * 100),
    };
  }
  const target1 = Math.min(support, price - risk * 1.5);
  const target2 = Math.max(0, price - risk * 2.2);
  return {
    plan: {
      entryZone: { from: format(price), to: format(Math.min(resistance, price + currentAtr * 0.35)) },
      invalidation: format(stop),
      stopLoss: format(stop),
      targets: [format(target1), format(target2)],
      riskReward: round((price - target1) / risk),
    },
    volatilityPercent: round(currentAtr / price * 100),
  };
}

function expiry(timeframe: string, observedAt: string): string {
  const base = Date.parse(observedAt);
  const ttl = timeframe === '5m'
    ? 15 * 60_000
    : timeframe === '15m'
      ? 45 * 60_000
      : timeframe === '60m' || timeframe === '1H'
        ? 3 * 60 * 60_000
        : timeframe === '4H'
          ? 12 * 60 * 60_000
          : 3 * 24 * 60 * 60_000;
  return new Date((Number.isFinite(base) ? base : Date.now()) + ttl).toISOString();
}

function signalId(
  memberId: string,
  entry: Pick<CatalogEntry, 'market' | 'ticker'>,
  direction: ScannerSignalDirection,
  timeframe: string,
  selected: string[],
): string {
  const digest = createHash('sha256')
    .update([memberId, entry.market, entry.ticker, direction, timeframe, [...selected].sort().join('|')].join(':'))
    .digest('hex')
    .slice(0, 24);
  return `signal:${digest}`;
}

export interface StockSignalPolicyInput {
  memberId: string;
  card: ScanCard;
  universeEntry: ScannerUniverseEntry;
  candles: Candle[];
  selected: string[];
  timeframe: string;
}

export function applyStockSignalPolicy(input: StockSignalPolicyInput): ScannerSignalCard {
  const { card, universeEntry, candles, selected, timeframe } = input;
  const factors = card.scoreBreakdown ?? {};
  let completenessTotal = 0;
  let fixedScore = 0;
  for (const [key, weight] of Object.entries(FACTOR_WEIGHTS)) {
    const factor = factors[key];
    completenessTotal += weight * (STATUS_COMPLETENESS[factor?.status ?? 'unavailable'] ?? 0);
    fixedScore += weight * (typeof factor?.score === 'number' && Number.isFinite(factor.score) ? factor.score : 0) / 100;
  }
  const dataCompleteness = Math.round(clamp(completenessTotal));
  const dataState = mapDataState(card.dataState);
  let scoreCap = 100;
  if (dataCompleteness < 50) scoreCap = 49;
  else if (dataCompleteness < 65) scoreCap = 59;
  else if (dataCompleteness < 80) scoreCap = 69;
  if (factors.risk?.status !== 'ok' || card.riskScore == null) scoreCap = Math.min(scoreCap, 64);
  if (universeEntry.listingStatus !== 'LISTED') scoreCap = Math.min(scoreCap, 64);
  if (dataState === 'partial') scoreCap = Math.min(scoreCap, 69);
  if (['stale', 'insufficient', 'unavailable'].includes(dataState)) scoreCap = Math.min(scoreCap, 59);
  const score = Math.round(clamp(Math.min(fixedScore, scoreCap)));
  const confidence = Math.round(clamp(Math.min(
    Number.isFinite(card.confidence) ? card.confidence : 0,
    dataCompleteness,
    dataState === 'complete' ? 100 : dataState === 'partial' ? 69 : 59,
  )));

  const matchedSet = new Set(card.matched ?? []);
  const missingSet = new Set(card.missing ?? []);
  const evidence: ScannerEvidence[] = selected.map((label) => {
    const factorKey = factorForCondition(label);
    const factor = factors[factorKey];
    const status = matchedSet.has(label)
      ? 'matched'
      : factor?.status !== 'ok'
        ? 'unverified'
        : 'not_matched';
    return {
      key: label,
      label,
      status,
      source: sourceForCondition(label),
      observedAt: card.analyzedAt ?? null,
      reasons: factor?.reasons?.length
        ? factor.reasons
        : status === 'unverified'
          ? ['필수 데이터가 없어 조건을 확인하지 못했습니다.']
          : status === 'not_matched' || missingSet.has(label)
            ? ['실제 데이터가 선택 조건을 충족하지 않았습니다.']
            : ['백엔드가 실제 데이터로 조건을 확인했습니다.'],
    };
  });
  const notMatched = evidence.filter((item) => item.status === 'not_matched').map((item) => item.label);
  const unverified = evidence.filter((item) => item.status === 'unverified').map((item) => item.label);
  const allSelectedMatched = selected.length > 0 && evidence.every((item) => item.status === 'matched');
  const direction: ScannerSignalDirection = 'LONG';
  const observedAt = card.analyzedAt || new Date().toISOString();
  const technicalPlan = pricePlan(card.price, candles, direction, card.currency);
  const strongSignalEligible = allSelectedMatched
    && score >= 75
    && confidence >= 70
    && dataCompleteness >= 80
    && card.riskScore != null
    && card.riskScore <= 45
    && card.liquidity != null
    && card.liquidity > 0
    && dataState === 'complete'
    && technicalPlan.plan.riskReward != null
    && technicalPlan.plan.riskReward >= 1.5
    && universeEntry.listingStatus === 'LISTED';
  const warnings: string[] = [];
  if (unverified.length) warnings.push(`미확인 조건 ${unverified.length}개`);
  if (card.riskScore == null) warnings.push('위험 데이터 없음');
  if (dataState !== 'complete') warnings.push(`데이터 상태 ${dataState}`);
  if (universeEntry.listingStatus !== 'LISTED') warnings.push('상장 상태 미확인');

  const volume = candles.at(-1)?.volume ?? null;
  const tradingValue = volume != null && Number.isFinite(volume) ? volume * card.price : card.liquidity;
  const sources = new Set<string>(['market-quote', 'market-candles']);
  for (const item of evidence) {
    if (item.status !== 'unverified') sources.add(item.source);
  }

  return {
    signalId: signalId(input.memberId, universeEntry, direction, timeframe, selected),
    assetClass: 'stock',
    market: card.market,
    exchange: universeEntry.exchange,
    symbol: card.ticker,
    name: card.name,
    currency: card.currency,
    assetType: String(card.assetType ?? universeEntry.assetType),
    listingStatus: universeEntry.listingStatus,
    price: card.price,
    changePercent: Number.isFinite(card.changePercent) ? card.changePercent : null,
    direction,
    signalState: strongSignalEligible ? 'WATCHING' : dataState === 'unavailable' ? 'INVALIDATED' : 'DETECTED',
    score,
    confidence,
    dataCompleteness,
    riskScore: card.riskScore,
    riskLevel: card.riskLevel,
    liquidity: card.liquidity,
    volume,
    tradingValue: tradingValue != null && Number.isFinite(tradingValue) ? tradingValue : null,
    spreadPercent: null,
    volatilityPercent: technicalPlan.volatilityPercent,
    matched: evidence.filter((item) => item.status === 'matched').map((item) => item.label),
    notMatched,
    unverified,
    evidence,
    pricePlan: technicalPlan.plan,
    dataState,
    dataSources: [...sources],
    observedAt,
    expiresAt: expiry(timeframe, observedAt),
    strongSignalEligible,
    warnings,
  };
}
