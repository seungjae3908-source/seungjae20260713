export type ScannerSavedSearch = {
  id: string;
  name: string;
  assetType: 'stock';
  market: 'KR' | 'US';
  timeframe: '5m' | '15m' | '1H' | '4H' | '1D';
  selected: string[];
  preset: string | null;
  volumeThreshold: number;
  tradingValueThreshold: number;
  volumeLookbackDays: number;
  tradingValueLookbackDays: number;
  marketCapThreshold: number;
  minimumScore: number;
  maximumRiskScore: number;
  createdAt: string;
  updatedAt: string;
};

export const SCANNER_SAVED_SEARCHES_KEY = 'sa-saved-searches-v1';
export const SCANNER_THRESHOLD_KEY = 'scanner.threshold.v1';
export const SCANNER_MARKET_KEY = 'scanner-market';
const TIMEFRAMES = new Set(['5m', '15m', '1H', '4H', '1D']);

function numberInRange(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function normalize(value: unknown): ScannerSavedSearch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = String(item.id ?? '').trim();
  const selected = Array.isArray(item.selected)
    ? [...new Set(item.selected.map(String).map((entry) => entry.trim()).filter(Boolean))].slice(0, 40)
    : [];
  if (!id || !selected.length) return null;
  const now = new Date().toISOString();
  const timeframe = String(item.timeframe ?? '1D');
  return {
    id,
    name: String(item.name ?? selected.slice(0, 2).join('+')).trim().slice(0, 80) || '저장 검색',
    assetType: 'stock',
    market: item.market === 'US' ? 'US' : 'KR',
    timeframe: TIMEFRAMES.has(timeframe) ? timeframe as ScannerSavedSearch['timeframe'] : '1D',
    selected,
    preset: typeof item.preset === 'string' && item.preset.trim() ? item.preset.trim() : null,
    volumeThreshold: numberInRange(item.volumeThreshold, 1, 10_000, 150),
    tradingValueThreshold: numberInRange(item.tradingValueThreshold, 1, 10_000, 150),
    volumeLookbackDays: Math.round(numberInRange(item.volumeLookbackDays, 1, 250, 5)),
    tradingValueLookbackDays: Math.round(numberInRange(item.tradingValueLookbackDays, 1, 250, 5)),
    marketCapThreshold: numberInRange(item.marketCapThreshold, 0, Number.MAX_SAFE_INTEGER, 1_000_000_000),
    minimumScore: Math.round(numberInRange(item.minimumScore, 0, 100, 0)),
    maximumRiskScore: Math.round(numberInRange(item.maximumRiskScore, 0, 100, 100)),
    createdAt: Number.isFinite(Date.parse(String(item.createdAt ?? ''))) ? String(item.createdAt) : now,
    updatedAt: Number.isFinite(Date.parse(String(item.updatedAt ?? ''))) ? String(item.updatedAt) : now,
  };
}

export function parseScannerSavedSearches(raw: string | null | undefined) {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .map(normalize)
      .filter((item): item is ScannerSavedSearch => Boolean(item))
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .slice(0, 20);
  } catch {
    return [];
  }
}

export function loadScannerSavedSearches(storage: Pick<Storage, 'getItem'> = window.localStorage) {
  return parseScannerSavedSearches(storage.getItem(SCANNER_SAVED_SEARCHES_KEY));
}

export function writeScannerSavedSearches(
  items: ScannerSavedSearch[],
  storage: Pick<Storage, 'setItem'> = window.localStorage,
) {
  const normalized = parseScannerSavedSearches(JSON.stringify(items));
  storage.setItem(SCANNER_SAVED_SEARCHES_KEY, JSON.stringify(normalized));
  return normalized;
}

export function updateScannerSavedSearch(
  items: ScannerSavedSearch[],
  id: string,
  patch: Partial<ScannerSavedSearch>,
  now = new Date(),
) {
  const current = items.find((item) => item.id === id);
  if (!current) return items;
  const next = normalize({ ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: now.toISOString() });
  if (!next) return items;
  return items.map((item) => item.id === id ? next : item);
}

export function deleteScannerSavedSearch(items: ScannerSavedSearch[], id: string) {
  return items.filter((item) => item.id !== id);
}

export function resetScannerSearchStorage(storage: Pick<Storage, 'removeItem'>) {
  storage.removeItem(SCANNER_SAVED_SEARCHES_KEY);
  storage.removeItem(SCANNER_THRESHOLD_KEY);
  storage.removeItem(SCANNER_MARKET_KEY);
}
