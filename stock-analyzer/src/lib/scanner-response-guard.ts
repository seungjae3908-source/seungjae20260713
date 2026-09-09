import { api, type ScanResult } from './api';

const INVALID_SCAN_RESPONSE = 'INVALID_SCAN_RESPONSE';
let installed = false;

type ScanMethod = typeof api.scan;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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

function isMetricRow(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.label)) return false;
  return typeof value.value === 'string' || isFiniteNumber(value.value);
}

function isValidCard(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.ticker) || !isNonEmptyString(value.name)) return false;
  if (value.market !== 'KR' && value.market !== 'US') return false;
  if (value.currency !== 'KRW' && value.currency !== 'USD') return false;
  if ((value.market === 'KR' && value.currency !== 'KRW') || (value.market === 'US' && value.currency !== 'USD')) return false;
  if (!isFiniteNumber(value.price) || value.price <= 0) return false;
  if (!isFiniteNumber(value.changePct)) return false;
  if (!isFiniteNumber(value.score) || !isFiniteNumber(value.confidence) || !isFiniteNumber(value.breakoutProbability)) return false;
  if (!isStringArray(value.matched) || !isStringArray(value.missing)) return false;
  if (!Array.isArray(value.entry) || !value.entry.every(isMetricRow)) return false;
  if (!Array.isArray(value.stop) || !value.stop.every(isMetricRow)) return false;
  if (!isNonEmptyString(value.expectedPeriod)) return false;
  if (!isNonNegativeInteger(value.matchCount) || !isNonNegativeInteger(value.selectedCount)) return false;
  return true;
}

export function validateScannerResponse(value: unknown): ScanResult {
  if (!isRecord(value) || !Array.isArray(value.cards) || !Array.isArray(value.selected)) {
    throw new Error(INVALID_SCAN_RESPONSE);
  }
  if (!isStringArray(value.selected)) throw new Error(INVALID_SCAN_RESPONSE);
  if (!value.cards.every(isValidCard)) throw new Error(INVALID_SCAN_RESPONSE);
  if (value.supportedIndicators !== undefined && !isStringArray(value.supportedIndicators)) {
    throw new Error(INVALID_SCAN_RESPONSE);
  }
  if (value.fetchedAt !== undefined) {
    if (!isNonEmptyString(value.fetchedAt) || !Number.isFinite(Date.parse(value.fetchedAt))) {
      throw new Error(INVALID_SCAN_RESPONSE);
    }
  }
  if (value.searchRunId !== undefined && !isNonEmptyString(value.searchRunId)) {
    throw new Error(INVALID_SCAN_RESPONSE);
  }
  return value as unknown as ScanResult;
}

export function installScannerResponseGuard(): void {
  if (installed) return;
  const originalScan: ScanMethod = api.scan;
  api.scan = (async (...args: Parameters<ScanMethod>) => {
    const value = await originalScan(...args);
    return validateScannerResponse(value);
  }) as ScanMethod;
  installed = true;
}
