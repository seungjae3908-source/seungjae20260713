export type ScannerSavedSearch = {
  id: string;
  name: string;
  assetClass: 'stock' | 'coin_spot' | 'coin_futures';
  market: string;
  symbols: string[];
  timeframe: '5m' | '15m' | '1H' | '4H' | '1D';
  selected: string[];
  alertEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ScannerSavedSearchStore = {
  revision: number;
  items: ScannerSavedSearch[];
};

export type ScannerSavedSearchMutation =
  | { ok: true; store: ScannerSavedSearchStore }
  | { ok: false; error: 'SAVED_SEARCH_CONFLICT' | 'SAVED_SEARCH_DUPLICATE' | 'SAVED_SEARCH_NOT_FOUND' | 'SAVED_SEARCH_INVALID' };

const TIMEFRAMES = new Set(['5m', '15m', '1H', '4H', '1D']);
const ASSET_CLASSES = new Set(['stock', 'coin_spot', 'coin_futures']);

export function scannerSavedSearchStorageKey(userId: string) {
  const normalized = userId.trim();
  if (!normalized) throw new Error('SAVED_SEARCH_USER_REQUIRED');
  return `sa-saved-searches-v2:${encodeURIComponent(normalized)}`;
}

function uniqueStrings(value: unknown, maximum = 40) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((item) => item.trim().toUpperCase()).filter(Boolean))].slice(0, maximum);
}

function normalize(value: unknown, now = new Date()): ScannerSavedSearch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = String(item.id ?? '').trim();
  const market = String(item.market ?? '').trim().toUpperCase();
  const assetClass = String(item.assetClass ?? '');
  const timeframe = String(item.timeframe ?? '');
  const selected = uniqueStrings(item.selected);
  const symbols = uniqueStrings(item.symbols, 100);
  if (!id || !market || !ASSET_CLASSES.has(assetClass) || !TIMEFRAMES.has(timeframe) || !selected.length) return null;
  const createdAt = Number.isFinite(Date.parse(String(item.createdAt ?? '')))
    ? String(item.createdAt)
    : now.toISOString();
  return {
    id,
    name: String(item.name ?? '').trim().slice(0, 80) || `${market} ${timeframe}`,
    assetClass: assetClass as ScannerSavedSearch['assetClass'],
    market,
    symbols,
    timeframe: timeframe as ScannerSavedSearch['timeframe'],
    selected,
    alertEnabled: item.alertEnabled === true,
    createdAt,
    updatedAt: Number.isFinite(Date.parse(String(item.updatedAt ?? '')))
      ? String(item.updatedAt)
      : now.toISOString(),
  };
}

function parse(raw: string | null | undefined): ScannerSavedSearchStore {
  try {
    const decoded = JSON.parse(raw ?? '{}') as { revision?: unknown; items?: unknown };
    const items = Array.isArray(decoded.items)
      ? decoded.items.map((item) => normalize(item)).filter((item): item is ScannerSavedSearch => Boolean(item))
      : [];
    const seen = new Set<string>();
    return {
      revision: Math.max(0, Math.trunc(Number(decoded.revision) || 0)),
      items: items.filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }).slice(0, 50),
    };
  } catch {
    return { revision: 0, items: [] };
  }
}

export function loadScannerSavedSearchStore(
  userId: string,
  storage: Pick<Storage, 'getItem'> = window.localStorage,
) {
  return parse(storage.getItem(scannerSavedSearchStorageKey(userId)));
}

export function scannerSavedSearchFingerprint(item: ScannerSavedSearch) {
  return [
    item.assetClass,
    item.market,
    [...item.symbols].sort().join(','),
    item.timeframe,
    [...item.selected].sort().join(','),
  ].join('|');
}

function commit(
  userId: string,
  expectedRevision: number,
  items: ScannerSavedSearch[],
  storage: Pick<Storage, 'getItem' | 'setItem'>,
): ScannerSavedSearchMutation {
  const current = loadScannerSavedSearchStore(userId, storage);
  if (current.revision !== expectedRevision) return { ok: false, error: 'SAVED_SEARCH_CONFLICT' };
  const store = { revision: current.revision + 1, items };
  storage.setItem(scannerSavedSearchStorageKey(userId), JSON.stringify(store));
  return { ok: true, store };
}

export function saveScannerSavedSearch(
  userId: string,
  expectedRevision: number,
  candidate: ScannerSavedSearch,
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage,
  now = new Date(),
): ScannerSavedSearchMutation {
  const next = normalize(candidate, now);
  if (!next) return { ok: false, error: 'SAVED_SEARCH_INVALID' };
  const current = loadScannerSavedSearchStore(userId, storage);
  const fingerprint = scannerSavedSearchFingerprint(next);
  if (current.items.some((item) => item.id !== next.id && scannerSavedSearchFingerprint(item) === fingerprint)) {
    return { ok: false, error: 'SAVED_SEARCH_DUPLICATE' };
  }
  const existing = current.items.find((item) => item.id === next.id);
  const saved = { ...next, createdAt: existing?.createdAt ?? next.createdAt, updatedAt: now.toISOString() };
  const items = existing
    ? current.items.map((item) => item.id === saved.id ? saved : item)
    : [saved, ...current.items].slice(0, 50);
  return commit(userId, expectedRevision, items, storage);
}

export function deleteScannerSavedSearch(
  userId: string,
  expectedRevision: number,
  id: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage,
): ScannerSavedSearchMutation {
  const current = loadScannerSavedSearchStore(userId, storage);
  if (!current.items.some((item) => item.id === id)) return { ok: false, error: 'SAVED_SEARCH_NOT_FOUND' };
  return commit(userId, expectedRevision, current.items.filter((item) => item.id !== id), storage);
}
