import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api, ApiError, type Timeframe, type MarketKey } from '@/lib/api';

// Don't retry deterministic 404s (unknown ticker).
const retry = (count: number, err: unknown) => {
  if (err instanceof ApiError && err.status === 404) return false;
  return count < 2;
};

const MIN = 60 * 1000;

const STALE = {
  quote: 45 * 1000,
  chart: 3 * MIN,
  news: 8 * MIN,
  disclosures: 8 * MIN,
  risk: 6 * 60 * MIN,
  signals: 30 * MIN,
  analysis: 10 * MIN,
  financials: 24 * 60 * MIN,
  catalog: 24 * 60 * MIN,
} as const;

function chartRefetchInterval(tf: Timeframe): number {
  if (tf === '1m' || tf === '5m' || tf === '15m') return 30 * 1000;
  if (tf === '30m' || tf === '60m') return 60 * 1000;
  return 5 * MIN;
}

function scanRefetchInterval(indicators: string[]): number {
  const mode = indicators.includes('swing')
    ? 'swing'
    : indicators.includes('undervalued')
      ? 'undervalued'
      : 'day';

  if (mode === 'day') return 60 * 1000;
  if (mode === 'swing') return 5 * MIN;
  return 30 * MIN;
}

export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: api.config,
    staleTime: STALE.catalog,
    gcTime: STALE.catalog,
  });
}

export function useSearch(query: string) {
  const q = query.trim();

  return useQuery({
    queryKey: ['search', q],
    queryFn: () => api.search(q),
    enabled: q.length > 0,
    staleTime: STALE.catalog,
    placeholderData: keepPreviousData,
    retry,
  });
}

export function useMovers(market?: MarketKey, autoRefresh = false) {
  return useQuery({
    queryKey: ['movers', market ?? 'default'],
    queryFn: () => api.movers(market),
    staleTime: STALE.quote,
    refetchInterval: autoRefresh ? 60 * 1000 : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
    retry,
  });
}

export function useSummary() {
  return useQuery({
    queryKey: ['summary'],
    queryFn: api.summary,
    staleTime: STALE.quote,
    retry,
  });
}

export function useBriefing() {
  return useQuery({
    queryKey: ['briefing'],
    queryFn: api.briefing,
    staleTime: STALE.quote,
    retry,
  });
}

export function useUndervalued(market: MarketKey, enabled = true) {
  return useQuery({
    queryKey: ['undervalued', market],
    queryFn: () => api.undervalued(market),
    staleTime: 10 * MIN,
    enabled,
    retry,
  });
}

export function useAlertFeed(market: 'ALL' | 'KR' | 'US') {
  return useQuery({
    queryKey: ['alert-feed', market],
    queryFn: () => api.alertFeed(market),
    staleTime: 5 * MIN,
    placeholderData: keepPreviousData,
    retry,
  });
}

export function useQuotes(tickers: string[]) {
  return useQuery({
    queryKey: ['quotes', tickers.join(',')],
    queryFn: () => api.quotes(tickers),
    enabled: tickers.length > 0,
    staleTime: STALE.quote,
    retry,
  });
}

export function useOverview(ticker: string) {
  return useQuery({
    queryKey: ['overview', ticker],
    queryFn: () => api.overview(ticker),
    enabled: ticker.trim().length > 0,
    staleTime: STALE.quote,
    retry,
  });
}

export function useChart(ticker: string, tf: Timeframe, enabled: boolean) {
  const interval = chartRefetchInterval(tf);

  return useQuery({
    queryKey: ['chart', ticker, tf],
    queryFn: () => api.chart(ticker, tf),
    enabled: enabled && ticker.trim().length > 0,
    staleTime: STALE.chart,
    refetchInterval: enabled ? interval : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
    retry,
  });
}

export function useFinancials(ticker: string, enabled: boolean) {
  return useQuery({
    queryKey: ['financials', ticker],
    queryFn: () => api.financials(ticker),
    enabled: enabled && ticker.trim().length > 0,
    staleTime: STALE.financials,
    gcTime: STALE.financials,
    placeholderData: keepPreviousData,
    retry,
  });
}

export function useRisk(ticker: string, enabled: boolean) {
  return useQuery({
    queryKey: ['risk', ticker],
    queryFn: () => api.risk(ticker),
    enabled: enabled && ticker.trim().length > 0,
    staleTime: STALE.risk,
    placeholderData: keepPreviousData,
    retry,
  });
}

export function useDisclosures(ticker: string, enabled: boolean) {
  return useQuery({
    queryKey: ['disclosures', ticker],
    queryFn: () => api.disclosures(ticker),
    enabled: enabled && ticker.trim().length > 0,
    staleTime: STALE.disclosures,
    placeholderData: keepPreviousData,
    retry,
  });
}

export function useSignals(ticker: string, enabled: boolean) {
  return useQuery({
    queryKey: ['signals', ticker],
    queryFn: () => api.signals(ticker),
    enabled: enabled && ticker.trim().length > 0,
    staleTime: STALE.signals,
    placeholderData: keepPreviousData,
    retry,
  });
}

export function useScan(
  indicators: string[],
  market: string,
  autoRefresh = true,
) {
  const interval = scanRefetchInterval(indicators);

  return useQuery({
    queryKey: ['scan', market, [...indicators].sort().join(',')],
    queryFn: () => api.scan(indicators, market),
    enabled: market.trim().length > 0,
    staleTime: STALE.quote,
    refetchInterval: autoRefresh ? interval : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
    retry,
  });
}

export function useNews(ticker: string, enabled: boolean) {
  return useQuery({
    queryKey: ['news', ticker],
    queryFn: () => api.news(ticker),
    enabled: enabled && ticker.trim().length > 0,
    staleTime: STALE.news,
    placeholderData: keepPreviousData,
    retry,
  });
}

export function useAnalysis(ticker: string, enabled: boolean) {
  return useQuery({
    queryKey: ['analysis', ticker],
    queryFn: () => api.analysis(ticker),
    enabled: enabled && ticker.trim().length > 0,
    staleTime: STALE.analysis,
    placeholderData: keepPreviousData,
    retry,
  });
}