import type { ScannerResponse, ScannerSignalCard, ScannerTradeAction } from './scanner-signal.types';
import {
  StrategyPromotionService,
  strategyCandidateId,
  type StrategyDirection,
  type StrategyPromotionRecord,
} from './strategy-promotion.service';

export type ForwardCanonicalMetadataLane = Readonly<{
  market: 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
  timeframe: '5m' | '15m' | '60m' | '4H' | '1D';
  strategyMode: 'scalping' | 'swing' | 'position';
  strategyHorizon: 'SCALP' | 'SWING' | 'POSITION';
  style: 'SCALPING' | 'SWING' | 'MID_LONG';
}>;

export type ForwardCanonicalPaperCandidate = Readonly<{
  candidateId: string;
  signal: Readonly<{
    signalId: string;
    market: ForwardCanonicalMetadataLane['market'];
    symbol: string;
    timeframe: ForwardCanonicalMetadataLane['timeframe'];
    horizon: number;
    direction: StrategyDirection;
    signalDirection: StrategyDirection;
    style: ForwardCanonicalMetadataLane['style'];
    strategyIdentity: Readonly<{
      candidateId: string;
      strategyFamily: string;
      strategyId: string;
      strategyVersion: string;
      parameterHash: string;
      parameterDigest: string;
      researchCodeSha: string;
      accountMode: 'PAPER';
    }>;
  }>;
  executionAuthority: 'NONE';
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
}>;

export type ForwardCanonicalMetadataResolution = Readonly<{
  paperCandidate: ForwardCanonicalPaperCandidate | null;
  blockers: readonly string[];
}>;

type ForwardMetadataCard = ScannerSignalCard & Readonly<{
  paperCandidate?: ForwardCanonicalPaperCandidate;
}>;

function exactSha(value: string): boolean {
  return /^[0-9a-f]{40}$/u.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function actionDirection(card: ScannerSignalCard, lane: ForwardCanonicalMetadataLane): StrategyDirection | null {
  const action: ScannerTradeAction | undefined = card.action;
  if (lane.market === 'CRYPTO_FUTURES') return action === 'LONG' || action === 'SHORT' ? action : null;
  return action === 'BUY' || action === 'SELL' ? action : null;
}

function timeframeMs(timeframe: ForwardCanonicalMetadataLane['timeframe']): number {
  return ({ '5m': 5 * 60_000, '15m': 15 * 60_000, '60m': 60 * 60_000,
    '4H': 4 * 60 * 60_000, '1D': 24 * 60 * 60_000 })[timeframe];
}

function signalHorizonBars(card: ScannerSignalCard, timeframe: ForwardCanonicalMetadataLane['timeframe']): number | null {
  const observedAt = Date.parse(card.observedAt);
  const expiresAt = Date.parse(card.expiresAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) || expiresAt <= observedAt) return null;
  const span = expiresAt - observedAt;
  const interval = timeframeMs(timeframe);
  if (span % interval !== 0) return null;
  const bars = span / interval;
  return Number.isInteger(bars) && bars > 0 ? bars : null;
}

function exactPromotionIdentity(
  records: readonly StrategyPromotionRecord[],
  lane: ForwardCanonicalMetadataLane,
  direction: StrategyDirection,
  researchCodeSha: string,
): { record: StrategyPromotionRecord | null; blockers: string[] } {
  const matches = records.filter((record) => record.identity.direction === direction);
  const blockers: string[] = [];
  if (matches.length !== 1) {
    blockers.push(matches.length === 0 ? 'CANONICAL_PROMOTION_IDENTITY_REQUIRED' : 'CANONICAL_PROMOTION_IDENTITY_AMBIGUOUS');
    return { record: null, blockers };
  }
  const record = matches[0]!;
  const identity = record.identity;
  if (record.executionAuthority !== 'NONE' || record.liveTradingAuthority !== false || record.privateTradingApiCount !== 0) {
    blockers.push('CANONICAL_PROMOTION_SAFETY_ENVELOPE_INVALID');
  }
  if (identity.market !== lane.market) blockers.push('PROMOTION_MARKET_MISMATCH');
  if (identity.strategyHorizon !== lane.strategyHorizon) blockers.push('PROMOTION_HORIZON_MISMATCH');
  if (identity.timeframe !== lane.timeframe) blockers.push('PROMOTION_TIMEFRAME_MISMATCH');
  if (identity.direction !== direction) blockers.push('PROMOTION_DIRECTION_MISMATCH');
  if (identity.strategyFamily !== 'CANONICAL_SCANNER_PROFILE') blockers.push('PROMOTION_STRATEGY_FAMILY_MISMATCH');
  if (!nonEmpty(identity.strategyId)) blockers.push('PROMOTION_STRATEGY_ID_REQUIRED');
  if (!nonEmpty(identity.strategyVersion)) blockers.push('PROMOTION_STRATEGY_VERSION_REQUIRED');
  if (!nonEmpty(identity.parameterHash)) blockers.push('PROMOTION_PARAMETER_HASH_REQUIRED');
  if (!exactSha(identity.researchCodeSha) || identity.researchCodeSha !== researchCodeSha) blockers.push('PROMOTION_RESEARCH_SHA_MISMATCH');
  return { record: blockers.length === 0 ? record : null, blockers };
}

export function resolveForwardObserverCanonicalMetadata(input: {
  card: ScannerSignalCard;
  lane: ForwardCanonicalMetadataLane;
  researchCodeSha: string;
  promotionRecords?: readonly StrategyPromotionRecord[];
}): ForwardCanonicalMetadataResolution {
  const researchCodeSha = input.researchCodeSha.trim().toLowerCase();
  const blockers: string[] = [];
  if (!exactSha(researchCodeSha)) {
    return Object.freeze({ paperCandidate: null, blockers: Object.freeze(['IMMUTABLE_RESEARCH_SHA_REQUIRED']) });
  }
  if (input.card.strategyMode !== input.lane.strategyMode) blockers.push('SCANNER_STRATEGY_MODE_MISMATCH');
  if (!nonEmpty(input.card.signalId) || !nonEmpty(input.card.symbol)) blockers.push('SCANNER_SIGNAL_IDENTITY_REQUIRED');
  const direction = actionDirection(input.card, input.lane);
  if (!direction) blockers.push('SCANNER_EXPLICIT_ACTION_REQUIRED');
  const horizon = signalHorizonBars(input.card, input.lane.timeframe);
  if (horizon == null) blockers.push('SCANNER_NUMERIC_HORIZON_REQUIRED');
  if (blockers.length > 0 || !direction || horizon == null) {
    return Object.freeze({ paperCandidate: null, blockers: Object.freeze([...new Set(blockers)]) });
  }

  const records = input.promotionRecords ?? new StrategyPromotionService({ sourceSha: researchCodeSha })
    .list({ market: input.lane.market, strategyHorizon: input.lane.strategyHorizon }).items;
  const promotion = exactPromotionIdentity(records, input.lane, direction, researchCodeSha);
  blockers.push(...promotion.blockers);
  if (!promotion.record || blockers.length > 0) {
    return Object.freeze({ paperCandidate: null, blockers: Object.freeze([...new Set(blockers)]) });
  }

  const identity = promotion.record.identity;
  const candidateId = strategyCandidateId(identity);
  const paperCandidate: ForwardCanonicalPaperCandidate = Object.freeze({
    candidateId,
    signal: Object.freeze({
      signalId: input.card.signalId,
      market: input.lane.market,
      symbol: input.card.symbol,
      timeframe: input.lane.timeframe,
      horizon,
      direction,
      signalDirection: direction,
      style: input.lane.style,
      strategyIdentity: Object.freeze({
        candidateId,
        strategyFamily: identity.strategyFamily,
        strategyId: identity.strategyId,
        strategyVersion: identity.strategyVersion,
        parameterHash: identity.parameterHash,
        parameterDigest: identity.parameterHash,
        researchCodeSha: identity.researchCodeSha,
        accountMode: 'PAPER' as const,
      }),
    }),
    executionAuthority: 'NONE' as const,
    liveOrderAllowed: false as const,
    privateTradingApiAllowed: false as const,
    orderSubmitted: false as const,
    exchangeRequestSent: false as const,
  });
  return Object.freeze({ paperCandidate, blockers: Object.freeze([]) });
}

export function attachForwardObserverCanonicalMetadata(input: {
  response: ScannerResponse;
  lane: ForwardCanonicalMetadataLane;
  researchCodeSha: string;
}): ScannerResponse {
  const service = new StrategyPromotionService({ sourceSha: input.researchCodeSha.trim().toLowerCase() });
  const promotionRecords = service.list({ market: input.lane.market, strategyHorizon: input.lane.strategyHorizon }).items;
  const cards = input.response.cards.map((card) => {
    const resolution = resolveForwardObserverCanonicalMetadata({
      card,
      lane: input.lane,
      researchCodeSha: input.researchCodeSha,
      promotionRecords,
    });
    if (!resolution.paperCandidate) return card;
    const enriched: ForwardMetadataCard = { ...card, paperCandidate: resolution.paperCandidate };
    return enriched;
  });
  return { ...input.response, cards };
}
