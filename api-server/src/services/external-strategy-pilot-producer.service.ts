import { createHash } from 'node:crypto';
import {
  buildScannerIndicatorSnapshot,
  scannerEma,
  scannerMacd,
  scannerRsi,
} from './scanner-indicator-library.service';
import { evaluateScannerDataQuality } from './scanner-data-quality.service';
import {
  EXTERNAL_STRATEGY_SOURCE_SET_DIGEST,
  STRATEGY_RULE_PACK_AI_REVIEW_MAX_TTL_MS,
  evaluateStrategyRulePackDeterministicGate,
  strategyRulePackAiEvidenceDigest,
} from './evidence-backed-auto-strategy-catalog.service';
import { calculateTradingRisk, type RiskEngineResult } from './trading-risk-engine.service';
import { MarketIntelligenceAiAnalyzer } from './market-intelligence-ai-analysis.service';
import type { CanonicalSignalAiReviewProof } from './member-auto-trading-ai-review-evidence.service';
import type { UpbitTrendPullbackPublicSnapshot } from './upbit-external-pilot-public-data.service';
import {
  buildMemberAutoTradingPaperHandoff,
  validateMemberAutoTradingPaperHandoff,
  type MemberAutoTradingPaperHandoff,
} from '../../../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js';

const STRATEGY_ID = 'TREND_PULLBACK_REACCEL_V1' as const;
const STRATEGY_VERSION = 'TREND_PULLBACK_REACCEL_V1@1' as const;
const COST_MAX_AGE_MS = 24 * 60 * 60_000;
const DATA_MAX_AGE_MS = 30_000;
// This amount is used only to measure observed public orderbook depth. It is
// never an order-size authority; member sizing is applied later by the Worker.
const LIQUIDITY_REFERENCE_NOTIONAL_KRW = 100_000;

export type ExternalPilotAiDecision = Readonly<{
  status: 'PASS' | 'VETO' | 'ABSTAIN' | 'UNAVAILABLE';
  provider: string | null;
  model: string | null;
  reviewedAtMs: number;
  reason: string;
}>;

export type ExternalPilotAiReviewer = Readonly<{
  review(input: Readonly<{
    evidenceDigest: string;
    signalId: string;
    symbol: string;
    direction: 'BUY';
    observedAtMs: number;
    facts: readonly string[];
  }>, signal?: AbortSignal): Promise<ExternalPilotAiDecision>;
}>;

export type UpbitExternalPilotCostPolicy = Readonly<{
  version: string;
  commissionRate: number;
  entryCommissionRate?: number;
  exitCommissionRate?: number;
  minimumOrderKrw?: number;
  observedAtMs: number;
  maxAgeMs?: number;
  provenance: string;
  quality: 'ACCOUNT_READBACK' | 'DOCUMENTED_CURRENT_POLICY';
}>;

export type ExternalPilotFreeAiPolicy = Readonly<{
  configured: boolean;
  provider: 'google-gemini' | 'groq' | null;
  model: string | null;
  reason: string;
}>;

export type UpbitExternalPilotProducerInput = Readonly<{
  serviceSha: string;
  snapshot: UpbitTrendPullbackPublicSnapshot;
  costPolicy: UpbitExternalPilotCostPolicy | null;
  aiReviewer: ExternalPilotAiReviewer | null;
  nowMs?: number;
  riskAccountBalanceKrw?: number;
  dailyRealizedPnlKrw?: number;
  weeklyRealizedPnlKrw?: number;
  consecutiveLosses?: number;
  openExposureKrw?: number;
  sameDirectionExposureKrw?: number;
  signal?: AbortSignal;
}>;

export type UpbitExternalPilotProducerResult = Readonly<{
  schemaVersion: 'external-strategy-pilot-producer-result-v1';
  market: 'CRYPTO_SPOT';
  symbol: string;
  strategyId: typeof STRATEGY_ID;
  observationKind: 'LIVE_PUBLIC_MARKET';
  state: 'BLOCKED_DATA' | 'NO_SIGNAL' | 'BLOCKED_COST' | 'BLOCKED_RISK' | 'BLOCKED_AI' | 'READY';
  naturalCandidateCount: 0 | 1;
  riskAdmissionCount: 0 | 1;
  handoffEntryCount: 0 | 1;
  workerContractAdmissionCount: 0 | 1;
  blockers: readonly string[];
  metrics: Readonly<Record<string, number | string | boolean | null>>;
  handoff: Readonly<Record<string, unknown>>;
}>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validRate(value: unknown): value is number {
  return finite(value) && value >= 0 && value < 0.1;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Pure parser for an already-authorized Upbit /v1/orders/chance response. */
export function upbitExternalPilotCostPolicyFromOrderChance(
  raw: unknown,
  observedAtMs: number,
  provenance = 'UPBIT_READ_ONLY_ORDERS_CHANCE',
): UpbitExternalPilotCostPolicy {
  const root = record(raw);
  const market = record(root?.market);
  const bid = record(market?.bid);
  const ask = record(market?.ask);
  const entryCommissionRate = numeric(root?.bid_fee);
  const exitCommissionRate = numeric(root?.ask_fee);
  const minimumOrderKrw = numeric(bid?.min_total) ?? numeric(ask?.min_total);
  if (!validRate(entryCommissionRate) || !validRate(exitCommissionRate)
    || minimumOrderKrw == null || minimumOrderKrw <= 0
    || !finite(observedAtMs) || observedAtMs <= 0 || !provenance.trim()) {
    throw new Error('UPBIT_PILOT_ACCOUNT_COST_READBACK_INVALID');
  }
  return Object.freeze({
    version: `upbit-account-readback-v1:${observedAtMs}`,
    commissionRate: Math.max(entryCommissionRate, exitCommissionRate),
    entryCommissionRate,
    exitCommissionRate,
    minimumOrderKrw,
    observedAtMs,
    provenance,
    quality: 'ACCOUNT_READBACK' as const,
  });
}

export function resolveExternalPilotFreeAiPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ExternalPilotFreeAiPolicy {
  const blocked = (reason: string): ExternalPilotFreeAiPolicy => Object.freeze({
    configured: false, provider: null, model: null, reason,
  });
  if (env.EXTERNAL_PILOT_AI_FREE_TIER_CONFIRMED !== 'true') {
    return blocked('EXTERNAL_PILOT_AI_FREE_TIER_CONFIRMATION_REQUIRED');
  }
  const explicit = env.AI_CHAT_PROVIDER?.trim().toLowerCase() ?? '';
  if (explicit === 'openai-compatible') return blocked('EXTERNAL_PILOT_AI_PAID_OR_UNVERIFIED_PROVIDER_BLOCKED');
  const geminiKey = env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim();
  const groqKey = env.GROQ_API_KEY?.trim();
  if (geminiKey && groqKey) return blocked('EXTERNAL_PILOT_AI_MULTI_PROVIDER_FALLBACK_BLOCKED');
  const geminiSelected = ['google', 'gemini', 'google-gemini'].includes(explicit)
    || (!explicit && Boolean(geminiKey));
  const groqSelected = explicit === 'groq' || (!explicit && Boolean(groqKey));
  if (geminiSelected) {
    if (groqKey) return blocked('EXTERNAL_PILOT_AI_MULTI_PROVIDER_FALLBACK_BLOCKED');
    const key = explicit ? env.AI_CHAT_API_KEY?.trim() || geminiKey : geminiKey;
    const model = env.AI_CHAT_MODEL?.trim() || env.GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite';
    return key && model === 'gemini-3.1-flash-lite'
      ? Object.freeze({ configured: true, provider: 'google-gemini', model, reason: 'FREE_TIER_EXACT_MODEL_CONFIGURED' })
      : blocked(key ? 'EXTERNAL_PILOT_AI_FREE_MODEL_REQUIRED' : 'EXTERNAL_PILOT_AI_KEY_REQUIRED');
  }
  if (groqSelected) {
    if (geminiKey) return blocked('EXTERNAL_PILOT_AI_MULTI_PROVIDER_FALLBACK_BLOCKED');
    const key = explicit ? env.AI_CHAT_API_KEY?.trim() || groqKey : groqKey;
    const model = env.AI_CHAT_MODEL?.trim() || env.GROQ_MODEL?.trim() || 'openai/gpt-oss-20b';
    return key && model === 'openai/gpt-oss-20b'
      ? Object.freeze({ configured: true, provider: 'groq', model, reason: 'FREE_TIER_EXACT_MODEL_CONFIGURED' })
      : blocked(key ? 'EXTERNAL_PILOT_AI_FREE_MODEL_REQUIRED' : 'EXTERNAL_PILOT_AI_KEY_REQUIRED');
  }
  return blocked(explicit ? 'EXTERNAL_PILOT_AI_PROVIDER_UNSUPPORTED' : 'EXTERNAL_PILOT_AI_NOT_CONFIGURED');
}

export function buildEmptyExternalPilotHandoffFile(serviceSha: string, evaluatedAtMs: number, cycleId: string) {
  if (!/^[a-f0-9]{40}$/u.test(serviceSha)) throw new Error('EXTERNAL_PILOT_SERVICE_SHA_REQUIRED');
  const handoff = buildMemberAutoTradingPaperHandoff({ cycleId, evaluatedAtMs, lanes: [] });
  return Object.freeze({
    schemaVersion: 'external-strategy-pilot-handoff-file-v1',
    envelope: Object.freeze({
      admissionPath: 'EXTERNAL_STRATEGY_PILOT',
      researchGenuineSClaimed: false,
      sourceSetDigest: EXTERNAL_STRATEGY_SOURCE_SET_DIGEST,
      serviceSha,
    }),
    handoff,
  });
}

function result(
  input: UpbitExternalPilotProducerInput,
  state: UpbitExternalPilotProducerResult['state'],
  blockers: readonly string[],
  metrics: Record<string, number | string | boolean | null>,
  handoff: Record<string, unknown>,
  counts: { natural?: boolean; risk?: boolean; handoff?: boolean } = {},
): UpbitExternalPilotProducerResult {
  return Object.freeze({
    schemaVersion: 'external-strategy-pilot-producer-result-v1',
    market: 'CRYPTO_SPOT',
    symbol: input.snapshot.symbol,
    strategyId: STRATEGY_ID,
    observationKind: 'LIVE_PUBLIC_MARKET',
    state,
    naturalCandidateCount: counts.natural ? 1 : 0,
    riskAdmissionCount: counts.risk ? 1 : 0,
    handoffEntryCount: counts.handoff ? 1 : 0,
    // Only the Worker-owned parser may increment this count. Building a
    // canonical handoff is not itself proof that the consumer accepted it.
    workerContractAdmissionCount: 0,
    blockers: Object.freeze([...new Set(blockers)].sort()),
    metrics: Object.freeze({ ...metrics }),
    handoff: Object.freeze(handoff),
  });
}

function previous<T>(rows: readonly T[]): readonly T[] {
  return rows.length > 1 ? rows.slice(0, -1) : [];
}

function last<T>(rows: readonly T[]): T {
  const value = rows.at(-1);
  if (value == null) throw new Error('UPBIT_PILOT_SERIES_EMPTY');
  return value;
}

function orderbookExecution(snapshot: UpbitTrendPullbackPublicSnapshot, quoteAmount: number) {
  let remaining = quoteAmount;
  let quantity = 0;
  let spent = 0;
  for (const level of snapshot.orderbook.askLevels) {
    const availableQuote = level.price * level.size;
    const takeQuote = Math.min(remaining, availableQuote);
    quantity += takeQuote / level.price;
    spent += takeQuote;
    remaining -= takeQuote;
    if (remaining <= 1e-8) break;
  }
  const averagePrice = quantity > 0 ? spent / quantity : null;
  const midpoint = (snapshot.orderbook.bid + snapshot.orderbook.ask) / 2;
  return {
    fillable: remaining <= 1,
    averagePrice,
    midpoint,
    spreadRate: (snapshot.orderbook.ask - snapshot.orderbook.bid) / midpoint,
    slippageRate: averagePrice == null ? null : Math.max(0, averagePrice / midpoint - 1),
  };
}

function quality(snapshot: UpbitTrendPullbackPublicSnapshot, nowMs: number) {
  const rows = [
    ['5m', snapshot.candles5m],
    ['15m', snapshot.candles15m],
    ['60m', snapshot.candles60m],
  ] as const;
  return rows.map(([timeframe, candles]) => evaluateScannerDataQuality({
    symbol: snapshot.symbol,
    timeframe,
    candles: [...candles],
    now: nowMs,
    sessionAware: false,
    providerObservations: [{
      provider: 'upbit-orderbook',
      symbol: snapshot.symbol,
      price: (snapshot.orderbook.bid + snapshot.orderbook.ask) / 2,
      observedAt: snapshot.orderbook.observedAtMs,
    }],
  }));
}

function strategyEvidence(snapshot: UpbitTrendPullbackPublicSnapshot, nowMs: number) {
  const five = buildScannerIndicatorSnapshot([...snapshot.candles5m], 'UTC');
  const fifteen = buildScannerIndicatorSnapshot([...snapshot.candles15m], 'UTC');
  const hourly = buildScannerIndicatorSnapshot([...snapshot.candles60m], 'UTC');
  const previous5Closes = previous(snapshot.candles5m).map((row) => row.close);
  const previous60Closes = previous(snapshot.candles60m).map((row) => row.close);
  const latest5 = last(snapshot.candles5m);
  const recentPullback = snapshot.candles15m.slice(-7, -1);
  const pullbackReference = Math.max(fifteen.ema20 ?? 0, fifteen.vwap ?? 0);
  const previousRsi = scannerRsi(previous5Closes, 14);
  const previousMacd = scannerMacd(previous5Closes);
  const previousHourlyEma20 = scannerEma(previous60Closes, 20);
  const microHigh = Math.max(...snapshot.candles5m.slice(-4, -1).map((row) => row.high));
  const qualities = quality(snapshot, nowMs);
  const orderbookMidpoint = (snapshot.orderbook.bid + snapshot.orderbook.ask) / 2;
  const priceAlignmentReady = Math.abs(latest5.close / orderbookMidpoint - 1) <= 0.005;
  const dataReady = qualities.every((row) => row.state === 'TRUSTED' && row.strongSignalAllowed)
    && nowMs - snapshot.orderbook.observedAtMs <= DATA_MAX_AGE_MS
    && priceAlignmentReady;
  const trendRegimeReady = hourly.close != null && hourly.ema20 != null && hourly.ema60 != null
    && previousHourlyEma20 != null && hourly.close > hourly.ema20 && hourly.ema20 > hourly.ema60
    && hourly.ema20 >= previousHourlyEma20;
  const waveStructureReady = five.waveStructure === 'BULLISH'
    && five.confirmedPivotHighs >= 2 && five.confirmedPivotLows >= 2;
  const pullbackReady = pullbackReference > 0
    && recentPullback.some((row) => row.low <= pullbackReference * 1.003)
    && latest5.close >= pullbackReference * 0.997;
  const reaccelerationReady = five.rsi14 != null && previousRsi != null
    && five.rsi14 >= 50 && five.rsi14 <= 72 && five.rsi14 > previousRsi
    && five.macd.histogram != null && previousMacd.histogram != null
    // A pullback can leave the histogram below zero. Re-acceleration is the
    // strictly rising histogram after that pullback; requiring it to cross zero
    // would turn this into a later breakout-chase rule that the catalog does
    // not specify.
    && five.macd.histogram > previousMacd.histogram;
  const volumeAccelerationReady = five.relativeVolume20 != null && five.relativeVolume20 >= 1.2
    && five.volumeTrend20 != null && five.volumeTrend20 > 0;
  const indicatorReady = [hourly.ema20, hourly.ema60, fifteen.vwap, five.rsi14,
    five.macd.histogram, five.relativeVolume20, five.atr14].every(finite);
  const entryTriggerReady = Number.isFinite(microHigh) && latest5.close > microHigh;
  const formulaReady = trendRegimeReady && waveStructureReady && pullbackReady
    && reaccelerationReady && volumeAccelerationReady && entryTriggerReady;
  return {
    qualities,
    five,
    fifteen,
    hourly,
    evidence: {
      strategyId: STRATEGY_ID,
      dataReady,
      priceAlignmentReady,
      formulaReady,
      waveStructureReady,
      indicatorReady,
      entryTriggerReady,
      trendRegimeReady,
      pullbackReady,
      reaccelerationReady,
      volumeAccelerationReady,
    },
    microHigh,
    latest5,
    previousRsi,
    previousMacdHistogram: previousMacd.histogram,
  };
}

function costPolicyBlockers(policy: UpbitExternalPilotCostPolicy | null, nowMs: number): string[] {
  if (!policy) return ['UPBIT_PILOT_COST_POLICY_REQUIRED'];
  const blockers: string[] = [];
  if (!policy.version.trim()) blockers.push('UPBIT_PILOT_COST_POLICY_VERSION_REQUIRED');
  if (!validRate(policy.commissionRate)) blockers.push('UPBIT_PILOT_COMMISSION_RATE_INVALID');
  if (policy.entryCommissionRate != null && !validRate(policy.entryCommissionRate)) {
    blockers.push('UPBIT_PILOT_ENTRY_COMMISSION_RATE_INVALID');
  }
  if (policy.exitCommissionRate != null && !validRate(policy.exitCommissionRate)) {
    blockers.push('UPBIT_PILOT_EXIT_COMMISSION_RATE_INVALID');
  }
  if (policy.minimumOrderKrw != null
    && (!finite(policy.minimumOrderKrw) || policy.minimumOrderKrw <= 0)) {
    blockers.push('UPBIT_PILOT_MINIMUM_ORDER_INVALID');
  }
  if (!finite(policy.observedAtMs) || policy.observedAtMs <= 0 || policy.observedAtMs > nowMs) {
    blockers.push('UPBIT_PILOT_COST_TIMESTAMP_INVALID');
  } else if (nowMs - policy.observedAtMs > (policy.maxAgeMs ?? COST_MAX_AGE_MS)) {
    blockers.push('UPBIT_PILOT_COST_POLICY_STALE');
  }
  if (!policy.provenance.trim()) blockers.push('UPBIT_PILOT_COST_PROVENANCE_REQUIRED');
  if (policy.quality !== 'ACCOUNT_READBACK' && policy.quality !== 'DOCUMENTED_CURRENT_POLICY') {
    blockers.push('UPBIT_PILOT_COST_POLICY_QUALITY_INVALID');
  }
  if (policy.maxAgeMs != null && (!finite(policy.maxAgeMs) || policy.maxAgeMs <= 0
    || policy.maxAgeMs > COST_MAX_AGE_MS)) {
    blockers.push('UPBIT_PILOT_COST_MAX_AGE_INVALID');
  }
  return blockers;
}

function canonicalProof(
  input: { signalId: string; serviceSha: string; evidenceDigest: string },
  review: ExternalPilotAiDecision,
): CanonicalSignalAiReviewProof {
  const reviewedAtMs = review.reviewedAtMs;
  const body = {
    schemaVersion: 'canonical-signal-ai-review-v1' as const,
    source: 'CANONICAL_SIGNAL_AI_REVIEW' as const,
    signalId: input.signalId,
    strategyId: STRATEGY_ID,
    market: 'CRYPTO_SPOT',
    direction: 'BUY',
    researchCodeSha: input.serviceSha,
    decision: 'PASS' as const,
    liveEligibility: 'PASS_ONLY_ELIGIBLE' as const,
    evidenceDigest: input.evidenceDigest,
    reviewedAtMs,
    expiresAtMs: reviewedAtMs + STRATEGY_RULE_PACK_AI_REVIEW_MAX_TTL_MS,
  };
  return Object.freeze({ ...body, reviewDigest: sha256(body) });
}

function riskEvidence(risk: RiskEngineResult, evaluatedAtMs: number) {
  return Object.freeze({
    status: 'APPROVED',
    source: 'TRADING_RISK_ENGINE',
    evaluatedAtMs,
    simulatedOnly: true,
    allowed: risk.allowed,
    blockCodes: Object.freeze([...risk.blockCodes]),
    recommendedQuantity: risk.recommendedQuantity,
    actualRiskPercent: risk.actualRiskPercent,
    riskReward1: risk.riskReward1,
    riskReward2: risk.riskReward2,
    policyIdentity: Object.freeze({
      policy: 'TRADING_RISK_POLICY',
      liquidityReferenceNotionalKrw: LIQUIDITY_REFERENCE_NOTIONAL_KRW,
      memberSizingRequiredAtWorker: true,
    }),
    executionAuthority: 'NONE',
  });
}

export class ExistingMarketAiExternalPilotReviewer implements ExternalPilotAiReviewer {
  constructor(
    private readonly analyzer = new MarketIntelligenceAiAnalyzer({ timeoutMs: 6_000, maxInFlight: 2, maxCacheEntries: 64 }),
    private readonly now: () => number = Date.now,
    private readonly policy: ExternalPilotFreeAiPolicy = resolveExternalPilotFreeAiPolicy(),
  ) {}

  async review(input: Parameters<ExternalPilotAiReviewer['review']>[0], signal?: AbortSignal): Promise<ExternalPilotAiDecision> {
    if (!this.policy.configured || !this.policy.provider || !this.policy.model) {
      return Object.freeze({ status: 'UNAVAILABLE', provider: null, model: null,
        reviewedAtMs: this.now(), reason: this.policy.reason });
    }
    const analyzed = await this.analyzer.analyze({
      analysisKey: input.evidenceDigest,
      aiMode: 'CHEAP_AI',
      evidenceStatus: 'READY',
      market: 'CRYPTO_SPOT',
      symbol: input.symbol,
      sourceType: 'EXTERNAL_STRATEGY_PILOT_SNAPSHOT',
      sourceTier: 'DIRECT_PUBLIC_MARKET_DATA',
      sourceName: 'Upbit public candles and orderbook',
      sourceUrl: 'https://api.upbit.com',
      publishedAt: new Date(input.observedAtMs).toISOString(),
      eventType: 'STRATEGY_RISK_VETO_REVIEW',
      headline: '추세 눌림 재가속 후보의 공개 데이터 위험 검토',
      evidenceFacts: [...input.facts],
    }, signal);
    const reviewedAtMs = this.now();
    if (analyzed.status !== 'ANALYZED' || !analyzed.analysis || !analyzed.model
      || analyzed.model !== this.policy.model) {
      return Object.freeze({ status: 'UNAVAILABLE', provider: null, model: analyzed.model,
        reviewedAtMs, reason: analyzed.model && analyzed.model !== this.policy.model
          ? 'AI_MODEL_POLICY_DRIFT' : analyzed.reason ?? 'AI_ANALYSIS_UNAVAILABLE' });
    }
    const opposing = analyzed.analysis.sentiment === 'NEGATIVE';
    const riskFlagged = analyzed.analysis.riskFlags.length > 0;
    const ambiguous = analyzed.analysis.sentiment === 'UNKNOWN' || analyzed.analysis.sentiment === 'MIXED';
    const status = opposing || riskFlagged ? 'VETO' : ambiguous ? 'ABSTAIN' : 'PASS';
    return Object.freeze({
      status,
      provider: this.policy.provider,
      model: analyzed.model,
      reviewedAtMs,
      reason: opposing ? 'AI_DIRECTION_CONFLICT' : riskFlagged ? 'AI_RISK_FLAGGED'
        : ambiguous ? 'AI_EVIDENCE_AMBIGUOUS' : 'AI_NO_VETO_FOUND',
    });
  }
}

export async function produceUpbitTrendPullbackExternalPilot(
  input: UpbitExternalPilotProducerInput,
): Promise<UpbitExternalPilotProducerResult> {
  const nowMs = input.nowMs ?? Date.now();
  if (!/^[a-f0-9]{40}$/u.test(input.serviceSha)) throw new Error('EXTERNAL_PILOT_SERVICE_SHA_REQUIRED');
  const cycleId = `external-pilot:${input.snapshot.symbol}:${nowMs}`;
  const blank = buildEmptyExternalPilotHandoffFile(input.serviceSha, nowMs, cycleId);
  const strategy = strategyEvidence(input.snapshot, nowMs);
  const execution = orderbookExecution(input.snapshot, LIQUIDITY_REFERENCE_NOTIONAL_KRW);
  const spreadPercent = execution.spreadRate * 100;
  const slippagePercent = execution.slippageRate == null ? null : execution.slippageRate * 100;
  const baseMetrics: Record<string, number | string | boolean | null> = {
    observedAtMs: input.snapshot.orderbook.observedAtMs,
    lastConfirmed5mAtMs: strategy.latest5.time,
    dataReady: strategy.evidence.dataReady,
    priceAlignmentReady: strategy.evidence.priceAlignmentReady,
    trendRegimeReady: strategy.evidence.trendRegimeReady,
    waveStructureReady: strategy.evidence.waveStructureReady,
    pullbackReady: strategy.evidence.pullbackReady,
    reaccelerationReady: strategy.evidence.reaccelerationReady,
    volumeAccelerationReady: strategy.evidence.volumeAccelerationReady,
    entryTriggerReady: strategy.evidence.entryTriggerReady,
    spreadPercent,
    liquidityReferenceNotionalKrw: LIQUIDITY_REFERENCE_NOTIONAL_KRW,
    liquidityReferenceSlippagePercent: slippagePercent,
    liquidityReferenceFillable: execution.fillable,
    rvol20: strategy.five.relativeVolume20,
    rsi14: strategy.five.rsi14,
    previousRsi14: strategy.previousRsi,
    macdHistogram: strategy.five.macd.histogram,
    previousMacdHistogram: strategy.previousMacdHistogram,
    waveStructure: strategy.five.waveStructure,
  };
  if (!strategy.evidence.dataReady) {
    const qualityBlockers = strategy.qualities.flatMap((row) => row.issues
      .filter((issue) => issue.severity === 'blocking').map((issue) => issue.code));
    return result(input, 'BLOCKED_DATA', qualityBlockers.length ? qualityBlockers : ['UPBIT_PILOT_DATA_NOT_READY'],
      baseMetrics, blank);
  }
  if (!strategy.evidence.formulaReady) {
    const missed = Object.entries(strategy.evidence)
      .filter(([key, ready]) => key !== 'strategyId' && ready !== true)
      .map(([key]) => `UPBIT_PILOT_${key.replace(/[A-Z]/gu, (m) => `_${m}`).toUpperCase()}_WAITING`);
    return result(input, 'NO_SIGNAL', missed, baseMetrics, blank);
  }
  const natural = true;
  const liquidityReady = execution.fillable && execution.slippageRate != null
    && spreadPercent <= 0.15 && slippagePercent! <= 0.25;
  if (!liquidityReady) {
    return result(input, 'BLOCKED_DATA', ['UPBIT_PILOT_LIQUIDITY_OR_SLIPPAGE_BLOCKED'],
      baseMetrics, blank, { natural });
  }
  const costBlockers = costPolicyBlockers(input.costPolicy, nowMs);
  if (costBlockers.length > 0 || !input.costPolicy || execution.slippageRate == null) {
    return result(input, 'BLOCKED_COST', costBlockers, baseMetrics, blank, { natural });
  }

  const entry = input.snapshot.orderbook.ask;
  const atr = strategy.five.atr14;
  const support = strategy.five.support20;
  if (!(atr != null && atr > 0 && support != null && support > 0 && support < entry)) {
    return result(input, 'BLOCKED_RISK', ['UPBIT_PILOT_STOP_STRUCTURE_REQUIRED'], baseMetrics, blank, { natural });
  }
  const structuralStop = Math.min(support, entry - atr * 1.1);
  const maximumStop = entry * 0.97;
  const stopLoss = Math.max(structuralStop, maximumStop);
  const riskDistance = entry - stopLoss;
  // Targets are evaluated after the same two-sided fee and observed-depth
  // slippage used by the risk engine. A nominal 1.5R target can fall below
  // 1R net on small crypto pullbacks, so the Pilot waits for a 2.2R/3.2R plan.
  const target1 = entry + riskDistance * 2.2;
  const target2 = entry + riskDistance * 3.2;
  const risk = calculateTradingRisk({
    market: 'crypto-spot',
    symbol: input.snapshot.symbol,
    side: 'long',
    accountBalance: Math.min(
      LIQUIDITY_REFERENCE_NOTIONAL_KRW,
      input.riskAccountBalanceKrw ?? LIQUIDITY_REFERENCE_NOTIONAL_KRW,
    ),
    entryPrice: entry,
    stopLossPrice: stopLoss,
    targetPrice1: target1,
    targetPrice2: target2,
    leverage: 1,
    riskPercent: 0.5,
    entryFeeRate: input.costPolicy.entryCommissionRate ?? input.costPolicy.commissionRate,
    exitFeeRate: input.costPolicy.exitCommissionRate ?? input.costPolicy.commissionRate,
    slippageRate: execution.slippageRate,
    estimatedFundingRate: 0,
    quantityStep: 1e-8,
    quantityPrecision: 8,
    minimumQuantity: 1e-8,
    minimumNotional: input.costPolicy.minimumOrderKrw ?? 5_000,
    maximumLeverage: 1,
    appMaximumLeverage: 1,
    contractRulesStatus: 'live',
    dataStatus: 'live',
    dailyRealizedPnl: input.dailyRealizedPnlKrw ?? 0,
    weeklyRealizedPnl: input.weeklyRealizedPnlKrw ?? 0,
    consecutiveLosses: input.consecutiveLosses ?? 0,
    openExposure: input.openExposureKrw ?? 0,
    sameDirectionExposure: input.sameDirectionExposureKrw ?? 0,
  }, new Date(nowMs));
  if (!risk.allowed || !finite(risk.recommendedQuantity) || risk.recommendedQuantity <= 0) {
    return result(input, 'BLOCKED_RISK', risk.blockCodes.length ? risk.blockCodes : ['UPBIT_PILOT_RISK_REJECTED'],
      { ...baseMetrics, riskReward1: risk.riskReward1, riskPercent: risk.actualRiskPercent }, blank, { natural });
  }

  const ruleEvidence = Object.freeze({
    ...strategy.evidence,
    liquidityReady: true,
    costEvidenceReady: true,
    riskReady: true,
  });
  const parameterHash = sha256({
    strategyVersion: STRATEGY_VERSION,
    timeframes: ['60m', '15m', '5m'],
    rvolMinimum: 1.2,
    spreadMaximumPercent: 0.15,
    slippageMaximumPercent: 0.25,
    riskPercent: 0.5,
  });
  const signalId = `external-pilot:${sha256([input.snapshot.symbol, strategy.latest5.time,
    STRATEGY_VERSION, input.serviceSha]).slice(0, 32)}`;
  const learningSnapshot = Object.freeze({
    strategyRulePackEvidence: ruleEvidence,
    referencePrice: execution.midpoint,
    entryPrice: entry,
    stopLoss,
    target1,
    target2,
    dataTimestamp: new Date(input.snapshot.orderbook.observedAtMs).toISOString(),
    reasons: Object.freeze([
      '1H EMA20/EMA60 상승 추세',
      '15m VWAP 눌림 지지',
      '5m 확정 HH-HL 및 RSI/MACD 재가속',
      '실제 Upbit 호가 기준 spread/depth 통과',
    ]),
    indicators: Object.freeze({
      hourlyEma20: strategy.hourly.ema20,
      hourlyEma60: strategy.hourly.ema60,
      fifteenVwap: strategy.fifteen.vwap,
      fiveRsi14: strategy.five.rsi14,
      fiveMacdHistogram: strategy.five.macd.histogram,
      fiveRvol20: strategy.five.relativeVolume20,
      fiveWaveStructure: strategy.five.waveStructure,
      tradeIntensityProxyIsTrueCvd: false,
    }),
  });
  const dataEvidence = Object.freeze({
    publicOnly: true,
    dataQuality: 'READY',
    provenance: input.snapshot.provenance.join('|'),
    asOfMs: input.snapshot.orderbook.observedAtMs,
    maxAgeMs: DATA_MAX_AGE_MS,
    marketStatus: 'TRADABLE',
    minOrderNotional: 5_000,
    correlatedExposurePercent: 100,
    observationKind: 'LIVE_PUBLIC_MARKET',
  });
  const publicQuote = Object.freeze({
    bid: input.snapshot.orderbook.bid,
    ask: input.snapshot.orderbook.ask,
    bidSize: input.snapshot.orderbook.bidSize,
    askSize: input.snapshot.orderbook.askSize,
    observedAtMs: input.snapshot.orderbook.observedAtMs,
  });
  const gateInput = {
    strategyId: STRATEGY_ID,
    signalId,
    market: 'CRYPTO_SPOT',
    direction: 'BUY',
    symbol: input.snapshot.symbol,
    timeframe: '5m',
    learningSnapshot,
    dataEvidence,
    publicQuote,
  };
  const deterministic = evaluateStrategyRulePackDeterministicGate(gateInput);
  if (!deterministic.recognized || !deterministic.readyForAiReview) {
    return result(input, 'BLOCKED_DATA', deterministic.blockers, baseMetrics, blank, { natural, risk: true });
  }
  if (!input.aiReviewer) {
    return result(input, 'BLOCKED_AI', ['UPBIT_PILOT_AI_REVIEWER_UNAVAILABLE'], baseMetrics, blank,
      { natural, risk: true });
  }
  const evidenceDigest = strategyRulePackAiEvidenceDigest(gateInput);
  const review = await input.aiReviewer.review({
    evidenceDigest,
    signalId,
    symbol: input.snapshot.symbol,
    direction: 'BUY',
    observedAtMs: input.snapshot.orderbook.observedAtMs,
    facts: Object.freeze([
      `60m EMA20 ${strategy.hourly.ema20}; EMA60 ${strategy.hourly.ema60}`,
      `15m VWAP ${strategy.fifteen.vwap}; 현재 ask ${entry}`,
      `5m wave ${strategy.five.waveStructure}; RSI14 ${strategy.five.rsi14}; MACD histogram ${strategy.five.macd.histogram}`,
      `5m RVOL20 ${strategy.five.relativeVolume20}; 관측 spread ${spreadPercent}%`,
      `비용 정책 ${input.costPolicy.version}; 주문 권한 NONE`,
    ]),
  }, input.signal);
  if (review.status !== 'PASS' || !review.provider || !review.model
    || !finite(review.reviewedAtMs) || review.reviewedAtMs < input.snapshot.orderbook.observedAtMs) {
    return result(input, 'BLOCKED_AI', [`UPBIT_PILOT_AI_${review.status}:${review.reason}`],
      { ...baseMetrics, aiStatus: review.status }, blank, { natural, risk: true });
  }
  const evaluatedAtMs = Math.max(nowMs, review.reviewedAtMs);
  const proof = canonicalProof({ signalId, serviceSha: input.serviceSha, evidenceDigest }, review);
  const candidate = {
    executionAuthority: 'NONE',
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    signal: {
      signalId,
      market: 'CRYPTO_SPOT',
      symbol: input.snapshot.symbol,
      timestampMs: input.snapshot.orderbook.observedAtMs,
      expiresAtMs: proof.expiresAtMs,
      ttlMs: proof.expiresAtMs - evaluatedAtMs,
      style: 'SCALPING',
      timeframe: '5m',
      horizon: 12,
      direction: 'BUY',
      regime: 'TREND_PULLBACK_REACCEL',
      strategyIdentity: {
        candidateId: `candidate:${sha256([signalId, parameterHash]).slice(0, 32)}`,
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        parameterHash,
        researchCodeSha: input.serviceSha,
        costPolicyVersion: input.costPolicy.version,
      },
      learningSnapshot,
    },
    paperIdentity: {
      signalId,
      candidateId: `candidate:${sha256([signalId, parameterHash]).slice(0, 32)}`,
      market: 'CRYPTO_SPOT',
      symbol: input.snapshot.symbol,
      timeframe: '5m',
      horizon: 12,
      direction: 'BUY',
      regime: 'TREND_PULLBACK_REACCEL',
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      parameterHash,
      researchCodeSha: input.serviceSha,
      costPolicyVersion: input.costPolicy.version,
      executionAuthority: 'NONE',
    },
    profitEvidence: {
      costPolicyId: input.costPolicy.version,
      profitabilityClaimed: false,
      researchGenuineSClaimed: false,
      source: 'EXTERNAL_STRATEGY_PILOT_LIVE_RULE_EVIDENCE',
    },
    riskEvidence: riskEvidence(risk, evaluatedAtMs),
    aiReviewEvidence: proof,
    execution: {
      marketAdapterIdentity: { provider: 'UPBIT_PUBLIC', market: 'CRYPTO_SPOT' },
      costPolicy: {
        version: input.costPolicy.version,
        commissionRate: input.costPolicy.commissionRate,
        entryCommissionRate: input.costPolicy.entryCommissionRate ?? input.costPolicy.commissionRate,
        exitCommissionRate: input.costPolicy.exitCommissionRate ?? input.costPolicy.commissionRate,
        minimumOrderKrw: input.costPolicy.minimumOrderKrw ?? 5_000,
        taxRate: 0,
        spreadRate: execution.spreadRate,
        slippageRate: execution.slippageRate,
        source: input.costPolicy.provenance,
        quality: input.costPolicy.quality,
      },
      executionPolicy: {
        orderType: 'market',
        liquidityReferenceNotionalKrw: LIQUIDITY_REFERENCE_NOTIONAL_KRW,
        memberSizingRequiredAtWorker: true,
      },
      dataEvidence,
    },
    order: { side: 'BUY', orderType: 'market', simulatedOnly: true },
    quote: publicQuote,
  };
  const handoff = buildMemberAutoTradingPaperHandoff({
    cycleId,
    evaluatedAtMs,
    lanes: [{ market: 'CRYPTO_SPOT', result: { candidates: [candidate] } }],
  });
  const validated = validateMemberAutoTradingPaperHandoff(handoff, evaluatedAtMs) as MemberAutoTradingPaperHandoff;
  const envelope = Object.freeze({
    schemaVersion: 'external-strategy-pilot-handoff-file-v1',
    envelope: Object.freeze({
      admissionPath: 'EXTERNAL_STRATEGY_PILOT',
      researchGenuineSClaimed: false,
      sourceSetDigest: EXTERNAL_STRATEGY_SOURCE_SET_DIGEST,
      serviceSha: input.serviceSha,
    }),
    handoff: validated,
  });
  return result(input, 'READY', [], {
    ...baseMetrics,
    riskReward1: risk.riskReward1,
    riskPercent: risk.actualRiskPercent,
    aiStatus: review.status,
  }, envelope, { natural, risk: true, handoff: true });
}
