import { createHash } from 'node:crypto';
import {
  getFuturesMarketSnapshot,
  normalizeFuturesSymbol,
  type DataStatus,
} from './futures-market-data.service';
import type { ScannerEvidence, ScannerSignalCard } from './scanner-signal.types';

const BITGET_BASE_URL = 'https://api.bitget.com';
const BITGET_POSITION_TIER_PATH = '/api/v3/market/position-tier';
const BITGET_CATEGORY = 'USDT-FUTURES';
const REQUEST_TIMEOUT_MS = 8_000;
const POSITION_TIER_TTL_MS = 60_000;
const POSITION_TIER_STALE_MS = 10 * 60_000;
const CANONICAL_LIQUIDATION_MODEL_OWNER = 'market-prediction-lab/src/crypto-futures-isolated-liquidation-model-v1.js';
const CANONICAL_LIQUIDATION_MODEL_ID = 'BITGET_CLASSIC_SINGLE_ASSET_ISOLATED_TIERED_V2025_11_10';

export type FuturesDerivativesEvidenceStatus = 'READY' | 'BLOCKED_DERIVATIVES_EVIDENCE';

export interface FuturesPositionTierRow {
  tier: number;
  minTierValue: number;
  maxTierValue: number;
  leverage: number;
  maintenanceMarginRate: number;
}

export interface FuturesPositionTierEvidence {
  symbol: string;
  source: 'bitget-public-position-tier';
  providerHost: 'api.bitget.com';
  endpoint: '/api/v3/market/position-tier';
  category: 'USDT-FUTURES';
  rows: FuturesPositionTierRow[];
  rawEvidenceSha256: string | null;
  observedAt: string | null;
  status: DataStatus;
  currentRuleOnly: true;
  historicalCoverageProven: false;
  publicDataOnly: true;
  privatePositionApiUsed: false;
  executionAuthority: 'NONE';
  warnings: string[];
}

export interface FuturesDirectionalDerivativesEvidence {
  symbol: string;
  status: FuturesDerivativesEvidenceStatus;
  markPrice: number | null;
  indexPrice: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  basis: number | null;
  basisPercent: number | null;
  observedAt: string | null;
  positionTier: FuturesPositionTierEvidence | null;
  liquidationRiskStructure: {
    status: 'READY_FOR_CANONICAL_RISK_SIZING' | 'BLOCKED_DERIVATIVES_EVIDENCE';
    canonicalModelId: string;
    canonicalModelOwner: string;
    currentPublicTierEvidenceReady: boolean;
    positionSpecificLiquidationPrice: null;
    positionSpecificRiskRequiresCanonicalSizing: true;
    historicalCoverageProven: false;
  };
  blockers: string[];
  warnings: string[];
  dataSources: string[];
  publicDataOnly: true;
  privatePositionApiUsed: false;
  executionAuthority: 'NONE';
}

type JsonObject = Record<string, unknown>;
type TierCacheEntry = { value: FuturesPositionTierEvidence; expiresAt: number };

let tierCache = new Map<string, TierCacheEntry>();
let tierInFlight = new Map<string, Promise<FuturesPositionTierEvidence>>();

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimestamp(value: unknown): number | null {
  const parsed = finite(value);
  if (parsed == null || parsed <= 0) return null;
  const milliseconds = parsed < 100_000_000_000 ? parsed * 1000 : parsed;
  return Number.isFinite(milliseconds) ? Math.trunc(milliseconds) : null;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function approximatelyEqual(left: number, right: number) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * 1e-9;
}

function evidenceDigest(symbol: string, observedAtMs: number, rows: FuturesPositionTierRow[]) {
  return createHash('sha256')
    .update(JSON.stringify({ symbol, observedAtMs, rows }))
    .digest('hex');
}

export function normalizeBitgetPositionTierEvidence(input: {
  symbol: unknown;
  rows: unknown;
  requestTime: unknown;
  now?: number;
}): FuturesPositionTierEvidence {
  const now = input.now ?? Date.now();
  const symbol = normalizeFuturesSymbol(input.symbol);
  const warnings: string[] = [];
  if (!symbol) {
    return {
      symbol: String(input.symbol ?? '').trim().toUpperCase(),
      source: 'bitget-public-position-tier',
      providerHost: 'api.bitget.com',
      endpoint: BITGET_POSITION_TIER_PATH,
      category: BITGET_CATEGORY,
      rows: [],
      rawEvidenceSha256: null,
      observedAt: null,
      status: 'insufficient',
      currentRuleOnly: true,
      historicalCoverageProven: false,
      publicDataOnly: true,
      privatePositionApiUsed: false,
      executionAuthority: 'NONE',
      warnings: ['INVALID_FUTURES_SYMBOL'],
    };
  }

  const observedAtMs = normalizeTimestamp(input.requestTime);
  const sourceRows = Array.isArray(input.rows) ? input.rows : [];
  const normalized: FuturesPositionTierRow[] = [];
  let invalid = !Array.isArray(input.rows) || sourceRows.length === 0;

  for (let index = 0; index < sourceRows.length; index += 1) {
    const raw = sourceRows[index];
    if (!isObject(raw)) {
      invalid = true;
      continue;
    }
    const tier = finite(raw.tier);
    const minTierValue = finite(raw.minTierValue);
    const maxTierValue = finite(raw.maxTierValue);
    const leverage = finite(raw.leverage);
    const maintenanceMarginRate = finite(raw.mmr);
    if (
      tier == null || !Number.isSafeInteger(tier) || tier !== index + 1
      || minTierValue == null || minTierValue < 0
      || maxTierValue == null || maxTierValue <= minTierValue
      || leverage == null || leverage <= 0
      || maintenanceMarginRate == null || maintenanceMarginRate < 0 || maintenanceMarginRate >= 1
    ) {
      invalid = true;
      continue;
    }
    normalized.push({ tier, minTierValue, maxTierValue, leverage, maintenanceMarginRate });
  }

  if (normalized.length !== sourceRows.length || normalized.length === 0) invalid = true;
  if (normalized.length > 0 && normalized[0].minTierValue !== 0) invalid = true;
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (!approximatelyEqual(previous.maxTierValue, current.minTierValue)) invalid = true;
    if (current.maintenanceMarginRate < previous.maintenanceMarginRate) invalid = true;
  }

  if (observedAtMs == null) warnings.push('POSITION_TIER_OBSERVED_AT_MISSING');
  else if (observedAtMs > now) {
    invalid = true;
    warnings.push('POSITION_TIER_FUTURE_LEAKAGE');
  }
  if (invalid) warnings.push('POSITION_TIER_EVIDENCE_INVALID');

  const status: DataStatus = invalid || observedAtMs == null
    ? 'insufficient'
    : now - observedAtMs > POSITION_TIER_STALE_MS
      ? 'delayed'
      : 'live';

  return {
    symbol,
    source: 'bitget-public-position-tier',
    providerHost: 'api.bitget.com',
    endpoint: BITGET_POSITION_TIER_PATH,
    category: BITGET_CATEGORY,
    rows: invalid ? [] : normalized,
    rawEvidenceSha256: !invalid && observedAtMs != null ? evidenceDigest(symbol, observedAtMs, normalized) : null,
    observedAt: observedAtMs == null ? null : new Date(observedAtMs).toISOString(),
    status,
    currentRuleOnly: true,
    historicalCoverageProven: false,
    publicDataOnly: true,
    privatePositionApiUsed: false,
    executionAuthority: 'NONE',
    warnings: unique(warnings),
  };
}

function linkedAbort(signal: AbortSignal | undefined) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason ?? new Error('FUTURES_DERIVATIVES_EVIDENCE_ABORTED'));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('BITGET_POSITION_TIER_TIMEOUT')), REQUEST_TIMEOUT_MS);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function fetchPositionTier(symbol: string, signal?: AbortSignal): Promise<FuturesPositionTierEvidence> {
  const linked = linkedAbort(signal);
  const url = new URL(BITGET_POSITION_TIER_PATH, BITGET_BASE_URL);
  url.searchParams.set('category', BITGET_CATEGORY);
  url.searchParams.set('symbol', symbol);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'seungjae-investment-app/2.0',
      },
      signal: linked.signal,
    });
    if (!response.ok) throw new Error(`BITGET_POSITION_TIER_HTTP_${response.status}`);
    const payload = await response.json() as unknown;
    if (!isObject(payload) || String(payload.code ?? '') !== '00000') {
      throw new Error('BITGET_POSITION_TIER_INVALID_RESPONSE');
    }
    return normalizeBitgetPositionTierEvidence({
      symbol,
      rows: payload.data,
      requestTime: payload.requestTime,
    });
  } finally {
    linked.cleanup();
  }
}

async function getPositionTier(symbol: string, signal?: AbortSignal): Promise<FuturesPositionTierEvidence> {
  const now = Date.now();
  const cached = tierCache.get(symbol);
  if (cached && cached.expiresAt > now) return cached.value;
  const running = tierInFlight.get(symbol);
  if (running) return running;

  const promise = fetchPositionTier(symbol, signal);
  tierInFlight.set(symbol, promise);
  try {
    const value = await promise;
    if (value.status === 'live') {
      tierCache.set(symbol, { value, expiresAt: Date.now() + POSITION_TIER_TTL_MS });
    }
    return value;
  } catch (error) {
    if (cached) {
      return {
        ...cached.value,
        status: 'cached',
        warnings: unique([...cached.value.warnings, 'POSITION_TIER_PROVIDER_UNAVAILABLE_LAST_GOOD_CACHE']),
      };
    }
    throw error;
  } finally {
    tierInFlight.delete(symbol);
  }
}

export async function getFuturesDirectionalDerivativesEvidence(
  value: unknown,
  signal?: AbortSignal,
): Promise<FuturesDirectionalDerivativesEvidence> {
  const symbol = normalizeFuturesSymbol(value);
  if (!symbol) throw new Error('INVALID_FUTURES_SYMBOL');
  if (signal?.aborted) throw signal.reason ?? new Error('FUTURES_DERIVATIVES_EVIDENCE_ABORTED');

  const [snapshotResult, tierResult] = await Promise.allSettled([
    getFuturesMarketSnapshot(symbol),
    getPositionTier(symbol, signal),
  ]);
  if (signal?.aborted) throw signal.reason ?? new Error('FUTURES_DERIVATIVES_EVIDENCE_ABORTED');

  const snapshot = snapshotResult.status === 'fulfilled' ? snapshotResult.value : null;
  const positionTier = tierResult.status === 'fulfilled' ? tierResult.value : null;
  const warnings: string[] = [];
  const blockers: string[] = [];

  if (!snapshot) blockers.push('DERIVATIVES_SNAPSHOT_UNAVAILABLE');
  if (!positionTier) blockers.push('POSITION_TIER_UNAVAILABLE');
  if (snapshot) warnings.push(...snapshot.warnings);
  if (positionTier) warnings.push(...positionTier.warnings);

  const markPrice = snapshot?.markPrice ?? null;
  const indexPrice = snapshot?.indexPrice ?? null;
  const fundingRate = snapshot?.fundingRate ?? null;
  const openInterest = snapshot?.openInterest ?? null;
  const basis = snapshot?.basis ?? null;
  const basisPercent = snapshot?.basisPercent ?? null;

  if (snapshot && !['live'].includes(snapshot.status)) blockers.push(`DERIVATIVES_SNAPSHOT_${snapshot.status.toUpperCase()}`);
  if (!(markPrice != null && markPrice > 0)) blockers.push('MARK_PRICE_MISSING');
  if (!(indexPrice != null && indexPrice > 0)) blockers.push('INDEX_PRICE_MISSING');
  if (fundingRate == null || !Number.isFinite(fundingRate)) blockers.push('FUNDING_MISSING');
  if (openInterest == null || !Number.isFinite(openInterest) || openInterest < 0) blockers.push('OPEN_INTEREST_MISSING');
  if (basis == null || basisPercent == null || !Number.isFinite(basis) || !Number.isFinite(basisPercent)) {
    blockers.push('BASIS_MISSING');
  } else if (markPrice != null && indexPrice != null && indexPrice > 0) {
    const expectedBasis = markPrice - indexPrice;
    const expectedBasisPercent = (expectedBasis / indexPrice) * 100;
    if (!approximatelyEqual(basis, expectedBasis) || !approximatelyEqual(basisPercent, expectedBasisPercent)) {
      blockers.push('BASIS_PROVENANCE_MISMATCH');
    }
  }
  const tierReady = positionTier?.status === 'live'
    && positionTier.rows.length > 0
    && positionTier.rawEvidenceSha256 != null;
  if (!tierReady) blockers.push('LIQUIDATION_RISK_TIER_MMR_EVIDENCE_MISSING');

  const observedTimes = [snapshot?.updatedAt, positionTier?.observedAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  const observedAt = observedTimes.length ? new Date(Math.max(...observedTimes)).toISOString() : null;
  const status: FuturesDerivativesEvidenceStatus = blockers.length === 0 ? 'READY' : 'BLOCKED_DERIVATIVES_EVIDENCE';

  return {
    symbol,
    status,
    markPrice,
    indexPrice,
    fundingRate,
    openInterest,
    basis,
    basisPercent,
    observedAt,
    positionTier,
    liquidationRiskStructure: {
      status: tierReady ? 'READY_FOR_CANONICAL_RISK_SIZING' : 'BLOCKED_DERIVATIVES_EVIDENCE',
      canonicalModelId: CANONICAL_LIQUIDATION_MODEL_ID,
      canonicalModelOwner: CANONICAL_LIQUIDATION_MODEL_OWNER,
      currentPublicTierEvidenceReady: tierReady,
      positionSpecificLiquidationPrice: null,
      positionSpecificRiskRequiresCanonicalSizing: true,
      historicalCoverageProven: false,
    },
    blockers: unique(blockers),
    warnings: unique(warnings),
    dataSources: unique([
      'bitget-public:/api/v2/mix/market/symbol-price',
      'bitget-public:/api/v2/mix/market/current-fund-rate',
      'bitget-public:/api/v2/mix/market/open-interest',
      'derived:mark-price-minus-index-price',
      'bitget-public:/api/v3/market/position-tier',
      `canonical-liquidation-model:${CANONICAL_LIQUIDATION_MODEL_ID}`,
    ]),
    publicDataOnly: true,
    privatePositionApiUsed: false,
    executionAuthority: 'NONE',
  };
}

function derivativeEvidenceRows(
  direction: 'LONG' | 'SHORT',
  evidence: FuturesDirectionalDerivativesEvidence | null,
): ScannerEvidence[] {
  const observedAt = evidence?.observedAt ?? null;
  const keyPrefix = direction.toLowerCase();
  const matched = (condition: boolean) => condition ? 'matched' as const : 'unverified' as const;
  const tier = evidence?.positionTier;
  return [
    {
      key: `${keyPrefix}-mark-price`,
      label: `${direction} MARK_PRICE`,
      status: matched(evidence?.markPrice != null && evidence.markPrice > 0),
      source: 'bitget-public:/api/v2/mix/market/symbol-price',
      observedAt,
      reasons: [evidence?.markPrice == null ? 'MARK_PRICE_MISSING' : `markPrice=${evidence.markPrice}`],
    },
    {
      key: `${keyPrefix}-index-price`,
      label: `${direction} INDEX_PRICE`,
      status: matched(evidence?.indexPrice != null && evidence.indexPrice > 0),
      source: 'bitget-public:/api/v2/mix/market/symbol-price',
      observedAt,
      reasons: [evidence?.indexPrice == null ? 'INDEX_PRICE_MISSING' : `indexPrice=${evidence.indexPrice}`],
    },
    {
      key: `${keyPrefix}-funding`,
      label: `${direction} FUNDING`,
      status: matched(evidence?.fundingRate != null && Number.isFinite(evidence.fundingRate)),
      source: 'bitget-public:/api/v2/mix/market/current-fund-rate',
      observedAt,
      reasons: [evidence?.fundingRate == null ? 'FUNDING_MISSING' : `fundingRate=${evidence.fundingRate}`],
    },
    {
      key: `${keyPrefix}-open-interest`,
      label: `${direction} OPEN_INTEREST`,
      status: matched(evidence?.openInterest != null && Number.isFinite(evidence.openInterest) && evidence.openInterest >= 0),
      source: 'bitget-public:/api/v2/mix/market/open-interest',
      observedAt,
      reasons: [evidence?.openInterest == null ? 'OPEN_INTEREST_MISSING' : `openInterest=${evidence.openInterest}`],
    },
    {
      key: `${keyPrefix}-basis`,
      label: `${direction} BASIS`,
      status: matched(evidence?.basis != null && evidence?.basisPercent != null),
      source: 'derived:mark-price-minus-index-price',
      observedAt,
      reasons: [
        evidence?.basis == null || evidence?.basisPercent == null
          ? 'BASIS_MISSING'
          : `basis=${evidence.basis}; basisPercent=${evidence.basisPercent}`,
      ],
    },
    {
      key: `${keyPrefix}-liquidation-risk`,
      label: `${direction} LIQUIDATION_RISK`,
      status: matched(evidence?.liquidationRiskStructure.currentPublicTierEvidenceReady === true),
      source: 'bitget-public:/api/v3/market/position-tier',
      observedAt: tier?.observedAt ?? observedAt,
      reasons: evidence?.liquidationRiskStructure.currentPublicTierEvidenceReady
        ? [
          `model=${evidence.liquidationRiskStructure.canonicalModelId}`,
          `tierEvidenceSha256=${tier?.rawEvidenceSha256 ?? 'missing'}`,
          '현재 public tier/MMR 청산구조 증거만 검증됨; 실제 포지션별 청산가는 canonical Risk/Sizing 이후 계산',
        ]
        : ['LIQUIDATION_RISK_TIER_MMR_EVIDENCE_MISSING'],
    },
  ];
}

const EMPTY_PRICE_PLAN = Object.freeze({
  entryZone: null,
  invalidation: null,
  stopLoss: null,
  targets: [] as number[],
  riskReward: null,
});

export function applyFuturesDerivativesEvidenceGate(
  card: ScannerSignalCard,
  evidence: FuturesDirectionalDerivativesEvidence | null,
): ScannerSignalCard {
  const direction = card.direction === 'SHORT' ? 'SHORT' : 'LONG';
  const derivativesRows = derivativeEvidenceRows(direction, evidence);
  const retainedEvidence = card.evidence.filter((row) => !row.key.endsWith('-derivatives'));
  const combinedEvidence = [...retainedEvidence, ...derivativesRows];
  const ready = evidence?.status === 'READY';
  const matched = combinedEvidence.filter((row) => row.status === 'matched').map((row) => row.label);
  const notMatched = combinedEvidence.filter((row) => row.status === 'not_matched').map((row) => row.label);
  const unverified = combinedEvidence.filter((row) => row.status === 'unverified').map((row) => row.label);

  return {
    ...card,
    action: ready ? direction : 'NONE',
    signalState: ready ? card.signalState : 'WATCHING',
    strongSignalEligible: ready && card.strongSignalEligible,
    dataCompleteness: ready ? card.dataCompleteness : Math.min(card.dataCompleteness, 79),
    dataState: ready ? card.dataState : card.dataState === 'stale' ? 'stale' : 'insufficient',
    matched,
    notMatched,
    unverified,
    evidence: combinedEvidence,
    pricePlan: ready ? card.pricePlan : { ...EMPTY_PRICE_PLAN, targets: [] },
    dataSources: unique([...card.dataSources, ...(evidence?.dataSources ?? [])]),
    warnings: unique([
      ...card.warnings,
      ...(ready ? [] : ['BLOCKED_DERIVATIVES_EVIDENCE']),
      ...(evidence?.blockers ?? ['DERIVATIVES_EVIDENCE_NOT_REQUESTED_OR_UNAVAILABLE']),
      ...(evidence?.warnings ?? []),
    ]),
  };
}

export function resetFuturesDirectionalDerivativesEvidenceStateForTests() {
  tierCache = new Map();
  tierInFlight = new Map();
}
