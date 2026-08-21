import type { ScannerResponse, ScannerSignalCard } from './scanner-signal.types';
import { CryptoSignalScannerService } from './crypto-signal-scanner.service';
import { CryptoPricePrecisionService } from './scanner-crypto-price-precision.service';
import { rankScannerCandidates } from './scanner-candidate-ranking.service';
import { withScannerCanonicalActions } from './scanner-market-action.service';
import {
  attachScannerCanonicalPaperIdentity,
  resolveScannerCanonicalPaperIdentity,
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
  AUTHORITATIVE_PAPER_CALLBACK_OWNERS_SAFETY,
  buildAuthoritativePaperExecutionObservation,
  buildAuthoritativeSizedContractRules,
  buildAuthoritativeSupplementalCostEvidence,
  paperStateFromAuthoritativeSnapshot,
} from './authoritative-paper-callback-owners.service';
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
  supplementalCostInputForCard(context: EvidenceContext): Promise<SupplementalCostInput | null>;
  now: () => number;
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
    supplementalCostInputForCard: async () => null,
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
      requiredData: ['public L2 depth', 'target quantity', 'request timing', 'calibrated fill model', 'immutable risk policy evidence'],
      source: async (context) => {
        const input = await dependencies.executionObservationInputForCard(context);
        return input == null ? null : buildAuthoritativePaperExecutionObservation(input);
      },
    }),
    supplementalCostEvidenceForCard: ownedSource({
      callback: 'supplementalCostEvidenceForCard',
      implementation: 'buildAuthoritativeSupplementalCostEvidence',
      requiredData: ['latency cost evidence', 'liquidity impact cost evidence', 'partial-fill cost evidence', 'funding evidence'],
      source: async (context) => {
        const input = await dependencies.supplementalCostInputForCard(context);
        return input == null ? null : buildAuthoritativeSupplementalCostEvidence(input);
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
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  scheduleActivationAuthority: false,
  financialMutationAllowed: false,
});
