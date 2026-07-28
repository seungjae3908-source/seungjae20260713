import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Bell, ChevronDown, ChevronUp, RefreshCw, Search, Star, X } from 'lucide-react';
import { ColorType, createChart, type UTCTimestamp } from 'lightweight-charts';
import { BottomNav } from '@/components/bottom-nav';
import { AppModal } from '@/components/app-modal';
import { apiGet } from '@/lib/api';
import { useAssetMode } from '@/lib/asset-mode';
import { displayCoinName, formatAppPercent, formatAppPrice } from '@/lib/stock-display';
import { cn } from '@/lib/utils';

export type CoinSpotViewMode = 'condition' | 'chart' | 'auto';

type AnyObj = Record<string, any>;
type SpotTimeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '60m' | '240m' | '1D' | '1W' | '1M';

type Candidate = {
  symbol: string;
  name: string;
  opinion: '매수' | '관망' | '매도';
  buyScore: number;
  sellScore: number;
  price: number | null;
  changePercent: number | null;
  reasons: string[];
  risks: string[];
};

type SpotPosition = {
  symbol: string;
  name: string;
  balance: number;
  locked: number;
  total: number;
  averageBuyPrice: number;
  currentPrice: number | null;
  cost: number;
  marketValue: number | null;
  profitAmount: number | null;
  profitPercent: number | null;
};

type SpotJournalEntry = {
  id: string;
  market: string;
  symbol: string;
  side: string;
  sideLabel: string;
  orderType: string;
  state: string;
  price: number | null;
  averagePrice: number | null;
  volume: number | null;
  remainingVolume: number | null;
  executedVolume: number | null;
  executedFunds: number | null;
  paidFee: number | null;
  tradesCount: number;
  createdAt: string;
};

const TIMEFRAMES: { key: SpotTimeframe; label: string }[] = [
  { key: '1m', label: '1분' },
  { key: '3m', label: '3분' },
  { key: '5m', label: '5분' },
  { key: '15m', label: '15분' },
  { key: '30m', label: '30분' },
  { key: '60m', label: '1시간' },
  { key: '240m', label: '4시간' },
  { key: '1D', label: '일봉' },
  { key: '1W', label: '주봉' },
  { key: '1M', label: '월봉' },
];

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timeframeUrl(symbol: string, timeframe: SpotTimeframe) {
  if (timeframe === '1D' || timeframe === '1W' || timeframe === '1M') {
    return `/crypto/spot/candles?symbol=${encodeURIComponent(symbol)}&tf=${timeframe}&count=200`;
  }
  return `/crypto/spot/candles?symbol=${encodeURIComponent(symbol)}&unit=${Number(timeframe.replace('m', ''))}&count=200`;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function rsi(values: number[], period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  const rows = values.slice(-(period + 1));
  for (let index = 1; index < rows.length; index += 1) {
    const change = rows[index] - rows[index - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function analyzeCandles(candles: AnyObj[]) {
  const closes = candles.map((row) => finite(row.close)).filter((value): value is number => value != null);
  const volumes = candles.map((row) => finite(row.volume)).filter((value): value is number => value != null);
  const current = closes.at(-1) ?? null;
  const previous = closes.at(-2) ?? current;
  const sma5 = average(closes.slice(-5));
  const sma20 = average(closes.slice(-20));
  const currentRsi = rsi(closes);
  const recentVolume = volumes.at(-1) ?? 0;
  const averageVolume = average(volumes.slice(-21, -1));
  const volumeRatio = averageVolume > 0 ? recentVolume / averageVolume : null;

  let buyScore = 35;
  let sellScore = 35;
  const reasons: string[] = [];
  const risks: string[] = [];

  if (current != null && sma5 && current > sma5) {
    buyScore += 14;
    reasons.push('현재가가 단기 이동평균선 위에 있습니다.');
  } else {
    sellScore += 12;
    risks.push('현재가가 단기 이동평균선 아래에 있습니다.');
  }
  if (sma5 && sma20 && sma5 > sma20) {
    buyScore += 16;
    reasons.push('단기 이동평균선이 중기 이동평균선보다 높아 상승 추세가 우세합니다.');
  } else {
    sellScore += 14;
    risks.push('단기 이동평균선이 중기 이동평균선보다 낮아 하락 추세를 확인해야 합니다.');
  }
  if (currentRsi != null) {
    if (currentRsi >= 50 && currentRsi <= 70) {
      buyScore += 12;
      reasons.push(`RSI ${currentRsi.toFixed(1)}로 상승 힘이 유지되는 구간입니다.`);
    } else if (currentRsi > 75) {
      sellScore += 13;
      risks.push(`RSI ${currentRsi.toFixed(1)}로 단기 과열 가능성이 있습니다.`);
    } else if (currentRsi < 35) {
      buyScore += 7;
      reasons.push(`RSI ${currentRsi.toFixed(1)}로 과매도 반등 가능성을 확인합니다.`);
    } else {
      sellScore += 5;
    }
  }
  if (volumeRatio != null && volumeRatio >= 1.5) {
    buyScore += current != null && previous != null && current >= previous ? 13 : 4;
    sellScore += current != null && previous != null && current < previous ? 13 : 0;
    (current != null && previous != null && current >= previous ? reasons : risks).push(`최근 거래량이 평균의 ${volumeRatio.toFixed(1)}배입니다.`);
  }
  if (current != null && previous != null && current > previous) buyScore += 8;
  if (current != null && previous != null && current < previous) sellScore += 8;

  buyScore = Math.max(0, Math.min(100, Math.round(buyScore)));
  sellScore = Math.max(0, Math.min(100, Math.round(sellScore)));
  const opinion = buyScore - sellScore >= 12 ? '매수' : sellScore - buyScore >= 12 ? '매도' : '관망';
  return { current, sma5, sma20, rsi: currentRsi, volumeRatio, buyScore, sellScore, opinion, reasons, risks };
}

function buildCandidate(row: AnyObj, name: string): Candidate {
  const change = finite(row.changePercent);
  const value = finite(row.tradingValue24h);
  const volume = finite(row.volume24h);
  let buyScore = 45;
  let sellScore = 35;
  const reasons: string[] = [];
  const risks: string[] = [];
  if (change != null && change > 0) {
    buyScore += Math.min(25, Math.round(change * 3));
    reasons.push(`24시간 등락률이 ${formatAppPercent(change)}로 상승 흐름입니다.`);
  } else if (change != null && change < 0) {
    sellScore += Math.min(25, Math.round(Math.abs(change) * 3));
    risks.push(`24시간 등락률이 ${formatAppPercent(change)}로 하락 흐름입니다.`);
  }
  if (value != null && value > 0) {
    buyScore += 10;
    reasons.push('24시간 거래대금이 확인되어 유동성 조건을 통과했습니다.');
  }
  if (volume == null || volume <= 0) risks.push('거래량 데이터가 부족해 신뢰도를 낮췄습니다.');
  buyScore = Math.max(0, Math.min(100, buyScore));
  sellScore = Math.max(0, Math.min(100, sellScore));
  return {
    symbol: String(row.symbol),
    name,
    opinion: buyScore - sellScore >= 12 ? '매수' : sellScore - buyScore >= 12 ? '매도' : '관망',
    buyScore,
    sellScore,
    price: finite(row.price),
    changePercent: change,
    reasons: reasons.length ? reasons : ['실제 시세와 거래량 조건을 종합해 관망 후보로 분류했습니다.'],
    risks: risks.length ? risks : ['시장 전체 급락과 변동성 확대 시 신호가 빠르게 바뀔 수 있습니다.'],
  };
}

function SpotChart({ candles }: { candles: AnyObj[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = ref.current;
    if (!container || !candles.length) return;
    const chart = createChart(container, {
      height: 360,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8' },
      grid: { vertLines: { color: 'rgba(148,163,184,.08)' }, horzLines: { color: 'rgba(148,163,184,.08)' } },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    const candleSeries = chart.addCandlestickSeries();
    const volumeSeries = chart.addHistogramSeries({ priceScaleId: '', priceFormat: { type: 'volume' } });
    const normalized = candles.map((row, index) => {
      const parsed = Date.parse(String(row.time ?? ''));
      const time = Math.floor((Number.isFinite(parsed) ? parsed : Date.now() - (candles.length - index) * 60_000) / 1000) as UTCTimestamp;
      return { time, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume ?? 0) };
    }).filter((row) => [row.open, row.high, row.low, row.close].every(Number.isFinite));
    candleSeries.setData(normalized.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    volumeSeries.setData(normalized.map(({ time, volume }) => ({ time, value: volume })));
    chart.timeScale().fitContent();
    const observer = new ResizeObserver(([entry]) => chart.applyOptions({ width: Math.max(1, entry.contentRect.width) }));
    observer.observe(container);
    return () => { observer.disconnect(); chart.remove(); };
  }, [candles]);
  return <div ref={ref} className="w-full" />;
}

export function CoinSpotTools({
  viewMode,
  onViewModeChange,
  onBackToStock,
  onOpenFutures,
}: {
  viewMode: CoinSpotViewMode;
  onViewModeChange: (mode: CoinSpotViewMode) => void;
  onBackToStock: () => void;
  onOpenFutures: () => void;
}) {
  const [, navigate] = useLocation();
  const assetMode = useAssetMode();
  const [query, setQuery] = useState('');
  const [symbol, setSymbol] = useState('BTC');
  const [timeframe, setTimeframe] = useState<SpotTimeframe>('15m');
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [explanation, setExplanation] = useState<{ title: string; body: string } | null>(null);
  const [openSections, setOpenSections] = useState({
    analyzer: true,
    scores: true,
    ai: true,
    market: false,
    auto: true,
    positions: true,
    journal: true,
  });

  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections((current) => ({ ...current, [key]: !current[key] }));
  };

  useEffect(() => {
    assetMode.setAsset('coin');
    assetMode.setCoinMarket('spot');
  }, []);

  const markets = useQuery({ queryKey: ['coin-spot-tools-markets'], queryFn: () => apiGet<AnyObj>('/crypto/spot/markets'), staleTime: 600_000 });
  const tickers = useQuery({ queryKey: ['crypto-spot-tickers'], queryFn: () => apiGet<AnyObj>('/crypto/spot/tickers'), refetchInterval: 10_000, refetchIntervalInBackground: true });
  const candles = useQuery({
    queryKey: ['coin-spot-tools-candles', symbol, timeframe],
    queryFn: () => apiGet<AnyObj>(timeframeUrl(symbol, timeframe)),
    refetchInterval: timeframe.endsWith('m') ? 15_000 : 60_000,
    refetchIntervalInBackground: true,
  });
  const accounts = useQuery({ queryKey: ['coin-spot-tools-accounts'], queryFn: () => apiGet<AnyObj>('/crypto/spot/accounts'), enabled: viewMode === 'auto', retry: false, refetchInterval: 15_000 });
  const spotJournal = useQuery({ queryKey: ['coin-spot-tools-journal'], queryFn: () => apiGet<AnyObj>('/crypto/spot/journal?limit=100'), enabled: viewMode === 'auto', retry: false, refetchInterval: 30_000 });

  const names = useMemo(() => new Map<string, AnyObj>(((markets.data?.markets ?? []) as AnyObj[]).map((row) => [String(row.symbol), row])), [markets.data]);
  const rows = useMemo(() => ((tickers.data?.tickers ?? []) as AnyObj[]).map((row) => ({ ...row, ...(names.get(String(row.symbol)) ?? {}) })), [names, tickers.data]);
  const selected = rows.find((row) => String(row.symbol) === symbol) ?? null;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => !needle || [row.symbol, row.koreanName, row.englishName].some((value) => String(value ?? '').toLowerCase().includes(needle))).slice(0, 100);
  }, [query, rows]);
  const candleRows = (candles.data?.candles ?? []) as AnyObj[];
  const analysis = useMemo(() => analyzeCandles(candleRows), [candleRows]);
  const candidates = useMemo(() => rows
    .map((row) => buildCandidate(row, displayCoinName(String(row.symbol), row.koreanName, row.englishName)))
    .sort((a, b) => Math.max(b.buyScore, b.sellScore) - Math.max(a.buyScore, a.sellScore) || Math.abs(b.buyScore - b.sellScore) - Math.abs(a.buyScore - a.sellScore))
    .slice(0, 50), [rows]);
  const analyzerRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return candidates
      .filter((item) => !needle || [item.symbol, item.name].some((value) => value.toLowerCase().includes(needle)))
      .slice(0, 10);
  }, [candidates, query]);
  const spotPositions = useMemo<SpotPosition[]>(() => {
    const accountRows = (accounts.data?.accounts ?? []) as AnyObj[];
    return accountRows.flatMap((account) => {
      const accountSymbol = String(account.currency ?? '').toUpperCase();
      const balance = Number(account.balance ?? 0);
      const locked = Number(account.locked ?? 0);
      const total = balance + locked;
      if (!accountSymbol || accountSymbol === 'KRW' || !Number.isFinite(total) || total <= 0) return [];
      const ticker = rows.find((row) => String(row.symbol).toUpperCase() === accountSymbol);
      const currentPrice = finite(ticker?.price);
      const averageBuyPrice = Number(account.averageBuyPrice ?? 0);
      const cost = Number.isFinite(averageBuyPrice) ? averageBuyPrice * total : 0;
      const marketValue = currentPrice == null ? null : currentPrice * total;
      const profitAmount = marketValue == null ? null : marketValue - cost;
      const profitPercent = currentPrice == null || averageBuyPrice <= 0 ? null : ((currentPrice - averageBuyPrice) / averageBuyPrice) * 100;
      return [{
        symbol: accountSymbol,
        name: displayCoinName(accountSymbol, ticker?.koreanName, ticker?.englishName),
        balance,
        locked,
        total,
        averageBuyPrice,
        currentPrice,
        cost,
        marketValue,
        profitAmount,
        profitPercent,
      }];
    }).sort((a, b) => Number(b.marketValue ?? 0) - Number(a.marketValue ?? 0));
  }, [accounts.data, rows]);
  const journalEntries = (spotJournal.data?.entries ?? []) as SpotJournalEntry[];

  const pickSymbol = (next: string) => { setSymbol(next); setQuery(''); };

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background">
      <header className="border-b border-card-border px-4 pb-3 pt-4">
        <div className="flex items-center gap-3">
          <h1 className="flex-1 text-center text-xl font-black">기술</h1>
          <button type="button" onClick={() => { void tickers.refetch(); void candles.refetch(); }} className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border"><RefreshCw className={cn('h-4 w-4', (tickers.isFetching || candles.isFetching) && 'animate-spin')} /></button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {/* 최상단 탭 클릭은 부모에서 주식 → 국내로 초기화한다. */}
          {([
            ['condition', '조건검색'],
            ['chart', '신호검색기'],
            ['auto', '자동매매'],
          ] as const).map(([key, label]) => (
            <TopButton
              key={key}
              active={viewMode === key}
              onClick={() => onViewModeChange(key)}
            >
              {label}
            </TopButton>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2"><TopButton active={false} onClick={onBackToStock}>주식</TopButton><TopButton active onClick={() => undefined}>코인</TopButton></div>
        {/* 주식의 국내/해외와 동일한 토글 인터페이스: 선택된 쪽 강조, 반대쪽 클릭 시 전환 */}
        <div className="mt-2 grid grid-cols-2 gap-2"><TopButton active onClick={() => undefined}>현물</TopButton><TopButton active={false} onClick={onOpenFutures}>선물</TopButton></div>
      </header>

      <main className="space-y-4 p-4 pb-28">
        {viewMode === 'condition' && (
          <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
            <h2 className="text-center text-sm font-black">현물 조건검색</h2>
            <label className="mt-3 flex h-11 items-center gap-2 rounded-2xl border border-card-border bg-background px-3"><Search className="h-4 w-4 text-muted-foreground" /><input value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none" />{query && <button type="button" onClick={() => setQuery('')} aria-label="검색 닫기"><X className="h-4 w-4" /></button>}</label>
            <div className="mt-3 max-h-[58vh] space-y-2 overflow-y-auto">
              {filtered.map((row) => {
                const item = buildCandidate(row, displayCoinName(String(row.symbol), row.koreanName, row.englishName));
                return <button key={row.symbol} type="button" onClick={() => setCandidate(item)} className="w-full rounded-2xl border border-card-border bg-background p-3 text-left"><div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-black">{item.name}</p><p className="mt-1 text-[10px] font-bold text-muted-foreground">매수 {item.buyScore} · 매도 {item.sellScore} · {item.opinion}</p></div><div className="shrink-0 text-right"><p className="text-xs font-black">{formatAppPrice(item.price, 'KRW')}</p><p className={cn('text-[10px] font-black', Number(item.changePercent) >= 0 ? 'text-positive' : 'text-destructive')}>{formatAppPercent(item.changePercent)}</p></div></div></button>;
              })}
            </div>
          </section>
        )}

        {viewMode === 'chart' && (
          <>
            <UnifiedSectionCard
              title="종목 롱·숏 분석기"
              subtitle="종목 검색 · 매수·매도 강도가 높은 순서대로 최대 10종목"
              open={openSections.analyzer}
              onToggle={() => toggleSection('analyzer')}
            >
              <label className="flex h-11 items-center gap-2 rounded-2xl border border-card-border bg-background px-3">
                <Search className="h-4 w-4 text-muted-foreground" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none" />
                {query && <button type="button" onClick={() => setQuery('')} aria-label="검색 닫기"><X className="h-4 w-4" /></button>}
              </label>
              <div className="mt-3 space-y-2">
                {analyzerRows.map((item, index) => (
                  <button key={item.symbol} type="button" onClick={() => pickSymbol(item.symbol)} className={cn('w-full rounded-2xl border p-3 text-left', symbol === item.symbol ? 'border-primary bg-primary/5' : 'border-card-border bg-background')}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0"><p className="truncate text-sm font-black">{index + 1}위 · {item.name}</p><p className="mt-1 text-[10px] font-bold text-muted-foreground">{item.symbol} · {item.opinion}</p></div>
                      <div className="shrink-0 text-right"><p className="text-[10px] font-black text-positive">롱·매수 {item.buyScore}</p><p className="mt-1 text-[10px] font-black text-destructive">숏·매도 {item.sellScore}</p></div>
                    </div>
                  </button>
                ))}
                {!analyzerRows.length && <StateBox>검색 결과가 없습니다.</StateBox>}
              </div>
            </UnifiedSectionCard>

            <section className="overflow-hidden rounded-3xl border border-card-border bg-card shadow-sm">
              <div className="border-b border-card-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <button type="button" aria-label="관심종목">
                        <Star className="h-5 w-5 text-muted-foreground" />
                      </button>
                      <h2 className="truncate text-lg font-black">
                        {displayCoinName(symbol, selected?.koreanName, selected?.englishName)}
                      </h2>
                      <span className="rounded-full bg-secondary px-2 py-1 text-[9px] font-black">
                        {TIMEFRAMES.find((item) => item.key === timeframe)?.label}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] font-bold text-muted-foreground">
                      업비트 현물 · 실제 시세와 봉 데이터
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="알림"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-background"
                  >
                    <Bell className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {TIMEFRAMES.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setTimeframe(item.key)}
                      className={cn(
                        'rounded-xl border px-3 py-2 text-[10px] font-black',
                        timeframe === item.key
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-card-border bg-background text-muted-foreground',
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="min-h-[390px] bg-background/30">
                {candles.isLoading ? (
                  <StateBox>차트 데이터를 불러오는 중입니다.</StateBox>
                ) : candles.isError || !candleRows.length ? (
                  <StateBox>실제 차트 데이터를 제공받지 못했습니다.</StateBox>
                ) : (
                  <SpotChart candles={candleRows} />
                )}
              </div>
            </section>

            <UnifiedSectionCard
              title="매수·매도 점수와 종합신호"
              subtitle="실제 봉의 이동평균·RSI·거래량을 종합한 현물 신호"
              open={openSections.scores}
              onToggle={() => toggleSection('scores')}
            >
              <div className="grid grid-cols-3 gap-2 text-center">
                <Score label="매수 점수" value={`${analysis.buyScore}`} />
                <Score label="매도 점수" value={`${analysis.sellScore}`} />
                <Score label="종합신호" value={analysis.opinion} />
              </div>
              <p className="mt-3 text-left text-xs font-bold leading-5 text-muted-foreground">
                {analysis.reasons[0] ?? analysis.risks[0] ?? '선택 봉의 실데이터가 충분해질 때 분석을 표시합니다.'}
              </p>
            </UnifiedSectionCard>

            <UnifiedSectionCard
              title="차트 AI 분석"
              subtitle="선택한 시간봉의 기술지표와 판단 근거"
              open={openSections.ai}
              onToggle={() => toggleSection('ai')}
            >
              <div className="grid grid-cols-2 gap-2">
                <Metric
                  label="단기 이동평균"
                  value={analysis.sma5 == null ? '데이터 없음' : formatAppPrice(analysis.sma5, 'KRW')}
                />
                <Metric
                  label="중기 이동평균"
                  value={analysis.sma20 == null ? '데이터 없음' : formatAppPrice(analysis.sma20, 'KRW')}
                />
                <Metric
                  label="RSI"
                  value={analysis.rsi == null ? '데이터 없음' : analysis.rsi.toFixed(1)}
                />
                <Metric
                  label="거래량 비율"
                  value={analysis.volumeRatio == null ? '데이터 없음' : `${analysis.volumeRatio.toFixed(2)}배`}
                />
              </div>
              <div className="mt-3 space-y-2">
                {[...analysis.reasons, ...analysis.risks].slice(0, 5).map((row, index) => (
                  <p
                    key={`${row}:${index}`}
                    className="rounded-2xl bg-background p-3 text-left text-xs font-bold leading-5 text-muted-foreground"
                  >
                    {row}
                  </p>
                ))}
                {!analysis.reasons.length && !analysis.risks.length && (
                  <StateBox>분석할 실제 캔들 데이터가 부족합니다.</StateBox>
                )}
              </div>
            </UnifiedSectionCard>

            <UnifiedSectionCard
              title="현물 시장 데이터"
              subtitle="업비트 공개 데이터에서 실제 제공되는 항목만 표시"
              open={openSections.market}
              onToggle={() => toggleSection('market')}
            >
              <div className="grid grid-cols-2 gap-2">
                <Metric
                  label="24시간 거래량"
                  value={finite(selected?.volume24h)?.toLocaleString('ko-KR') ?? '데이터 없음'}
                />
                <Metric
                  label="24시간 거래대금"
                  value={formatAppPrice(finite(selected?.tradingValue24h), 'KRW')}
                />
              </div>
              <p className="mt-3 rounded-2xl bg-background p-3 text-left text-xs font-bold leading-5 text-muted-foreground">
                업비트 현물 공개 API는 주식의 개인·외국인·기관 수급과 공매도 잔고를 제공하지 않습니다. 지원되지 않는 수치는 만들지 않습니다.
              </p>
            </UnifiedSectionCard>
          </>
        )}

        {viewMode === 'auto' && (
          <>
            <UnifiedSectionCard
              title="현물 자동매매"
              subtitle="계좌 연결 상태, 주문 안전장치와 최종 승인"
              open={openSections.auto}
              onToggle={() => toggleSection('auto')}
            >
              <div className="grid grid-cols-2 gap-2">
                <StatusPill ok={!accounts.isError} label={`업비트 계좌 · ${accounts.isLoading ? '확인 중' : accounts.isError ? '키 설정 필요' : `${Number(accounts.data?.count ?? 0)}개 자산`}`} />
                <StatusPill ok label="실제 주문 · 최종 승인" />
                <StatusPill ok label="시세 연결 · 공개 API" />
                <StatusPill ok label="주문 보호 · 서버 검사" />
              </div>
              <div className="mt-3 rounded-2xl border border-card-border bg-background p-3"><p className="text-xs font-black">주문 안전 원칙</p><p className="mt-2 text-left text-xs font-bold leading-5 text-muted-foreground">실제 주문은 서버의 실행키·금액 상한·가격변동 검사와 사용자 최종 승인을 모두 통과한 경우에만 전송됩니다.</p></div>
            </UnifiedSectionCard>

            <UnifiedSectionCard
              title="실제 보유 포지션"
              subtitle="업비트 실제 계좌의 보유 수량·평균매수가·현재 평가손익"
              open={openSections.positions}
              onToggle={() => toggleSection('positions')}
            >
              <div className="flex justify-end"><button type="button" onClick={() => void accounts.refetch()} disabled={accounts.isFetching} className="rounded-full border border-card-border bg-background px-3 py-1.5 text-[10px] font-black disabled:opacity-50">{accounts.isFetching ? '갱신 중' : '새로고침'}</button></div>
              {accounts.isError ? <StateBox>업비트 계좌를 불러오지 못했습니다. 로그인과 API 키를 확인하세요.</StateBox> : !spotPositions.length ? <StateBox>현재 실제 보유 중인 코인 포지션이 없습니다.</StateBox> : (
                <div className="mt-3 space-y-2">{spotPositions.map((position) => (
                  <article key={position.symbol} className="rounded-2xl border border-card-border bg-background p-3">
                    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-black">{position.name} · {position.symbol}</p><p className="mt-1 text-[10px] font-bold text-muted-foreground">보유 {position.total.toLocaleString('ko-KR', { maximumFractionDigits: 8 })} · 주문잠김 {position.locked.toLocaleString('ko-KR', { maximumFractionDigits: 8 })}</p></div><p className={cn('shrink-0 text-sm font-black', Number(position.profitPercent ?? 0) > 0 ? 'text-positive' : Number(position.profitPercent ?? 0) < 0 ? 'text-destructive' : '')}>{position.profitPercent == null ? '-' : `${position.profitPercent > 0 ? '+' : ''}${position.profitPercent.toFixed(2)}%`}</p></div>
                    <div className="mt-3 grid grid-cols-2 gap-2"><Metric label="평균 매수가" value={formatAppPrice(position.averageBuyPrice, 'KRW')} /><Metric label="현재가" value={formatAppPrice(position.currentPrice, 'KRW')} /><Metric label="매수 원금" value={formatAppPrice(position.cost, 'KRW')} /><Metric label="평가금액" value={formatAppPrice(position.marketValue, 'KRW')} /></div>
                  </article>
                ))}</div>
              )}
            </UnifiedSectionCard>

            <UnifiedSectionCard
              title="자동매매 매매일지"
              subtitle="업비트 실제 체결·취소 주문내역 기준"
              open={openSections.journal}
              onToggle={() => toggleSection('journal')}
            >
              <div className="flex justify-end"><button type="button" onClick={() => void spotJournal.refetch()} disabled={spotJournal.isFetching} className="rounded-full border border-card-border bg-background px-3 py-1.5 text-[10px] font-black disabled:opacity-50">{spotJournal.isFetching ? '갱신 중' : '새로고침'}</button></div>
              {spotJournal.isError ? <StateBox>업비트 실제 주문내역을 불러오지 못했습니다.</StateBox> : !journalEntries.length ? <StateBox>아직 기록된 실제 현물 주문이 없습니다.</StateBox> : (
                <div className="mt-3 space-y-2">{journalEntries.map((entry) => (
                  <details key={entry.id} className="rounded-2xl border border-card-border bg-background p-3">
                    <summary className="cursor-pointer list-none"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-black">{displayCoinName(entry.symbol)} · {entry.symbol}</p><p className="mt-1 text-[10px] font-bold text-muted-foreground">{entry.createdAt ? new Date(entry.createdAt).toLocaleString('ko-KR') : '-'} · {entry.state}</p></div><span className={cn('rounded-full border px-2 py-1 text-[10px] font-black', entry.side === 'bid' ? 'border-positive/30 bg-positive/10 text-positive' : 'border-destructive/30 bg-destructive/10 text-destructive')}>{entry.sideLabel}</span></div></summary>
                    <div className="mt-3 grid grid-cols-2 gap-2 border-t border-card-border pt-3"><Metric label="체결수량" value={entry.executedVolume == null ? '-' : entry.executedVolume.toLocaleString('ko-KR', { maximumFractionDigits: 8 })} /><Metric label="평균 체결가" value={formatAppPrice(entry.averagePrice, 'KRW')} /><Metric label="체결금액" value={formatAppPrice(entry.executedFunds, 'KRW')} /><Metric label="수수료" value={formatAppPrice(entry.paidFee, 'KRW')} /></div>
                  </details>
                ))}</div>
              )}
            </UnifiedSectionCard>
          </>
        )}
      </main>

      <AppModal open={Boolean(candidate)} title={candidate ? `${candidate.name} 분석` : ''} onClose={() => setCandidate(null)} footer={candidate ? <button type="button" onClick={() => navigate(`/stock-info?asset=coin&coinMarket=spot&symbol=${encodeURIComponent(candidate.symbol)}`)} className="w-full rounded-2xl bg-primary px-4 py-3 text-sm font-black text-primary-foreground">{candidate.name}으로 이동</button> : null}>
        {candidate && <div className="space-y-3 text-left"><div className="grid grid-cols-3 gap-2"><Score label="매수" value={`${candidate.buyScore}`} /><Score label="매도" value={`${candidate.sellScore}`} /><Score label="의견" value={candidate.opinion} /></div><DetailList title="판단 이유" rows={candidate.reasons} /><DetailList title="위험요인" rows={candidate.risks} /></div>}
      </AppModal>
      <AppModal open={Boolean(explanation)} title={explanation?.title ?? ''} onClose={() => setExplanation(null)}><p className="text-left text-sm font-bold leading-6 text-muted-foreground">{explanation?.body}</p></AppModal>
      <BottomNav />
    </div>
  );
}

function TopButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={cn('rounded-xl border px-3 py-2 text-center text-sm font-black', active ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-card text-muted-foreground')}>{children}</button>;
}

function UnifiedSectionCard({
  title,
  subtitle,
  open,
  onToggle,
  children,
}: {
  title: string;
  subtitle?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-card-border bg-card shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
      >
        <div className="min-w-0 flex-1 text-center">
          <h2 className="text-sm font-black">{title}</h2>
          {subtitle && (
            <p className="mt-1 break-keep text-[10px] font-bold leading-4 text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0" />
        )}
      </button>
      {open && <div className="border-t border-card-border p-4">{children}</div>}
    </section>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div
      className={cn(
        'rounded-xl border px-2 py-2 text-center text-[10px] font-black',
        ok
          ? 'border-positive/30 bg-positive/10 text-positive'
          : 'border-destructive/30 bg-destructive/10 text-destructive',
      )}
    >
      {label}
    </div>
  );
}

function Score({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl bg-secondary p-3"><p className="text-[10px] font-bold text-muted-foreground">{label}</p><p className="mt-1 text-sm font-black">{value}</p></div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl bg-secondary p-3 text-center"><p className="text-[10px] font-bold text-muted-foreground">{label}</p><p className="mt-1 break-keep text-xs font-black">{value}</p></div>; }
function StateBox({ children }: { children: React.ReactNode }) { return <p className="rounded-2xl bg-secondary p-4 text-center text-xs font-bold text-muted-foreground">{children}</p>; }
function DetailList({ title, rows }: { title: string; rows: string[] }) { return <div><p className="text-xs font-black">{title}</p><div className="mt-2 space-y-2">{rows.map((row, index) => <p key={`${title}:${index}`} className="rounded-2xl bg-secondary p-3 text-xs font-bold leading-5 text-muted-foreground">{row}</p>)}</div></div>; }