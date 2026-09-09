import { api, type ScanResult } from './api';

const INVALID_SCAN_RESPONSE = 'INVALID_SCAN_RESPONSE';
const UNHEALTHY_SCAN_RESPONSE = 'UNHEALTHY_SCAN_RESPONSE';
const MAX_RESPONSE_AGE_MS = 2 * 60_000;
const MAX_FUTURE_SKEW_MS = 5_000;
let installed = false;

type ScanMethod = typeof api.scan;
type JsonRecord = Record<string, unknown>;
type ScanExpectation = {
  selected?: string[];
  market?: string;
  timeframe?: string;
  now?: number;
};

const DATA_STATES = new Set(['complete', 'partial', 'stale', 'insufficient', 'unavailable', 'untrusted']);
const HEALTHY_OUTCOMES = new Set(['CANDIDATES_AVAILABLE', 'VALID_ZERO_SIGNAL', 'UNIVERSE_EMPTY', 'FILTER_TOO_STRICT']);
const ALL_OUTCOMES = new Set([
  ...HEALTHY_OUTCOMES,
  'PROVIDER_FAILURE',
  'SYMBOL_MAPPING_FAILURE',
  'REQUEST_TIMEOUT',
  'DATA_QUALITY_REJECT',
  'FRONTEND_RENDER_FAILURE',
]);

function fail(): never {
  throw new Error(INVALID_SCAN_RESPONSE);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isPercent(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 100;
}

function isIsoDate(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isFresh(value: unknown, now: number): value is string {
  if (!isIsoDate(value)) return false;
  const timestamp = Date.parse(value);
  return timestamp >= now - MAX_RESPONSE_AGE_MS && timestamp <= now + MAX_FUTURE_SKEW_MS;
}

function sameTimeframe(actual: string, expected: string): boolean {
  const normalize = (value: string) => value === '1H' ? '60m' : value;
  return normalize(actual) === normalize(expected);
}

function isPricePlan(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.entryZone !== null) {
    if (!isRecord(value.entryZone)) return false;
    if (!isFiniteNumber(value.entryZone.from) || !isFiniteNumber(value.entryZone.to)) return false;
    if (value.entryZone.from <= 0 || value.entryZone.to <= 0 || value.entryZone.from > value.entryZone.to) return false;
  }
  if (!isFiniteOrNull(value.invalidation) || !isFiniteOrNull(value.stopLoss) || !isFiniteOrNull(value.riskReward)) return false;
  if (!Array.isArray(value.targets) || !value.targets.every((target) => isFiniteNumber(target) && target > 0)) return false;
  return true;
}

function isEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.key) || !isNonEmptyString(value.label) || !isNonEmptyString(value.source)) return false;
  if (value.status !== 'matched' && value.status !== 'not_matched' && value.status !== 'unverified') return false;
  if (value.observedAt !== null && !isIsoDate(value.observedAt)) return false;
  return isStringArray(value.reasons);
}

function isCanonicalCard(value: unknown, market: 'KR' | 'US'): value is JsonRecord {
  if (!isRecord(value)) return false;
  if (value.assetClass !== 'stock' || value.market !== market) return false;
  if (!isNonEmptyString(value.signalId) || !isNonEmptyString(value.symbol) || !isNonEmptyString(value.name)) return false;
  if (market === 'KR' ? value.currency !== 'KRW' : value.currency !== 'USD') return false;
  if (!isNonEmptyString(value.assetType) || (value.listingStatus !== 'LISTED' && value.listingStatus !== 'UNKNOWN')) return false;
  if (!isFiniteNumber(value.price) || value.price <= 0 || !isFiniteOrNull(value.changePercent)) return false;
  if (value.direction !== 'LONG') return false;
  if (value.action !== undefined && value.action !== 'BUY') return false;
  if (!isNonEmptyString(value.signalState) || !isPercent(value.score) || !isPercent(value.confidence) || !isPercent(value.dataCompleteness)) return false;
  if (!isFiniteOrNull(value.riskScore) || !isNonEmptyString(value.riskLevel)) return false;
  for (const field of ['liquidity', 'volume', 'tradingValue', 'spreadPercent', 'volatilityPercent'] as const) {
    if (!isFiniteOrNull(value[field])) return false;
  }
  if (!isStringArray(value.matched) || !isStringArray(value.notMatched) || !isStringArray(value.unverified)) return false;
  if (!Array.isArray(value.evidence) || !value.evidence.every(isEvidence)) return false;
  if (!isPricePlan(value.pricePlan)) return false;
  if (!isNonEmptyString(value.dataState) || !DATA_STATES.has(value.dataState)) return false;
  if (!isStringArray(value.dataSources) || !isIsoDate(value.observedAt) || !isIsoDate(value.expiresAt)) return false;
  if (typeof value.strongSignalEligible !== 'boolean' || !isStringArray(value.warnings)) return false;
  return true;
}

function validateExecution(value: unknown): void {
  if (!isRecord(value)) fail();
  for (const field of ['requestedCount', 'startedCount', 'completedCount', 'excludedCount', 'providerErrorCount', 'timeoutCount', 'elapsedMs', 'deadlineMs', 'itemTimeoutMs', 'maxConcurrency'] as const) {
    if (!isNonNegativeInteger(value[field])) fail();
  }
  for (const field of ['partial', 'timedOut', 'cancelled', 'duplicate'] as const) {
    if (typeof value[field] !== 'boolean') fail();
  }
}

function validateUniverse(value: unknown): void {
  if (!isRecord(value)) fail();
  if (!isNonNegativeInteger(value.totalCount) || !isNonNegativeInteger(value.cursor)) fail();
  if (value.nextCursor !== null && !isNonNegativeInteger(value.nextCursor)) fail();
  if (!isNonEmptyString(value.source) || typeof value.partial !== 'boolean' || typeof value.stale !== 'boolean') fail();
  if (value.listingStatusCoverage !== 'listed-or-unknown') fail();
}

function compatibilityCard(card: JsonRecord, selectedCount: number): JsonRecord {
  const pricePlan = card.pricePlan as JsonRecord;
  const entryZone = isRecord(pricePlan.entryZone) ? pricePlan.entryZone : null;
  const entry = entryZone
    ? [String(entryZone.from), ...(entryZone.to === entryZone.from ? [] : [String(entryZone.to)])]
    : [];
  const stop = isFiniteNumber(pricePlan.stopLoss) ? [String(pricePlan.stopLoss)] : [];
  return {
    ...card,
    ticker: card.symbol,
    missing: card.unverified,
    entry,
    stop,
    matchCount: (card.matched as string[]).length,
    selectedCount,
  };
}

export function validateScannerResponse(value: unknown, expectation: ScanExpectation = {}): ScanResult {
  if (!isRecord(value) || value.ok !== true || value.assetClass !== 'stock') fail();
  if (value.market !== 'KR' && value.market !== 'US') fail();
  const market = value.market;
  if (!isNonEmptyString(value.requestId) || !isNonEmptyString(value.timeframe)) fail();
  if (expectation.market && market !== expectation.market) fail();
  if (expectation.timeframe && !sameTimeframe(value.timeframe, expectation.timeframe)) fail();
  if (!Array.isArray(value.cards) || !value.cards.every((card) => isCanonicalCard(card, market))) fail();
  if (!Array.isArray(value.alerts) || !Array.isArray(value.failures)) fail();
  validateExecution(value.execution);
  validateUniverse(value.universe);
  if (!isNonEmptyString(value.dataState) || !DATA_STATES.has(value.dataState)) fail();
  if (!isNonEmptyString(value.outcome) || !ALL_OUTCOMES.has(value.outcome)) fail();
  if (!isNonEmptyString(value.message)) fail();
  if (!isFresh(value.generatedAt, expectation.now ?? Date.now())) fail();
  if (value.orderSubmitted !== false || value.exchangeRequestSent !== false) fail();

  if (value.outcome === 'CANDIDATES_AVAILABLE' && value.cards.length === 0) fail();
  if (value.outcome !== 'CANDIDATES_AVAILABLE' && value.cards.length > 0) fail();
  if (!HEALTHY_OUTCOMES.has(value.outcome)) throw new Error(UNHEALTHY_SCAN_RESPONSE);

  const selected = expectation.selected ? [...new Set(expectation.selected.map((item) => item.trim()).filter(Boolean))] : [];
  const cards = (value.cards as JsonRecord[]).map((card) => compatibilityCard(card, selected.length));
  return {
    ...(value as JsonRecord),
    cards,
    selected,
    fetchedAt: value.generatedAt,
    searchRunId: value.requestId,
  } as unknown as ScanResult;
}

export function installScannerResponseGuard(): void {
  if (installed) return;
  const originalScan: ScanMethod = api.scan;
  api.scan = (async (...args: Parameters<ScanMethod>) => {
    const value = await originalScan(...args);
    return validateScannerResponse(value, {
      selected: args[0],
      market: args[1],
      timeframe: args[2]?.timeframe,
    });
  }) as ScanMethod;
  installed = true;
}
