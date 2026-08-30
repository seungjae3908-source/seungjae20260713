import type {
  ScannerResponse,
  ScannerSignalCard,
  ScannerStrategyMode,
  ScannerTradeAction,
} from './scanner-signal.types';
import {
  getScannerStrategyProfile,
  scannerModeToHorizon,
  type ScannerProfileHorizon,
  type ScannerProfileMarket,
} from './scanner-strategy-profile.service';
import {
  strategyParameterHash,
  StrategyPromotionService,
  type StrategyDirection,
  type StrategyPromotionRecord,
} from './strategy-promotion.service';

export type ScannerCanonicalPaperStyle = 'SCALPING' | 'SWING' | 'MID_LONG';

export type ScannerCanonicalPaperCandidate = Readonly<{
  signal: Readonly<{
    signalId: string;
    market: ScannerProfileMarket;
    symbol: string;
    timestampMs: number;
    ttlMs: number;
    expiresAtMs: number;
    style: ScannerCanonicalPaperStyle;
    timeframe: string;
    horizon: number;
    direction: StrategyDirection;
    signalDirection: StrategyDirection;
    strategyIdentity: Readonly<{
      strategyId: string;
      strategyVersion: string;
      parameterHash: string;
      researchCodeSha: string;
      costPolicyVersion: string;
    }>;
  }>;
  executionAuthority: 'NONE';
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
}>;

export type ScannerCanonicalPaperIdentityResolution = Readonly<{
  paperCandidate: ScannerCanonicalPaperCandidate | null;
  blockers: readonly string[];
}>;

type ScannerCardWithCanonicalPaperCandidate = ScannerSignalCard & Readonly<{
  paperCandidate?: ScannerCanonicalPaperCandidate;
}>;

const MARKET_ALIASES: Readonly<Record<ScannerProfileMarket, readonly string[]>> = Object.freeze({
  KR_STOCK: Object.freeze(['KR', 'KR_STOCK']),
  US_STOCK: Object.freeze(['US', 'US_STOCK']),
  CRYPTO_SPOT: Object.freeze(['SPOT', 'CRYPTO_SPOT', 'UPBIT_KRW']),
  CRYPTO_FUTURES: Object.freeze(['FUTURES', 'CRYPTO_FUTURES', 'BITGET_USDT_FUTURES']),
});

const ASSET_CLASSES: Readonly<Record<ScannerProfileMarket, ScannerSignalCard['assetClass']>> = Object.freeze({
  KR_STOCK: 'stock',
  US_STOCK: 'stock',
  CRYPTO_SPOT: 'coin_spot',
  CRYPTO_FUTURES: 'coin_futures',
});

const STYLE_BY_MODE: Readonly<Record<ScannerStrategyMode, ScannerCanonicalPaperStyle>> = Object.freeze({
  scalping: 'SCALPING',
  swing: 'SWING',
  position: 'MID_LONG',
});

function exactSha(value: string): boolean {
  return /^[0-9a-f]{40}$/u.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function explicitDirection(action: ScannerTradeAction | undefined, market: ScannerProfileMarket): StrategyDirection | null {
  if (market === 'CRYPTO_FUTURES') return action === 'LONG' || action === 'SHORT' ? action : null;
  return action === 'BUY' || action === 'SELL' ? action : null;
}

function canonicalMode(card: ScannerSignalCard): {
  mode: ScannerStrategyMode;
  horizon: ScannerProfileHorizon;
  style: ScannerCanonicalPaperStyle;
} | null {
  const mode = card.strategyMode;
  if (mode !== 'scalping' && mode !== 'swing' && mode !== 'position') return null;
  return Object.freeze({ mode, horizon: scannerModeToHorizon(mode), style: STYLE_BY_MODE[mode] });
}

function timeframeMs(timeframe: string): number | null {
  const match = /^(\d+)(m|H|D)$/u.exec(timeframe);
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isInteger(count) || count <= 0) return null;
  const unitMs = match[2] === 'm'
    ? 60_000
    : match[2] === 'H'
      ? 60 * 60_000
      : 24 * 60 * 60_000;
  return count * unitMs;
}

function canonicalHorizonBars(card: ScannerSignalCard, timeframe: string): {
  timestampMs: number;
  expiresAtMs: number;
  ttlMs: number;
  bars: number;
} | null {
  if (card.observedAt == null || card.expiresAt == null) return null;
  const timestampMs = Date.parse(card.observedAt);
  const expiresAtMs = Date.parse(card.expiresAt);
  const barMs = timeframeMs(timeframe);
  if (!Number.isFinite(timestampMs) || !Number.isFinite(expiresAtMs) || !barMs || expiresAtMs <= timestampMs) return null;
  const ttlMs = expiresAtMs - timestampMs;
  if (ttlMs % barMs !== 0) return null;
  const bars = ttlMs / barMs;
  if (!Number.isInteger(bars) || bars <= 0) return null;
  return Object.freeze({ timestampMs, expiresAtMs, ttlMs, bars });
}

function exactPromotionIdentity(input: {
  records: readonly StrategyPromotionRecord[];
  market: ScannerProfileMarket;
  profileHorizon: ScannerProfileHorizon;
  direction: StrategyDirection;
  researchCodeSha: string;
}): { record: StrategyPromotionRecord | null; blockers: string[] } {
  const profile = getScannerStrategyProfile(input.market, input.profileHorizon);
  const matches = input.records.filter((record) => record.identity.market === input.market
    && record.identity.strategyHorizon === input.profileHorizon
    && record.identity.direction === input.direction);
  const blockers: string[] = [];
  if (matches.length !== 1) {
    blockers.push(matches.length === 0
      ? 'CANONICAL_PROMOTION_IDENTITY_REQUIRED'
      : 'CANONICAL_PROMOTION_IDENTITY_AMBIGUOUS');
    return { record: null, blockers };
  }

  const record = matches[0]!;
  const identity = record.identity;
  if (record.executionAuthority !== 'NONE' || record.liveTradingAuthority !== false || record.privateTradingApiCount !== 0) {
    blockers.push('CANONICAL_PROMOTION_SAFETY_ENVELOPE_INVALID');
  }
  if (identity.strategyFamily !== 'CANONICAL_SCANNER_PROFILE') blockers.push('PROMOTION_STRATEGY_FAMILY_MISMATCH');
  if (identity.strategyId !== `${profile.id}_${input.direction}`) blockers.push('PROMOTION_STRATEGY_ID_MISMATCH');
  if (identity.strategyVersion !== profile.version) blockers.push('PROMOTION_STRATEGY_VERSION_MISMATCH');
  if (identity.parameterHash !== strategyParameterHash(profile)) blockers.push('PROMOTION_PARAMETER_HASH_MISMATCH');
  if (identity.timeframe !== profile.primaryTimeframe) blockers.push('PROMOTION_TIMEFRAME_MISMATCH');
  if (!exactSha(identity.researchCodeSha) || identity.researchCodeSha !== input.researchCodeSha) {
    blockers.push('PROMOTION_RESEARCH_SHA_MISMATCH');
  }
  if (!nonEmpty(identity.costPolicyVersion)) blockers.push('PROMOTION_COST_POLICY_VERSION_REQUIRED');
  return { record: blockers.length === 0 ? record : null, blockers };
}

export function resolveScannerCanonicalPaperIdentity(input: {
  card: ScannerSignalCard;
  market: ScannerProfileMarket;
  researchCodeSha: string;
  promotionRecords?: readonly StrategyPromotionRecord[];
}): ScannerCanonicalPaperIdentityResolution {
  const researchCodeSha = input.researchCodeSha.trim().toLowerCase();
  if (!exactSha(researchCodeSha)) {
    return Object.freeze({ paperCandidate: null, blockers: Object.freeze(['IMMUTABLE_RESEARCH_SHA_REQUIRED']) });
  }

  const blockers: string[] = [];
  const marketToken = String(input.card.market ?? '').trim().toUpperCase();
  if (!MARKET_ALIASES[input.market].includes(marketToken)) blockers.push('SCANNER_MARKET_MISMATCH');
  if (input.card.assetClass !== ASSET_CLASSES[input.market]) blockers.push('SCANNER_ASSET_CLASS_MISMATCH');
  if (!nonEmpty(input.card.signalId) || !nonEmpty(input.card.symbol)) blockers.push('SCANNER_SIGNAL_IDENTITY_REQUIRED');

  const mode = canonicalMode(input.card);
  if (!mode) blockers.push('SCANNER_STRATEGY_MODE_REQUIRED');
  const direction = explicitDirection(input.card.action, input.market);
  if (!direction) blockers.push('SCANNER_EXPLICIT_ACTION_REQUIRED');
  if (!mode || !direction || blockers.length > 0) {
    return Object.freeze({ paperCandidate: null, blockers: Object.freeze([...new Set(blockers)]) });
  }

  const profile = getScannerStrategyProfile(input.market, mode.horizon);
  const horizon = canonicalHorizonBars(input.card, profile.primaryTimeframe);
  if (!horizon) blockers.push('SCANNER_CANONICAL_HORIZON_REQUIRED');

  const records = input.promotionRecords ?? new StrategyPromotionService({ sourceSha: researchCodeSha })
    .list({ market: input.market, strategyHorizon: mode.horizon, direction }).items;
  const promotion = exactPromotionIdentity({
    records,
    market: input.market,
    profileHorizon: mode.horizon,
    direction,
    researchCodeSha,
  });
  blockers.push(...promotion.blockers);

  if (!horizon || !promotion.record || blockers.length > 0) {
    return Object.freeze({ paperCandidate: null, blockers: Object.freeze([...new Set(blockers)]) });
  }

  const identity = promotion.record.identity;
  const paperCandidate: ScannerCanonicalPaperCandidate = Object.freeze({
    signal: Object.freeze({
      signalId: input.card.signalId,
      market: input.market,
      symbol: input.card.symbol,
      timestampMs: horizon.timestampMs,
      ttlMs: horizon.ttlMs,
      expiresAtMs: horizon.expiresAtMs,
      style: mode.style,
      timeframe: identity.timeframe,
      horizon: horizon.bars,
      direction,
      signalDirection: direction,
      strategyIdentity: Object.freeze({
        strategyId: identity.strategyId,
        strategyVersion: identity.strategyVersion,
        parameterHash: identity.parameterHash,
        researchCodeSha: identity.researchCodeSha,
        costPolicyVersion: identity.costPolicyVersion,
      }),
    }),
    executionAuthority: 'NONE',
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
  return Object.freeze({ paperCandidate, blockers: Object.freeze([]) });
}

export function attachScannerCanonicalPaperIdentity(input: {
  response: ScannerResponse;
  market: ScannerProfileMarket;
  researchCodeSha: string;
}): ScannerResponse {
  const researchCodeSha = input.researchCodeSha.trim().toLowerCase();
  if (!exactSha(researchCodeSha)) return input.response;
  const service = new StrategyPromotionService({ sourceSha: researchCodeSha });
  const promotionRecords = service.list({ market: input.market }).items;
  const cards = input.response.cards.map((card) => {
    const resolution = resolveScannerCanonicalPaperIdentity({
      card,
      market: input.market,
      researchCodeSha,
      promotionRecords,
    });
    if (!resolution.paperCandidate) return card;
    const enriched: ScannerCardWithCanonicalPaperCandidate = { ...card, paperCandidate: resolution.paperCandidate };
    return enriched;
  });
  return { ...input.response, cards };
}
