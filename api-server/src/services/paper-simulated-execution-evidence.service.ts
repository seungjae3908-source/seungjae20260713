// The canonical implementation is JavaScript owned by market-intelligence-sidecar.
// @ts-expect-error The sidecar is bundled as validated ESM and has no TypeScript declaration.
import { evaluateCalibratedFillModel, walkOrderBook } from '../../../market-intelligence-sidecar/src/execution-quality.mjs';

export const PAPER_SIMULATED_EXECUTION_EVIDENCE_VERSION = 'paper-simulated-execution-evidence-v1';

export const PAPER_SIMULATED_EXECUTION_EVIDENCE_SAFETY = Object.freeze({
  schemaVersion: 'paper-simulated-execution-evidence-safety-v1',
  executionMode: 'SIMULATED_EXECUTION_ONLY',
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  realFillClaimAllowed: false,
  currentPriceFillAssumptionAllowed: false,
  financialMutationAllowed: false,
});

type DepthLevel = readonly [number | string, number | string] | Readonly<{
  price: number | string;
  size?: number | string;
  qty?: number | string;
  quantity?: number | string;
}>;

export interface PaperSimulatedExecutionEvidenceInput {
  source: string;
  market: string;
  symbol: string;
  direction: string;
  targetQuantity: number;
  bids: readonly DepthLevel[];
  asks: readonly DepthLevel[];
  observedAtMs: number;
  requestStartedAtMs?: number | null;
  requestCompletedAtMs?: number | null;
  maximumAgeMs: number;
  provenance: readonly string[];
  calibratedFillModel?: Readonly<Record<string, unknown>> | null;
  policy?: Readonly<Record<string, unknown>>;
  nowMs?: number;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function levelPrice(level: DepthLevel): number | null {
  if (Array.isArray(level)) return finite(level[0]);
  return finite((level as Readonly<{ price: number | string }>).price);
}

function bestPrice(levels: readonly DepthLevel[], side: 'BID' | 'ASK'): number | null {
  const prices = levels.map(levelPrice).filter((value): value is number => value != null && value > 0);
  if (prices.length === 0) return null;
  return side === 'BID' ? Math.max(...prices) : Math.min(...prices);
}

function cloneLevel(level: DepthLevel): DepthLevel {
  if (Array.isArray(level)) return [level[0], level[1]];
  return { ...(level as Exclude<DepthLevel, readonly [number | string, number | string]>) };
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function freeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}

export function buildPaperSimulatedExecutionEvidence(
  input: PaperSimulatedExecutionEvidenceInput,
): Readonly<Record<string, unknown>> {
  const nowMs = finite(input?.nowMs) ?? Date.now();
  const observedAtMs = finite(input?.observedAtMs);
  const maximumAgeMs = finite(input?.maximumAgeMs);
  const targetQuantity = finite(input?.targetQuantity);
  const blockers: string[] = [];

  if (!nonEmpty(input?.source)) blockers.push('PUBLIC_DEPTH_SOURCE_REQUIRED');
  if (!nonEmpty(input?.market)) blockers.push('MARKET_REQUIRED');
  if (!nonEmpty(input?.symbol)) blockers.push('SYMBOL_REQUIRED');
  if (!nonEmpty(input?.direction)) blockers.push('EXECUTION_DIRECTION_REQUIRED');
  if (!(targetQuantity != null && targetQuantity > 0)) blockers.push('TARGET_QUANTITY_REQUIRED');
  if (!(observedAtMs != null && observedAtMs > 0)) blockers.push('PUBLIC_DEPTH_TIMESTAMP_REQUIRED');
  if (!(maximumAgeMs != null && maximumAgeMs > 0)) blockers.push('PUBLIC_DEPTH_FRESHNESS_CONTRACT_REQUIRED');
  if (observedAtMs != null && maximumAgeMs != null && nowMs - observedAtMs > maximumAgeMs) {
    blockers.push('PUBLIC_DEPTH_STALE');
  }
  if (!Array.isArray(input?.provenance) || input.provenance.length === 0 || !input.provenance.every(nonEmpty)) {
    blockers.push('PUBLIC_DEPTH_PROVENANCE_REQUIRED');
  }

  const bids = Array.isArray(input?.bids) ? input.bids.map(cloneLevel) : [];
  const asks = Array.isArray(input?.asks) ? input.asks.map(cloneLevel) : [];
  const bid = bestPrice(bids, 'BID');
  const ask = bestPrice(asks, 'ASK');
  if (bid == null || ask == null || ask < bid) blockers.push('PUBLIC_DEPTH_BOOK_INVALID');

  const bookWalk = walkOrderBook({
    direction: input?.direction,
    targetQty: input?.targetQuantity,
    bids,
    asks,
  }, input?.policy ?? {});
  if (bookWalk?.status === 'NOT_AVAILABLE') blockers.push(String(bookWalk.reason ?? 'BOOK_WALK_NOT_AVAILABLE'));

  const fillModel = evaluateCalibratedFillModel(
    input?.calibratedFillModel ?? {},
    input?.policy ?? {},
    nowMs,
  );
  if (fillModel?.status === 'NOT_AVAILABLE') blockers.push(String(fillModel.reason ?? 'CALIBRATED_FILL_MODEL_EVIDENCE_MISSING'));

  const requestStartedAtMs = finite(input?.requestStartedAtMs);
  const requestCompletedAtMs = finite(input?.requestCompletedAtMs);
  const observedRoundTripMs = requestStartedAtMs != null
    && requestCompletedAtMs != null
    && requestCompletedAtMs >= requestStartedAtMs
    ? requestCompletedAtMs - requestStartedAtMs
    : null;
  if (observedRoundTripMs == null) blockers.push('OBSERVED_LATENCY_DURATION_MISSING');

  blockers.push(
    'LATENCY_COST_MODEL_OWNER_MISSING',
    'LIQUIDITY_IMPACT_COST_MODEL_OWNER_MISSING',
    'PARTIAL_FILL_COST_MODEL_OWNER_MISSING',
  );

  const spreadAbsolute = bid != null && ask != null && ask >= bid ? ask - bid : null;
  const spreadPercent = spreadAbsolute != null && bid != null && ask != null
    ? (spreadAbsolute / ((bid + ask) / 2)) * 100
    : null;

  return freeze({
    schemaVersion: PAPER_SIMULATED_EXECUTION_EVIDENCE_VERSION,
    status: 'BLOCKED_DATA',
    modelStatus: bookWalk?.status === 'NOT_AVAILABLE' ? 'BLOCKED_DATA' : 'SIMULATION_AVAILABLE',
    blockers: unique(blockers),
    source: nonEmpty(input?.source) ? input.source.trim() : null,
    timestamp: observedAtMs,
    market: nonEmpty(input?.market) ? input.market.trim() : null,
    symbol: nonEmpty(input?.symbol) ? input.symbol.trim() : null,
    observed: {
      bid,
      ask,
      spread: { absolute: spreadAbsolute, percent: spreadPercent, quality: 'OBSERVED_PUBLIC_DEPTH' },
      depth: { bids, asks, quality: 'OBSERVED_PUBLIC_DEPTH' },
      latencyEvidence: {
        observedRoundTripMs,
        costPercent: null,
        quality: observedRoundTripMs == null ? 'NOT_AVAILABLE' : 'OBSERVED_DURATION_ONLY',
      },
    },
    estimated: {
      slippageEstimate: {
        percent: finite(bookWalk?.slippageBps) == null ? null : Number(bookWalk.slippageBps) / 100,
        quality: bookWalk?.status === 'NOT_AVAILABLE' ? 'NOT_AVAILABLE' : 'ESTIMATED',
        model: bookWalk?.model ?? null,
      },
      liquidityEvidence: {
        targetQuantity: targetQuantity != null && targetQuantity > 0 ? targetQuantity : null,
        visibleExecutableQuantity: finite(bookWalk?.filledQty),
        visibleCoverageRatio: finite(bookWalk?.coverageRatio),
        permanentMarketImpactEstimated: false,
      },
      partialFillEstimate: {
        visibleDepthFillFraction: finite(bookWalk?.coverageRatio),
        calibratedFillProbability: finite(fillModel?.fillProbability),
        quality: fillModel?.status === 'NOT_AVAILABLE' ? 'UNCALIBRATED_MODEL_ONLY' : 'CALIBRATED_ESTIMATE',
      },
    },
    confidence: {
      classification: fillModel?.status === 'NOT_AVAILABLE' ? 'UNCALIBRATED' : 'CALIBRATED',
      numericConfidence: null,
      fillModel,
    },
    provenance: Array.isArray(input?.provenance) ? [...input.provenance] : [],
    executionMode: 'SIMULATED_EXECUTION_ONLY',
    publicDepthIsFillProof: false,
    realFillClaim: false,
    currentPriceIsFillPrice: false,
    costEvidenceReady: false,
    safety: PAPER_SIMULATED_EXECUTION_EVIDENCE_SAFETY,
  });
}
