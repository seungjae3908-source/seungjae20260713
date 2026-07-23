// 차트중계 — 실시간 차트 생중계 / AI 차트 실시간 생중계 (표시 전용, 자동매매 실행 없음)
// chart-broadcast.tsx 의 lightweight-charts 캔들/거래량 렌더링 방식과 폴링 패턴을 재사용한다.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, Loader2, RefreshCw, Search, Settings2, ShieldAlert, X } from 'lucide-react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { apiGet, ApiError } from '@/lib/api';
import { BottomNav } from '@/components/bottom-nav';
import { memberGradeLabel, useMemberPermissions } from '@/lib/permissions';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useRealtimeChart } from '@/hooks/use-realtime-chart';

type AnyObj = Record<string, any>;

type Asset = 'stockKR' | 'stockUS' | 'coinSpot' | 'coinFutures';
type Tab = 'live' | 'ai';

type CandlePoint = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type OverlayShape = {
  type: 'candle' | 'vline' | 'zone' | 'level';
  fromTime?: number | null;
  toTime?: number | null;
  level?: number | null;
  level2?: number | null;
};

type ChartSignal = {
  id: string;
  kind: 'chart' | 'candle' | 'indicator';
  name: string;
  occurredAt: string;
  price: number | null;
  barTime: number | null;
  importance: string;
  meaningGeneral: string;
  meaningHere: string;
  confirmations: string[];
  invalidation: string[];
  risk: string;
  overlay: OverlayShape | null;
};

type AiPlan = {
  ok: boolean;
  symbol: string;
  view: '매수' | '매도' | '중립';
  target: number | null;
  stop: number | null;
  buyLevels: (number | null)[];
  sellLevels: (number | null)[];
  basis: string[];
  invalidation: string[];
  risks: string[];
  dataAsOf: string | null;
};

type ChartSettings = {
  liveSignal: boolean;
  chartPattern: boolean;
  candlePattern: boolean;
  volumeSignal: boolean;
  indicatorSignal: boolean;
  target: boolean;
  stop: boolean;
  buyLevels: boolean;
  sellLevels: boolean;
  ai: boolean;
  highlight: boolean;
};

const SETTINGS_KEY = 'chart-relay-settings-v1';

const DEFAULT_SETTINGS: ChartSettings = {
  liveSignal: true,
  chartPattern: true,
  candlePattern: true,
  volumeSignal: true,
  indicatorSignal: true,
  target: true,
  stop: true,
  buyLevels: true,
  sellLevels: true,
  ai: true,
  highlight: true,
};

const SETTING_LABELS: Array<{ key: keyof ChartSettings; label: string }> = [
  { key: 'liveSignal', label: '실시간 신호' },
  { key: 'chartPattern', label: '차트 패턴' },
  { key: 'candlePattern', label: '캔들 패턴' },
  { key: 'volumeSignal', label: '거래량 신호' },
  { key: 'indicatorSignal', label: '기술지표 신호' },
  { key: 'target', label: '목표가' },
  { key: 'stop', label: '손절가' },
  { key: 'buyLevels', label: '분할매수' },
  { key: 'sellLevels', label: '분할매도' },
  { key: 'ai', label: 'AI 분석' },
  { key: 'highlight', label: '신호 강조' },
];

const ASSET_GROUPS = [
  {
    key: 'stock',
    label: '주식',
    items: [
      { key: 'stockKR' as Asset, label: '국내주식' },
      { key: 'stockUS' as Asset, label: '해외주식' },
    ],
  },
  {
    key: 'coin',
    label: '코인',
    items: [
      { key: 'coinSpot' as Asset, label: '현물' },
      { key: 'coinFutures' as Asset, label: '선물', futures: true },
    ],
  },
] as const;


type IntervalItem = { key: string; label: string };

const STOCK_INTERVALS: IntervalItem[] = [
  { key: '1m', label: '1분' },
  { key: '3m', label: '3분' },
  { key: '5m', label: '5분' },
  { key: '15m', label: '15분' },
  { key: '30m', label: '30분' },
  { key: '1H', label: '1시간' },
  { key: '4H', label: '4시간' },
  { key: '1D', label: '1일' },
];

const SPOT_INTERVALS: IntervalItem[] = [
  { key: '1m', label: '1분' },
  { key: '3m', label: '3분' },
  { key: '5m', label: '5분' },
  { key: '15m', label: '15분' },
  { key: '30m', label: '30분' },
  { key: '60m', label: '1시간' },
  { key: '1D', label: '1일' },
  { key: '1W', label: '1주' },
];

const FUTURES_INTERVALS: IntervalItem[] = [
  { key: '1m', label: '1분' },
  { key: '3m', label: '3분' },
  { key: '5m', label: '5분' },
  { key: '15m', label: '15분' },
  { key: '30m', label: '30분' },
  { key: '1H', label: '1시간' },
  { key: '4H', label: '4시간' },
  { key: '1D', label: '1일' },
];

const DEFAULT_SYMBOL: Record<Asset, string> = {
  stockKR: '005930',
  stockUS: 'AAPL',
  coinSpot: 'BTC',
  coinFutures: 'BTCUSDT',
};

function finite(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toUnixSeconds(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw > 1e12) return Math.floor(raw / 1000);
    if (raw > 1e9) return Math.floor(raw);
  }
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 1e9) {
    return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
  }
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return null;
}

function normalizeCandles(rows: AnyObj[]): CandlePoint[] {
  const normalized = rows
    .map((row) => {
      const close = finite(row?.close ?? row?.closePrice ?? row?.trade_price ?? row?.price);
      const open = finite(row?.open ?? row?.openPrice ?? row?.opening_price ?? close);
      const high = finite(row?.high ?? row?.highPrice ?? row?.high_price ?? open ?? close);
      const low = finite(row?.low ?? row?.lowPrice ?? row?.low_price ?? open ?? close);
      const volume = finite(row?.volume ?? row?.tradeVolume ?? 0) ?? 0;
      if (close == null || open == null || high == null || low == null) return null;
      const time = toUnixSeconds(row?.time ?? row?.date ?? row?.datetime ?? row?.timestamp ?? row?.dt);
      if (time == null) return null;
      return {
        time: time as UTCTimestamp,
        open,
        high: Math.max(high, open, close),
        low: Math.min(low, open, close),
        close,
        volume: Math.max(volume, 0),
      } satisfies CandlePoint;
    })
    .filter((row): row is CandlePoint => row != null)
    .sort((a, b) => Number(a.time) - Number(b.time));
  return [...new Map(normalized.map((row) => [Number(row.time), row])).values()];
}

function candleUrl(asset: Asset, symbol: string, interval: string): string {
  const s = encodeURIComponent(symbol);
  if (asset === 'stockKR' || asset === 'stockUS') {
    return `/stocks/${s}/candles?tf=${encodeURIComponent(interval)}`;
  }
  if (asset === 'coinSpot') {
    if (interval === '1D' || interval === '1W' || interval === '1M') {
      return `/crypto/spot/candles?symbol=${s}&tf=${interval}&count=200`;
    }
    if (interval === '60m') return `/crypto/spot/candles?symbol=${s}&unit=60&count=200`;
    return `/crypto/spot/candles?symbol=${s}&unit=${Number(interval.replace('m', '')) || 15}&count=200`;
  }
  return `/crypto/futures/candles?symbol=${s}&granularity=${encodeURIComponent(interval)}&limit=200`;
}

function extractCandleRows(payload: AnyObj): AnyObj[] {
  if (Array.isArray(payload?.candles)) return payload.candles;
  if (Array.isArray(payload?.data?.candles)) return payload.data.candles;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function normalizeAiPlan(raw: Record<string, unknown> | null): AiPlan | null {
  if (!raw || raw.ok === false) return null;
  const view = String(raw.view ?? '중립');
  if (view !== '매수' && view !== '매도' && view !== '중립') return null;
  const levels = (value: unknown): (number | null)[] =>
    Array.isArray(value) ? value.map((item) => finite(item)) : [];
  const rows = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(String).filter(Boolean) : [];

  return {
    ok: true,
    symbol: String(raw.symbol ?? ''),
    view,
    target: finite(raw.target),
    stop: finite(raw.stop),
    buyLevels: levels(raw.buyLevels),
    sellLevels: levels(raw.sellLevels),
    basis: rows(raw.basis),
    invalidation: rows(raw.invalidation),
    risks: rows(raw.risks),
    dataAsOf: raw.dataAsOf == null ? null : String(raw.dataAsOf),
  };
}

function signalContract(asset: Asset): { assetParam: string; coinMarket: string | null } {
  if (asset === 'stockKR' || asset === 'stockUS') return { assetParam: 'stock', coinMarket: null };
  if (asset === 'coinSpot') return { assetParam: 'coin', coinMarket: 'spot' };
  return { assetParam: 'coin', coinMarket: 'futures' };
}

function formatPrice(value: number | null, asset: Asset): string {
  if (value == null || !Number.isFinite(value)) return '산출 불가';
  if (asset === 'stockUS') {
    return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (asset === 'coinSpot' || asset === 'coinFutures') {
    return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 0 : 4 });
  }
  return `${Math.round(value).toLocaleString()}원`;
}

function intervalsFor(asset: Asset): IntervalItem[] {
  if (asset === 'coinSpot') return SPOT_INTERVALS;
  if (asset === 'coinFutures') return FUTURES_INTERVALS;
  return STOCK_INTERVALS;
}

function loadSettings(): ChartSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ChartSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// ── 차트 렌더러 (chart-broadcast.tsx 스타일 재사용) ──
function RelayChart({
  candles,
  timeVisible,
  settings,
  signals,
  activeSignalId,
  plan,
  asset,
  tab,
}: {
  candles: CandlePoint[];
  timeVisible: boolean;
  settings: ChartSettings;
  signals: ChartSignal[];
  activeSignalId: string | null;
  plan: AiPlan | null;
  asset: Asset;
  tab: Tab;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || candles.length < 2) return;
    const dark = document.documentElement.classList.contains('dark');
    const chart = createChart(container, {
      width: Math.max(container.clientWidth, 1),
      height: 360,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: dark ? '#94a3b8' : '#64748b',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: dark ? 'rgba(148,163,184,0.08)' : 'rgba(100,116,139,0.10)' },
        horzLines: { color: dark ? 'rgba(148,163,184,0.08)' : 'rgba(100,116,139,0.10)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderVisible: false, timeVisible, secondsVisible: false, rightOffset: 5, barSpacing: 7 },
      handleScroll: true,
      handleScale: true,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#ef4444',
      downColor: '#3b82f6',
      wickUpColor: '#ef4444',
      wickDownColor: '#3b82f6',
      borderUpColor: '#ef4444',
      borderDownColor: '#3b82f6',
      priceLineVisible: true,
      lastValueVisible: true,
    });
    candleSeries.setData(
      candles.map((row) => ({ time: row.time, open: row.open, high: row.high, low: row.low, close: row.close })),
    );

    const volumeSeries: ISeriesApi<'Histogram'> = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volumeSeries.setData(
      candles.map((row) => ({
        time: row.time,
        value: row.volume,
        color: row.close >= row.open ? 'rgba(239,68,68,0.42)' : 'rgba(59,130,246,0.42)',
      })),
    );

    // AI 계획 수평선 (표시 전용 · 실제 주문과 연결되지 않음)
    if (tab === 'ai' && settings.ai && plan) {
      const lines: Array<{ price: number | null; color: string; title: string; on: boolean }> = [
        { price: plan.target, color: '#f97316', title: '목표가', on: settings.target },
        { price: plan.stop, color: '#0ea5e9', title: '손절가', on: settings.stop },
        { price: plan.buyLevels?.[0] ?? null, color: '#ef4444', title: '1차 매수', on: settings.buyLevels },
        { price: plan.buyLevels?.[1] ?? null, color: '#ef4444', title: '2차 매수', on: settings.buyLevels },
        { price: plan.buyLevels?.[2] ?? null, color: '#ef4444', title: '3차 매수', on: settings.buyLevels },
        { price: plan.sellLevels?.[0] ?? null, color: '#3b82f6', title: '1차 매도', on: settings.sellLevels },
        { price: plan.sellLevels?.[1] ?? null, color: '#3b82f6', title: '2차 매도', on: settings.sellLevels },
        { price: plan.sellLevels?.[2] ?? null, color: '#3b82f6', title: '3차 매도', on: settings.sellLevels },
      ];
      for (const line of lines) {
        if (!line.on || line.price == null || !Number.isFinite(line.price)) continue;
        candleSeries.createPriceLine({
          price: line.price,
          color: line.color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: line.title,
        });
      }
    }

    // 실시간 신호 강조 오버레이 (선택된 신호만)
    if (tab === 'live' && settings.highlight && activeSignalId) {
      const signal = signals.find((item) => item.id === activeSignalId);
      const overlay = signal?.overlay ?? null;
      if (overlay) {
        if (overlay.type === 'level' && overlay.level != null && Number.isFinite(overlay.level)) {
          candleSeries.createPriceLine({
            price: overlay.level,
            color: '#eab308',
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: signal?.name ?? '신호',
          });
          if (overlay.level2 != null && Number.isFinite(overlay.level2)) {
            candleSeries.createPriceLine({
              price: overlay.level2,
              color: '#eab308',
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: '',
            });
          }
        }
        if (overlay.type === 'candle' && overlay.fromTime != null) {
          const target = toUnixSeconds(overlay.fromTime);
          if (target != null) {
            candleSeries.setMarkers([
              {
                time: target as Time,
                position: 'aboveBar',
                color: '#eab308',
                shape: 'circle',
                text: signal?.name ?? '신호',
              },
            ] as any);
          }
        }
        if (overlay.type === 'vline' || overlay.type === 'zone') {
          const from = overlay.fromTime != null ? toUnixSeconds(overlay.fromTime) : null;
          if (from != null) {
            candleSeries.setMarkers([
              {
                time: from as Time,
                position: 'belowBar',
                color: '#eab308',
                shape: 'arrowUp',
                text: signal?.name ?? '신호',
              },
            ] as any);
          }
        }
      }
    }

    chart.timeScale().fitContent();
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) chart.applyOptions({ width: Math.max(width, 1) });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [candles, timeVisible, settings, signals, activeSignalId, plan, asset, tab]);

  return <div ref={containerRef} className="h-[360px] w-full" />;
}

export default function ChartRelayPage() {
  const [location, navigate] = useLocation();
  const queryClient = useQueryClient();
  const permissions = useMemberPermissions();
  const auth = useAuth() as AnyObj;
  const canUseFutures = permissions.has('futures');

  const [initialRoute] = useState(() => {
    const queryText =
      typeof window !== 'undefined'
        ? window.location.search.replace(/^\?/, '')
        : location.includes('?')
          ? location.slice(location.indexOf('?') + 1)
          : '';

    const params = new URLSearchParams(queryText);
    const assetParam = params.get('asset');
    const symbolParam = params.get('symbol');
    const intervalParam = params.get('interval');
    const tabParam = params.get('tab');

    const initialAsset: Asset =
      assetParam === 'stockUS' ||
      assetParam === 'coinSpot' ||
      assetParam === 'coinFutures'
        ? assetParam
        : 'stockKR';

    return {
      asset: initialAsset,
      symbol:
        symbolParam?.trim().toUpperCase() ||
        DEFAULT_SYMBOL[initialAsset],
      interval: intervalParam?.trim() || '5m',
      tab: tabParam === 'ai' ? ('ai' as Tab) : ('live' as Tab),
    };
  });

  const [asset, setAsset] = useState<Asset>(initialRoute.asset);
  const [symbol, setSymbol] = useState<string>(initialRoute.symbol);
  const [symbolInput, setSymbolInput] = useState<string>('');
  const [interval, setIntervalState] = useState<string>(initialRoute.interval);
  const [tab, setTab] = useState<Tab>(initialRoute.tab);
  const [assetMenu, setAssetMenu] =
    useState<'stock' | 'coin' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ChartSettings>(() => loadSettings());
  const [activeSignalId, setActiveSignalId] = useState<string | null>(null);
  const [modalSignal, setModalSignal] = useState<ChartSignal | null>(null);

  const futuresLocked = asset === 'coinFutures' && !canUseFutures;
  const realtime = useRealtimeChart({
    asset,
    symbol,
    interval,
    enabled: Boolean(symbol) && !futuresLocked,
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  // 최초 진입에서는 URL로 전달된 종목을 유지하고,
  // 사용자가 자산 종류를 직접 바꿀 때만 기본 종목으로 변경한다.
  const initializedAssetRef = useRef(false);

  useEffect(() => {
    const list = intervalsFor(asset);

    setSymbolInput('');
    setActiveSignalId(null);
    setModalSignal(null);
    setIntervalState((current) =>
      list.some((item) => item.key === current)
        ? current
        : list[3]?.key ?? list[0]?.key ?? '5m',
    );

    if (!initializedAssetRef.current) {
      initializedAssetRef.current = true;
      return;
    }

    setSymbol(DEFAULT_SYMBOL[asset]);
  }, [asset]);

  const contract = signalContract(asset);
  const candleQueryKey = useMemo(
    () => ['chart-relay-candles', asset, symbol, interval] as const,
    [asset, interval, symbol],
  );
  const signalsQueryKey = useMemo(
    () => ['chart-relay-signals', asset, symbol, interval] as const,
    [asset, interval, symbol],
  );
  const planQueryKey = useMemo(
    () => ['chart-relay-ai', asset, symbol, interval] as const,
    [asset, interval, symbol],
  );
  const useRestFallback = realtime.status === 'idle'
    || realtime.status === 'error'
    || realtime.status === 'reconnecting';

  const candleQuery = useQuery({
    queryKey: candleQueryKey,
    queryFn: async () => {
      const normalizedSymbol = symbol.trim().toUpperCase();
      const payload = await apiGet<AnyObj>(
        candleUrl(asset, normalizedSymbol, interval),
      );

      if (extractCandleRows(payload).length < 2) {
        throw new Error('EMPTY_CANDLE_DATA');
      }

      return payload;
    },
    enabled: Boolean(symbol.trim()) && !futuresLocked && useRestFallback,
    refetchInterval: useRestFallback ? 20_000 : false,
    refetchIntervalInBackground: true,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
    retry: 3,
    retryDelay: (attempt) => Math.min(1_500 * 2 ** attempt, 8_000),
  });

  const signalsQuery = useQuery({
    queryKey: signalsQueryKey,
    queryFn: () =>
      apiGet<AnyObj>(
        `/market/chart-signals?asset=${contract.assetParam}${contract.coinMarket ? `&coinMarket=${contract.coinMarket}` : ''}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
      ),
    enabled: Boolean(symbol) && !futuresLocked && tab === 'live' && useRestFallback,
    refetchInterval: useRestFallback ? 30_000 : false,
    refetchIntervalInBackground: true,
    retry: 1,
  });

  const planQuery = useQuery({
    queryKey: planQueryKey,
    queryFn: () =>
      apiGet<AiPlan>(
        `/market/ai-chart-plan?asset=${contract.assetParam}${contract.coinMarket ? `&coinMarket=${contract.coinMarket}` : ''}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
      ),
    enabled: Boolean(symbol) && !futuresLocked && tab === 'ai' && useRestFallback,
    refetchInterval: useRestFallback ? 30_000 : false,
    refetchIntervalInBackground: true,
    retry: 1,
  });

  useEffect(() => {
    const snapshot = realtime.snapshot;
    if (
      !snapshot ||
      snapshot.asset !== asset ||
      snapshot.symbol !== symbol.toUpperCase() ||
      snapshot.interval !== interval
    ) {
      return;
    }

    queryClient.setQueryData<AnyObj>(candleQueryKey, {
      ok: true,
      provider: snapshot.provider,
      fetchedAt: snapshot.fetchedAt,
      candles: snapshot.candles,
      count: snapshot.candles.length,
    });
    queryClient.setQueryData<AnyObj>(signalsQueryKey, {
      ok: true,
      symbol: snapshot.symbol,
      interval: snapshot.interval,
      updatedAt: snapshot.fetchedAt,
      signals: snapshot.signals,
    });
    const livePlan = normalizeAiPlan(snapshot.plan);
    if (livePlan) queryClient.setQueryData<AiPlan>(planQueryKey, livePlan);
  }, [
    asset,
    candleQueryKey,
    interval,
    planQueryKey,
    queryClient,
    realtime.snapshot,
    signalsQueryKey,
    symbol,
  ]);

  const candles = useMemo(
    () => normalizeCandles(extractCandleRows(candleQuery.data ?? {})),
    [candleQuery.data],
  );

  const signals = useMemo<ChartSignal[]>(() => {
    const raw = Array.isArray(signalsQuery.data?.signals) ? (signalsQuery.data!.signals as AnyObj[]) : [];
    const mapped: ChartSignal[] = [];
    const seen = new Set<string>();
    for (const row of raw) {
      const id = String(row?.id ?? '');
      if (!id || seen.has(id)) continue;
      const signal: ChartSignal = {
        id,
        kind: (row?.kind as ChartSignal['kind']) ?? 'chart',
        name: String(row?.name ?? '신호'),
        occurredAt: String(row?.occurredAt ?? ''),
        price: finite(row?.price),
        barTime: toUnixSeconds(row?.barTime),
        importance: String(row?.importance ?? ''),
        meaningGeneral: String(row?.meaningGeneral ?? ''),
        meaningHere: String(row?.meaningHere ?? ''),
        confirmations: Array.isArray(row?.confirmations) ? row.confirmations.map(String) : [],
        invalidation: Array.isArray(row?.invalidation) ? row.invalidation.map(String) : [],
        risk: String(row?.risk ?? ''),
        overlay: (row?.overlay as OverlayShape | null) ?? null,
      };
      // 설정 토글에 따라 종류별 필터
      if (!settings.liveSignal) continue;
      if (signal.kind === 'chart' && !settings.chartPattern) continue;
      if (signal.kind === 'candle' && !settings.candlePattern) continue;
      if (signal.kind === 'indicator' && !(settings.indicatorSignal || settings.volumeSignal)) continue;
      seen.add(id);
      mapped.push(signal);
    }
    return mapped;
  }, [signalsQuery.data, settings]);

  // 활성 신호가 목록에서 사라지면 강조 해제
  useEffect(() => {
    if (activeSignalId && !signals.some((item) => item.id === activeSignalId)) {
      setActiveSignalId(null);
    }
  }, [signals, activeSignalId]);

  const plan = planQuery.data && planQuery.data.ok ? planQuery.data : null;
  const timeVisible = /m|H/.test(interval);
  const intervalList = intervalsFor(asset);
  const isCoin = asset === 'coinSpot' || asset === 'coinFutures';
  const realtimeLabel = realtime.status === 'live'
    ? `연결됨${realtime.provider ? ` · ${realtime.provider}` : ''}`
    : realtime.status === 'connecting'
      ? '연결 중'
      : realtime.status === 'connected'
        ? '구독 중'
        : realtime.status === 'reconnecting'
          ? '재연결 중'
          : realtime.status === 'error'
            ? '연결 오류 · REST 갱신 중'
            : '대기';

  const submitSymbol = () => {
    const next = symbolInput.trim();
    if (!next) return;
    setSymbol(isCoin ? next.toUpperCase() : next);
    setSymbolInput('');
    setActiveSignalId(null);
  };

  const selectAsset = (next: Asset) => {
    setAssetMenu(null);
    setAsset(next);
  };

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background">
      <div className="mx-auto max-w-md px-4 pb-28 pt-4">
        <header className="grid grid-cols-[40px_1fr_40px] items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/')}
            aria-label="뒤로"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="text-center">
            <h1 className="text-lg font-extrabold">차트중계</h1>
            <p className="text-[11px] font-bold text-muted-foreground">실시간 차트·AI 생중계 (표시 전용)</p>
          </div>
          <button
            type="button"
            onClick={() => {
              void candleQuery.refetch();
              if (tab === 'live') void signalsQuery.refetch();
              else void planQuery.refetch();
            }}
            aria-label="새로고침"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"
          >
            <RefreshCw className={cn('h-4 w-4', candleQuery.isFetching && 'animate-spin')} />
          </button>
        </header>

        {/* 자산 선택 */}
        <div className="relative mt-3 grid grid-cols-2 gap-2">
          {ASSET_GROUPS.map((group) => {
            const selectedGroup =
              group.key === 'stock'
                ? asset === 'stockKR' || asset === 'stockUS'
                : asset === 'coinSpot' || asset === 'coinFutures';

            return (
              <div key={group.key} className="relative">
                <button
                  type="button"
                  onClick={() =>
                    setAssetMenu((current) =>
                      current === group.key ? null : group.key,
                    )
                  }
                  className={cn(
                    'flex w-full items-center justify-center gap-1 rounded-xl border px-2 py-2.5 text-xs font-extrabold',
                    selectedGroup
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-card-border bg-card text-muted-foreground',
                  )}
                >
                  {group.label}
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>

                {assetMenu === group.key && (
                  <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 overflow-hidden rounded-xl border border-card-border bg-card p-1 shadow-xl">
                    {group.items.map((item) => {
                      const locked =
                        'futures' in item &&
                        item.futures &&
                        !canUseFutures;

                      return (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => {
                            if (!locked) selectAsset(item.key);
                          }}
                          disabled={locked}
                          className={cn(
                            'block w-full rounded-lg px-3 py-2 text-center text-xs font-black disabled:opacity-45',
                            asset === item.key
                              ? 'bg-primary text-primary-foreground'
                              : 'text-foreground hover:bg-secondary',
                          )}
                        >
                          {item.label}
                          {locked ? ' 🔒' : ''}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 종목 입력 */}
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={symbolInput}
            onChange={(event) => setSymbolInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitSymbol();
            }}
            placeholder={isCoin ? '심볼 입력 (예: BTC)' : '종목 코드 입력'}
            className="h-11 w-full rounded-2xl border border-card-border bg-card pl-10 pr-16 text-sm font-bold outline-none focus:border-primary"
          />
          <button
            type="button"
            onClick={submitSymbol}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-xl bg-primary px-3 py-1.5 text-[11px] font-extrabold text-primary-foreground"
          >
            선택
          </button>
        </div>
        <p className="mt-1.5 text-center text-[11px] font-bold text-muted-foreground">
          현재 종목: <span className="font-black text-foreground">{symbol || '해당 종목 없음'}</span>
          {' · '}실시간: <span title={realtime.error ?? undefined}>{realtimeLabel}</span>
        </p>

        {/* 시간봉 선택 */}
        <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
          {intervalList.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setIntervalState(item.key);
                setActiveSignalId(null);
              }}
              className={cn(
                'shrink-0 rounded-xl border px-3 py-2 text-xs font-extrabold',
                interval === item.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-card-border bg-card text-muted-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* 탭 */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setTab('live')}
            className={cn(
              'rounded-xl border px-2 py-2.5 text-center text-xs font-extrabold',
              tab === 'live'
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-card-border bg-card text-muted-foreground',
            )}
          >
            실시간 차트 생중계
          </button>
          <button
            type="button"
            onClick={() => setTab('ai')}
            className={cn(
              'rounded-xl border px-2 py-2.5 text-center text-xs font-extrabold',
              tab === 'ai'
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-card-border bg-card text-muted-foreground',
            )}
          >
            AI 차트 실시간 생중계
          </button>
        </div>

        {/* 차트 설정 토글 패널 */}
        <button
          type="button"
          onClick={() => setSettingsOpen((current) => !current)}
          className="mt-3 flex w-full items-center justify-between rounded-2xl border border-card-border bg-card px-3 py-2.5 text-left"
        >
          <span className="inline-flex items-center gap-2 text-xs font-extrabold">
            <Settings2 className="h-4 w-4 text-primary" /> 차트 설정 · 표시 항목
          </span>
        </button>
        {settingsOpen && (
          <div className="mt-2 flex flex-wrap gap-2 rounded-2xl border border-card-border bg-card p-3">
            {SETTING_LABELS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setSettings((current) => ({ ...current, [item.key]: !current[item.key] }))}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-[11px] font-extrabold',
                  settings[item.key]
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-card-border bg-background text-muted-foreground',
                )}
              >
                {settings[item.key] ? '✓ ' : '+ '}
                {item.label}
              </button>
            ))}
          </div>
        )}

        {/* 본문 */}
        {futuresLocked ? (
          <div className="mt-3">
            <StateBox>
              코인 선물은 정회원 전용입니다. 현재 등급: {memberGradeLabel(auth?.profile ?? null)} · 등급 변경은 관리자에게 문의해 주세요.
            </StateBox>
          </div>
        ) : (
          <>
            {/* 차트 영역 */}
            <section className="mt-3 overflow-hidden rounded-2xl border border-card-border bg-card">
              <div className="min-h-[360px] bg-background/30">
                {candleQuery.isLoading ? (
                  <div className="flex h-[360px] items-center justify-center gap-2 text-sm font-bold text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" /> 차트 불러오는 중...
                  </div>
                ) : candleQuery.isError ? (
                  <div className="flex h-[360px] flex-col items-center justify-center px-6 text-center">
                    <ShieldAlert className="h-8 w-8 text-warning" />
                    <p className="mt-3 text-sm font-extrabold">차트 데이터를 불러오지 못했습니다.</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      원인: {candleQuery.error instanceof ApiError ? candleQuery.error.code : '네트워크 오류 또는 시간 초과'}
                    </p>
                    <button
                      type="button"
                      onClick={() => void candleQuery.refetch()}
                      disabled={candleQuery.isFetching}
                      className="mt-4 rounded-full bg-primary px-4 py-2 text-xs font-extrabold text-primary-foreground disabled:opacity-60"
                    >
                      {candleQuery.isFetching ? '다시 시도 중...' : '다시 시도'}
                    </button>
                  </div>
                ) : candles.length < 2 ? (
                  <div className="flex h-[360px] flex-col items-center justify-center px-6 text-center">
                    <p className="text-sm font-extrabold">현재 선택한 종목과 시간봉의 차트 데이터가 없습니다.</p>
                    <p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">
                      다른 시간봉을 선택하거나 종목을 확인해 주세요.
                    </p>
                    <button
                      type="button"
                      onClick={() => void candleQuery.refetch()}
                      disabled={candleQuery.isFetching}
                      className="mt-4 rounded-full border border-card-border bg-card px-4 py-2 text-xs font-extrabold disabled:opacity-60"
                    >
                      {candleQuery.isFetching ? '새로고침 중...' : '새로고침'}
                    </button>
                  </div>
                ) : (
                  <RelayChart
                    candles={candles}
                    timeVisible={timeVisible}
                    settings={settings}
                    signals={signals}
                    activeSignalId={activeSignalId}
                    plan={plan}
                    asset={asset}
                    tab={tab}
                  />
                )}
              </div>
            </section>

            {tab === 'live' ? (
              <LiveSignalsPanel
                query={signalsQuery}
                signals={signals}
                activeSignalId={activeSignalId}
                onSelect={(signal) => {
                  setActiveSignalId(signal.id);
                  setModalSignal(signal);
                }}
                enabled={settings.liveSignal}
              />
            ) : (
              <AiPlanPanel query={planQuery} plan={plan} asset={asset} settings={settings} />
            )}
          </>
        )}
      </div>

      {modalSignal && (
        <SignalModal
          signal={modalSignal}
          asset={asset}
          interval={interval}
          onClose={() => setModalSignal(null)}
        />
      )}

      <BottomNav />
    </div>
  );
}

function LiveSignalsPanel({
  query,
  signals,
  activeSignalId,
  onSelect,
  enabled,
}: {
  query: ReturnType<typeof useQuery<AnyObj>>;
  signals: ChartSignal[];
  activeSignalId: string | null;
  onSelect: (signal: ChartSignal) => void;
  enabled: boolean;
}) {
  return (
    <section className="mt-3">
      <h2 className="text-sm font-extrabold">실시간 신호</h2>
      <p className="mt-0.5 text-[11px] font-bold text-muted-foreground">
        조건을 만족하는 활성 신호만 표시됩니다. 신호를 누르면 차트 강조와 설명이 열립니다.
      </p>
      <div className="mt-2 space-y-2">
        {!enabled ? (
          <StateBox>설정에서 실시간 신호가 꺼져 있습니다.</StateBox>
        ) : query.isLoading ? (
          <StateBox>신호를 불러오는 중입니다.</StateBox>
        ) : query.isError ? (
          <StateBox error>데이터를 불러오지 못했습니다.</StateBox>
        ) : signals.length === 0 ? (
          <StateBox>현재 활성화된 신호가 없습니다.</StateBox>
        ) : (
          signals.map((signal) => (
            <button
              key={signal.id}
              type="button"
              onClick={() => onSelect(signal)}
              className={cn(
                'flex w-full items-center justify-between gap-3 rounded-2xl border p-3 text-left',
                activeSignalId === signal.id ? 'border-primary bg-primary/5' : 'border-card-border bg-card',
              )}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-black">{signal.name}</p>
                <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
                  {signal.kind === 'chart' ? '차트 패턴' : signal.kind === 'candle' ? '캔들 패턴' : '기술지표'}
                  {signal.occurredAt ? ` · ${formatTime(signal.occurredAt)}` : ''}
                </p>
              </div>
              <span className="shrink-0 text-[10px] font-black text-muted-foreground">자세히</span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}

function AiPlanPanel({
  query,
  plan,
  asset,
  settings,
}: {
  query: ReturnType<typeof useQuery<AiPlan>>;
  plan: AiPlan | null;
  asset: Asset;
  settings: ChartSettings;
}) {
  return (
    <section className="mt-3 space-y-2">
      <h2 className="text-sm font-extrabold">AI 차트 실시간 생중계</h2>
      <p className="rounded-2xl border border-warning/40 bg-warning/10 px-3 py-2 text-[10px] font-bold text-warning">
        표시 전용입니다. 실제 주문과 연결되지 않습니다.
      </p>
      {!settings.ai ? (
        <StateBox>설정에서 AI 분석이 꺼져 있습니다.</StateBox>
      ) : query.isLoading ? (
        <StateBox>AI 분석을 불러오는 중입니다.</StateBox>
      ) : query.isError ? (
        <StateBox error>데이터를 불러오지 못했습니다.</StateBox>
      ) : !plan ? (
        <StateBox>분석 가능한 데이터가 없습니다.</StateBox>
      ) : (
        <div className="space-y-2">
          <div className="rounded-2xl border border-card-border bg-card p-3 text-center">
            <p className="text-[11px] font-bold text-muted-foreground">현재 관점</p>
            <p
              className={cn(
                'mt-1 text-lg font-black',
                plan.view === '매수' ? 'text-destructive' : plan.view === '매도' ? 'text-blue-500' : 'text-muted-foreground',
              )}
            >
              {plan.view}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <PlanCell label="목표가" value={formatPrice(plan.target, asset)} tone="target" />
            <PlanCell label="손절가" value={formatPrice(plan.stop, asset)} tone="stop" />
          </div>

          <div className="rounded-2xl border border-card-border bg-card p-3">
            <p className="mb-2 text-[11px] font-black text-destructive">분할매수 (매수 관점)</p>
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((idx) => (
                <PlanCell key={idx} label={`${idx + 1}차`} value={formatPrice(plan.buyLevels?.[idx] ?? null, asset)} tone="buy" />
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-card-border bg-card p-3">
            <p className="mb-2 text-[11px] font-black text-blue-500">분할매도 (매도 관점)</p>
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((idx) => (
                <PlanCell key={idx} label={`${idx + 1}차`} value={formatPrice(plan.sellLevels?.[idx] ?? null, asset)} tone="sell" />
              ))}
            </div>
          </div>

          <ListCard title="분석 근거" items={plan.basis} empty="분석 근거가 없습니다." />
          <ListCard title="계획 무효 조건" items={plan.invalidation} empty="무효 조건이 없습니다." />
          <ListCard title="위험 요인" items={plan.risks} empty="위험 요인이 없습니다." />

          {plan.dataAsOf && (
            <p className="text-center text-[10px] font-bold text-muted-foreground">기준 시각 {formatTime(plan.dataAsOf)}</p>
          )}
        </div>
      )}
    </section>
  );
}

function SignalModal({
  signal,
  asset,
  interval,
  onClose,
}: {
  signal: ChartSignal;
  asset: Asset;
  interval: string;
  onClose: () => void;
}) {
  const intervalLabel = intervalsFor(asset).find((item) => item.key === interval)?.label ?? interval;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3" onClick={onClose}>
      <div
        className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl border border-card-border bg-card p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-black">{signal.name}</h3>
            <p className="mt-0.5 text-[11px] font-bold text-muted-foreground">
              {signal.occurredAt ? formatTime(signal.occurredAt) : '시각 미상'} · {intervalLabel}봉
              {signal.price != null ? ` · ${formatPrice(signal.price, asset)}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-card-border bg-background"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-3 space-y-3">
          <ModalBlock title="중요한 이유" text={signal.importance} />
          <ModalBlock title="일반적인 의미" text={signal.meaningGeneral} />
          <ModalBlock title="현재 차트에서의 의미" text={signal.meaningHere} />
          <ModalList title="추가 확인 조건" items={signal.confirmations} />
          <ModalList title="무효화 조건" items={signal.invalidation} />
          <ModalBlock title="위험 안내" text={signal.risk} />
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-2xl bg-primary py-2.5 text-sm font-extrabold text-primary-foreground"
        >
          닫기
        </button>
      </div>
    </div>
  );
}

function ModalBlock({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <p className="text-[11px] font-black text-muted-foreground">{title}</p>
      <p className="mt-1 break-keep text-xs font-bold leading-6 text-foreground">{text || '설명이 없습니다.'}</p>
    </div>
  );
}

function ModalList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-[11px] font-black text-muted-foreground">{title}</p>
      {items.length ? (
        <ul className="mt-1 space-y-1">
          {items.map((item, index) => (
            <li key={index} className="break-keep text-xs font-bold leading-6 text-foreground">
              · {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs font-bold text-muted-foreground">해당 없음</p>
      )}
    </div>
  );
}

function ListCard({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div className="rounded-2xl border border-card-border bg-card p-3">
      <p className="text-[11px] font-black text-muted-foreground">{title}</p>
      {items && items.length ? (
        <ul className="mt-1 space-y-1">
          {items.map((item, index) => (
            <li key={index} className="break-keep text-xs font-bold leading-6 text-foreground">
              · {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs font-bold text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

function PlanCell({ label, value, tone }: { label: string; value: string; tone: 'target' | 'stop' | 'buy' | 'sell' }) {
  const toneClass =
    tone === 'target'
      ? 'text-warning'
      : tone === 'stop'
        ? 'text-blue-500'
        : tone === 'buy'
          ? 'text-destructive'
          : 'text-blue-500';
  return (
    <div className="rounded-2xl border border-card-border bg-background p-2.5 text-center">
      <p className="text-[10px] font-bold text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-xs font-black', value === '산출 불가' ? 'text-muted-foreground' : toneClass)}>{value}</p>
    </div>
  );
}

function StateBox({ children, error }: { children: ReactNode; error?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-2xl border p-4 text-center text-xs font-bold',
        error
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-card-border bg-card text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}

function formatTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(parsed));
}