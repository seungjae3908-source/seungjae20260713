import type { ScannerResponse, ScannerSignalCard } from './scanner-signal.types';
import { CryptoSignalScannerService } from './crypto-signal-scanner.service';
import { CryptoPricePrecisionService } from './scanner-crypto-price-precision.service';
import { rankScannerCandidates } from './scanner-candidate-ranking.service';
import { withScannerCanonicalActions } from './scanner-market-action.service';
import {
  attachScannerCanonicalPaperIdentity,
  resolveScannerCanonicalPaperIdentity,
  type ScannerCanonicalPaperCandidate,
} from './scanner-canonical-paper-identity.service';
import { prepareForwardRecommendationObservation } from './forward-recommendation-observer.service';
import {
  FORWARD_OBSERVER_DATA_MAX_AGE_MS,
  FORWARD_OBSERVER_LANES,
  latestCardEvidenceTimestamp,
} from './forward-recommendation-observer-runtime.service';
import {
  buildBitgetFuturesPublicEvidence,
  buildBitgetFuturesPublicRequests,
  type BitgetPublicRequest,
} from './bitget-futures-public-evidence.service';
import { fetchPublicMarketJson } from './public-market-http';
import {
  auditAuthoritativeSupplementalCostSources,
  buildAuthoritativePaperFundingHoldingHorizonCost,
  collectAuthoritativePaperExecutionObservationInput,
  AUTHORITATIVE_PAPER_EXECUTION_SIZING_EVIDENCE_VERSION,
  type AuthoritativePaperExecutionSizingEvidence,
} from './authoritative-paper-execution-cost-sources.service';
import {
  bindAuthoritativePaperLatencyToSupplementalCostInput,
  collectAuthoritativePaperLatencyCostEvidence,
  readBitgetPublicLatencyMidpointQuote,
  type AuthoritativePaperSupplementalCostInput,
} from './authoritative-paper-latency-cost-evidence.service';
import {
  AUTHORITATIVE_PAPER_CALLBACK_OWNERS_SAFETY,
  buildAuthoritativePaperExecutionObservation,
  buildAuthoritativeSizedContractRules,
  buildAuthoritativeSupplementalCostEvidence,
  paperStateFromAuthoritativeSnapshot,
  type AuthoritativePaperRiskPolicyEvidence,
} from './authoritative-paper-callback-owners.service';
import {
  createAuthoritativePaperGenericRiskPolicyProducer,
  buildAuthoritativePaperRiskSizingFromGenericRiskPolicySource,
  type AuthoritativePaperGenericRiskPolicyRequest,
  type AuthoritativePaperGenericRiskPolicySourceResult,
} from './authoritative-paper-generic-risk-policy-producer.service';
import {
  validateImmutablePaperTradingStateSnapshot,
  type PaperTradingStateSnapshot,
} from './paper-trading-state-snapshot.service';
import type { PaperTradingState } from './paper-trading.types';
import type { ScannerCryptoFuturesPaperExecutionObservation } from './scanner-crypto-futures-paper-admission-composer.service';
import type { SupplementalExecutionCostEvidence } from './scanner-profit-cost-evidence-adapter.service';

export const AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_VERSION =
  'authoritative-paper-evidence-sources-v1' as const;

export const AUTHORITATIVE_PAPER_BLOCKED_DATA_SOURCE_CONTRACT_VERSION =
  'authoritative-paper-blocked-data-source-contract-v1' as const;

export const AUTHORITATIVE_PAPER_CALLBACK_OWNER_CONTRACT_VERSION =
  'authoritative-paper-callback-owner-contract-v1' as const;

const BITGET_BASE_URL = 'https://api.bitget.com';
const FUTURES_LANE = FORWARD_OBSERVER_LANES.find((lane) => lane.market === 'CRYPTO_FUTURES');
const NATURAL_CYCLE_MAX_SIZING_ITERATIONS = 8;
const NATURAL_CYCLE_EVIDENCE_MAXIMUM_AGE_MS = 30_000;

type EvidenceContext = Readonly<{
  card: unknown;
  market: 'CRYPTO_FUTURES';
  cycle?: unknown;
  signal?: unknown;
}>;

type FetchPublicJson = (
  url: URL,
  input: Readonly<{ provider: string; signal?: AbortSignal }>,
) => Promise<unknown>;

export type AuthoritativePaperBlockedDataSourceContract = Readonly<{
  schemaVersion: typeof AUTHORITATIVE_PAPER_BLOCKED_DATA_SOURCE_CONTRACT_VERSION;
  callback: 'paperStateForCard' | 'contractRulesForCard' | 'executionObservationForCard' | 'supplementalCostEvidenceForCard';
  status: 'BLOCKED_DATA';
  ownerStatus: 'OWNER_MISSING';
  blocker: string;
  provenance: string;
  unknownIsZero: false;
}>;

export type AuthoritativePaperCallbackOwnerContract = Readonly<{
  schemaVersion: typeof AUTHORITATIVE_PAPER_CALLBACK_OWNER_CONTRACT_VERSION;
  callback: 'paperStateForCard' | 'contractRulesForCard' | 'executionObservationForCard' | 'supplementalCostEvidenceForCard';
  ownerStatus: 'OWNER_EXISTS';
  dataReadiness: 'RUNTIME_VALIDATED_BLOCKED_DATA';
  implementation: string;
  requiredData: readonly string[];
  missingDataBehavior: 'BLOCKED_DATA';
  unknownIsZero: false;
}>;

type AuthoritativePaperOwnedSource<T> =
  ((context: EvidenceContext) => Promise<T | null>)
  & Readonly<{ authoritativeOwner: AuthoritativePaperCallbackOwnerContract }>;

type SizedContractInput = Parameters<typeof buildAuthoritativeSizedContractRules>[0];
type ExecutionObservationInput = Parameters<typeof buildAuthoritativePaperExecutionObservation>[0];
type SupplementalCostInput = Parameters<typeof buildAuthoritativeSupplementalCostEvidence>[0];

type Dependencies = Readonly<{
  scan: typeof CryptoSignalScannerService.scan;
  align: typeof CryptoPricePrecisionService.align;
  rank: typeof rankScannerCandidates;
  withCanonicalActions: typeof withScannerCanonicalActions;
  attachCanonicalIdentity: typeof attachScannerCanonicalPaperIdentity;
  resolveCanonicalIdentity: typeof resolveScannerCanonicalPaperIdentity;
  prepareObservation: typeof prepareForwardRecommendationObservation;
  latestEvidenceTimestamp: typeof latestCardEvidenceTimestamp;
  buildPublicRequests: typeof buildBitgetFuturesPublicRequests;
  buildPublicEvidence: typeof buildBitgetFuturesPublicEvidence;
  fetchPublicJson: FetchPublicJson;
  paperStateSnapshotForCard(context: EvidenceContext): Promise<unknown | null>;
  sizedContractInputForCard(context: EvidenceContext): Promise<SizedContractInput | null>;
  executionObservationInputForCard(context: EvidenceContext): Promise<ExecutionObservationInput | null>;
  executionSizingEvidenceForCard(context: EvidenceContext): Promise<AuthoritativePaperExecutionSizingEvidence | null>;
  supplementalCostInputForCard(context: EvidenceContext): Promise<AuthoritativePaperSupplementalCostInput | null>;
  publicEvidenceForSupplementalCostForCard(context: EvidenceContext): Promise<ReturnType<typeof buildBitgetFuturesPublicEvidence> | null>;
  executionObservationForSupplementalCostForCard(context: EvidenceContext): Promise<ScannerCryptoFuturesPaperExecutionObservation | null>;
  now: () => number;
}>;

export type AuthoritativePaperNaturalCycleEvidenceSources = Readonly<{
  paperStateSnapshotForCard(context: EvidenceContext): Promise<unknown | null>;
  riskPolicyRecordForCard(
    context: EvidenceContext,
    request: AuthoritativePaperGenericRiskPolicyRequest,
  ): Promise<unknown | null>;
  supplementalCostInputForCard(context: EvidenceContext): Promise<AuthoritativePaperSupplementalCostInput | null>;
  positionTiersForCard?(context: EvidenceContext): Promise<unknown | null>;
}>;

export type AuthoritativePaperNaturalCycleEvidenceSourceWiring =
  AuthoritativePaperEvidenceSourceWiring & Readonly<{
    naturalCycleSourceGraph: Readonly<{
      schemaVersion: 'authoritative-paper-natural-cycle-source-graph-v1';
      sizingIterationLimit: 8;
      policyDefaultsAllowed: false;
      unknownCostIsZero: false;
      publicDepthIsRealFill: false;
      realFillObserved: false;
      latencyEvidenceOwner: 'AUTHORITATIVE_PUBLIC_BBO_REQUEST_BRACKET';
      latencyEvidenceQuality: 'ESTIMATED';
      latencyMissingIsZero: false;
      executionAuthority: 'NONE';
    }>;
  }>;

export type AuthoritativePaperEvidenceSourceWiring = Readonly<{
  scanBatchForMarket(context: Readonly<{
    market: 'CRYPTO_FUTURES';
    cycle?: unknown;
    signal?: unknown;
  }>): Promise<(input: Readonly<{ market: 'CRYPTO_FUTURES'; cursor: number }>) => Promise<ScannerResponse>>;
  paperCandidateForCard(context: EvidenceContext): ReturnType<typeof resolveScannerCanonicalPaperIdentity>['paperCandidate'];
  learningSnapshotForCard(context: EvidenceContext): ReturnType<typeof prepareForwardRecommendationObservation>['observation'] extends infer Observation
    ? Observation extends { snapshot: infer Snapshot } ? Snapshot | null : null
    : null;
  paperStateForCard: AuthoritativePaperOwnedSource<Readonly<PaperTradingState>>;
  contractRulesForCard: AuthoritativePaperOwnedSource<ReturnType<typeof buildAuthoritativeSizedContractRules>['contractRules']>;
  publicEvidenceForCard(context: EvidenceContext): Promise<ReturnType<typeof buildBitgetFuturesPublicEvidence> | null>;
  executionObservationForCard: AuthoritativePaperOwnedSource<ScannerCryptoFuturesPaperExecutionObservation>;
  supplementalCostEvidenceForCard: AuthoritativePaperOwnedSource<SupplementalExecutionCostEvidence>;
}>;

function exactSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function scannerCard(value: unknown): ScannerSignalCard | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const card = value as Partial<ScannerSignalCard>;
  return typeof card.signalId === 'string' && typeof card.symbol === 'string'
    ? value as ScannerSignalCard
    : null;
}

function abortSignal(value: unknown): AbortSignal | undefined {
  return value instanceof AbortSignal ? value : undefined;
}

function publicUrl(request: BitgetPublicRequest): URL {
  if (request.method !== 'GET') throw new Error('AUTHORITATIVE_PUBLIC_MARKET_GET_REQUIRED');
  const url = new URL(request.path, BITGET_BASE_URL);
  url.search = request.query;
  return url;
}

function ownedSource<T>({
  callback,
  implementation,
  requiredData,
  source,
}: Readonly<{
  callback: AuthoritativePaperCallbackOwnerContract['callback'];
  implementation: string;
  requiredData: readonly string[];
  source: (context: EvidenceContext) => Promise<T | null>;
}>): AuthoritativePaperOwnedSource<T> {
  return Object.freeze(Object.assign(source, {
    authoritativeOwner: Object.freeze({
      schemaVersion: AUTHORITATIVE_PAPER_CALLBACK_OWNER_CONTRACT_VERSION,
      callback,
      ownerStatus: 'OWNER_EXISTS' as const,
      dataReadiness: 'RUNTIME_VALIDATED_BLOCKED_DATA' as const,
      implementation,
      requiredData: Object.freeze([...requiredData]),
      missingDataBehavior: 'BLOCKED_DATA' as const,
      unknownIsZero: false as const,
    }),
  })) as AuthoritativePaperOwnedSource<T>;
}

function defaultDependencies(): Dependencies {
  return Object.freeze({
    scan: CryptoSignalScannerService.scan.bind(CryptoSignalScannerService),
    align: CryptoPricePrecisionService.align.bind(CryptoPricePrecisionService),
    rank: rankScannerCandidates,
    withCanonicalActions: withScannerCanonicalActions,
    attachCanonicalIdentity: attachScannerCanonicalPaperIdentity,
    resolveCanonicalIdentity: resolveScannerCanonicalPaperIdentity,
    prepareObservation: prepareForwardRecommendationObservation,
    latestEvidenceTimestamp: latestCardEvidenceTimestamp,
    buildPublicRequests: buildBitgetFuturesPublicRequests,
    buildPublicEvidence: buildBitgetFuturesPublicEvidence,
    fetchPublicJson: (url, input) => fetchPublicMarketJson(url, input),
    paperStateSnapshotForCard: async () => null,
    sizedContractInputForCard: async () => null,
    executionObservationInputForCard: async () => null,
    executionSizingEvidenceForCard: async () => null,
    supplementalCostInputForCard: async () => null,
    publicEvidenceForSupplementalCostForCard: async () => null,
    executionObservationForSupplementalCostForCard: async () => null,
    now: Date.now,
  });
}

function normalizeRankedScannerResponse(
  response: ScannerResponse,
  researchCodeSha: string,
  dependencies: Dependencies,
): ScannerResponse {
  const ranking = dependencies.rank({
    cards: response.cards,
    market: response.market,
    strategy: 'swing',
    limit: 10,
  });
  const directionalCards = ranking.cards.filter((card) => card.direction === 'LONG' || card.direction === 'SHORT');
  const actioned = dependencies.withCanonicalActions({
    ...response,
    cards: directionalCards,
    execution: {
      ...response.execution,
      hardFilterPassCount: ranking.diagnostics.hardFilterPassCount,
      hardFilterRejectedCount: ranking.diagnostics.hardFilterRejectedCount,
      softCandidateCount: ranking.diagnostics.softCandidateCount,
      finalDisplayedCount: directionalCards.length,
      sGradeCount: directionalCards.filter((card) => card.signalGrade === 'S').length,
      aGradeCount: directionalCards.filter((card) => card.signalGrade === 'A').length,
      bGradeCount: directionalCards.filter((card) => card.signalGrade === 'B').length,
      backtestMissingCount: ranking.diagnostics.backtestMissingCount,
    },
  });
  return dependencies.attachCanonicalIdentity({
    response: actioned,
    market: 'CRYPTO_FUTURES',
    researchCodeSha,
  });
}

export function createAuthoritativePaperEvidenceSourceWiring({
  researchCodeSha,
  dependencies: overrides = {},
}: Readonly<{
  researchCodeSha: string;
  dependencies?: Partial<Dependencies>;
}>): AuthoritativePaperEvidenceSourceWiring {
  const normalizedSha = String(researchCodeSha ?? '').trim().toLowerCase();
  if (!exactSha(normalizedSha)) throw new TypeError('authoritative Paper evidence sources require an exact research SHA');
  if (!FUTURES_LANE) throw new Error('FORWARD_OBSERVER_FUTURES_LANE_REQUIRED');
  const dependencies = Object.freeze({ ...defaultDependencies(), ...overrides }) as Dependencies;
  const callbackOwnerSources = Object.freeze({
    paperStateForCard: ownedSource({
      callback: 'paperStateForCard',
      implementation: 'paperStateFromAuthoritativeSnapshot/validateImmutablePaperTradingStateSnapshot',
      requiredData: ['lossless immutable PaperTradingState snapshot from the canonical Paper state writer'],
      source: async (context) => {
        const snapshot = await dependencies.paperStateSnapshotForCard(context);
        return snapshot == null ? null : paperStateFromAuthoritativeSnapshot(snapshot, dependencies.now());
      },
    }),
    contractRulesForCard: ownedSource({
      callback: 'contractRulesForCard',
      implementation: 'buildAuthoritativeSizedContractRules/selectBitgetPositionTier',
      requiredData: ['public contracts', 'public position tier schedule', 'sized notional', 'immutable risk policy evidence'],
      source: async (context) => {
        const input = await dependencies.sizedContractInputForCard(context);
        return input == null ? null : buildAuthoritativeSizedContractRules(input).contractRules;
      },
    }),
    executionObservationForCard: ownedSource({
      callback: 'executionObservationForCard',
      implementation: 'buildAuthoritativePaperExecutionObservation/buildPaperSimulatedExecutionEvidence',
      requiredData: [
        'public L2 depth',
        'target quantity',
        'request timing',
        'immutable risk policy evidence',
        'optional LIVE_SUBMITTED_EXECUTION calibration reported separately from Paper simulation readiness',
      ],
      source: async (context) => {
        let input = await dependencies.executionObservationInputForCard(context);
        if (input == null) {
          const sizingEvidence = await dependencies.executionSizingEvidenceForCard(context);
          if (sizingEvidence == null) return null;
          input = await collectAuthoritativePaperExecutionObservationInput({
            context,
            sizingEvidence,
            fetchPublicJson: dependencies.fetchPublicJson,
            now: dependencies.now,
          });
        }
        return input == null ? null : buildAuthoritativePaperExecutionObservation(input);
      },
    }),
    supplementalCostEvidenceForCard: ownedSource({
      callback: 'supplementalCostEvidenceForCard',
      implementation: 'collectAuthoritativePaperLatencyCostEvidence/bindAuthoritativePaperLatencyToSupplementalCostInput/buildAuthoritativeSupplementalCostEvidence',
      requiredData: ['latency cost evidence', 'liquidity impact cost evidence', 'partial-fill cost evidence', 'funding evidence'],
      source: async (context) => {
        const [input, publicEvidence, executionObservation] = await Promise.all([
          dependencies.supplementalCostInputForCard(context),
          dependencies.publicEvidenceForSupplementalCostForCard(context),
          dependencies.executionObservationForSupplementalCostForCard(context),
        ]);
        const audit = auditAuthoritativeSupplementalCostSources({
          publicEvidence,
          executionObservation,
          supplemental: input,
          nowMs: dependencies.now(),
        });
        return audit.supplementalCostInput == null
          ? null
          : buildAuthoritativeSupplementalCostEvidence(audit.supplementalCostInput);
      },
    }),
  });

  return Object.freeze({
    async scanBatchForMarket({ market, signal }) {
      if (market !== 'CRYPTO_FUTURES') throw new Error('AUTHORITATIVE_SCANNER_MARKET_NOT_OWNED');
      const outerSignal = abortSignal(signal);
      return async function scanBatch({ market: selectedMarket, cursor }) {
        if (selectedMarket !== 'CRYPTO_FUTURES') throw new Error('AUTHORITATIVE_SCANNER_MARKET_MISMATCH');
        const scanned = await dependencies.scan({
          memberId: 'forward-observer-public-only',
          market: 'futures',
          strategyMode: 'swing',
          timeframe: FUTURES_LANE.timeframe,
          condition: 'trend',
          cursor,
          batchSize: FUTURES_LANE.batchSize,
          signal: outerSignal,
        });
        const aligned = await dependencies.align('futures', scanned, outerSignal);
        return normalizeRankedScannerResponse(aligned, normalizedSha, dependencies);
      };
    },

    paperCandidateForCard({ card, market }) {
      const value = scannerCard(card);
      if (!value || market !== 'CRYPTO_FUTURES') return null;
      return dependencies.resolveCanonicalIdentity({
        card: value,
        market,
        researchCodeSha: normalizedSha,
      }).paperCandidate;
    },

    learningSnapshotForCard({ card, market }) {
      const value = scannerCard(card);
      if (!value || market !== 'CRYPTO_FUTURES') return null;
      const candidate = dependencies.resolveCanonicalIdentity({
        card: value,
        market,
        researchCodeSha: normalizedSha,
      }).paperCandidate;
      const dataTimestamp = dependencies.latestEvidenceTimestamp(value);
      if (!candidate || !dataTimestamp) return null;
      const decision = dependencies.prepareObservation({
        card: value,
        strategyIdentity: {
          strategyId: candidate.signal.strategyIdentity.strategyId,
          strategyVersion: candidate.signal.strategyIdentity.strategyVersion,
          parameterHash: candidate.signal.strategyIdentity.parameterHash,
          researchCodeSha: candidate.signal.strategyIdentity.researchCodeSha,
          market: candidate.signal.market,
          symbol: candidate.signal.symbol,
          timeframe: candidate.signal.timeframe,
          horizon: candidate.signal.horizon,
          direction: candidate.signal.direction,
        },
        dataTimestamp,
        dataMaxAgeMs: FORWARD_OBSERVER_DATA_MAX_AGE_MS,
        publicDataOnly: true,
      });
      return decision.status === 'OBSERVATION_READY' ? decision.observation?.snapshot ?? null : null;
    },

    ...callbackOwnerSources,

    async publicEvidenceForCard({ card, market, signal }) {
      const value = scannerCard(card);
      if (!value || market !== 'CRYPTO_FUTURES') return null;
      const requests = dependencies.buildPublicRequests(value.symbol);
      const requestSignal = abortSignal(signal);
      const entries = await Promise.all(Object.entries(requests).map(async ([key, request]) => [
        key,
        await dependencies.fetchPublicJson(publicUrl(request), { provider: 'bitget', signal: requestSignal }),
      ] as const));
      const payloads = Object.fromEntries(entries);
      const nowMs = dependencies.now();
      if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error('AUTHORITATIVE_PUBLIC_EVIDENCE_CLOCK_INVALID');
      return dependencies.buildPublicEvidence({
        symbol: value.symbol,
        nowMs,
        ticker: payloads.ticker,
        funding: payloads.funding,
        openInterest: payloads.openInterest,
        contract: payloads.contract,
        candles5m: payloads.symbol5m,
        candles1h: payloads.symbol1h,
        benchmarkBtc1h: payloads.benchmarkBtc1h,
        benchmarkBtc1d: payloads.benchmarkBtc1d,
      });
    },
  });
}

type NaturalCycleResolution = Readonly<{
  paperStateSnapshot: PaperTradingStateSnapshot | null;
  paperState: Readonly<PaperTradingState> | null;
  publicEvidence: ReturnType<typeof buildBitgetFuturesPublicEvidence> | null;
  sizedContractInput: SizedContractInput | null;
  executionObservationInput: ExecutionObservationInput | null;
  executionObservation: ScannerCryptoFuturesPaperExecutionObservation | null;
  supplementalCostInput: AuthoritativePaperSupplementalCostInput | null;
}>;

function naturalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function naturalNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function naturalPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function naturalFresh(observedAtMs: number, maximumAgeMs: number, nowMs: number): boolean {
  return naturalPositive(observedAtMs)
    && naturalPositive(maximumAgeMs)
    && observedAtMs <= nowMs
    && nowMs - observedAtMs <= maximumAgeMs;
}

function naturalFundingBoundSupplementalCostInput(input: Readonly<{
  candidate: ScannerCanonicalPaperCandidate;
  riskPolicy: unknown;
  publicEvidence: ReturnType<typeof buildBitgetFuturesPublicEvidence>;
  sourceSupplementalCostInput: AuthoritativePaperSupplementalCostInput | null;
  researchCodeSha: string;
  entryTimestampMs: number;
  positionNotional: number;
  nowMs: number;
}>): AuthoritativePaperSupplementalCostInput | null {
  const costPolicyId = naturalNonEmpty(input.sourceSupplementalCostInput?.costPolicyId)
    ? input.sourceSupplementalCostInput.costPolicyId.trim()
    : input.candidate.signal.strategyIdentity.costPolicyVersion;
  const fundingCost = buildAuthoritativePaperFundingHoldingHorizonCost({
    candidate: input.candidate,
    riskPolicy: input.riskPolicy,
    publicEvidence: input.publicEvidence,
    researchCodeSha: input.researchCodeSha,
    costPolicyId,
    entryTimestampMs: input.entryTimestampMs,
    expectedExitTimestampMs: input.candidate.signal.expiresAtMs,
    positionNotional: input.positionNotional,
    nowMs: input.nowMs,
    maximumAgeMs: NATURAL_CYCLE_EVIDENCE_MAXIMUM_AGE_MS,
  });
  if (fundingCost.status !== 'PRESENT' || fundingCost.fundingCostEvidence == null) return null;
  return Object.freeze({
    ...(input.sourceSupplementalCostInput == null ? {} : {
      latency: input.sourceSupplementalCostInput.latency,
      liquidityImpact: input.sourceSupplementalCostInput.liquidityImpact,
      partialFillImpact: input.sourceSupplementalCostInput.partialFillImpact,
      nowMs: input.sourceSupplementalCostInput.nowMs,
      maximumAgeMs: input.sourceSupplementalCostInput.maximumAgeMs,
    }),
    costPolicyId,
    observedAtMs: naturalPositive(input.sourceSupplementalCostInput?.observedAtMs)
      ? input.sourceSupplementalCostInput.observedAtMs
      : input.publicEvidence.observedAtMs,
    // Natural Paper funding is owned by the candidate-bound holding-horizon
    // producer. A file-carried scalar cannot bypass this binding.
    funding: fundingCost.fundingCostEvidence,
  });
}

function naturalSymbol(value: unknown): string | null {
  if (!naturalNonEmpty(value)) return null;
  const symbol = value.trim().toUpperCase().replace(/[^A-Z0-9]/gu, '');
  return symbol.length > 0 && symbol.endsWith('USDT') ? symbol : null;
}

function naturalQuantityPrecision(step: number): number | null {
  if (!naturalPositive(step)) return null;
  for (let precision = 0; precision <= 12; precision += 1) {
    const scaled = step * (10 ** precision);
    if (Math.abs(scaled - Math.round(scaled)) <= Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8) {
      return precision;
    }
  }
  return null;
}

function naturalExecutionRiskPolicy(
  sourceResult: AuthoritativePaperGenericRiskPolicySourceResult,
  request: AuthoritativePaperGenericRiskPolicyRequest,
  nowMs: number,
): AuthoritativePaperRiskPolicyEvidence | null {
  if (sourceResult.status !== 'PRESENT') return null;
  const value = naturalRecord(sourceResult.policyEvidence);
  if (!value
    || value.schemaVersion !== 'authoritative-paper-generic-risk-policy-evidence-v1'
    || !naturalNonEmpty(value.policyId)
    || !naturalNonEmpty(value.policyVersion)
    || !naturalNonEmpty(value.source)
    || !Array.isArray(value.provenance)
    || value.provenance.length === 0
    || !value.provenance.every(naturalNonEmpty)
    || value.researchCodeSha !== request.researchCodeSha
    || !Array.isArray(value.marketScopes)
    || !value.marketScopes.includes(request.market)
    || !Array.isArray(value.strategyScopes)
    || !value.strategyScopes.includes(request.strategyScope)
    || (value.symbolScopes !== '*'
      && (!Array.isArray(value.symbolScopes)
        || !value.symbolScopes.map(naturalSymbol).includes(naturalSymbol(request.symbol))))
    || !naturalPositive(value.riskPercent)
    || value.riskPercent > 1
    || !naturalPositive(value.requestedLeverage)
    || !naturalPositive(value.maximumLeverage)
    || value.requestedLeverage > value.maximumLeverage
    || (value.marginMode !== 'isolated' && value.marginMode !== 'cross')
    || !naturalFresh(Number(value.observedAtMs), Number(value.maximumAgeMs), nowMs)) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 'authoritative-paper-risk-policy-evidence-v1',
    leverage: value.requestedLeverage,
    riskPercent: value.riskPercent,
    marginMode: value.marginMode,
    source: `${value.source.trim()}:${value.policyId.trim()}:${value.policyVersion.trim()}`,
    observedAtMs: Number(value.observedAtMs),
    maximumAgeMs: Number(value.maximumAgeMs),
  });
}

function naturalPositionTierUrl(symbol: string): URL {
  const url = new URL('/api/v2/mix/market/query-position-lever', BITGET_BASE_URL);
  url.search = new URLSearchParams({
    productType: 'usdt-futures',
    symbol,
  }).toString();
  return url;
}

function naturalPositionTierRows(value: unknown): readonly unknown[] | null {
  if (Array.isArray(value)) return value.length > 0 ? Object.freeze([...value]) : null;
  const envelope = naturalRecord(value);
  if (!envelope || envelope.code !== '00000' || !Array.isArray(envelope.data) || envelope.data.length === 0) {
    return null;
  }
  return Object.freeze([...envelope.data]);
}

function naturalEmptyResolution(
  partial: Partial<NaturalCycleResolution> = {},
): NaturalCycleResolution {
  return Object.freeze({
    paperStateSnapshot: null,
    paperState: null,
    publicEvidence: null,
    sizedContractInput: null,
    executionObservationInput: null,
    executionObservation: null,
    supplementalCostInput: null,
    ...partial,
  });
}

/**
 * Natural-cycle orchestration only. It reuses the existing Scanner, Paper state,
 * contract, TradingRiskEngine and public-L2 owners. No policy value, cost value,
 * fill probability, or account balance is synthesized here.
 */
export function createAuthoritativePaperNaturalCycleEvidenceSourceWiring({
  researchCodeSha,
  sources,
  dependencies: overrides = {},
}: Readonly<{
  researchCodeSha: string;
  sources: AuthoritativePaperNaturalCycleEvidenceSources;
  dependencies?: Partial<Dependencies>;
}>): AuthoritativePaperNaturalCycleEvidenceSourceWiring {
  if (typeof sources?.paperStateSnapshotForCard !== 'function'
    || typeof sources?.riskPolicyRecordForCard !== 'function'
    || typeof sources?.supplementalCostInputForCard !== 'function') {
    throw new TypeError('AUTHORITATIVE_NATURAL_CYCLE_SOURCE_CALLBACKS_REQUIRED');
  }
  const normalizedSha = String(researchCodeSha ?? '').trim().toLowerCase();
  if (!exactSha(normalizedSha)) throw new TypeError('authoritative Natural cycle requires an exact research SHA');
  const dependencies = Object.freeze({ ...defaultDependencies(), ...overrides }) as Dependencies;
  const snapshotCache = new WeakMap<object, Promise<unknown | null>>();
  const publicEvidenceCache = new WeakMap<object, Promise<ReturnType<typeof buildBitgetFuturesPublicEvidence> | null>>();
  const resolutionCache = new WeakMap<object, Promise<NaturalCycleResolution>>();
  const defaultEvidenceContext = Object.freeze({ card: null, market: 'CRYPTO_FUTURES' as const });
  let baseWiring: AuthoritativePaperEvidenceSourceWiring;

  function cacheKey(context: EvidenceContext | null | undefined): object {
    return context && typeof context === 'object' ? context : defaultEvidenceContext;
  }

  function paperStateSnapshot(context: EvidenceContext): Promise<unknown | null> {
    const key = cacheKey(context);
    const cached = snapshotCache.get(key);
    if (cached) return cached;
    const pending = Promise.resolve(sources.paperStateSnapshotForCard(context));
    snapshotCache.set(key, pending);
    return pending;
  }

  function publicEvidence(context: EvidenceContext): Promise<ReturnType<typeof buildBitgetFuturesPublicEvidence> | null> {
    const key = cacheKey(context);
    const cached = publicEvidenceCache.get(key);
    if (cached) return cached;
    const pending = Promise.resolve(baseWiring.publicEvidenceForCard(context)).catch(() => null);
    publicEvidenceCache.set(key, pending);
    return pending;
  }

  async function resolveNaturalCycle(context: EvidenceContext): Promise<NaturalCycleResolution> {
    const key = cacheKey(context);
    const cached = resolutionCache.get(key);
    if (cached) return cached;
    const pending = (async (): Promise<NaturalCycleResolution> => {
      let partial = naturalEmptyResolution();
      try {
        const candidate = baseWiring.paperCandidateForCard(context);
        const learning = baseWiring.learningSnapshotForCard(context);
        if (!candidate || !learning) return partial;
        const snapshotValue = await paperStateSnapshot(context);
        if (snapshotValue == null) return partial;
        const nowMs = dependencies.now();
        const snapshot = validateImmutablePaperTradingStateSnapshot(snapshotValue, nowMs);
        const state = snapshot.state;
        partial = naturalEmptyResolution({ paperStateSnapshot: snapshot, paperState: state });

        const marketEvidence = await publicEvidence(context);
        if (!marketEvidence || marketEvidence.dataQuality !== 'ready') return partial;
        const symbol = naturalSymbol(candidate.signal.symbol);
        if (!symbol || naturalSymbol(marketEvidence.symbol) !== symbol) return partial;
        partial = naturalEmptyResolution({ ...partial, publicEvidence: marketEvidence });

        const strategyScope = candidate.signal.strategyIdentity.strategyId;
        const direction = candidate.signal.direction;
        if (direction !== 'LONG' && direction !== 'SHORT') return partial;
        const request = Object.freeze({
          market: 'CRYPTO_FUTURES' as const,
          symbol,
          strategyScope,
          researchCodeSha: normalizedSha,
        });
        const policyProducer = createAuthoritativePaperGenericRiskPolicyProducer({
          readCanonicalRecord: (policyRequest) => sources.riskPolicyRecordForCard(context, policyRequest),
          now: dependencies.now,
        });
        const policySource = await policyProducer(request);
        const executionRiskPolicy = naturalExecutionRiskPolicy(policySource, request, nowMs);
        if (!executionRiskPolicy) return partial;
        const sourceSupplementalCostInput = await sources.supplementalCostInputForCard(context).catch(() => null);

        const tierPayload = typeof sources.positionTiersForCard === 'function'
          ? await sources.positionTiersForCard(context)
          : await dependencies.fetchPublicJson(naturalPositionTierUrl(symbol), {
            provider: 'bitget',
            signal: abortSignal(context.signal),
          });
        const positionTiers = naturalPositionTierRows(tierPayload);
        const quantityPrecision = naturalQuantityPrecision(marketEvidence.sizeMultiplier);
        if (!positionTiers || quantityPrecision == null) return partial;

        const dataObservedAtMs = Date.parse(learning.dataTimestamp);
        if (!naturalFresh(dataObservedAtMs, FORWARD_OBSERVER_DATA_MAX_AGE_MS, nowMs)
          || !naturalPositive(learning.entryPrice)
          || !naturalPositive(learning.stopLoss)) return partial;

        const stablePolicyProducer = async () => policySource;
        const seenQuantities = new Set<string>();
        let probeQuantity = marketEvidence.minTradeNum;
        for (let iteration = 0; iteration < NATURAL_CYCLE_MAX_SIZING_ITERATIONS; iteration += 1) {
          if (!naturalPositive(probeQuantity)) return partial;
          const quantityIdentity = probeQuantity.toPrecision(15);
          if (seenQuantities.has(quantityIdentity)) return partial;
          seenQuantities.add(quantityIdentity);
          const sizedNotional = probeQuantity * learning.entryPrice;
          const sizedContractInput: SizedContractInput = Object.freeze({
            publicEvidence: marketEvidence,
            positionTiers,
            sizedNotional,
            quantityPrecision,
            riskPolicy: executionRiskPolicy,
            observedAtMs: marketEvidence.observedAtMs,
            nowMs,
            maximumAgeMs: NATURAL_CYCLE_EVIDENCE_MAXIMUM_AGE_MS,
          });
          const sizedContract = buildAuthoritativeSizedContractRules(sizedContractInput);
          const executionSizing: AuthoritativePaperExecutionSizingEvidence = Object.freeze({
            schemaVersion: AUTHORITATIVE_PAPER_EXECUTION_SIZING_EVIDENCE_VERSION,
            signalId: candidate.signal.signalId,
            symbol,
            direction,
            targetQuantity: probeQuantity,
            riskPolicy: executionRiskPolicy,
            source: 'GENERIC_AUTHORITATIVE_PAPER_RISK_SIZING_FIXED_POINT',
            observedAtMs: nowMs,
            maximumAgeMs: NATURAL_CYCLE_EVIDENCE_MAXIMUM_AGE_MS,
          });
          const latencyCollection = await collectAuthoritativePaperLatencyCostEvidence({
            market: 'CRYPTO_FUTURES',
            symbol,
            researchCodeSha: normalizedSha,
            direction,
            readPublicMidpointQuote: (phase, attempt) => readBitgetPublicLatencyMidpointQuote({
              market: 'CRYPTO_FUTURES',
              symbol,
              researchCodeSha: normalizedSha,
              phase,
              attempt,
              fetchPublicJson: dependencies.fetchPublicJson,
              signal: abortSignal(context.signal),
            }),
            executeMeasuredPublicRequest: () => collectAuthoritativePaperExecutionObservationInput({
              context,
              sizingEvidence: executionSizing,
              fetchPublicJson: dependencies.fetchPublicJson,
              now: dependencies.now,
            }),
            now: dependencies.now,
            maximumAgeMs: NATURAL_CYCLE_EVIDENCE_MAXIMUM_AGE_MS,
            maximumRequestDurationMs: NATURAL_CYCLE_EVIDENCE_MAXIMUM_AGE_MS,
            maximumPostObservationAttempts: 3,
          });
          const executionInput = latencyCollection.requestResult;
          if (!executionInput) return partial;
          const executionObservation = buildAuthoritativePaperExecutionObservation(executionInput);
          const slippagePercent = executionObservation.slippage.valuePercent;
          if (!Number.isFinite(slippagePercent) || slippagePercent < 0) return partial;
          const fundingBoundSupplementalCostInput = naturalFundingBoundSupplementalCostInput({
            candidate,
            riskPolicy: policySource.policyEvidence,
            publicEvidence: marketEvidence,
            sourceSupplementalCostInput,
            researchCodeSha: normalizedSha,
            entryTimestampMs: nowMs,
            positionNotional: probeQuantity * learning.entryPrice,
            nowMs: latencyCollection.evaluatedAtMs,
          });
          const latencyBinding = bindAuthoritativePaperLatencyToSupplementalCostInput({
            sourceSupplementalCostInput: fundingBoundSupplementalCostInput,
            latency: latencyCollection.latency,
          });
          const supplementalCostInput = latencyBinding.supplementalCostInput;
          if (!supplementalCostInput || !supplementalCostInput.funding) return partial;
          const supplementalAudit = auditAuthoritativeSupplementalCostSources({
            publicEvidence: marketEvidence,
            executionObservation,
            supplemental: supplementalCostInput,
            nowMs: latencyCollection.evaluatedAtMs,
            maximumAgeMs: NATURAL_CYCLE_EVIDENCE_MAXIMUM_AGE_MS,
          });
          const executionCostComponentNames = [
            'spread',
            'slippage',
            'latency',
            'liquidityImpact',
            'partialFillImpact',
          ] as const;
          const executionCostPercentValues = executionCostComponentNames.map(
            (name) => supplementalAudit.components[name].value,
          );
          const completeExecutionCostPercent = supplementalAudit.fullCostReady
            && executionCostPercentValues.every((value): value is number => (
              typeof value === 'number' && Number.isFinite(value) && value >= 0
            ))
            ? executionCostPercentValues.reduce((sum, value) => sum + value, 0)
            : null;
          const sizingExecutionCostRate = completeExecutionCostPercent == null
            ? slippagePercent / 100
            : completeExecutionCostPercent / 100;
          const fundingExecutionCostRate = supplementalCostInput.funding.valuePercent / 100;

          const bridge = await buildAuthoritativePaperRiskSizingFromGenericRiskPolicySource({
            market: 'CRYPTO_FUTURES',
            symbol,
            strategyScope,
            side: direction,
            researchCodeSha: normalizedSha,
            paperStateSourceSha: snapshot.sourceSha,
            paperAccountId: snapshot.accountId,
            paperStateSnapshot: snapshot,
            contractRulesEvidence: Object.freeze({
              schemaVersion: 'authoritative-paper-contract-rules-evidence-v1',
              ruleVersion: `bitget-sized-contract-tier-${String(sizedContract.selectedTier.index)}`,
              market: 'CRYPTO_FUTURES',
              symbol,
              source: 'AUTHORITATIVE_SIZED_BITGET_PUBLIC_CONTRACT_RULES',
              provenance: sizedContract.provenance,
              observedAtMs: marketEvidence.observedAtMs,
              maximumAgeMs: NATURAL_CYCLE_EVIDENCE_MAXIMUM_AGE_MS,
              rules: sizedContract.contractRules,
            }),
            marketEvidence: Object.freeze({
              schemaVersion: 'authoritative-paper-market-risk-evidence-v1',
              market: 'CRYPTO_FUTURES',
              symbol,
              entryPrice: learning.entryPrice,
              stopLossPrice: learning.stopLoss,
              source: 'FORWARD_OBSERVATION_IMMUTABLE_SIGNAL_SNAPSHOT',
              provenance: learning.dataProvenance,
              observedAtMs: dataObservedAtMs,
              maximumAgeMs: FORWARD_OBSERVER_DATA_MAX_AGE_MS,
              status: 'live',
            }),
            costEvidence: Object.freeze({
              schemaVersion: 'authoritative-paper-risk-cost-evidence-v1',
              market: 'CRYPTO_FUTURES',
              symbol,
              source: completeExecutionCostPercent == null
                ? 'BITGET_PUBLIC_FEES_HORIZON_FUNDING_PLUS_PUBLIC_L2_BOOK_WALK'
                : 'AUTHORITATIVE_FULL_EXECUTION_COST_FIXED_POINT',
              provenance: Object.freeze([
                'bitget-public-v2-contracts',
                supplementalCostInput.funding.source,
                executionObservation.providerProvenance,
                ...(completeExecutionCostPercent == null
                  ? []
                  : executionCostComponentNames.map(
                    (name) => supplementalAudit.components[name].source as string,
                  )),
              ]),
              observedAtMs: Math.min(marketEvidence.observedAtMs, executionObservation.slippage.observedAtMs),
              maximumAgeMs: NATURAL_CYCLE_EVIDENCE_MAXIMUM_AGE_MS,
              entryFeeRate: marketEvidence.takerFeeRate,
              exitFeeRate: marketEvidence.takerFeeRate,
              slippageRate: sizingExecutionCostRate,
              estimatedFundingRate: fundingExecutionCostRate,
            }),
          }, stablePolicyProducer, nowMs);
          const targetQuantity = bridge.sizingEvidence.targetQuantity;
          if (bridge.policySource !== policySource
            || bridge.sizingEvidence.status !== 'PRESENT'
            || !naturalPositive(targetQuantity)) return partial;
          const converged = Math.abs(targetQuantity - probeQuantity)
            <= Number.EPSILON * Math.max(1, Math.abs(targetQuantity), Math.abs(probeQuantity)) * 8;
          if (!converged) {
            probeQuantity = targetQuantity;
            continue;
          }

          const finalFundingBoundSupplementalCostInput = naturalFundingBoundSupplementalCostInput({
            candidate,
            riskPolicy: policySource.policyEvidence,
            publicEvidence: marketEvidence,
            sourceSupplementalCostInput,
            researchCodeSha: normalizedSha,
            entryTimestampMs: nowMs,
            positionNotional: targetQuantity * learning.entryPrice,
            nowMs: latencyCollection.evaluatedAtMs,
          });
          const finalLatencyBinding = bindAuthoritativePaperLatencyToSupplementalCostInput({
            sourceSupplementalCostInput: finalFundingBoundSupplementalCostInput,
            latency: latencyCollection.latency,
          });
          const finalSupplementalCostInput = finalLatencyBinding.supplementalCostInput;
          if (!finalSupplementalCostInput) return partial;
          return naturalEmptyResolution({
            paperStateSnapshot: snapshot,
            paperState: state,
            publicEvidence: marketEvidence,
            sizedContractInput,
            executionObservationInput: executionInput,
            executionObservation,
            supplementalCostInput: finalSupplementalCostInput,
          });
        }
        return partial;
      } catch {
        return partial;
      }
    })();
    resolutionCache.set(key, pending);
    return pending;
  }

  baseWiring = createAuthoritativePaperEvidenceSourceWiring({
    researchCodeSha: normalizedSha,
    dependencies: {
      ...dependencies,
      paperStateSnapshotForCard: paperStateSnapshot,
      sizedContractInputForCard: async (context) => (await resolveNaturalCycle(context)).sizedContractInput,
      executionObservationInputForCard: async (context) => (await resolveNaturalCycle(context)).executionObservationInput,
      executionSizingEvidenceForCard: async () => null,
      supplementalCostInputForCard: async (context) => (await resolveNaturalCycle(context)).supplementalCostInput,
      publicEvidenceForSupplementalCostForCard: async (context) => (await resolveNaturalCycle(context)).publicEvidence,
      executionObservationForSupplementalCostForCard: async (context) => (await resolveNaturalCycle(context)).executionObservation,
    },
  });

  return Object.freeze({
    ...baseWiring,
    publicEvidenceForCard: publicEvidence,
    naturalCycleSourceGraph: Object.freeze({
      schemaVersion: 'authoritative-paper-natural-cycle-source-graph-v1',
      sizingIterationLimit: NATURAL_CYCLE_MAX_SIZING_ITERATIONS,
      policyDefaultsAllowed: false,
      unknownCostIsZero: false,
      publicDepthIsRealFill: false,
      realFillObserved: false,
      latencyEvidenceOwner: 'AUTHORITATIVE_PUBLIC_BBO_REQUEST_BRACKET',
      latencyEvidenceQuality: 'ESTIMATED',
      latencyMissingIsZero: false,
      executionAuthority: 'NONE',
    }),
  });
}

export const AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_SAFETY = Object.freeze({
  schemaVersion: AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_VERSION,
  ownersConnected: Object.freeze([
    'scanBatchForMarket',
    'paperCandidateForCard',
    'learningSnapshotForCard',
    'paperStateForCard',
    'contractRulesForCard',
    'publicEvidenceForCard',
    'executionObservationForCard',
    'supplementalCostEvidenceForCard',
  ]),
  callbackContractsConnected: Object.freeze([
    'scanBatchForMarket',
    'paperCandidateForCard',
    'learningSnapshotForCard',
    'paperStateForCard',
    'contractRulesForCard',
    'publicEvidenceForCard',
    'executionObservationForCard',
    'supplementalCostEvidenceForCard',
  ]),
  ownerMissingCallbacks: Object.freeze([]),
  ownerMissingCount: 0,
  ownerDataReadiness: AUTHORITATIVE_PAPER_CALLBACK_OWNERS_SAFETY.dataReadiness,
  latencyEvidenceOwnerConnected: true,
  latencyPublicRequestBracketingRequired: true,
  latencyMissingIsZero: false,
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  scheduleActivationAuthority: false,
  financialMutationAllowed: false,
});
