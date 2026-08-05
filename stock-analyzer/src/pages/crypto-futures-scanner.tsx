import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw, RotateCcw, Save, Search, ShieldCheck } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAssetMode } from '@/lib/asset-mode';
import {
  DEFAULT_CRYPTO_FUTURES_FILTERS,
  scanCryptoFuturesMarket,
  type CryptoFuturesCandle,
  type CryptoFuturesFilters,
  type CryptoFuturesTicker,
  type FuturesDirectionFilter,
  type FuturesTechnicalFilter,
} from '@/lib/crypto-futures-scanner';
import { cn } from '@/lib/utils';

const STORAGE_KEY = 'crypto-futures-scanner-filters-v1';
const TIMEFRAME_KEY = 'crypto-futures-scanner-timeframe-v1';
const TIMEFRAMES = ['5m', '15m', '1H', '4H', '1D'] as const;
type Timeframe = typeof TIMEFRAMES[number];

function loadFilters(): CryptoFuturesFilters {
  if (typeof window === 'undefined') return DEFAULT_CRYPTO_FUTURES_FILTERS;
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      ...DEFAULT_CRYPTO_FUTURES_FILTERS,
      ...value,
      query: '',
      direction: ['ALL', 'LONG', 'SHORT', 'WAIT'].includes(value.direction) ? value.direction : 'ALL',
      technical: ['all', 'volume', 'breakout', 'pullback', 'rsiOversold', 'rsiOverbought', 'trend'].includes(value.technical)
        ? value.technical
        : 'all',
    };
  } catch {
    return DEFAULT_CRYPTO_FUTURES_FILTERS;
  }
}

function loadTimeframe(): Timeframe {
  if (typeof window === 'undefined') return '15m';
  const value = window.localStorage.getItem(TIMEFRAME_KEY);
  return TIMEFRAMES.includes(value as Timeframe) ? value as Timeframe : '15m';
}

async function json<T>(response: Response, fallback: T) {
  return response.json().catch(() => fallback) as Promise<T>;
}

function compact(value: number | null | undefined, suffix = '') {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  if (Math.abs(number) >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1)}B${suffix}`;
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M${suffix}`;
  if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(1)}K${suffix}`;
  return `${number.toLocaleString('ko-KR', { maximumFractionDigits: 4 })}${suffix}`;
}

function price(value: number | null | undefined) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return number.toLocaleString('ko-KR', { maximumFractionDigits: number >= 1 ? 4 : 8 });
}

function percent(value: number | null | undefined, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return `${number > 0 ? '+' : ''}${number.toFixed(digits)}%`;
}

export default function CryptoFuturesScannerPage() {
  const assetMode = useAssetMode();
  const [, navigate] = useLocation();
  const [filters, setFilters] = useState<CryptoFuturesFilters>(loadFilters);
  const [timeframe, setTimeframe] = useState<Timeframe>(loadTimeframe);
  const [message, setMessage] = useState('');

  const tickersQuery = useQuery({
    queryKey: ['crypto-public-futures-tickers'],
    queryFn: async ({ signal }) => {
      const response = await authorizedFetch('/api/crypto/futures/tickers', { signal, headers: { 'Cache-Control': 'no-cache' } });
      const payload = await json<{ tickers?: CryptoFuturesTicker[]; updatedAt?: string; error?: string }>(response, {});
      if (!response.ok || !Array.isArray(payload.tickers)) throw new Error(payload.error ?? `HTTP_${response.status}`);
      return { tickers: payload.tickers, providerUpdatedAt: payload.updatedAt ?? new Date().toISOString() };
    },
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: 2,
  });

  const candleSymbols = useMemo(() => [...(tickersQuery.data?.tickers ?? [])]
    .filter((item) => item.symbol)
    .sort((a, b) => Number(b.tradingValue24h ?? 0) - Number(a.tradingValue24h ?? 0) || a.symbol.localeCompare(b.symbol))
    .slice(0, 20)
    .map((item) => item.symbol), [tickersQuery.data]);
  const candleKey = candleSymbols.join('|');

  const candlesQuery = useQuery({
    queryKey: ['crypto-public-futures-candles', timeframe, candleKey],
    queryFn: async ({ signal }) => {
      const rows = new Map<string, CryptoFuturesCandle[]>();
      const errors: string[] = [];
      for (let index = 0; index < candleSymbols.length; index += 4) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const batch = candleSymbols.slice(index, index + 4);
        const settled = await Promise.allSettled(batch.map(async (symbol) => {
          const response = await authorizedFetch(`/api/crypto/futures/candles?symbol=${encodeURIComponent(symbol)}&granularity=${encodeURIComponent(timeframe)}&limit=120`, { signal, headers: { 'Cache-Control': 'no-cache' } });
          const payload = await json<{ candles?: CryptoFuturesCandle[]; error?: string }>(response, {});
          if (!response.ok || !Array.isArray(payload.candles)) throw new Error(`${symbol}:${payload.error ?? `HTTP_${response.status}`}`);
          return { symbol, candles: payload.candles };
        }));
        for (const result of settled) {
          if (result.status === 'fulfilled') rows.set(result.value.symbol, result.value.candles);
          else errors.push(result.reason instanceof Error ? result.reason.message : 'CANDLE_PROVIDER_ERROR');
        }
      }
      return { rows, errors };
    },
    enabled: candleSymbols.length > 0,
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: 1,
  });

  const result = useMemo(() => scanCryptoFuturesMarket(
    tickersQuery.data?.tickers ?? [],
    candlesQuery.data?.rows ?? new Map(),
    filters,
    Date.now(),
  ), [tickersQuery.data, candlesQuery.data, filters]);

  function update<K extends keyof CryptoFuturesFilters>(key: K, value: CryptoFuturesFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function chooseTimeframe(value: Timeframe) {
    setTimeframe(value);
    window.localStorage.setItem(TIMEFRAME_KEY, value);
  }

  function save() {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...filters, query: '' }));
    window.localStorage.setItem(TIMEFRAME_KEY, timeframe);
    setMessage('코인 선물 검색 조건을 저장했습니다.');
  }

  function reset() {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(TIMEFRAME_KEY);
    setFilters(DEFAULT_CRYPTO_FUTURES_FILTERS);
    setTimeframe('15m');
    setMessage('코인 선물 검색 조건을 기본값으로 초기화했습니다.');
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background pb-24 text-foreground">
      <header className="border-b border-card-border bg-background px-4 pb-4 pt-5">
        <div className="mx-auto max-w-6xl">
          <div className="flex items-start justify-between gap-3"><div><p className="text-[11px] font-extrabold text-primary">기술탭 · 공개 시세 전용</p><h1 className="text-xl font-black">코인 선물 신호검색기</h1><p className="mt-1 text-xs text-muted-foreground">Bitget USDT 선물 · 계좌·포지션·주문 API 호출 없음</p></div><button type="button" onClick={() => { void tickersQuery.refetch(); void candlesQuery.refetch(); }} aria-label="코인 선물 시세 새로고침" className="rounded-full border border-card-border bg-card p-2.5"><RefreshCw className={cn('h-4 w-4', (tickersQuery.isFetching || candlesQuery.isFetching) && 'animate-spin')} /></button></div>
          <div className="mt-4 grid grid-cols-3 gap-2"><button type="button" onClick={() => assetMode.setAsset('stock')} className="rounded-xl border border-card-border bg-card px-2 py-2 text-xs font-extrabold">주식</button><button type="button" onClick={() => assetMode.setCoinMarket('spot')} className="rounded-xl border border-card-border bg-card px-2 py-2 text-xs font-extrabold">코인 현물</button><button type="button" className="rounded-xl border border-primary bg-primary px-2 py-2 text-xs font-extrabold text-primary-foreground">코인 선물</button></div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 p-4">
        <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-black">검색 조건</h2><p className="mt-1 text-[10px] font-bold text-muted-foreground">공개 시세는 15초, 상위 20개 기술 캔들은 30초마다 갱신합니다.</p></div><div className="flex gap-1"><button type="button" onClick={save} aria-label="코인 선물 검색 조건 저장" className="rounded-xl border border-card-border p-2"><Save className="h-4 w-4" /></button><button type="button" onClick={reset} aria-label="코인 선물 검색 조건 초기화" className="rounded-xl border border-card-border p-2"><RotateCcw className="h-4 w-4" /></button></div></div>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">{TIMEFRAMES.map((item) => <button key={item} type="button" onClick={() => chooseTimeframe(item)} className={cn('shrink-0 rounded-xl border px-3 py-2 text-xs font-extrabold', timeframe === item ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-background')}>{item}</button>)}</div>
          <label className="mt-3 flex items-center gap-2 rounded-2xl border border-card-border bg-background px-3 py-2"><Search className="h-4 w-4 text-muted-foreground" /><input aria-label="코인 선물 종목 검색" value={filters.query} onChange={(event) => update('query', event.target.value)} placeholder="BTCUSDT" className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none" /></label>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <NumberFilter label="최소 거래대금 USDT" value={filters.minimumTradingValueUsdt} step={1_000_000} onChange={(value) => update('minimumTradingValueUsdt', value)} />
            <NumberFilter label="최소 거래량" value={filters.minimumVolume24h} step={1_000} onChange={(value) => update('minimumVolume24h', value)} />
            <NumberFilter label="최소 OI" value={filters.minimumOpenInterest} step={1_000} onChange={(value) => update('minimumOpenInterest', value)} />
            <NumberFilter label="최소 등락률%" value={filters.minimumChangePercent} step={1} min={-100} onChange={(value) => update('minimumChangePercent', value)} />
            <NumberFilter label="최대 등락률%" value={filters.maximumChangePercent} step={1} min={-100} onChange={(value) => update('maximumChangePercent', value)} />
            <NumberFilter label="최소 점수" value={filters.minimumScore} step={5} min={0} max={100} onChange={(value) => update('minimumScore', value)} />
            <NumberFilter label="최대 위험" value={filters.maximumRiskScore} step={5} min={0} max={100} onChange={(value) => update('maximumRiskScore', value)} />
            <label className="rounded-xl border border-card-border bg-background p-2 text-[10px] font-bold text-muted-foreground">방향<select aria-label="코인 선물 방향" value={filters.direction} onChange={(event) => update('direction', event.target.value as FuturesDirectionFilter)} className="mt-1 w-full bg-transparent text-xs font-extrabold text-foreground"><option value="ALL">전체</option><option value="LONG">롱</option><option value="SHORT">숏</option><option value="WAIT">관망</option></select></label>
            <label className="rounded-xl border border-card-border bg-background p-2 text-[10px] font-bold text-muted-foreground">기술 조건<select aria-label="코인 선물 기술 조건" value={filters.technical} onChange={(event) => update('technical', event.target.value as FuturesTechnicalFilter)} className="mt-1 w-full bg-transparent text-xs font-extrabold text-foreground"><option value="all">전체</option><option value="volume">거래량 증가</option><option value="breakout">돌파</option><option value="pullback">눌림</option><option value="rsiOversold">RSI 과매도</option><option value="rsiOverbought">RSI 과열</option><option value="trend">추세</option></select></label>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs"><label className="flex items-center gap-2 rounded-xl border border-card-border bg-background p-3 font-bold"><input type="checkbox" checked={filters.excludeStale} onChange={(event) => update('excludeStale', event.target.checked)} />지연 시세 제외</label><label className="flex items-center gap-2 rounded-xl border border-card-border bg-background p-3 font-bold"><input type="checkbox" checked={filters.excludeChaseRisk} onChange={(event) => update('excludeChaseRisk', event.target.checked)} />급변 추격 제외</label></div>
          {message ? <p role="status" className="mt-3 rounded-xl bg-secondary p-2 text-xs font-bold">{message}</p> : null}
        </section>

        {candlesQuery.data?.errors.length ? <p className="flex gap-2 rounded-2xl border border-warning/30 bg-warning/10 p-3 text-xs font-bold"><AlertTriangle className="h-4 w-4 shrink-0 text-warning" />일부 캔들 공급자 실패 {candlesQuery.data.errors.length}건 · 성공한 종목은 계속 표시하고 실패 종목은 위험 점수를 높입니다.</p> : null}
        {tickersQuery.isError ? <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 text-center"><p className="text-sm font-extrabold text-destructive">선물 시세 공급자 오류</p><p className="mt-2 text-xs text-muted-foreground">{tickersQuery.error instanceof Error ? tickersQuery.error.message : 'BITGET_TICKERS_UNAVAILABLE'}</p><button type="button" onClick={() => void tickersQuery.refetch()} className="mt-3 rounded-xl bg-primary px-4 py-2 text-xs font-extrabold text-primary-foreground">다시 시도</button></section> : null}

        {!tickersQuery.isError ? <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-black">검색 결과 {result.rows.length}개</h2><p className="mt-1 text-[10px] font-bold text-muted-foreground">전체 {result.scanned} · 제외 {result.excludedCount} · 중복 제거 {result.duplicateCount}</p></div><div className="text-right text-[10px] font-bold text-muted-foreground"><p>공급자 기준 {tickersQuery.data?.providerUpdatedAt ? new Date(tickersQuery.data.providerUpdatedAt).toLocaleString('ko-KR') : '-'}</p><p>필터 계산 {new Date(result.updatedAt).toLocaleString('ko-KR')}</p></div></div>
          {tickersQuery.isLoading ? <p className="mt-4 rounded-2xl bg-background p-6 text-center text-sm font-bold text-muted-foreground">Bitget 선물 시세를 불러오는 중...</p> : result.rows.length === 0 ? <p className="mt-4 rounded-2xl border border-dashed border-card-border bg-background p-6 text-center text-sm font-bold">조건에 맞는 선물 종목이 없습니다. 조회 오류와 구분된 정상 0건입니다.</p> : <div className="mt-4 space-y-2">{result.rows.slice(0, 100).map((row, index) => <article key={row.symbol} className="rounded-2xl border border-card-border bg-background p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong>{index + 1}위 · {row.symbol}</strong><span className={cn('rounded-full px-2 py-1 text-[10px] font-extrabold', row.direction === 'LONG' ? 'bg-positive/10 text-positive' : row.direction === 'SHORT' ? 'bg-destructive/10 text-destructive' : 'bg-secondary text-muted-foreground')}>{row.direction}</span>{row.chaseRisk ? <span className="rounded-full bg-warning/10 px-2 py-1 text-[10px] font-extrabold text-warning">추격 위험</span> : null}</div><p className="mt-1 text-xs font-bold text-muted-foreground">가격 {price(row.markPrice)} · 24h {percent(row.changePercent24h)} · 거래대금 {compact(row.tradingValue24h, ' USDT')}</p><p className="mt-1 text-[10px] font-bold text-muted-foreground">롱 {row.longScore} · 숏 {row.shortScore} · RSI {row.rsi == null ? '-' : row.rsi.toFixed(1)} · 거래량배수 {row.volumeRatio == null ? '-' : `${row.volumeRatio.toFixed(2)}x`} · 펀딩 {percent(row.fundingRatePercent, 4)} · OI {compact(row.openInterest)}</p><div className="mt-2 flex flex-wrap gap-1">{row.matched.map((item) => <span key={item} className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-bold text-primary">{item}</span>)}{row.warnings.map((item) => <span key={item} className="rounded-full bg-destructive/10 px-2 py-1 text-[10px] font-bold text-destructive">{item}</span>)}</div><p className="mt-2 text-[10px] font-bold text-muted-foreground">데이터 {row.dataState} · 기준시각 {row.timestamp ? new Date(row.timestamp).toLocaleString('ko-KR') : '-'}</p></div><div className="shrink-0 text-right"><p className="text-lg font-black text-primary">{row.score}점</p><p className="text-[10px] font-bold text-muted-foreground">위험 {row.riskScore}</p><button type="button" onClick={() => navigate(`/stock-info?asset=coin&coinMarket=futures&symbol=${encodeURIComponent(row.symbol.replace(/USDT$/, ''))}`)} className="mt-2 rounded-xl border border-card-border px-2 py-1.5 text-[10px] font-extrabold">상세</button></div></div></article>)}</div>}
        </section> : null}

        <p className="flex gap-2 rounded-2xl border border-primary/20 bg-primary/5 p-3 text-[10px] font-semibold leading-4 text-muted-foreground"><ShieldCheck className="h-4 w-4 shrink-0 text-primary" />이 화면은 공개 Bitget 시세·캔들만 조회합니다. 비공개 계좌·포지션·주문·자동매매 API를 호출하거나 버튼으로 노출하지 않습니다.</p>
      </main>
      <BottomNav />
    </div>
  );
}

function NumberFilter({ label, value, step, min = 0, max = Number.MAX_SAFE_INTEGER, onChange }: { label: string; value: number; step: number; min?: number; max?: number; onChange: (value: number) => void }) {
  return <label className="rounded-xl border border-card-border bg-background p-2 text-[10px] font-bold text-muted-foreground">{label}<input type="number" aria-label={label} value={value} step={step} min={min} max={max} onChange={(event) => onChange(Math.min(max, Math.max(min, Number(event.target.value) || 0)))} className="mt-1 w-full bg-transparent text-xs font-extrabold text-foreground outline-none" /></label>;
}
