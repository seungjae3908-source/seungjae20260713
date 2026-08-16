import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type AnalysisAssetType = 'stock' | 'coin_spot' | 'coin_futures';
export type AnalysisMarket = 'KR' | 'US' | 'UPBIT' | 'BITGET';
export type AnalysisTradeAction = 'BUY' | 'SELL' | 'LONG' | 'SHORT' | 'NO_TRADE' | 'UNKNOWN' | 'NONE';

export type AnalysisPricePlan = {
  entryZone: { from: number; to: number } | null;
  invalidation: number | null;
  stopLoss: number | null;
  targets: number[];
  riskReward: number | null;
};

export type AnalysisSelection = {
  assetType: AnalysisAssetType;
  market: AnalysisMarket;
  symbol: string;
  ticker: string;
  displayName: string;
  timeframe: string;
  searchRunId?: string;
  signalScore?: number;
  signalRank?: number;
  confidence?: number;
  riskLevel?: string;
  action?: AnalysisTradeAction;
  pricePlan?: AnalysisPricePlan;
  matchedSignals?: string[];
  reasons?: string[];
  selectedAt: string;
};

const STORAGE_KEY = 'sa-analysis-selection-v1';

function finite(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finiteOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanString(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizePricePlan(value: unknown): AnalysisPricePlan | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  let entryZone: AnalysisPricePlan['entryZone'] = null;
  if (row.entryZone && typeof row.entryZone === 'object' && !Array.isArray(row.entryZone)) {
    const zone = row.entryZone as Record<string, unknown>;
    const from = finite(zone.from);
    const to = finite(zone.to);
    if (from != null && to != null && from > 0 && to > 0) {
      entryZone = { from: Math.min(from, to), to: Math.max(from, to) };
    }
  }
  const targets = Array.isArray(row.targets)
    ? row.targets.map((target) => finite(target)).filter((target): target is number => target != null && target > 0).slice(0, 6)
    : [];
  return {
    entryZone,
    invalidation: finiteOrNull(row.invalidation),
    stopLoss: finiteOrNull(row.stopLoss),
    targets,
    riskReward: finiteOrNull(row.riskReward),
  };
}

export function normalizeAnalysisSelection(value: unknown): AnalysisSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const assetType = row.assetType === 'coin_spot' || row.assetType === 'coin_futures'
    ? row.assetType
    : 'stock';
  const market = ['KR', 'US', 'UPBIT', 'BITGET'].includes(String(row.market))
    ? row.market as AnalysisMarket
    : null;
  const ticker = cleanString(row.ticker || row.symbol, 32).toUpperCase();
  if (!market || !ticker) return null;
  const textList = (item: unknown) => Array.isArray(item)
    ? item.map((part) => cleanString(part, 160)).filter(Boolean).slice(0, 20)
    : undefined;
  const action = ['BUY', 'SELL', 'LONG', 'SHORT', 'NO_TRADE', 'UNKNOWN', 'NONE'].includes(String(row.action))
    ? row.action as AnalysisTradeAction
    : undefined;
  return {
    assetType,
    market,
    symbol: cleanString(row.symbol || ticker, 32).toUpperCase(),
    ticker,
    displayName: cleanString(row.displayName || ticker, 120),
    timeframe: cleanString(row.timeframe || '1D', 12),
    searchRunId: cleanString(row.searchRunId, 80) || undefined,
    signalScore: finite(row.signalScore),
    signalRank: finite(row.signalRank),
    confidence: finite(row.confidence),
    riskLevel: cleanString(row.riskLevel, 40) || undefined,
    action,
    pricePlan: normalizePricePlan(row.pricePlan),
    matchedSignals: textList(row.matchedSignals),
    reasons: textList(row.reasons),
    selectedAt: cleanString(row.selectedAt, 40) || new Date().toISOString(),
  };
}

function readStoredSelection(): AnalysisSelection | null {
  if (typeof window === 'undefined') return null;
  try {
    return normalizeAnalysisSelection(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

export function selectionFromSearch(search: string): AnalysisSelection | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (!params.get('ticker') && !params.get('symbol')) return null;
  return normalizeAnalysisSelection({
    assetType: params.get('assetType'),
    market: params.get('market'),
    symbol: params.get('symbol'),
    ticker: params.get('ticker'),
    displayName: params.get('name'),
    timeframe: params.get('timeframe'),
    searchRunId: params.get('searchRunId'),
    selectedAt: new Date().toISOString(),
  });
}

export function selectionQuery(selection: AnalysisSelection): string {
  const params = new URLSearchParams({
    assetType: selection.assetType,
    market: selection.market,
    symbol: selection.symbol,
    ticker: selection.ticker,
    name: selection.displayName,
    timeframe: selection.timeframe,
  });
  if (selection.searchRunId) params.set('searchRunId', selection.searchRunId);
  return params.toString();
}

type AnalysisSelectionContextValue = {
  selection: AnalysisSelection | null;
  select: (selection: AnalysisSelection) => void;
  clear: () => void;
};

const AnalysisSelectionContext = createContext<AnalysisSelectionContextValue | null>(null);

export function AnalysisSelectionProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<AnalysisSelection | null>(readStoredSelection);
  const select = useCallback((next: AnalysisSelection) => {
    const normalized = normalizeAnalysisSelection(next);
    if (!normalized) return;
    setSelection(normalized);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  }, []);
  const clear = useCallback(() => {
    setSelection(null);
    window.localStorage.removeItem(STORAGE_KEY);
  }, []);
  const value = useMemo(() => ({ selection, select, clear }), [selection, select, clear]);
  return <AnalysisSelectionContext.Provider value={value}>{children}</AnalysisSelectionContext.Provider>;
}

export function useAnalysisSelection() {
  const value = useContext(AnalysisSelectionContext);
  if (!value) throw new Error('useAnalysisSelection must be used inside AnalysisSelectionProvider');
  return value;
}