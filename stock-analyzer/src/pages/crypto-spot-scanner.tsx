import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw, RotateCcw, Save, Search, ShieldCheck } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAssetMode } from '@/lib/asset-mode';
import {
  DEFAULT_CRYPTO_SPOT_FILTERS,
  scanCryptoSpotMarket,
  type CryptoSpotMarket,
  type CryptoSpotScannerFilters,
  type CryptoSpotTicker,
  type CryptoSpotTrend,
} from '@/lib/crypto-spot-scanner';
import { cn } from '@/lib/utils';

const STORAGE_KEY = 'crypto-spot-scanner-filters-v1';

function loadFilters(): CryptoSpotScannerFilters {
  if (typeof window === 'undefined') return DEFAULT_CRYPTO_SPOT_FILTERS;
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      ...DEFAULT_CRYPTO_SPOT_FILTERS,
      ...value,
      query: '',
      trend: ['all', 'gainers', 'losers', 'breakout', 'pullback', 'surge', 'plunge'].includes(value.trend)
        ? value.trend
        : 'all',
    };
  } catch {
    return DEFAULT_CRYPTO_SPOT_FILTERS;
  }
}

async function json<T>(response: Response, fallback: T) {
  return response.json().catch(() => fallback) as Promise<T>;
}

function formatKrw(value: number | null | undefined) {
  if (!Number.isFinite(Number(value))) return '-';
  return `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: Number(value) < 1 ? 8 : 0 }).format(Number(value))}원`;
}

function compactKrw(value: number | null | undefined) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  if (number >= 1_000_000_000_000) return `${(number / 1_000_000_000_000).toFixed(1)}조`;
  if (number >= 100_000_000) return `${(number / 100_000_000).toFixed(1)}억`;
  if (number >= 10_000) return `${(number / 10_000).toFixed(1)}만`;
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(number);
}

function percent(value: number | null | undefined) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return `${number > 0 ? '+' : ''}${number.toFixed(2)}%`;
}

export default function CryptoSpotScannerPage() {
  const assetMode = useAssetMode();
  const [, navigate] = useLocation();
  const [filters, setFilters] = useState<CryptoSpotScannerFilters>(loadFilters);
  const [message, setMessage] = useState('');

  const source = useQuery({
    queryKey: ['crypto-spot-scanner-source'],
    queryFn: async ({ signal }) => {
      const [marketsResult, tickersResult] = await Promise.allSettled([
        authorizedFetch('/api/crypto/spot/markets', { signal, headers: { 'Cache-Control': 'no-cache' } }),
        authorizedFetch('/api/crypto/spot/tickers', { signal, headers: { 'Cache-Control': 'no-cache' } }),
      ]);
      if (tickersResult.status !== 'fulfilled') throw tickersResult.reason;
      const tickerPayload = await json<{ tickers?: CryptoSpotTicker[]; updatedAt?: string; error?: string }>(tickersResult.value, {});
      if (!tickersResult.value.ok || !Array.isArray(tickerPayload.tickers)) {
        throw new Error(tickerPayload.error ?? 'UPBIT_TICKERS_UNAVAILABLE');
      }
      let markets: CryptoSpotMarket[] = [];
      let marketProviderError: string | null = null;
      if (marketsResult.status === 'fulfilled') {
        const marketPayload = await json<{ markets?: CryptoSpotMarket[]; error?: string }>(marketsResult.value, {});
        if (marketsResult.value.ok && Array.isArray(marketPayload.markets)) markets = marketPayload.markets;
        else marketProviderError = marketPayload.error ?? `HTTP_${marketsResult.value.status}`;
      } else {
        marketProviderError = marketsResult.reason instanceof Error ? marketsResult.reason.message : 'UPBIT_MARKETS_UNAVAILABLE';
      }
      return {
        markets,
        tickers: tickerPayload.tickers,
        providerUpdatedAt: tickerPayload.updatedAt ?? new Date().toISOString(),
        marketProviderError,
      };
    },
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: 2,
  });

  const result = useMemo(() => scanCryptoSpotMarket(
    source.data?.markets ?? [],
    source.data?.tickers ?? [],
    filters,
    Date.now(),
  ), [source.data, filters]);

  function update<K extends keyof CryptoSpotScannerFilters>(key: K, value: CryptoSpotScannerFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function save() {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...filters, query: '' }));
    setMessage('코인 현물 검색 조건을 저장했습니다.');
  }

  function reset() {
    window.localStorage.removeItem(STORAGE_KEY);
    setFilters(DEFAULT_CRYPTO_SPOT_FILTERS);
    setMessage('코인 현물 검색 조건을 기본값으로 초기화했습니다.');
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background pb-24 text-foreground">
      <header className="border-b border-card-border bg-background px-4 pb-4 pt-5">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-start justify-between gap-3">
            <div><p className="text-[11px] font-extrabold text-primary">기술탭 · 공개 시세 전용</p><h1 className="text-xl font-black">코인 현물 신호검색기</h1><p className="mt-1 text-xs text-muted-foreground">Upbit KRW 현물 · 실제 주문 기능 없음</p></div>
            <button type="button" onClick={() => void source.refetch()} aria-label="코인 현물 시세 새로고침" className="rounded-full border border-card-border bg-card p-2.5"><RefreshCw className={cn('h-4 w-4', source.isFetching && 'animate-spin')} /></button>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <button type="button" onClick={() => assetMode.setAsset('stock')} className="rounded-xl border border-card-border bg-card px-2 py-2 text-xs font-extrabold">주식</button>
            <button type="button" className="rounded-xl border border-primary bg-primary px-2 py-2 text-xs font-extrabold text-primary-foreground">코인 현물</button>
            <button type="button" onClick={() => assetMode.setCoinMarket('futures')} className="rounded-xl border border-card-border bg-card px-2 py-2 text-xs font-extrabold">코인 선물</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 p-4">
        <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-black">검색 조건</h2><p className="mt-1 text-[10px] font-bold text-muted-foreground">필터 변경은 이미 받은 현물 데이터에 즉시 적용되며 중복 네트워크 요청을 만들지 않습니다.</p></div><div className="flex gap-1"><button type="button" onClick={save} aria-label="코인 현물 검색 조건 저장" className="rounded-xl border border-card-border p-2"><Save className="h-4 w-4" /></button><button type="button" onClick={reset} aria-label="코인 현물 검색 조건 초기화" className="rounded-xl border border-card-border p-2"><RotateCcw className="h-4 w-4" /></button></div></div>
          <label className="mt-3 flex items-center gap-2 rounded-2xl border border-card-border bg-background px-3 py-2"><Search className="h-4 w-4 text-muted-foreground" /><input aria-label="코인 현물 종목 검색" value={filters.query} onChange={(event) => update('query', event.target.value)} placeholder="심볼 또는 한글명" className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none" /></label>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <NumberFilter label="최소 거래대금" value={filters.minimumTradingValueKrw} step={100_000_000} onChange={(value) => update('minimumTradingValueKrw', value)} />
            <NumberFilter label="최소 거래량" value={filters.minimumVolume24h} step={1_000} onChange={(value) => update('minimumVolume24h', value)} />
            <NumberFilter label="최소 등락률%" value={filters.minimumChangePercent} step={1} onChange={(value) => update('minimumChangePercent', value)} />
            <NumberFilter label="최대 등락률%" value={filters.maximumChangePercent} step={1} onChange={(value) => update('maximumChangePercent', value)} />
            <NumberFilter label="최소 점수" value={filters.minimumScore} step={5} min={0} max={100} onChange={(value) => update('minimumScore', value)} />
            <NumberFilter label="최대 위험" value={filters.maximumRiskScore} step={5} min={0} max={100} onChange={(value) => update('maximumRiskScore', value)} />
            <label className="rounded-xl border border-card-border bg-background p-2 text-[10px] font-bold text-muted-foreground">추세 조건<select aria-label="코인 현물 추세 조건" value={filters.trend} onChange={(event) => update('trend', event.target.value as CryptoSpotTrend)} className="mt-1 w-full bg-transparent text-xs font-extrabold text-foreground"><option value="all">전체</option><option value="gainers">상승</option><option value="losers">하락</option><option value="breakout">돌파 근접</option><option value="pullback">눌림</option><option value="surge">급등 10%+</option><option value="plunge">급락 -10% 이하</option></select></label>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <label className="flex items-center gap-2 rounded-xl border border-card-border bg-background p-3 font-bold"><input type="checkbox" checked={filters.excludeWarnings} onChange={(event) => update('excludeWarnings', event.target.checked)} />유의 종목 제외</label>
            <label className="flex items-center gap-2 rounded-xl border border-card-border bg-background p-3 font-bold"><input type="checkbox" checked={filters.excludeStale} onChange={(event) => update('excludeStale', event.target.checked)} />지연 시세 제외</label>
          </div>
          {message ? <p role="status" className="mt-3 rounded-xl bg-secondary p-2 text-xs font-bold">{message}</p> : null}
        </section>

        {source.data?.marketProviderError ? <p className="flex gap-2 rounded-2xl border border-warning/30 bg-warning/10 p-3 text-xs font-bold"><AlertTriangle className="h-4 w-4 shrink-0 text-warning" />마켓 이름 공급자 일부 실패 · 심볼로 결과를 계속 표시합니다. {source.data.marketProviderError}</p> : null}
        {source.isError ? <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 text-center"><p className="text-sm font-extrabold text-destructive">현물 시세 공급자 오류</p><p className="mt-2 text-xs text-muted-foreground">{source.error instanceof Error ? source.error.message : 'UPBIT_TICKERS_UNAVAILABLE'}</p><button type="button" onClick={() => void source.refetch()} className="mt-3 rounded-xl bg-primary px-4 py-2 text-xs font-extrabold text-primary-foreground">다시 시도</button></section> : null}

        {!source.isError ? <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-black">검색 결과 {result.rows.length}개</h2><p className="mt-1 text-[10px] font-bold text-muted-foreground">전체 {result.scanned} · 제외 {result.excludedCount} · 중복 제거 {result.duplicateCount}</p></div><div className="text-right text-[10px] font-bold text-muted-foreground"><p>공급자 기준 {source.data?.providerUpdatedAt ? new Date(source.data.providerUpdatedAt).toLocaleString('ko-KR') : '-'}</p><p>필터 계산 {new Date(result.updatedAt).toLocaleString('ko-KR')}</p></div></div>
          {source.isLoading ? <p className="mt-4 rounded-2xl bg-background p-6 text-center text-sm font-bold text-muted-foreground">Upbit 현물 시세를 불러오는 중...</p> : result.rows.length === 0 ? <p className="mt-4 rounded-2xl border border-dashed border-card-border bg-background p-6 text-center text-sm font-bold">조건에 맞는 현물 종목이 없습니다. 조회 오류와 구분된 정상 0건입니다.</p> : <div className="mt-4 space-y-2">{result.rows.slice(0, 100).map((row, index) => <article key={row.symbol} className="rounded-2xl border border-card-border bg-background p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong>{index + 1}위 · {row.name}</strong><span className="rounded-full bg-secondary px-2 py-1 text-[10px] font-bold">{row.symbol}</span>{row.chaseRisk ? <span className="rounded-full bg-warning/10 px-2 py-1 text-[10px] font-extrabold text-warning">추격 위험</span> : null}</div><p className="mt-1 text-xs font-bold text-muted-foreground">현재가 {formatKrw(row.price)} · 24h {percent(row.changePercent)} · 거래대금 {compactKrw(row.tradingValue24h)}</p><div className="mt-2 flex flex-wrap gap-1">{row.matched.map((item) => <span key={item} className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-bold text-primary">{item}</span>)}{row.warnings.map((item) => <span key={item} className="rounded-full bg-destructive/10 px-2 py-1 text-[10px] font-bold text-destructive">{item}</span>)}</div><p className="mt-2 text-[10px] font-bold text-muted-foreground">데이터 {row.dataState} · 기준시각 {row.timestamp ? new Date(row.timestamp).toLocaleString('ko-KR') : '-'}</p></div><div className="shrink-0 text-right"><p className="text-lg font-black text-primary">{row.score}점</p><p className="text-[10px] font-bold text-muted-foreground">위험 {row.riskScore}</p><button type="button" onClick={() => navigate(`/stock-info?asset=coin&coinMarket=spot&symbol=${encodeURIComponent(row.symbol)}`)} className="mt-2 rounded-xl border border-card-border px-2 py-1.5 text-[10px] font-extrabold">상세</button></div></div></article>)}</div>}
        </section> : null}

        <p className="flex gap-2 rounded-2xl border border-primary/20 bg-primary/5 p-3 text-[10px] font-semibold leading-4 text-muted-foreground"><ShieldCheck className="h-4 w-4 shrink-0 text-primary" />이 화면은 공개 현물 시세 검색만 수행합니다. 계좌·잔고·주문 API를 호출하지 않으며 승인 또는 자동매매 버튼을 제공하지 않습니다.</p>
      </main>
      <BottomNav />
    </div>
  );
}

function NumberFilter({ label, value, step, min = -100, max = Number.MAX_SAFE_INTEGER, onChange }: { label: string; value: number; step: number; min?: number; max?: number; onChange: (value: number) => void }) {
  return <label className="rounded-xl border border-card-border bg-background p-2 text-[10px] font-bold text-muted-foreground">{label}<input type="number" aria-label={label} value={value} step={step} min={min} max={max} onChange={(event) => onChange(Math.min(max, Math.max(min, Number(event.target.value) || 0)))} className="mt-1 w-full bg-transparent text-xs font-extrabold text-foreground outline-none" /></label>;
}
