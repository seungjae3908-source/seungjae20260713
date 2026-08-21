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

export const AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_VERSION =
  'authoritative-paper-evidence-sources-v1' as const;

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
  publicEvidenceForCard(context: EvidenceContext): Promise<ReturnType<typeof buildBitgetFuturesPublicEvidence> | null>;
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
    'publicEvidenceForCard',
  ]),
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  scheduleActivationAuthority: false,
  financialMutationAllowed: false,
});
