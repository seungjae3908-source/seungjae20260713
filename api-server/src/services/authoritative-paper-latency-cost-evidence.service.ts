import type { PercentCostEvidence } from './scanner-profit-cost-evidence-adapter.service';

export const AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_VERSION =
  'authoritative-paper-latency-cost-evidence-v1' as const;

export type LatencyDirection = 'LONG' | 'SHORT';

export type AuthoritativePaperLatencyIdentity = Readonly<{
  market: 'CRYPTO_FUTURES';
  symbol: string;
  researchCodeSha: string;
}>;

export type PublicMidpointObservation = AuthoritativePaperLatencyIdentity & Readonly<{
  observationId: string;
  midpoint: number;
  observedAtMs: number;
  source: string;
  evidenceClass: 'PUBLIC_MIDPOINT';
  endpointClass: 'PUBLIC_MARKET';
  privateApiUsed: false;
}>;

export type PublicMidpointQuote = AuthoritativePaperLatencyIdentity & Readonly<{
  observationId: string;
  bidPrice: number;
  askPrice: number;
  observedAtMs: number;
  source: string;
  endpointClass: 'PUBLIC_MARKET';
  privateApiUsed: false;
}>;

export type AuthoritativePaperLatencyCostEvidenceResult = Readonly<{
  schemaVersion: typeof AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_VERSION;
  status: 'PRESENT' | 'BLOCKED_DATA';
  evidence: PercentCostEvidence | null;
  observedRoundTripMs: number | null;
  signedMidpointMovePercent: number | null;
  adverseMovePercent: number | null;
  blockers: readonly string[];
  executionAuthority: 'NONE';
  privateApiUsed: false;
  liveTrading: false;
  realFillObserved: false;
  unknownCostIsZero: false;
}>;

export type AuthoritativePaperLatencyCostInput = AuthoritativePaperLatencyIdentity & Readonly<{
  direction: LatencyDirection;
  requestStartedAtMs: number;
  requestCompletedAtMs: number;
  preRequest: PublicMidpointObservation | null;
  postRequest: PublicMidpointObservation | null;
  nowMs?: number;
  maximumAgeMs?: number;
  maximumRequestDurationMs?: number;
}>;

export type AuthoritativePaperSupplementalCostInput = Readonly<{
  costPolicyId?: string;
  observedAtMs?: number;
  latency?: PercentCostEvidence | null;
  liquidityImpact?: PercentCostEvidence | null;
  partialFillImpact?: PercentCostEvidence | null;
  funding?: PercentCostEvidence | null;
  nowMs?: number;
  maximumAgeMs?: number;
}>;

export type AuthoritativePaperLatencySupplementalBinding = Readonly<{
  schemaVersion: typeof AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_VERSION;
  status: 'PRESENT' | 'BLOCKED_DATA';
  latencyStatus: 'PRESENT' | 'BLOCKED_DATA';
  supplementalCostInput: AuthoritativePaperSupplementalCostInput | null;
  blockers: readonly string[];
  otherCostComponentsChanged: false;
  fullCostReadyEvaluated: false;
  executionAuthority: 'NONE';
  privateApiUsed: false;
  realFillObserved: false;
  unknownCostIsZero: false;
}>;

export type AuthoritativePaperLatencyCollection<T> = Readonly<{
  requestResult: T;
  latency: AuthoritativePaperLatencyCostEvidenceResult;
  preRequest: PublicMidpointObservation | null;
  postRequest: PublicMidpointObservation | null;
  requestStartedAtMs: number;
  requestCompletedAtMs: number;
  evaluatedAtMs: number;
  realMeasuredRequestTiming: true;
  executionAuthority: 'NONE';
  privateApiUsed: false;
  realFillObserved: false;
}>;

type CollectorInput<T> = AuthoritativePaperLatencyIdentity & Readonly<{
  direction: LatencyDirection;
  readPublicMidpointQuote(phase: 'PRE' | 'POST', attempt: number): Promise<PublicMidpointQuote | null>;
  executeMeasuredPublicRequest(): Promise<T>;
  now?: () => number;
  maximumAgeMs?: number;
  maximumRequestDurationMs?: number;
  maximumPostObservationAttempts?: number;
}>;

type FetchPublicJson = (
  url: URL,
  input: Readonly<{ provider: string; signal?: AbortSignal }>,
) => Promise<unknown>;

export type BitgetPublicMidpointQuoteInput = AuthoritativePaperLatencyIdentity & Readonly<{
  phase: 'PRE' | 'POST';
  attempt: number;
  fetchPublicJson: FetchPublicJson;
  signal?: AbortSignal;
}>;

const DEFAULT_MAXIMUM_AGE_MS = 30_000;
const DEFAULT_MAXIMUM_REQUEST_DURATION_MS = 30_000;
const DEFAULT_MAXIMUM_POST_OBSERVATION_ATTEMPTS = 3;
const EXACT_SHA = /^[0-9a-f]{40}$/u;
const BITGET_PUBLIC_BASE_URL = 'https://api.bitget.com';

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalSymbol(value: unknown): string | null {
  if (!nonEmpty(value)) return null;
  const symbol = value.trim().toUpperCase().replace(/[^A-Z0-9]/gu, '');
  return symbol.length > 4 && symbol.endsWith('USDT') ? symbol : null;
}

function exactSha(value: unknown): value is string {
  return typeof value === 'string' && EXACT_SHA.test(value.trim().toLowerCase());
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function scalar(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function topPrice(value: unknown): number | null {
  if (!Array.isArray(value) || !Array.isArray(value[0])) return null;
  const price = scalar(value[0][0]);
  return positive(price) ? price : null;
}

export async function readBitgetPublicLatencyMidpointQuote(
  input: BitgetPublicMidpointQuoteInput,
): Promise<PublicMidpointQuote | null> {
  if (typeof input?.fetchPublicJson !== 'function') throw new TypeError('PUBLIC_MIDPOINT_FETCH_REQUIRED');
  const symbol = canonicalSymbol(input?.symbol);
  const researchCodeSha = String(input?.researchCodeSha ?? '').trim().toLowerCase();
  if (input?.market !== 'CRYPTO_FUTURES' || !symbol || !exactSha(researchCodeSha)
    || (input?.phase !== 'PRE' && input?.phase !== 'POST')
    || !Number.isInteger(input?.attempt) || input.attempt < 1 || input.attempt > 5) return null;
  const url = new URL('/api/v3/market/orderbook', BITGET_PUBLIC_BASE_URL);
  url.search = new URLSearchParams({
    category: 'USDT-FUTURES',
    symbol,
    limit: '1',
  }).toString();
  const payload = record(await input.fetchPublicJson(url, {
    provider: 'bitget',
    signal: input.signal,
  }));
  const data = record(payload?.data);
  const observedAtMs = scalar(data?.ts);
  const bidPrice = topPrice(data?.b);
  const askPrice = topPrice(data?.a);
  if (payload?.code !== '00000' || !positive(observedAtMs)
    || !positive(bidPrice) || !positive(askPrice) || askPrice < bidPrice) return null;
  return Object.freeze({
    market: 'CRYPTO_FUTURES' as const,
    symbol,
    researchCodeSha,
    observationId: [
      'bitget-public-uta-v3-orderbook-bbo',
      input.phase.toLowerCase(),
      String(input.attempt),
      symbol,
      String(observedAtMs),
      String(bidPrice),
      String(askPrice),
    ].join(':'),
    bidPrice,
    askPrice,
    observedAtMs,
    source: `BITGET_PUBLIC_UTA_V3_ORDERBOOK_BBO_${input.phase}`,
    endpointClass: 'PUBLIC_MARKET' as const,
    privateApiUsed: false as const,
  });
}

function blocked(blockers: readonly string[]): AuthoritativePaperLatencyCostEvidenceResult {
  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_VERSION,
    status: 'BLOCKED_DATA' as const,
    evidence: null,
    observedRoundTripMs: null,
    signedMidpointMovePercent: null,
    adverseMovePercent: null,
    blockers: Object.freeze([...new Set(blockers)]),
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    liveTrading: false as const,
    realFillObserved: false as const,
    unknownCostIsZero: false as const,
  });
}

function observationBlockers(
  phase: 'PRE' | 'POST',
  value: PublicMidpointObservation | null | undefined,
  identity: AuthoritativePaperLatencyIdentity,
): string[] {
  const prefix = `LATENCY_${phase}_REQUEST`;
  if (!value) return [`${prefix}_MIDPOINT_UNAVAILABLE`];
  const blockers: string[] = [];
  if (!positive(value.midpoint) || !positive(value.observedAtMs) || !nonEmpty(value.source)
    || !nonEmpty(value.observationId)) blockers.push(`${prefix}_MIDPOINT_UNAVAILABLE`);
  if (value.evidenceClass !== 'PUBLIC_MIDPOINT') blockers.push(`${prefix}_EVIDENCE_CLASS_INVALID`);
  if (value.endpointClass !== 'PUBLIC_MARKET' || value.privateApiUsed !== false) {
    blockers.push(`${prefix}_PUBLIC_MARKET_EVIDENCE_REQUIRED`);
  }
  if (value.market !== identity.market) blockers.push(`${prefix}_MARKET_MISMATCH`);
  if (canonicalSymbol(value.symbol) !== canonicalSymbol(identity.symbol)) blockers.push(`${prefix}_SYMBOL_MISMATCH`);
  if (!exactSha(value.researchCodeSha)
    || value.researchCodeSha.trim().toLowerCase() !== identity.researchCodeSha.trim().toLowerCase()) {
    blockers.push(`${prefix}_RESEARCH_SHA_MISMATCH`);
  }
  return blockers;
}

export function buildAuthoritativePaperLatencyCostEvidence(
  input: AuthoritativePaperLatencyCostInput,
): AuthoritativePaperLatencyCostEvidenceResult {
  const nowMs = positive(input?.nowMs) ? input.nowMs : Date.now();
  const maximumAgeMs = positive(input?.maximumAgeMs) ? input.maximumAgeMs : DEFAULT_MAXIMUM_AGE_MS;
  const maximumRequestDurationMs = positive(input?.maximumRequestDurationMs)
    ? input.maximumRequestDurationMs
    : DEFAULT_MAXIMUM_REQUEST_DURATION_MS;
  const blockers: string[] = [];
  const symbol = canonicalSymbol(input?.symbol);
  const identity = Object.freeze({
    market: input?.market,
    symbol: symbol ?? '',
    researchCodeSha: String(input?.researchCodeSha ?? '').trim().toLowerCase(),
  }) as AuthoritativePaperLatencyIdentity;

  if (input?.direction !== 'LONG' && input?.direction !== 'SHORT') blockers.push('LATENCY_DIRECTION_INVALID');
  if (input?.market !== 'CRYPTO_FUTURES') blockers.push('LATENCY_MARKET_INVALID');
  if (!symbol) blockers.push('LATENCY_SYMBOL_INVALID');
  if (!exactSha(input?.researchCodeSha)) blockers.push('LATENCY_RESEARCH_SHA_INVALID');
  if (!positive(nowMs)) blockers.push('LATENCY_CLOCK_INVALID');
  if (!positive(input?.requestStartedAtMs) || !positive(input?.requestCompletedAtMs)
    || input.requestCompletedAtMs <= input.requestStartedAtMs) {
    blockers.push('LATENCY_REQUEST_TIMING_INVALID');
  }
  if ((positive(input?.requestStartedAtMs) && input.requestStartedAtMs > nowMs)
    || (positive(input?.requestCompletedAtMs) && input.requestCompletedAtMs > nowMs)) {
    blockers.push('LATENCY_REQUEST_TIMING_FROM_FUTURE');
  }

  const roundTripMs = positive(input?.requestStartedAtMs) && positive(input?.requestCompletedAtMs)
    && input.requestCompletedAtMs > input.requestStartedAtMs
    ? input.requestCompletedAtMs - input.requestStartedAtMs
    : null;
  if (roundTripMs != null && roundTripMs > maximumRequestDurationMs) {
    blockers.push('LATENCY_REQUEST_DURATION_EXCEEDS_POLICY');
  }

  const pre = input?.preRequest;
  const post = input?.postRequest;
  blockers.push(...observationBlockers('PRE', pre, identity));
  blockers.push(...observationBlockers('POST', post, identity));

  if (positive(pre?.observedAtMs) && pre.observedAtMs > nowMs) {
    blockers.push('LATENCY_PRE_REQUEST_EVIDENCE_FROM_FUTURE');
  } else if (positive(pre?.observedAtMs) && nowMs - pre.observedAtMs > maximumAgeMs) {
    blockers.push('LATENCY_PRE_REQUEST_EVIDENCE_STALE');
  }
  if (positive(post?.observedAtMs) && post.observedAtMs > nowMs) {
    blockers.push('LATENCY_POST_REQUEST_EVIDENCE_FROM_FUTURE');
  } else if (positive(post?.observedAtMs) && nowMs - post.observedAtMs > maximumAgeMs) {
    blockers.push('LATENCY_POST_REQUEST_EVIDENCE_STALE');
  }
  if (positive(pre?.observedAtMs) && positive(input?.requestStartedAtMs)
    && pre.observedAtMs > input.requestStartedAtMs) {
    blockers.push('LATENCY_PRE_REQUEST_TIMESTAMP_NOT_BRACKETING_REQUEST');
  }
  if (positive(post?.observedAtMs) && positive(input?.requestCompletedAtMs)
    && post.observedAtMs < input.requestCompletedAtMs) {
    blockers.push('LATENCY_POST_REQUEST_TIMESTAMP_NOT_BRACKETING_REQUEST');
  }
  if (positive(pre?.observedAtMs) && positive(post?.observedAtMs)
    && post.observedAtMs <= pre.observedAtMs) {
    blockers.push('LATENCY_MIDPOINT_OBSERVATION_ORDER_INVALID');
  }
  if (pre && post && (pre.observationId === post.observationId
    || pre.observedAtMs === post.observedAtMs)) {
    blockers.push('LATENCY_REUSED_MIDPOINT_OBSERVATION');
  }

  if (blockers.length > 0 || !pre || !post) return blocked(blockers);

  const signedMovePercent = input.direction === 'LONG'
    ? ((post.midpoint - pre.midpoint) / pre.midpoint) * 100
    : ((pre.midpoint - post.midpoint) / pre.midpoint) * 100;
  const adverseMovePercent = Math.max(0, signedMovePercent);
  const evidence: PercentCostEvidence = Object.freeze({
    valuePercent: adverseMovePercent,
    quality: 'ESTIMATED',
    source: `PUBLIC_MIDPOINT_ADVERSE_MOVE_OVER_OBSERVED_REQUEST_LATENCY:${pre.source.trim()}->${post.source.trim()}`,
    observedAtMs: post.observedAtMs,
  });

  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_VERSION,
    status: 'PRESENT' as const,
    evidence,
    observedRoundTripMs: roundTripMs,
    signedMidpointMovePercent: signedMovePercent,
    adverseMovePercent,
    blockers: Object.freeze([]),
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    liveTrading: false as const,
    realFillObserved: false as const,
    unknownCostIsZero: false as const,
  });
}

function quoteObservation(value: PublicMidpointQuote | null): PublicMidpointObservation | null {
  if (!value || !positive(value.bidPrice) || !positive(value.askPrice) || value.askPrice < value.bidPrice) return null;
  return Object.freeze({
    market: value.market,
    symbol: value.symbol,
    researchCodeSha: value.researchCodeSha,
    observationId: value.observationId,
    midpoint: (value.bidPrice + value.askPrice) / 2,
    observedAtMs: value.observedAtMs,
    source: value.source,
    evidenceClass: 'PUBLIC_MIDPOINT' as const,
    endpointClass: value.endpointClass,
    privateApiUsed: value.privateApiUsed,
  });
}

export async function collectAuthoritativePaperLatencyCostEvidence<T>(
  input: CollectorInput<T>,
): Promise<AuthoritativePaperLatencyCollection<T>> {
  if (typeof input?.readPublicMidpointQuote !== 'function') throw new TypeError('PUBLIC_MIDPOINT_READER_REQUIRED');
  if (typeof input?.executeMeasuredPublicRequest !== 'function') throw new TypeError('MEASURED_PUBLIC_REQUEST_REQUIRED');
  const now = input.now ?? Date.now;
  if (typeof now !== 'function') throw new TypeError('LATENCY_CLOCK_REQUIRED');
  const attempts = Number.isInteger(input.maximumPostObservationAttempts)
    && Number(input.maximumPostObservationAttempts) > 0
    && Number(input.maximumPostObservationAttempts) <= 5
    ? Number(input.maximumPostObservationAttempts)
    : DEFAULT_MAXIMUM_POST_OBSERVATION_ATTEMPTS;
  const preRequest = quoteObservation(await input.readPublicMidpointQuote('PRE', 1));
  const requestStartedAtMs = now();
  const requestResult = await input.executeMeasuredPublicRequest();
  const requestCompletedAtMs = now();
  let postRequest: PublicMidpointObservation | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    postRequest = quoteObservation(await input.readPublicMidpointQuote('POST', attempt));
    if (postRequest && positive(requestCompletedAtMs)
      && postRequest.observedAtMs >= requestCompletedAtMs
      && (!preRequest || (postRequest.observedAtMs > preRequest.observedAtMs
        && postRequest.observationId !== preRequest.observationId))) break;
  }
  const nowMs = now();
  const latency = buildAuthoritativePaperLatencyCostEvidence({
    market: input.market,
    symbol: input.symbol,
    researchCodeSha: input.researchCodeSha,
    direction: input.direction,
    requestStartedAtMs,
    requestCompletedAtMs,
    preRequest,
    postRequest,
    nowMs,
    maximumAgeMs: input.maximumAgeMs,
    maximumRequestDurationMs: input.maximumRequestDurationMs,
  });
  return Object.freeze({
    requestResult,
    latency,
    preRequest,
    postRequest,
    requestStartedAtMs,
    requestCompletedAtMs,
    evaluatedAtMs: nowMs,
    realMeasuredRequestTiming: true,
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    realFillObserved: false as const,
  });
}

export function bindAuthoritativePaperLatencyToSupplementalCostInput(input: Readonly<{
  sourceSupplementalCostInput: AuthoritativePaperSupplementalCostInput | null;
  latency: AuthoritativePaperLatencyCostEvidenceResult;
}>): AuthoritativePaperLatencySupplementalBinding {
  const source = input?.sourceSupplementalCostInput;
  const blockers = [...(input?.latency?.blockers ?? [])];
  if (!source || !nonEmpty(source.costPolicyId) || !positive(source.observedAtMs)) {
    blockers.push('SUPPLEMENTAL_COST_INPUT_UNAVAILABLE');
  }
  const latencyEvidence = input?.latency?.status === 'PRESENT' ? input.latency.evidence : null;
  if (!latencyEvidence) blockers.push('LATENCY_COST_EVIDENCE_UNAVAILABLE');
  const supplementalCostInput = source == null ? null : Object.freeze({
    ...source,
    latency: latencyEvidence,
  });
  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_VERSION,
    status: blockers.length === 0 ? 'PRESENT' as const : 'BLOCKED_DATA' as const,
    latencyStatus: latencyEvidence ? 'PRESENT' as const : 'BLOCKED_DATA' as const,
    supplementalCostInput,
    blockers: Object.freeze([...new Set(blockers)]),
    otherCostComponentsChanged: false as const,
    fullCostReadyEvaluated: false as const,
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    realFillObserved: false as const,
    unknownCostIsZero: false as const,
  });
}

export const AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_SAFETY = Object.freeze({
  schemaVersion: AUTHORITATIVE_PAPER_LATENCY_COST_EVIDENCE_VERSION,
  publicMarketDataOnly: true,
  observedRequestDurationRequired: true,
  temporalBracketingRequired: true,
  distinctPrePostObservationRequired: true,
  exactMarketSymbolResearchShaBindingRequired: true,
  favorableMoveMayProduceObservedZeroAdverseCost: true,
  missingDataMayProduceZeroCost: false,
  requestDurationMayBeUsedAsPercentCost: false,
  spreadMayBeUsedAsLatencyCost: false,
  bookWalkMayBeUsedAsLatencyCost: false,
  liquidityImpactMayBeUsedAsLatencyCost: false,
  partialFillMayBeUsedAsLatencyCost: false,
  otherCostComponentsMutable: false,
  riskSizingPolicyMutable: false,
  causalExecutionClaimAllowed: false,
  realFillObserved: false,
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
  financialMutationAllowed: false,
});
