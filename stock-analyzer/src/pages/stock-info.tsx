import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Search,
  Star,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { api, apiGet, type SearchResult } from '@/lib/api';
import { formatAppPercent, formatAppPrice, toggleWatchlistItem, isInWatchlist } from '@/lib/stock-display';
import { cn } from '@/lib/utils';
import { useAssetMode } from '@/lib/asset-mode';

type AnyObj = Record<string, any>;
type AssetTab = 'stock' | 'coin';
type MarketTab = 'KR' | 'US';
type FinancialPeriod = 'annual' | 'quarterly';
type FlowPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

const DEFAULT_TICKER: Record<MarketTab, string> = { KR: '005930', US: 'AAPL' };

function queryState(location: string) {
  const params = new URLSearchParams(location.split('?')[1] ?? '');
  const asset: AssetTab = params.get('asset') === 'coin' ? 'coin' : 'stock';
  const market: MarketTab = params.get('market') === 'US' ? 'US' : 'KR';
  const ticker = String(params.get('ticker') ?? DEFAULT_TICKER[market]).toUpperCase();
  return { asset, market, ticker };
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value: unknown): string | null {
  const result = String(value ?? '').trim();
  return result || null;
}

function metric(value: unknown, suffix = '') {
  const number = finite(value);
  return number == null ? '데이터 없음' : `${number.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

function money(value: unknown, currency: string) {
  const number = finite(value);
  return number == null ? '데이터 없음' : formatAppPrice(number, currency);
}

function normalizeTitle(value: unknown) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/정정|첨부정정|기재정정/g, '')
    .replace(/[^0-9a-z가-힣]/g, '');
}

function groupUnique<T extends AnyObj>(rows: T[], titleOf: (row: T) => unknown): T[] {
  const grouped = new Map<string, T>();
  for (const row of [...rows].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))) {
    const key = normalizeTitle(titleOf(row)) || String(row.url ?? row.id ?? Math.random());
    const current = grouped.get(key);
    if (current) (current as AnyObj).relatedCount = Number((current as AnyObj).relatedCount ?? 1) + Number((row as AnyObj).relatedCount ?? 1);
    else grouped.set(key, { ...row, relatedCount: Number(row.relatedCount ?? 1) });
  }
  return [...grouped.values()];
}

export default function StockInfoPage() {
  const [location, navigate] = useLocation();
  const appMode = useAssetMode();
  const initial = queryState(location);
  const [asset, setAsset] = useState<AssetTab>(initial.asset);
  const [market, setMarket] = useState<MarketTab>(initial.market);
  const [ticker, setTicker] = useState(initial.ticker);
  const [searchText, setSearchText] = useState('');
  const [financialPeriod, setFinancialPeriod] = useState<FinancialPeriod>('annual');
  const [flowPeriod, setFlowPeriod] = useState<FlowPeriod>('daily');
  const [watchlisted, setWatchlisted] = useState(() => isInWatchlist(initial.ticker));

  useEffect(() => {
    const next = queryState(location);
    setAsset(next.asset);
    setMarket(next.market);
    setTicker(next.ticker);
    setWatchlisted(isInWatchlist(next.ticker));
  }, [location]);

  function updateSelection(next: Partial<{ asset: AssetTab; market: MarketTab; ticker: string }>) {
    const nextAsset = next.asset ?? asset;
    const nextMarket = next.market ?? market;
    appMode.setAsset(nextAsset);
    if (nextAsset === 'stock') appMode.setStockMarket(nextMarket);
    const nextTicker = String(next.ticker ?? (next.market && next.market !== market ? DEFAULT_TICKER[nextMarket] : ticker)).toUpperCase();
    const params = new URLSearchParams({ asset: nextAsset, market: nextMarket, ticker: nextTicker });
    navigate(`/stock-info?${params.toString()}`, { replace: true });
  }

  const search = useQuery({
    queryKey: ['stock-info-search', market, searchText.trim()],
    queryFn: () => api.search(searchText.trim()),
    enabled: asset === 'stock',
    staleTime: 30_000,
  });

  const candidates = useMemo(
    () => (search.data?.results ?? []).filter((row) => row.market === market).slice(0, 50),
    [market, search.data],
  );

  const quote = useQuery({
    queryKey: ['stock-info-quote', ticker],
    queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/quote`),
    enabled: asset === 'stock' && Boolean(ticker),
    refetchInterval: 30_000,
  });
  const profile = useQuery({
    queryKey: ['stock-info-profile', ticker],
    queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/profile`),
    enabled: asset === 'stock' && Boolean(ticker),
    staleTime: 5 * 60_000,
  });
  const financials = useQuery({
    queryKey: ['stock-info-financials', ticker],
    queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/financials`),
    enabled: asset === 'stock' && Boolean(ticker),
    staleTime: 5 * 60_000,
  });
  const flow = useQuery({
    queryKey: ['stock-info-flow', ticker, flowPeriod],
    queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/market-flow?period=${flowPeriod}`),
    enabled: asset === 'stock' && Boolean(ticker),
  });
  const shortSelling = useQuery({
    queryKey: ['stock-info-short', ticker, flowPeriod],
    queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/short-selling?period=${flowPeriod}`),
    enabled: asset === 'stock' && Boolean(ticker),
  });
  const news = useQuery({
    queryKey: ['stock-info-news-all', ticker],
    queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/news?all=1`),
    enabled: asset === 'stock' && Boolean(ticker),
  });
  const disclosures = useQuery({
    queryKey: ['stock-info-disclosures-all', ticker],
    queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/disclosures?all=1`),
    enabled: asset === 'stock' && Boolean(ticker),
  });

  const selectedName = text(quote.data?.name) ?? text(profile.data?.name) ?? ticker;
  const currency = text(quote.data?.currency) ?? (market === 'KR' ? 'KRW' : 'USD');
  const financeData = financials.data?.financials ?? financials.data ?? {};
  const financeRows = (financialPeriod === 'annual'
    ? financeData.annual ?? financeData.yearly
    : financeData.quarterly ?? financeData.quarters) as AnyObj[] | undefined;
  const financeLatest = financeRows?.[0] ?? null;
  const ratios = financeData.ratios ?? {};
  const newsRows = groupUnique((news.data?.news ?? news.data?.items ?? []) as AnyObj[], (row) => row.title);
  const disclosureRows = groupUnique(
    ([...(disclosures.data?.disclosures ?? []), ...(disclosures.data?.filings ?? [])]) as AnyObj[],
    (row) => row.report ?? `${row.form ?? ''}${row.description ?? ''}`,
  );

  const refreshAll = () => {
    void Promise.all([
      quote.refetch(),
      profile.refetch(),
      financials.refetch(),
      flow.refetch(),
      shortSelling.refetch(),
      news.refetch(),
      disclosures.refetch(),
    ]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="border-b border-card-border bg-background/95 px-4 pb-3 pt-4 backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-black">주식정보</h1>
            <p className="mt-1 text-xs text-muted-foreground">선택 종목의 실제 시세·재무·수급·공매도·뉴스·공시</p>
          </div>
          <button type="button" onClick={refreshAll} aria-label="전체 새로고침" className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card">
            <RefreshCw className={cn('h-4 w-4', quote.isFetching && 'animate-spin')} />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Tab active={asset === 'stock'} onClick={() => updateSelection({ asset: 'stock' })}>주식</Tab>
          <Tab active={asset === 'coin'} onClick={() => updateSelection({ asset: 'coin' })}>코인</Tab>
        </div>
        {asset === 'stock' && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Tab active={market === 'KR'} onClick={() => updateSelection({ market: 'KR' })}>국내</Tab>
            <Tab active={market === 'US'} onClick={() => updateSelection({ market: 'US' })}>미국</Tab>
          </div>
        )}
      </header>

      {asset === 'coin' ? (
        <CoinInfo />
      ) : (
        <main className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-28 pt-4">
          <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
            <label className="flex h-11 items-center gap-2 rounded-2xl border border-card-border bg-background px-3">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="종목명·코드 검색" className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none" />
            </label>
            <div className="mt-3 max-h-44 space-y-1 overflow-y-auto">
              {search.isLoading && <InlineState>종목 목록을 불러오는 중입니다.</InlineState>}
              {search.isError && <InlineState tone="error">종목 목록을 불러오지 못했습니다.</InlineState>}
              {candidates.map((item: SearchResult) => (
                <button key={`${item.market}:${item.ticker}`} type="button" onClick={() => { setSearchText(''); updateSelection({ ticker: item.ticker }); }} className={cn('flex w-full items-center justify-between rounded-xl px-3 py-2 text-left', item.ticker === ticker ? 'bg-primary/10 text-primary' : 'bg-secondary/60')}>
                  <span className="min-w-0 truncate text-sm font-black">{item.name}</span>
                  <span className="ml-2 shrink-0 text-[10px] font-bold text-muted-foreground">{item.ticker}</span>
                </button>
              ))}
            </div>
          </section>

          <Section title="기본정보" state={queryStateText(quote)}>
            {quote.data && (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-xl font-black">{selectedName}</p>
                    <p className="mt-1 text-xs font-bold text-muted-foreground">{ticker} · {market === 'KR' ? '국내' : '미국'} · 기준 {formatDate(quote.data.updatedAt)}</p>
                  </div>
                  <button type="button" onClick={() => setWatchlisted(toggleWatchlistItem({ ticker, name: selectedName, market, currency }))} aria-label="관심종목" className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full border', watchlisted ? 'border-warning bg-warning/10 text-warning' : 'border-card-border')}>
                    <Star className={cn('h-5 w-5', watchlisted && 'fill-current')} />
                  </button>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Metric label="현재가" value={money(quote.data.price, currency)} strong />
                  <Metric label="등락률" value={finite(quote.data.changePercent) == null ? '데이터 없음' : formatAppPercent(quote.data.changePercent)} tone={Number(quote.data.changePercent) >= 0 ? 'up' : 'down'} />
                  <Metric label="전일대비" value={money(quote.data.changeAmount, currency)} />
                  <Metric label="거래량" value={metric(quote.data.volume)} />
                  <Metric label="시가" value={money(quote.data.open, currency)} />
                  <Metric label="고가 / 저가" value={`${money(quote.data.high, currency)} / ${money(quote.data.low, currency)}`} />
                  <Metric label="거래대금" value={money(quote.data.tradingValue, currency)} />
                  <Metric label="시가총액" value={money(quote.data.marketCap ?? financials.data?.marketCap, currency)} />
                </div>
                <button type="button" onClick={() => navigate(`/stock/${encodeURIComponent(ticker)}`)} className="mt-3 flex w-full items-center justify-center gap-1 rounded-2xl bg-primary px-4 py-3 text-sm font-black text-primary-foreground">상세 분석 <ChevronRight className="h-4 w-4" /></button>
              </>
            )}
          </Section>

          <Section title="기업·업종" state={queryStateText(profile)}>
            {profile.data && <div className="grid grid-cols-2 gap-2"><Metric label="업종" value={text(profile.data.industry) ?? '데이터 없음'} /><Metric label="산업" value={text(profile.data.sector) ?? '데이터 없음'} /><Metric label="국가" value={text(profile.data.country) ?? '데이터 없음'} /><Metric label="시장상태" value={text(quote.data?.marketStatus) ?? '제공기관 미지원'} /></div>}
          </Section>

          <Section title="재무요약" state={queryStateText(financials)} action={<Toggle values={[['annual', '연간'], ['quarterly', '분기']]} value={financialPeriod} onChange={(value) => setFinancialPeriod(value as FinancialPeriod)} />}>
            {financials.data && (
              <div className="grid grid-cols-2 gap-2">
                <Metric label="매출" value={money(financeLatest?.revenue, currency)} />
                <Metric label="영업이익" value={money(financeLatest?.operatingIncome, currency)} />
                <Metric label="순이익" value={money(financeLatest?.netIncome, currency)} />
                <Metric label="자산" value={money(financeLatest?.assets, currency)} />
                <Metric label="부채" value={money(financeLatest?.liabilities ?? financeLatest?.debt, currency)} />
                <Metric label="자본" value={money(financeLatest?.equity ?? financeLatest?.capital, currency)} />
                <Metric label="영업현금흐름" value={money(financeLatest?.operatingCashFlow, currency)} />
                <Metric label="PER" value={metric(ratios.per, '배')} />
                <Metric label="PBR" value={metric(ratios.pbr, '배')} />
                <Metric label="ROE" value={metric(ratios.roe, '%')} />
                <Metric label="부채비율" value={metric(ratios.debtRatio, '%')} />
                <Metric label="기준기간" value={text(financeLatest?.periodLabel ?? financeLatest?.period) ?? '데이터 없음'} />
              </div>
            )}
          </Section>

          <Section title="수급·공매도" state={queryStateText(flow)} action={<Toggle values={[['daily', '일'], ['weekly', '주'], ['monthly', '월'], ['yearly', '년']]} value={flowPeriod} onChange={(value) => setFlowPeriod(value as FlowPeriod)} />}>
            <div className="grid grid-cols-2 gap-2">
              <Metric label="개인 순매매" value={flow.data?.available ? metric(flow.data?.totals?.individual) : flow.data?.message ?? '데이터 없음'} />
              <Metric label="기관 순매매" value={flow.data?.available ? metric(flow.data?.totals?.institution) : flow.data?.message ?? '데이터 없음'} />
              <Metric label="외국인 순매매" value={flow.data?.available ? metric(flow.data?.totals?.foreign) : flow.data?.message ?? '데이터 없음'} />
              <Metric label="공매도 거래량" value={shortSelling.data?.available ? metric(shortSelling.data?.latest?.shortVolume) : shortSelling.data?.message ?? '데이터 없음'} />
              <Metric label="공매도 비중" value={shortSelling.data?.available ? metric(shortSelling.data?.latest?.ratio, '%') : '데이터 없음'} />
              <Metric label="대차잔고" value={shortSelling.data?.available ? metric(shortSelling.data?.latest?.balance) : '데이터 없음'} />
            </div>
            {flow.data?.note && <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">{flow.data.note}</p>}
          </Section>

          <HistorySection title="최신 뉴스" rows={newsRows} latestCount={5} loading={news.isLoading} error={news.isError} titleOf={(row) => row.title} subtitleOf={(row) => `${row.source ?? '뉴스'} · ${row.date ?? '날짜 없음'}`} />
          <HistorySection title="최신 공시" rows={disclosureRows} latestCount={5} loading={disclosures.isLoading} error={disclosures.isError} titleOf={(row) => row.report ?? `${row.form ?? '공시'} ${row.description ?? ''}`} subtitleOf={(row) => `${row.date ?? '날짜 없음'} · ${market === 'KR' ? 'DART' : 'SEC EDGAR'}`} />
        </main>
      )}
      <BottomNav />
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} className={cn('rounded-xl border px-3 py-2 text-sm font-black', active ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-card text-muted-foreground')}>{children}</button>;
}

function Section({ title, state, action, children }: { title: string; state?: string | null; action?: ReactNode; children: ReactNode }) {
  return <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm"><div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-sm font-black">{title}</h2>{action}</div>{state ? <InlineState tone={state.includes('못') ? 'error' : undefined}>{state}</InlineState> : children}</section>;
}

function Metric({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'up' | 'down' }) {
  return <div className="rounded-2xl bg-secondary/60 p-3"><p className="text-[10px] font-bold text-muted-foreground">{label}</p><p className={cn('mt-1 break-words text-xs font-black', strong && 'text-base', tone === 'up' && 'text-positive', tone === 'down' && 'text-destructive')}>{value}</p></div>;
}

function InlineState({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return <p className={cn('rounded-2xl bg-secondary p-4 text-center text-xs font-bold text-muted-foreground', tone === 'error' && 'bg-destructive/10 text-destructive')}>{children}</p>;
}

function queryStateText(query: { isLoading: boolean; isError: boolean; data?: unknown }): string | null {
  if (query.isLoading) return '데이터를 불러오는 중입니다.';
  if (query.isError) return '데이터를 불러오지 못했습니다.';
  if (!query.data) return '데이터 없음';
  return null;
}

function Toggle({ values, value, onChange }: { values: [string, string][]; value: string; onChange: (value: string) => void }) {
  return <div className="flex rounded-xl bg-secondary p-1">{values.map(([key, label]) => <button key={key} type="button" onClick={() => onChange(key)} className={cn('rounded-lg px-2 py-1 text-[10px] font-black', value === key && 'bg-card text-primary shadow')}>{label}</button>)}</div>;
}

function HistorySection({ title, rows, latestCount, loading, error, titleOf, subtitleOf }: { title: string; rows: AnyObj[]; latestCount: number; loading: boolean; error: boolean; titleOf: (row: AnyObj) => unknown; subtitleOf: (row: AnyObj) => string }) {
  const latest = rows.slice(0, latestCount);
  return <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm"><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-black">{title}</h2><span className="text-[10px] font-bold text-muted-foreground">최신 고유 {latest.length}건 / 전체 {rows.length}건</span></div>{loading && <InlineState>데이터를 불러오는 중입니다.</InlineState>}{error && <InlineState tone="error">데이터를 불러오지 못했습니다.</InlineState>}{!loading && !error && latest.length === 0 && <InlineState>제공된 데이터가 없습니다.</InlineState>}<div className="space-y-2">{latest.map((row, index) => <HistoryRow key={`${row.url ?? titleOf(row)}:${index}`} row={row} title={String(titleOf(row) || '제목 없음')} subtitle={subtitleOf(row)} />)}</div>{rows.length > latestCount && <details className="mt-3 rounded-2xl border border-card-border bg-background p-3"><summary className="cursor-pointer text-xs font-black">전체 과거 이력 보기 ({rows.length}건)</summary><div className="mt-3 max-h-96 space-y-2 overflow-y-auto">{rows.slice(latestCount).map((row, index) => <HistoryRow key={`history:${row.url ?? titleOf(row)}:${index}`} row={row} title={String(titleOf(row) || '제목 없음')} subtitle={subtitleOf(row)} />)}</div></details>}</section>;
}

function HistoryRow({ row, title, subtitle }: { row: AnyObj; title: string; subtitle: string }) {
  const content = <div className="rounded-2xl bg-secondary/60 p-3"><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="break-keep text-xs font-black leading-relaxed">{title}</p><p className="mt-1 text-[10px] font-bold text-muted-foreground">{subtitle}{Number(row.relatedCount ?? 1) > 1 ? ` · 관련 ${row.relatedCount}건` : ''}</p></div>{row.url && <ExternalLink className="h-3.5 w-3.5 shrink-0 text-primary" />}</div></div>;
  return row.url ? <a href={String(row.url)} target="_blank" rel="noreferrer">{content}</a> : content;
}

function formatDate(value: unknown) {
  const date = new Date(String(value ?? ''));
  return Number.isFinite(date.getTime()) ? date.toLocaleString('ko-KR') : '기준시각 없음';
}

type CoinMarketTab = 'spot' | 'futures';

function CoinInfo() {
  const [location, navigate] = useLocation();
  const appMode = useAssetMode();
  const params = new URLSearchParams(location.split('?')[1] ?? '');
  const initialMarket: CoinMarketTab = params.get('coinMarket') === 'futures' ? 'futures' : 'spot';
  const [coinMarket, setCoinMarket] = useState<CoinMarketTab>(initialMarket);
  const [symbol, setSymbol] = useState(() => String(params.get('symbol') ?? (initialMarket === 'spot' ? 'BTC' : 'BTCUSDT')).toUpperCase());
  const [searchText, setSearchText] = useState('');

  useEffect(() => {
    const nextParams = new URLSearchParams(location.split('?')[1] ?? '');
    const nextMarket: CoinMarketTab = nextParams.get('coinMarket') === 'futures' ? 'futures' : 'spot';
    setCoinMarket(nextMarket);
    setSymbol(String(nextParams.get('symbol') ?? (nextMarket === 'spot' ? 'BTC' : 'BTCUSDT')).toUpperCase());
  }, [location]);

  const changeCoin = (nextMarket: CoinMarketTab, nextSymbol?: string) => {
    appMode.setAsset('coin');
    appMode.setCoinMarket(nextMarket);
    const next = new URLSearchParams(location.split('?')[1] ?? '');
    next.set('asset', 'coin');
    next.set('coinMarket', nextMarket);
    next.set('symbol', String(nextSymbol ?? (nextMarket === 'spot' ? 'BTC' : 'BTCUSDT')).toUpperCase());
    navigate(`/stock-info?${next.toString()}`, { replace: true });
  };

  const status = useQuery({
    queryKey: ['crypto-status'],
    queryFn: () => apiGet<AnyObj>('/crypto/status'),
    staleTime: 30_000,
  });
  const spotMarkets = useQuery({
    queryKey: ['crypto-spot-markets'],
    queryFn: () => apiGet<AnyObj>('/crypto/spot/markets'),
    enabled: coinMarket === 'spot',
    staleTime: 10 * 60_000,
  });
  const spotTickers = useQuery({
    queryKey: ['crypto-spot-tickers'],
    queryFn: () => apiGet<AnyObj>('/crypto/spot/tickers'),
    enabled: coinMarket === 'spot',
    refetchInterval: 15_000,
  });
  const orderbook = useQuery({
    queryKey: ['crypto-spot-orderbook', symbol],
    queryFn: () => apiGet<AnyObj>(`/crypto/spot/orderbook?symbol=${encodeURIComponent(symbol)}`),
    enabled: coinMarket === 'spot' && Boolean(symbol),
    refetchInterval: 5_000,
  });
  const [coinTf, setCoinTf] = useState<'15m' | '1D' | '1W' | '1M'>('15m');
  const spotCandles = useQuery({
    queryKey: ['crypto-spot-candles', symbol, coinTf],
    queryFn: () =>
      apiGet<AnyObj>(
        coinTf === '15m'
          ? `/crypto/spot/candles?symbol=${encodeURIComponent(symbol)}&unit=15&count=120`
          : `/crypto/spot/candles?symbol=${encodeURIComponent(symbol)}&tf=${coinTf}&count=200`,
      ),
    enabled: coinMarket === 'spot' && Boolean(symbol),
    refetchInterval: 30_000,
  });
  const futuresTickers = useQuery({
    queryKey: ['crypto-futures-tickers'],
    queryFn: () => apiGet<AnyObj>('/crypto/futures/tickers'),
    enabled: coinMarket === 'futures',
    refetchInterval: 10_000,
  });
  const futuresCandles = useQuery({
    queryKey: ['crypto-futures-candles', symbol],
    queryFn: () => apiGet<AnyObj>(`/crypto/futures/candles?symbol=${encodeURIComponent(symbol)}&granularity=15m&limit=200`),
    enabled: coinMarket === 'futures' && Boolean(symbol),
    refetchInterval: 30_000,
  });

  const marketNames = new Map<string, AnyObj>(
    ((spotMarkets.data?.markets ?? []) as AnyObj[]).map((item) => [String(item.symbol), item]),
  );
  const spotRows = ((spotTickers.data?.tickers ?? []) as AnyObj[]).map((item) => ({ ...item, ...(marketNames.get(String(item.symbol)) ?? {}) }));
  const futureRows = (futuresTickers.data?.tickers ?? []) as AnyObj[];
  const rows = coinMarket === 'spot' ? spotRows : futureRows;
  const filteredRows = rows
    .filter((item) => {
      const query = searchText.trim().toLowerCase();
      if (!query) return true;
      return [item.symbol, item.koreanName, item.englishName].some((value) => String(value ?? '').toLowerCase().includes(query));
    })
    .sort((a, b) => Number(b.tradingValue24h ?? 0) - Number(a.tradingValue24h ?? 0))
    .slice(0, 100);
  const selected = rows.find((item) => String(item.symbol).toUpperCase() === symbol) ?? null;
  const currency = coinMarket === 'spot' ? 'KRW' : 'USDT';
  const candles = (coinMarket === 'spot' ? spotCandles.data?.candles : futuresCandles.data?.candles) as AnyObj[] | undefined;
  const latestCandle = candles?.at(-1);
  const connectionOk = coinMarket === 'spot' ? status.data?.upbit?.ok : status.data?.bitget?.ok;

  return (
    <main className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-28 pt-4">
      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
        <div className="grid grid-cols-2 gap-2">
          <Tab active={coinMarket === 'spot'} onClick={() => changeCoin('spot')}>현물 · 업비트</Tab>
          <Tab active={coinMarket === 'futures'} onClick={() => changeCoin('futures')}>선물 · 비트겟</Tab>
        </div>
        <div className={cn('mt-3 rounded-2xl px-3 py-2 text-xs font-black', connectionOk ? 'bg-positive/10 text-positive' : 'bg-destructive/10 text-destructive')}>
          {coinMarket === 'spot' ? '업비트' : '비트겟'} 공개 시세 · {status.isLoading ? '연결 확인 중' : connectionOk ? '정상' : '연결 오류'}
        </div>
        <label className="mt-3 flex h-11 items-center gap-2 rounded-2xl border border-card-border bg-background px-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder={coinMarket === 'spot' ? '코인명·심볼 검색' : '선물 심볼 검색'} className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none" />
        </label>
        <div className="mt-3 max-h-52 space-y-1 overflow-y-auto">
          {(coinMarket === 'spot' ? spotTickers.isLoading : futuresTickers.isLoading) && <InlineState>코인 목록을 불러오는 중입니다.</InlineState>}
          {filteredRows.map((item) => {
            const itemSymbol = String(item.symbol);
            return (
              <button key={itemSymbol} type="button" onClick={() => { setSearchText(''); changeCoin(coinMarket, itemSymbol); }} className={cn('flex w-full items-center justify-between rounded-xl px-3 py-2 text-left', itemSymbol === symbol ? 'bg-primary/10 text-primary' : 'bg-secondary/60')}>
                <span className="min-w-0 truncate text-sm font-black">{item.koreanName ?? item.englishName ?? itemSymbol}</span>
                <span className="ml-2 shrink-0 text-[10px] font-bold text-muted-foreground">{itemSymbol}</span>
              </button>
            );
          })}
        </div>
      </section>

      <Section title={coinMarket === 'spot' ? '현물 기본정보' : '선물 기본정보'} state={selected ? null : '선택한 코인의 시세 데이터가 없습니다.'}>
        {selected && (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xl font-black">{selected.koreanName ?? selected.englishName ?? selected.symbol}</p>
                <p className="mt-1 text-xs font-bold text-muted-foreground">{selected.symbol} · {coinMarket === 'spot' ? '업비트 KRW' : '비트겟 USDT 선물'} · 기준 {formatDate(coinMarket === 'spot' ? spotTickers.data?.updatedAt : futuresTickers.data?.updatedAt)}</p>
              </div>
              <button type="button" onClick={() => { void (coinMarket === 'spot' ? spotTickers.refetch() : futuresTickers.refetch()); }} className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border"><RefreshCw className="h-4 w-4" /></button>
            </div>
            {coinMarket === 'spot' && (
              <div className="mt-3 grid grid-cols-4 gap-1">
                {(['15m', '1D', '1W', '1M'] as const).map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => setCoinTf(tf)}
                    className={cn(
                      'rounded-xl border px-2 py-1.5 text-[11px] font-black',
                      coinTf === tf ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-card text-muted-foreground',
                    )}
                  >
                    {tf === '15m' ? '15분' : tf === '1D' ? '일봉' : tf === '1W' ? '주봉' : '월봉'}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Metric label="현재가" value={money(selected.price, currency)} strong />
              <Metric label="24시간 등락률" value={finite(selected.changePercent ?? selected.changePercent24h) == null ? '데이터 없음' : formatAppPercent(selected.changePercent ?? selected.changePercent24h)} tone={Number(selected.changePercent ?? selected.changePercent24h) >= 0 ? 'up' : 'down'} />
              <Metric label="24시간 고가" value={money(selected.high24h, currency)} />
              <Metric label="24시간 저가" value={money(selected.low24h, currency)} />
              <Metric label="24시간 거래량" value={metric(selected.volume24h)} />
              <Metric label="24시간 거래대금" value={money(selected.tradingValue24h, currency)} />
              {coinMarket === 'futures' && <Metric label="마크가격" value={money(selected.markPrice, currency)} />}
              {coinMarket === 'futures' && <Metric label="지수가격" value={money(selected.indexPrice, currency)} />}
              {coinMarket === 'futures' && <Metric label="펀딩비" value={metric(finite(selected.fundingRate) == null ? null : Number(selected.fundingRate) * 100, '%')} />}
              {coinMarket === 'futures' && <Metric label="미결제약정" value={metric(selected.openInterest)} />}
              {coinMarket === 'futures' && <Metric label="매수 / 매도호가" value={`${money(selected.bidPrice, currency)} / ${money(selected.askPrice, currency)}`} />}
              <Metric label={coinMarket === 'spot' ? `${coinTf === '15m' ? '15분봉' : coinTf === '1D' ? '일봉' : coinTf === '1W' ? '주봉' : '월봉'} 최신 종가` : '15분봉 최신 종가'} value={money(latestCandle?.close, currency)} />
              <Metric label="캔들 수" value={candles?.length ? `${candles.length}개` : '데이터 없음'} />
              {coinMarket === 'spot' && <Metric label="유의 상태" value={selected.warning ? '유의 종목' : '정상'} tone={selected.warning ? 'down' : undefined} />}
            </div>
          </>
        )}
      </Section>

      {coinMarket === 'spot' && (
        <Section title="호가" state={queryStateText(orderbook)}>
          <div className="grid grid-cols-2 gap-2">
            <Metric label="총 매도잔량" value={metric(orderbook.data?.totalAskSize)} />
            <Metric label="총 매수잔량" value={metric(orderbook.data?.totalBidSize)} />
          </div>
          <div className="mt-3 max-h-72 space-y-1 overflow-y-auto">
            {((orderbook.data?.units ?? []) as AnyObj[]).slice(0, 15).map((unit, index) => (
              <div key={index} className="grid grid-cols-4 gap-1 rounded-xl bg-secondary/60 p-2 text-center text-[10px] font-bold">
                <span className="text-destructive">{money(unit.askPrice, 'KRW')}</span><span>{metric(unit.askSize)}</span><span>{metric(unit.bidSize)}</span><span className="text-positive">{money(unit.bidPrice, 'KRW')}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <section className="rounded-3xl border border-card-border bg-card p-4 text-xs font-bold leading-relaxed text-muted-foreground shadow-sm">
        코인 화면에는 PER·PBR·ROE·기관·외국인 수급을 표시하지 않습니다. 공개 시세와 실제 거래소 응답이 없으면 임시 가격을 만들지 않고 데이터 없음으로 표시합니다.
      </section>
    </main>
  );
}
