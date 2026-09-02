import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  PatternAwareUnifiedChartCanvas,
  type PatternAwareUnifiedChartCanvasHandle,
} from '@/components/pattern-aware-unified-chart-canvas';
import { SelectedCandleDetailPanel } from '@/components/selected-candle-detail';
import { api } from '@/lib/api';
import { authorizedFetch } from '@/lib/auth-fetch';
import { createAiChartPublicStreamClient } from '@/lib/ai-chart-public-stream-client';
import {
  aiChartStreamIdentityKey,
  createAiChartStreamReduction,
  reconcileAiChartPublicTrades,
  type AiChartPublicStreamMarket,
  type AiChartPublicStreamStatus,
  type AiChartStreamIntegrityIssue,
} from '@/lib/ai-chart-public-stream';
import {
  buildChartAnalysis,
  shouldAppendTimeline,
  type ChartAnalysis,
} from '@/lib/chart-analysis';
import type { NormalizedChartCandle } from '@/lib/chart-candle-normalizer';
import {
  computeChartIndicators,
  type ChartIndicatorResult,
} from '@/lib/chart-indicator-engine';
import { analyzeChartStructure } from '@/lib/chart-structure-engine';
import {
  UNIFIED_CHART_TIMEFRAMES,
  UnifiedChartDataError,
  defaultUnifiedSymbol,
  fetchUnifiedChartData,
  marketAssetType,
  normalizeUnifiedSymbol,
  unifiedChartDataStatus,
  unifiedMarketLabel,
  type UnifiedChartData,
  type UnifiedChartTimeframe,
} from '@/lib/unified-chart-data';
import type { AnalysisMarket, AnalysisSelection } from '@/lib/analysis-selection';
import { cn } from '@/lib/utils';

type OverlayKey =
  | 'sma5'
  | 'sma20'
  | 'sma60'
  | 'sma120'
  | 'ema12'
  | 'ema26'
  | 'bollinger'
  | 'vwap'
  | 'volume'
  | 'levels'
  | 'markers'
  | 'rsi'
  | 'macd'
  | 'atr';

type SearchCandidate = {
  symbol: string;
  name: string;
  market: AnalysisMarket;
  price: number | null;
  changePercent: number | null;
};

type PriceLevels = {
  support: number;
  support2: number;
  resistance: number;
  resistance2: number;
  targetReference: number;
  invalidationReference: number;
};

type TimelineItem = {
  key: string;
  analysis: ChartAnalysis;
};

type Props = {
  selection: AnalysisSelection;
  onSelectionChange: (selection: AnalysisSelection) => void;
  onAnalysisChange?: (analysis: ChartAnalysis | null) => void;
};

type AiChartRealtimeHealth = {
  transportMode: 'STREAM' | 'POLLING';
  connectionState: AiChartPublicStreamStatus | 'REST_ONLY' | 'POLLING_PAUSED' | 'REST_BOOTSTRAP';
  dataStatus: 'LIVE' | 'DEGRADED' | 'RECOVERING' | 'STALE' | 'UNAVAILABLE';
  provider: string;
  symbol: string;
  timeframe: UnifiedChartTimeframe;
  lastValidEventAt: number | null;
  recoveryState: string;
  integrityIssues: AiChartStreamIntegrityIssue[];
};

const EMPTY_CANDLES: NormalizedChartCandle[] = [];
const MARKET_OPTIONS: Array<{ key: AnalysisMarket; label: string }> = [
  { key: 'KR', label: '국내주식' },
  { key: 'US', label: '미국주식' },
  { key: 'UPBIT', label: '코인 현물' },
  { key: 'BITGET', label: '코인 선물' },
];
const OVERLAY_OPTIONS: Array<{ key: OverlayKey; label: string }> = [
  { key: 'sma5', label: 'SMA5' },
  { key: 'sma20', label: 'SMA20' },
  { key: 'sma60', label: 'SMA60' },
  { key: 'sma120', label: 'SMA120' },
  { key: 'ema12', label: 'EMA12' },
  { key: 'ema26', label: 'EMA26' },
  { key: 'bollinger', label: '볼린저밴드' },
  { key: 'vwap', label: 'VWAP' },
  { key: 'volume', label: '거래량' },
  { key: 'levels', label: '지지·저항' },
  { key: 'markers', label: '분석 마커' },
  { key: 'rsi', label: 'RSI' },
  { key: 'macd', label: 'MACD' },
  { key: 'atr', label: 'ATR' },
];
const DEFAULT_OVERLAYS: Record<OverlayKey, boolean> = {
  sma5: true,
  sma20: true,
  sma60: false,
  sma120: false,
  ema12: false,
  ema26: false,
  bollinger: false,
  vwap: false,
  volume: true,
  levels: true,
  markers: true,
  rsi: true,
  macd: true,
  atr: true,
};
const OVERLAY_STORAGE_KEY = 'unified-analysis-chart-overlays.v1';

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadOverlays(): Record<OverlayKey, boolean> {
  if (typeof window === 'undefined') return DEFAULT_OVERLAYS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(OVERLAY_STORAGE_KEY) ?? '{}') as Partial<Record<OverlayKey, boolean>>;
    return { ...DEFAULT_OVERLAYS, ...parsed };
  } catch {
    return DEFAULT_OVERLAYS;
  }
}

function persistOverlays(overlays: Record<OverlayKey, boolean>): Record<OverlayKey, boolean> {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(overlays));
  }
  return overlays;
}

function formatPrice(value: number | null | undefined, market: AnalysisMarket): string {
  if (value == null || !Number.isFinite(value)) return '-';
  if (market === 'US') {
    return `$${value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (market === 'BITGET') {
    return `${value.toLocaleString('ko-KR', { maximumFractionDigits: value >= 1000 ? 2 : 8 })} USDT`;
  }
  return `${value.toLocaleString('ko-KR', { maximumFractionDigits: value >= 1000 ? 0 : 8 })}원`;
}

function formatPlanPrice(value: number | null | undefined, market: AnalysisMarket): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '미확인';
  return formatPrice(value, market);
}

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatDataAge(data: UnifiedChartData | undefined): string {
  const value = data?.updatedAt ?? data?.fetchedAt;
  if (!value) return '미확인';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '미확인';
  const ageMs = Math.max(0, Date.now() - timestamp);
  if (ageMs < 1_000) return '<1초';
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}초`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}분`;
  return `${(ageMs / 3_600_000).toFixed(1)}시간`;
}

function scannerActionLabel(action: AnalysisSelection['action']): string {
  if (action === 'BUY') return '매수';
  if (action === 'SELL') return '매도 참고';
  if (action === 'LONG') return '롱';
  if (action === 'SHORT') return '숏';
  if (action === 'NO_TRADE' || action === 'NONE') return '거래 안 함';
  return '미확인';
}

function dataStatusLabel(status: ReturnType<typeof unifiedChartDataStatus>): string {
  return {
    ok: '정상',
    delayed: '지연',
    stale: '오래된 데이터',
    insufficient: '데이터 부족',
    unavailable: '연결 오류',
  }[status];
}

function dataStatusClass(status: ReturnType<typeof unifiedChartDataStatus>): string {
  if (status === 'ok') return 'border-positive/30 bg-positive/10 text-positive';
  if (status === 'delayed' || status === 'stale') return 'border-warning/30 bg-warning/10 text-warning';
  return 'border-destructive/30 bg-destructive/10 text-destructive';
}

async function searchCandidates(
  market: AnalysisMarket,
  query: string,
  signal?: AbortSignal,
): Promise<SearchCandidate[]> {
  const needle = query.trim().toUpperCase();
  if (!needle) return [];

  if (market === 'KR' || market === 'US') {
    const payload = await api.searchRows(query);
    return payload.results
      .filter((row) => row.market === market)
      .map((row) => ({
        symbol: row.ticker,
        name: row.name,
        market,
        price: finite(row.price),
        changePercent: finite(row.changePercent),
      }))
      .slice(0, 20);
  }

  const url = market === 'UPBIT'
    ? '/api/crypto/spot/markets'
    : '/api/crypto/futures/tickers';
  const response = await authorizedFetch(url, { cache: 'no-store', signal });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.message ?? payload.error ?? `HTTP ${response.status}`));

  if (market === 'UPBIT') {
    const rows = Array.isArray(payload.markets) ? payload.markets as Record<string, unknown>[] : [];
    return rows
      .map((row) => ({
        symbol: normalizeUnifiedSymbol('UPBIT', row.symbol ?? row.market),
        name: String(row.koreanName ?? row.englishName ?? row.symbol ?? ''),
        market,
        price: null,
        changePercent: null,
      }))
      .filter((row) => row.symbol && `${row.symbol} ${row.name}`.toUpperCase().includes(needle))
      .slice(0, 30);
  }

  const rows = Array.isArray(payload.tickers) ? payload.tickers as Record<string, unknown>[] : [];
  return rows
    .map((row) => ({
      symbol: normalizeUnifiedSymbol('BITGET', row.symbol),
      name: String(row.symbol ?? ''),
      market,
      price: finite(row.markPrice ?? row.price),
      changePercent: finite(row.changePercent24h ?? row.changePercent),
    }))
    .filter((row) => row.symbol.includes(needle))
    .slice(0, 30);
}

function computeLevels(candles: NormalizedChartCandle[], indicators: ChartIndicatorResult): PriceLevels | null {
  const latest = candles.at(-1);
  if (!latest) return null;
  const history = candles.filter((row) => row.isClosed).slice(-100, -1);
  const fallback = Math.max(indicators.latest?.atr14 ?? 0, latest.close * 0.008);
  const lows = history.map((row) => row.low).filter((price) => price < latest.close).sort((a, b) => b - a);
  const highs = history.map((row) => row.high).filter((price) => price > latest.close).sort((a, b) => a - b);
  const support = lows[0] ?? latest.close - fallback;
  const support2 = lows.find((price) => price < support * 0.995) ?? support - fallback;
  const resistance = highs[0] ?? latest.close + fallback;
  const resistance2 = highs.find((price) => price > resistance * 1.005) ?? resistance + fallback;
  const risk = Math.max(latest.close - support, fallback);
  return {
    support,
    support2,
    resistance,
    resistance2,
    targetReference: Math.max(resistance2, latest.close + risk * 1.8),
    invalidationReference: Math.max(Number.EPSILON, Math.min(support, latest.close - risk)),
  };
}

function buildCurrentAnalysis(input: {
  selection: AnalysisSelection;
  data: UnifiedChartData;
  indicators: ChartIndicatorResult;
  levels: PriceLevels;
  previous: ChartAnalysis | null;
}): ChartAnalysis | null {
  const candles = input.data.normalization.candles;
  const latest = candles.at(-1);
  const previousCandle = candles.at(-2);
  if (!latest || !previousCandle) return null;
  const current = input.indicators.latest;
  const structure = analyzeChartStructure(candles);
  const pattern = structure.patterns
    .filter((item) => item.status !== 'expired')
    .sort((left, right) => right.updatedAtTime - left.updatedAtTime)[0];
  const trend = structure.marketStructure.trend === 'bullish'
    ? '상승'
    : structure.marketStructure.trend === 'bearish'
      ? '하락'
      : current?.sma5 != null && current.sma20 != null
        ? current.sma5 > current.sma20 ? '상승' : current.sma5 < current.sma20 ? '하락' : '중립'
        : '중립';
  const volumeRatio = current?.volumeRatio20 ?? 1;
  const bullishMomentum = trend === '상승' && (current?.macdHistogram == null || current.macdHistogram >= 0);
  const bearishMomentum = trend === '하락' && (current?.macdHistogram == null || current.macdHistogram <= 0);
  const dataStatus = unifiedChartDataStatus(input.data, false);
  const directionalSignal = pattern?.status === 'candidate'
    ? 'WATCH'
    : pattern?.bias === 'bullish'
      ? 'HOLD'
      : pattern?.bias === 'bearish'
        ? 'EXIT'
        : bullishMomentum
          ? 'HOLD'
          : bearishMomentum
            ? 'EXIT'
            : 'WATCH';
  const signal = dataStatus === 'ok' ? directionalSignal : 'WATCH';
  const technicalScore = Math.max(20, Math.min(92, Math.round(
    45 +
    (trend === '중립' ? 0 : 12) +
    (pattern ? 15 : 0) +
    Math.min(12, Math.max(0, (volumeRatio - 1) * 12)) +
    (latest.isClosed ? 8 : -8),
  )));
  const patternText = pattern
    ? `${pattern.label} ${pattern.status === 'confirmed' ? '확정' : pattern.status === 'invalidated' ? '무효화' : '후보'}`
    : null;
  const title = patternText ?? (trend === '상승' ? '상승 구조 관찰' : trend === '하락' ? '하락 구조 관찰' : '방향 확인 중');
  const summary = dataStatus !== 'ok'
    ? `데이터 상태가 ${dataStatusLabel(dataStatus)}이므로 방향 신호를 강행하지 않고 WATCH로 제한합니다.`
    : pattern
      ? pattern.status === 'confirmed'
        ? `${pattern.label}이 완료된 봉 기준으로 확인됐습니다. 넥라인과 무효화 기준을 함께 확인하세요.`
        : pattern.status === 'invalidated'
          ? `${pattern.label} 후보가 기준 가격을 벗어나 무효화됐습니다.`
          : `${pattern.label} 후보가 감지됐지만 넥라인 확인 전이므로 확정으로 판단하지 않습니다.`
      : `${input.selection.timeframe} 기준 ${trend} 구조입니다. 현재가 ${latest.close}, 지지 ${input.levels.support}, 저항 ${input.levels.resistance}를 기준으로 다음 완료봉을 확인합니다.`;
  const anchors = pattern?.anchorPivots ?? [];

  return buildChartAnalysis({
    symbol: input.selection.ticker,
    market: input.selection.market,
    timeframe: input.selection.timeframe,
    latestTime: latest.time,
    currentPrice: latest.close,
    previousClose: previousCandle.close,
    trend,
    rsi: current?.rsi14 ?? null,
    macd: current?.macd ?? null,
    volumeRatio,
    support: pattern?.type === 'double-top' ? pattern.neckline : pattern?.type === 'double-bottom' ? pattern.invalidationLevel : input.levels.support,
    resistance: pattern?.type === 'double-bottom' ? pattern.neckline : pattern?.type === 'double-top' ? pattern.invalidationLevel : input.levels.resistance,
    signal,
    confidence: technicalScore,
    title,
    summary,
    patterns: patternText ? [patternText] : [],
    source: input.data.provider,
    isClosedCandle: latest.isClosed,
    anchorTimes: anchors.map((pivot) => pivot.time),
    anchorPoints: anchors.map((pivot) => ({ time: pivot.time, price: pivot.price, role: pivot.kind })),
    previousAnalysis: input.previous,
    dataStatus,
    engineVersion: 'unified-chart-v3-evidence-truth-v1',
  });
}

export function UnifiedAnalysisChart({ selection, onSelectionChange, onAnalysisChange }: Props) {
  const market = selection.market;
  const timeframe = (UNIFIED_CHART_TIMEFRAMES.some((item) => item.key === selection.timeframe) ? selection.timeframe : '5m') as UnifiedChartTimeframe;
  const [draft, setDraft] = useState(selection.ticker);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [live, setLive] = useState(true);
  const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>(loadOverlays);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [inputError, setInputError] = useState('');
  const [selectedCandleTime, setSelectedCandleTime] = useState<number | null>(null);
  const streamMarket: AiChartPublicStreamMarket | null = market === 'UPBIT' || market === 'BITGET' ? market : null;
  const [realtimeHealth, setRealtimeHealth] = useState<AiChartRealtimeHealth>({
    transportMode: 'POLLING',
    connectionState: 'REST_BOOTSTRAP',
    dataStatus: 'UNAVAILABLE',
    provider: 'REST',
    symbol: selection.ticker,
    timeframe,
    lastValidEventAt: null,
    recoveryState: 'BOOTSTRAP_REQUIRED',
    integrityIssues: [],
  });
  const streamGenerationRef = useRef(0);
  const realtimeCanvasRef = useRef<PatternAwareUnifiedChartCanvasHandle | null>(null);
  const previousAnalysisRef = useRef<ChartAnalysis | null>(null);

  useEffect(() => {
    setDraft(selection.ticker);
    setQuery('');
    setSearchOpen(false);
    setTimeline([]);
    setSelectedCandleTime(null);
    previousAnalysisRef.current = null;
    onAnalysisChange?.(null);
  }, [selection.market, selection.ticker, selection.timeframe, onAnalysisChange]);

  const searchQuery = useQuery({
    queryKey: ['unified-chart-search', market, query.trim()],
    queryFn: ({ signal }) => searchCandidates(market, query, signal),
    enabled: query.trim().length > 0,
    staleTime: 30_000,
    retry: 1,
  });
  const streamOwnsTransport = live && streamMarket != null && (
    realtimeHealth.connectionState === 'CONNECTING'
    || realtimeHealth.connectionState === 'WAITING_FIRST_EVENT'
    || realtimeHealth.connectionState === 'LIVE_STREAM'
    || realtimeHealth.connectionState === 'RECOVERING'
  );
  const chartQuery = useQuery({
    queryKey: ['unified-chart-data', market, selection.ticker, timeframe],
    queryFn: ({ signal }) => fetchUnifiedChartData({ market, symbol: selection.ticker, timeframe, signal }),
    enabled: Boolean(selection.ticker),
    refetchInterval: live && !streamOwnsTransport ? (timeframe === '1D' ? 30_000 : 8_000) : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: (failureCount, error) => {
      if (failureCount >= 1) return false;
      if (error instanceof UnifiedChartDataError) return error.retryable && error.kind !== 'aborted';
      return true;
    },
  });


  useEffect(() => {
    const generation = streamGenerationRef.current + 1;
    streamGenerationRef.current = generation;
    const symbol = normalizeUnifiedSymbol(market, selection.ticker);

    if (!live) {
      setRealtimeHealth({
        transportMode: 'POLLING',
        connectionState: 'POLLING_PAUSED',
        dataStatus: 'UNAVAILABLE',
        provider: 'REST',
        symbol,
        timeframe,
        lastValidEventAt: null,
        recoveryState: 'PAUSED_BY_USER',
        integrityIssues: [],
      });
      return;
    }

    if (!streamMarket) {
      setRealtimeHealth({
        transportMode: 'POLLING',
        connectionState: 'REST_ONLY',
        dataStatus: chartQuery.data ? 'DEGRADED' : 'UNAVAILABLE',
        provider: chartQuery.data?.provider ?? 'REST',
        symbol,
        timeframe,
        lastValidEventAt: null,
        recoveryState: 'PUBLIC_STREAM_NOT_SUPPORTED_FOR_MARKET',
        integrityIssues: [],
      });
      return;
    }

    const bootstrap = chartQuery.data;
    if (!bootstrap || bootstrap.normalization.candles.length < 2 || !symbol) {
      setRealtimeHealth({
        transportMode: 'POLLING',
        connectionState: 'REST_BOOTSTRAP',
        dataStatus: 'UNAVAILABLE',
        provider: bootstrap?.provider ?? 'REST',
        symbol,
        timeframe,
        lastValidEventAt: null,
        recoveryState: 'VALID_BOOTSTRAP_REQUIRED',
        integrityIssues: [],
      });
      return;
    }

    const identityKey = aiChartStreamIdentityKey({ market: streamMarket, symbol, timeframe, generation });
    const bootstrapCutoffMs = Date.now();
    let reduction = createAiChartStreamReduction(bootstrap.normalization.candles);
    let lastValidEventAt: number | null = null;
    let recoveryRequested = false;

    const requestRecovery = (issues: AiChartStreamIntegrityIssue[], reason: string) => {
      if (streamGenerationRef.current !== generation) return;
      setRealtimeHealth({
        transportMode: 'STREAM',
        connectionState: 'RECOVERING',
        dataStatus: 'RECOVERING',
        provider: streamMarket === 'UPBIT' ? 'UPBIT_PUBLIC' : 'BITGET_PUBLIC',
        symbol,
        timeframe,
        lastValidEventAt,
        recoveryState: reason,
        integrityIssues: issues,
      });
      if (recoveryRequested) return;
      recoveryRequested = true;
      void chartQuery.refetch();
    };

    const client = createAiChartPublicStreamClient({
      market: streamMarket,
      symbol,
      onStatus: (status, reason) => {
        if (streamGenerationRef.current !== generation) return;
        if (status === 'RECOVERING') {
          requestRecovery([], reason);
          return;
        }
        setRealtimeHealth({
          transportMode: status === 'FALLBACK_POLLING' || status === 'DISCONNECTED' ? 'POLLING' : 'STREAM',
          connectionState: status,
          dataStatus: status === 'LIVE_STREAM'
            ? 'LIVE'
            : status === 'FALLBACK_POLLING'
              ? 'DEGRADED'
              : 'UNAVAILABLE',
          provider: streamMarket === 'UPBIT' ? 'UPBIT_PUBLIC' : 'BITGET_PUBLIC',
          symbol,
          timeframe,
          lastValidEventAt,
          recoveryState: reason,
          integrityIssues: [],
        });
      },
      onDiagnostic: (diagnostic) => {
        if (streamGenerationRef.current !== generation) return;
        if (diagnostic.reason === 'STREAM_DELAYED') {
          setRealtimeHealth((current) => current.dataStatus === 'DEGRADED'
            ? current
            : {
                ...current,
                dataStatus: 'DEGRADED',
                recoveryState: 'MARKET_EVENT_DELAYED',
                lastValidEventAt: diagnostic.lastEventAtMs,
              });
        } else if (diagnostic.reason === 'PUBLIC_TRADE_BATCH') {
          setRealtimeHealth((current) => current.dataStatus === 'LIVE'
            ? current
            : {
                ...current,
                dataStatus: 'LIVE',
                recoveryState: 'INTEGRITY_REVALIDATED',
                lastValidEventAt: diagnostic.lastEventAtMs,
                integrityIssues: [],
              });
        }
      },
      onTrades: (events) => {
        if (
          streamGenerationRef.current !== generation
          || recoveryRequested
          || identityKey !== aiChartStreamIdentityKey({ market: streamMarket, symbol, timeframe, generation })
        ) {
          return false;
        }
        const reconciled = reconcileAiChartPublicTrades({
          previous: reduction,
          events: [...events],
          market: streamMarket,
          symbol,
          timeframe,
          bootstrapCutoffMs,
        });
        if (reconciled.needsSnapshot) {
          requestRecovery(reconciled.integrityIssues, 'REST_STREAM_RECONCILIATION_REQUIRED');
          return false;
        }
        if (reconciled.acceptedEvents === 0 || !reconciled.latestCandle) return false;
        if (!realtimeCanvasRef.current?.applyRealtimeCandle(reconciled.latestCandle)) {
          requestRecovery(['INVALID_EVENT_VALUE'], 'INCREMENTAL_CHART_UPDATE_REJECTED');
          return false;
        }
        reduction = reconciled.reduction;
        lastValidEventAt = events.reduce(
          (latest, event) => Math.max(latest, event.eventTimeMs),
          lastValidEventAt ?? 0,
        );
        return true;
      },
    });

    client.start();
    return () => {
      if (streamGenerationRef.current === generation) streamGenerationRef.current += 1;
      client.stop();
    };
  }, [chartQuery.data, chartQuery.dataUpdatedAt, chartQuery.refetch, live, market, selection.ticker, streamMarket, timeframe]);

  const candles = chartQuery.data?.normalization.candles ?? EMPTY_CANDLES;
  const indicators = useMemo(() => computeChartIndicators(candles), [candles]);
  const levels = useMemo(() => computeLevels(candles, indicators), [candles, indicators]);
  const analysis = useMemo(() => {
    if (!chartQuery.data || !levels || candles.length < 2) return null;
    return buildCurrentAnalysis({
      selection: { ...selection, timeframe },
      data: chartQuery.data,
      indicators,
      levels,
      previous: previousAnalysisRef.current,
    });
  }, [candles.length, chartQuery.data, indicators, levels, selection, timeframe]);

  useEffect(() => {
    if (selectedCandleTime != null && !candles.some((candle) => candle.time === selectedCandleTime)) {
      setSelectedCandleTime(null);
    }
  }, [candles, selectedCandleTime]);

  useEffect(() => {
    if (!analysis) {
      onAnalysisChange?.(null);
      return;
    }
    const previous = previousAnalysisRef.current;
    previousAnalysisRef.current = analysis;
    onAnalysisChange?.(analysis);
    if (!shouldAppendTimeline(previous, analysis)) return;
    const key = `${analysis.id}:${analysis.status}:${Math.floor(analysis.confidence / 10)}`;
    setTimeline((current) => [{ key, analysis }, ...current.filter((item) => item.key !== key)].slice(0, 30));
  }, [analysis, onAnalysisChange]);

  const commitSelection = useCallback((candidate: {
    market: AnalysisMarket;
    symbol: string;
    name: string;
    timeframe?: UnifiedChartTimeframe;
  }) => {
    const symbol = normalizeUnifiedSymbol(candidate.market, candidate.symbol);
    if (!symbol) {
      setInputError('유효한 종목 심볼을 입력하세요.');
      return;
    }
    const nextTimeframe = candidate.timeframe ?? timeframe;
    const sameScannerAsset = selection.market === candidate.market
      && selection.ticker === symbol;
    setInputError('');
    onSelectionChange({
      ...selection,
      assetType: marketAssetType(candidate.market),
      market: candidate.market,
      symbol,
      ticker: symbol,
      displayName: candidate.name.trim() || symbol,
      timeframe: nextTimeframe,
      searchRunId: sameScannerAsset ? selection.searchRunId : undefined,
      signalScore: sameScannerAsset ? selection.signalScore : undefined,
      signalRank: sameScannerAsset ? selection.signalRank : undefined,
      confidence: sameScannerAsset ? selection.confidence : undefined,
      riskLevel: sameScannerAsset ? selection.riskLevel : undefined,
      action: sameScannerAsset ? selection.action : undefined,
      pricePlan: sameScannerAsset ? selection.pricePlan : undefined,
      matchedSignals: sameScannerAsset ? selection.matchedSignals : undefined,
      reasons: sameScannerAsset ? selection.reasons : undefined,
      selectedAt: sameScannerAsset ? selection.selectedAt : new Date().toISOString(),
    });
  }, [onSelectionChange, selection, timeframe]);

  const handleCandleSelect = useCallback((time: number) => {
    setSelectedCandleTime(time);
  }, []);
  const changeMarket = (nextMarket: AnalysisMarket) => {
    if (nextMarket === market) return;
    const fallback = defaultUnifiedSymbol(nextMarket);
    commitSelection({ market: nextMarket, symbol: fallback.symbol, name: fallback.displayName, timeframe });
  };
  const submitDraft = () => {
    const normalizedDraft = normalizeUnifiedSymbol(market, draft);
    const displayName = normalizedDraft === selection.ticker ? selection.displayName : draft;
    commitSelection({ market, symbol: draft, name: displayName, timeframe });
    setQuery('');
    setSearchOpen(false);
  };
  const changeTimeframe = (nextTimeframe: UnifiedChartTimeframe) => commitSelection({
    market,
    symbol: selection.ticker,
    name: selection.displayName,
    timeframe: nextTimeframe,
  });
  const toggleOverlay = (key: OverlayKey) => setOverlays((current) => persistOverlays({ ...current, [key]: !current[key] }));

  const dataStatus = unifiedChartDataStatus(chartQuery.data, chartQuery.isError);
  const latest = candles.at(-1);
  const currentIndicator = indicators.latest;
  const searchRows = searchQuery.data ?? [];
  const warnings = chartQuery.data?.normalization.warnings ?? [];
  const errorMessage = chartQuery.error instanceof Error ? chartQuery.error.message : '차트 데이터를 불러오지 못했습니다.';
  const pricePlan = selection.pricePlan;
  const entryText = pricePlan?.entryZone
    ? `${formatPlanPrice(pricePlan.entryZone.from, market)} ~ ${formatPlanPrice(pricePlan.entryZone.to, market)}`
    : '미확인';

  return (
    <div className="space-y-4" data-testid="unified-analysis-chart">
      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-[11px] font-extrabold text-primary">시장·종목 선택</p><h2 className="mt-1 text-base font-black">실제 차트 데이터</h2></div>
          <button
            type="button"
            aria-label={live ? '자동 갱신 중' : '갱신 일시정지'}
            data-testid="chart-stream-status"
            onClick={() => setLive((current) => !current)}
            className={cn('rounded-full border px-3 py-1.5 text-xs font-extrabold', live ? 'border-warning/30 bg-warning/10 text-warning' : 'border-card-border bg-background text-muted-foreground')}
          >
            {live ? 'FALLBACK POLLING' : 'POLLING PAUSED'}
          </button>
        </div>
        <p className="mt-2 text-[10px] font-bold text-muted-foreground">현재 AI Chart 데이터 transport는 WebSocket이 아니라 REST polling입니다. 실제 streaming 연결이 검증되기 전에는 LIVE STREAM으로 표시하지 않습니다.</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {MARKET_OPTIONS.map((item) => (
            <button key={item.key} type="button" data-testid={`market-${item.key}`} onClick={() => changeMarket(item.key)} className={cn('rounded-xl border px-2 py-2 text-xs font-black', market === item.key ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-background text-muted-foreground')}>{item.label}</button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-card-border bg-background px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              value={draft}
              onChange={(event) => {
                const value = event.target.value;
                setDraft(value);
                setQuery(value);
                setSearchOpen(Boolean(value.trim()));
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitDraft();
                }
              }}
              aria-label="차트 종목 심볼"
              placeholder="종목명·심볼 검색"
              className="h-11 min-w-0 flex-1 bg-transparent text-sm font-bold outline-none"
            />
            {draft && <button type="button" aria-label="심볼 지우기" onClick={() => { setDraft(''); setQuery(''); setSearchOpen(false); }}><X className="h-4 w-4 text-muted-foreground" /></button>}
          </label>
          <button type="button" data-testid="apply-chart-symbol" onClick={submitDraft} className="shrink-0 rounded-2xl bg-primary px-4 text-xs font-black text-primary-foreground">적용</button>
        </div>
        {inputError && <p role="alert" className="mt-2 text-xs font-bold text-destructive">{inputError}</p>}
        {searchOpen && (
          <div data-testid="chart-symbol-search-results" className="mt-2 rounded-2xl border border-card-border bg-background p-2">
            <div className="max-h-60 overflow-y-auto">
              {searchQuery.isLoading ? <Centered><Loader2 className="h-4 w-4 animate-spin" /> 검색 중</Centered> : searchQuery.isError ? <p role="alert" className="p-4 text-center text-xs font-bold text-destructive">검색 데이터를 불러오지 못했습니다.</p> : searchRows.length ? searchRows.map((row) => (
                <button key={`${row.market}:${row.symbol}`} type="button" onClick={() => { setDraft(row.symbol); setQuery(''); setSearchOpen(false); commitSelection({ market: row.market, symbol: row.symbol, name: row.name }); }} className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-secondary">
                  <div className="min-w-0"><p className="truncate text-sm font-black">{row.name}</p><p className="text-[10px] font-bold text-muted-foreground">{row.symbol}</p></div>
                  <div className="text-right text-[10px] font-bold"><p>{formatPrice(row.price, row.market)}</p><p>{formatPercent(row.changePercent)}</p></div>
                </button>
              )) : <p className="p-4 text-center text-xs font-bold text-muted-foreground">검색 결과가 없습니다. 심볼을 직접 입력한 뒤 적용할 수 있습니다.</p>}
            </div>
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-3xl border border-card-border bg-card shadow-sm">
        <div className="border-b border-card-border p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="truncate text-lg font-black">{selection.displayName}</h2><span className="rounded-full bg-secondary px-2 py-1 text-[10px] font-extrabold text-muted-foreground">{selection.ticker}</span><span data-testid="chart-data-status" className={cn('rounded-full border px-2 py-1 text-[10px] font-black', dataStatusClass(dataStatus))}>{dataStatusLabel(dataStatus)}</span></div><p className="mt-1 text-[11px] font-bold text-muted-foreground">{unifiedMarketLabel(market)} · {chartQuery.data?.provider ?? '데이터 연결 대기'}</p></div>
            <button type="button" aria-label="차트 새로고침" onClick={() => void chartQuery.refetch()} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-background"><RefreshCw className={cn('h-4 w-4', chartQuery.isFetching && 'animate-spin')} /></button>
          </div>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {UNIFIED_CHART_TIMEFRAMES.map((item) => <button key={item.key} type="button" data-testid={`timeframe-${item.key}`} onClick={() => changeTimeframe(item.key)} className={cn('shrink-0 rounded-xl border px-3 py-2 text-xs font-extrabold', timeframe === item.key ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-background text-muted-foreground')}>{item.label}</button>)}
          </div>
          <button type="button" onClick={() => setSettingsOpen((current) => !current)} className="mt-3 flex w-full items-center justify-between rounded-2xl border border-card-border bg-background px-3 py-2.5 text-left"><span className="inline-flex items-center gap-2 text-xs font-extrabold"><Settings2 className="h-4 w-4 text-primary" /> 지표 설정 · 브라우저 저장</span>{settingsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</button>
          {settingsOpen && <div className="mt-2 flex flex-wrap gap-2 rounded-2xl border border-card-border bg-background p-3">{OVERLAY_OPTIONS.map((item) => <button key={item.key} type="button" data-testid={`overlay-${item.key}`} onClick={() => toggleOverlay(item.key)} className={cn('rounded-full border px-3 py-1.5 text-[11px] font-extrabold', overlays[item.key] ? 'border-primary bg-primary/10 text-primary' : 'border-card-border bg-card text-muted-foreground')}>{overlays[item.key] ? '✓ ' : '+ '}{item.label}</button>)}</div>}
        </div>
        <div className="min-h-[390px] bg-background/30">
          {chartQuery.isLoading ? <Centered tall><Loader2 className="h-5 w-5 animate-spin" /> 차트 불러오는 중</Centered> : chartQuery.isError ? <div className="flex h-[390px] flex-col items-center justify-center px-6 text-center" data-testid="chart-error-state"><AlertTriangle className="h-8 w-8 text-destructive" /><p className="mt-3 text-sm font-black">차트 데이터를 불러오지 못했습니다.</p><p role="alert" className="mt-1 break-keep text-xs font-bold leading-5 text-muted-foreground">{errorMessage}</p><button type="button" onClick={() => void chartQuery.refetch()} className="mt-4 rounded-full bg-primary px-4 py-2 text-xs font-black text-primary-foreground">다시 시도</button></div> : candles.length < 2 || !levels ? <div className="flex h-[390px] flex-col items-center justify-center px-6 text-center" data-testid="chart-empty-state"><BarChart3 className="h-8 w-8 text-muted-foreground" /><p className="mt-3 text-sm font-black">표시할 유효한 캔들이 없습니다.</p><p className="mt-1 break-keep text-xs font-bold leading-5 text-muted-foreground">잘못된 심볼, 데이터 없는 종목 또는 지원하지 않는 시간봉인지 확인하세요. 임시 캔들은 만들지 않습니다.</p></div> : <PatternAwareUnifiedChartCanvas ref={realtimeCanvasRef} candles={candles} indicators={indicators} levels={levels} analysis={analysis} pricePlan={pricePlan} overlays={overlays} timeframe={timeframe} resetKey={`${market}:${selection.ticker}:${timeframe}`} market={market} onCandleSelect={handleCandleSelect} />}
        </div>
      </section>

      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="ai-chart-v3-evidence-status">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-[11px] font-extrabold text-primary">AI Chart V3 Evidence Truth</p>
            <h2 className="mt-1 text-sm font-black">Transport · Provenance · Calibration</h2>
          </div>
          <span className={cn('rounded-full border px-3 py-1 text-[10px] font-black', dataStatusClass(dataStatus))}>{dataStatusLabel(dataStatus)}</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="STREAM STATUS" value={realtimeHealth.connectionState} />
          <Metric label="TRANSPORT" value={realtimeHealth.transportMode} />
          <Metric label="STREAM DATA" value={realtimeHealth.dataStatus} />
          <Metric label="DATA AGE" value={realtimeHealth.lastValidEventAt == null ? formatDataAge(chartQuery.data) : `${Math.max(0, Date.now() - realtimeHealth.lastValidEventAt)}ms`} />
          <Metric label="PROVIDER" value={realtimeHealth.provider} />
          <Metric label="IDENTITY" value={`${realtimeHealth.symbol} · ${realtimeHealth.timeframe}`} />
          <Metric label="RECOVERY" value={realtimeHealth.recoveryState} />
          <Metric label="INTEGRITY" value={realtimeHealth.integrityIssues.length ? realtimeHealth.integrityIssues.join(', ') : 'NO_UNRESOLVED_ISSUE'} />
          <Metric label="PROVENANCE" value={chartQuery.data?.provider ? '상단 출처 연결됨' : '미연결'} />
          <Metric label="TECHNICAL SCORE" value={analysis ? `${analysis.confidence}/100` : '계산 대기'} />
          <Metric label="CALIBRATED PROBABILITY" value="INSUFFICIENT_SAMPLE" />
          <Metric label="SAMPLE N" value="0 (연결된 검증표본 없음)" />
          <Metric label="EXPECTED VALUE" value="UNAVAILABLE" />
          <Metric label="DATA QUALITY" value={dataStatusLabel(dataStatus)} />
        </div>
        <p className="mt-3 rounded-2xl bg-background p-3 text-[11px] font-bold leading-5 text-muted-foreground">TECHNICAL SCORE는 규칙 기반 차트 강도 점수이며 실제 승률이 아닙니다. Backtest/OOS/Walk-Forward/Shadow/Paper의 검증 표본이 이 차트와 정식으로 연결되기 전에는 확률·승률·EV를 생성하지 않습니다. 지연·오래된·불충분 데이터에서는 방향 신호를 강행하지 않고 WATCH로 제한합니다.</p>
      </section>

      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="scanner-price-plan-chart">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-[11px] font-extrabold text-primary">신호검색기 계획</p>
            <h2 className="mt-1 break-keep text-sm font-black">진입 · 손절 · 목표가</h2>
            <p className="mt-1 text-[10px] font-bold text-muted-foreground">같은 종목에서는 차트 시간봉을 바꿔도 Scanner에서 전달된 계획을 유지합니다.</p>
          </div>
          <span data-testid="scanner-price-plan-action" className="shrink-0 rounded-full border border-card-border bg-background px-3 py-1 text-xs font-black">{scannerActionLabel(selection.action)}</span>
        </div>
        {pricePlan ? (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="진입" value={entryText} />
            <Metric label="손절" value={formatPlanPrice(pricePlan.stopLoss, market)} />
            <Metric label="무효화" value={formatPlanPrice(pricePlan.invalidation, market)} />
            <Metric label="목표1" value={formatPlanPrice(pricePlan.targets[0], market)} />
            <Metric label="목표2" value={formatPlanPrice(pricePlan.targets[1], market)} />
            <Metric label="R:R" value={pricePlan.riskReward != null && Number.isFinite(pricePlan.riskReward) && pricePlan.riskReward > 0 ? pricePlan.riskReward.toFixed(2) : '미확인'} />
          </div>
        ) : (
          <p className="mt-3 rounded-2xl bg-background p-3 break-keep text-xs font-bold text-muted-foreground">Scanner에서 전달된 Price Plan이 없습니다. 신호검색기 계획이 없는 경우 차트가 임의의 진입가·손절가·목표가를 만들지 않습니다.</p>
        )}
      </section>

      <SelectedCandleDetailPanel
        candles={candles}
        indicators={indicators}
        market={market}
        timeframe={timeframe}
        selectedTime={selectedCandleTime}
        onReset={() => setSelectedCandleTime(null)}
      />

      {warnings.length > 0 && <section className="rounded-3xl border border-warning/30 bg-warning/5 p-4" data-testid="chart-data-warnings"><div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-warning" /><h2 className="text-sm font-black">데이터 품질 알림</h2></div><ul className="mt-2 space-y-1 text-xs font-bold text-muted-foreground">{warnings.map((warning) => <li key={warning}>• {warning}</li>)}</ul></section>}

      {latest && levels && <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm"><div className="flex items-start justify-between gap-3"><div><p className="text-[11px] font-extrabold text-primary">기술지표·분석 참고선</p><h2 className="mt-1 text-lg font-black">{analysis?.title ?? '분석 준비 중'}</h2></div><div className="rounded-full border border-card-border bg-secondary px-3 py-1.5 text-xs font-black">{analysis?.bias === 'bullish' ? '상승 우세' : analysis?.bias === 'bearish' ? '하락 우세' : '중립'}</div></div><p className="mt-3 rounded-2xl bg-secondary/70 p-3 text-xs font-bold leading-5">{analysis?.summary ?? '유효한 완료봉과 지표가 준비되면 분석을 표시합니다.'}</p><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><Metric label="현재가" value={formatPrice(latest.close, market)} icon={<BarChart3 className="h-4 w-4" />} /><Metric label="1차 지지" value={formatPrice(levels.support, market)} icon={<TrendingDown className="h-4 w-4" />} /><Metric label="1차 저항" value={formatPrice(levels.resistance, market)} icon={<TrendingUp className="h-4 w-4" />} /><Metric label="목표 참고" value={formatPrice(levels.targetReference, market)} icon={<TrendingUp className="h-4 w-4" />} />{overlays.rsi && <Metric label="RSI14" value={currentIndicator?.rsi14 == null ? '-' : currentIndicator.rsi14.toFixed(1)} />}{overlays.macd && <Metric label="MACD" value={currentIndicator?.macd == null ? '-' : currentIndicator.macd.toFixed(4)} />}{overlays.atr && <Metric label="ATR14" value={formatPrice(currentIndicator?.atr14, market)} />}<Metric label="거래량 비율" value={currentIndicator?.volumeRatio20 == null ? '-' : `${currentIndicator.volumeRatio20.toFixed(2)}배`} /></div></section>}

      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm"><div className="flex items-center justify-between gap-2"><div><p className="text-[11px] font-extrabold text-primary">분석 상태 타임라인</p><h2 className="mt-1 text-sm font-black">형성 → 후보 → 확정·무효화</h2></div><span className="text-[10px] font-bold text-muted-foreground">최근 {timeline.length}건</span></div><div className="mt-3 max-h-72 space-y-2 overflow-y-auto">{timeline.length ? timeline.map((item) => <div key={item.key} className="rounded-2xl bg-background p-3 text-xs"><div className="flex items-center justify-between gap-2"><strong>{item.analysis.title}</strong><span className="text-[10px] font-black text-primary">{item.analysis.status}</span></div><p className="mt-1 break-keep font-bold leading-5 text-muted-foreground">{item.analysis.transitionReason}</p><p className="mt-1 text-[10px] font-semibold text-muted-foreground">{new Date(item.analysis.detectedAt).toLocaleString('ko-KR')}</p></div>) : <p className="rounded-2xl bg-background p-5 text-center text-xs font-bold text-muted-foreground">새 분석 상태를 기다리는 중입니다.</p>}</div></section>
      <p className="px-1 text-[10px] font-semibold leading-4 text-muted-foreground">국내주식·미국주식·업비트 현물·비트겟 선물의 공개 시세를 읽기 전용으로 분석합니다. 현재 transport는 FALLBACK POLLING이며 검증된 streaming이 연결되기 전에는 LIVE로 표시하지 않습니다. 주문 API와 연결하지 않으며 실제 주문을 실행하지 않습니다.</p>
    </div>
  );
}

function Centered({ children, tall = false }: { children: ReactNode; tall?: boolean }) {
  return <p className={cn('flex items-center justify-center gap-2 text-xs font-bold text-muted-foreground', tall ? 'h-[390px]' : 'p-5')}>{children}</p>;
}

function Metric({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return <div className="rounded-2xl border border-card-border bg-background p-3"><div className="flex items-center gap-1.5 text-primary">{icon}<span className="text-[10px] font-extrabold text-muted-foreground">{label}</span></div><p className="mt-2 break-words text-sm font-black">{value}</p></div>;
}