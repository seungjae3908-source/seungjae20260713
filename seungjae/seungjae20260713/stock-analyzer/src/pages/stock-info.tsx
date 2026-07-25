import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { ColorType, LineStyle, createChart, type UTCTimestamp } from 'lightweight-charts';
import {
	Archive,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ExternalLink,
	RefreshCw,
	Search,
	Settings2,
	Star,
	X,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { PriceAlertCard } from '@/components/price-alert-card';
import { api, apiGet, type SearchResult } from '@/lib/api';
import { authorizedFetch } from '@/lib/auth-fetch';
import { displayCoinName, displayStockName, formatAppPercent, formatAppPrice, toggleWatchlistItem, isInWatchlist } from '@/lib/stock-display';
import { cn } from '@/lib/utils';
import { useAssetMode } from '@/lib/asset-mode';
import {
	CHART_TIMEFRAMES,
	loadVisibleChartTimeframes,
	saveVisibleChartTimeframes,
	type VisibleChartTimeframe,
} from '@/lib/chart-preferences';

type AnyObj = Record<string, any>;
type AssetTab = 'stock' | 'coin';
type MarketTab = 'KR' | 'US';
type FinancialPeriod = 'annual' | 'quarterly';
type FlowPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

type CoinMarketTab = 'spot' | 'futures';
type CoinViewTab = 'market' | 'ai';
type SpecialFeedMarket = MarketTab | CoinMarketTab;
type SpecialFeedFilter = 'all' | 'news' | 'positive' | 'negative' | 'disclosure' | 'signal';
type SpecialFeedView = 'latest' | 'archive';
type SpecialFeedItem = {
	id: string;
	asset: AssetTab;
	kind: 'news' | 'disclosure' | 'signal';
	tone: 'positive' | 'negative' | 'neutral';
	ticker: string;
	name: string;
	market: SpecialFeedMarket;
	currency: 'KRW' | 'USD' | 'USDT';
	title: string;
	summary: string;
	source: string;
	url: string | null;
	timeframe: string | null;
	price: number | null;
	changePercent: number | null;
	sourceAt: string | null;
	detectedAt: string;
	archiveAt: string;
	expiresAt: string | null;
};
type SpecialFeedResponse = {
	ok?: boolean;
	asset: AssetTab;
	market: SpecialFeedMarket;
	items: SpecialFeedItem[];
	count: number;
	catalogSize?: number;
	scannedNow?: number;
	updatedAt?: string;
	latestDays?: number;
	message?: string;
};

// 기본 종목 자동 선택 없음 — 사용자가 검색해서 선택하기 전에는 검색창만 표시한다.
function queryState(location: string) {
	const locationQuery = location.includes('?') ? location.split('?')[1] ?? '' : '';
	const browserQuery = typeof window !== 'undefined' ? window.location.search.replace(/^\?/, '') : '';
	const params = new URLSearchParams(locationQuery || browserQuery);
	const asset: AssetTab = params.get('asset') === 'coin' ? 'coin' : 'stock';
	const market: MarketTab = params.get('market') === 'US' ? 'US' : 'KR';
	const ticker = String(params.get('ticker') ?? '').toUpperCase();
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

// 재무 금액을 백만 단위로 표시 (국내: 백만원, 미국: USD million). 임의 환산 없음.
function millions(value: unknown) {
	const number = finite(value);
	return number == null ? '데이터 없음' : Math.round(number / 1_000_000).toLocaleString('ko-KR');
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
	const [financialPeriod, setFinancialPeriod] = useState<FinancialPeriod>('quarterly');
	const [flowPeriod, setFlowPeriod] = useState<FlowPeriod>('daily');
	const [watchlisted, setWatchlisted] = useState(() => isInWatchlist(initial.ticker));
	const [feedFilter, setFeedFilter] = useState<SpecialFeedFilter>('all');
	const [nowMs, setNowMs] = useState(() => Date.now());

	useEffect(() => {
		const next = queryState(location);
		setAsset(next.asset);
		setMarket(next.market);
		setTicker(next.ticker);
		setWatchlisted(isInWatchlist(next.ticker));
	}, [location]);

	useEffect(() => {
		const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, []);

	function updateSelection(next: Partial<{ asset: AssetTab; market: MarketTab; ticker: string }>) {
		const nextAsset = next.asset ?? asset;
		const nextMarket = next.market ?? market;
		const assetChanged = nextAsset !== asset;
		const marketChanged = nextMarket !== market;
		const nextTicker = String(next.ticker ?? (assetChanged || marketChanged ? '' : ticker)).toUpperCase();

		// 쿼리 문자열만 바뀌어도 화면이 즉시 반응하도록 로컬 상태를 먼저 갱신한다.
		setAsset(nextAsset);
		setMarket(nextMarket);
		setTicker(nextTicker);
		setSearchText('');
		setWatchlisted(isInWatchlist(nextTicker));

		appMode.setAsset(nextAsset);
		if (nextAsset === 'stock') {
			appMode.setStockMarket(nextMarket);
			const params = new URLSearchParams({ asset: 'stock', market: nextMarket });
			if (nextTicker) params.set('ticker', nextTicker);
			navigate(`/stock-info?${params.toString()}`, { replace: true });
			return;
		}

		const params = new URLSearchParams({ asset: 'coin', coinMarket: appMode.coinMarket });
		navigate(`/stock-info?${params.toString()}`, { replace: true });
	}

	const search = useQuery({
		queryKey: ['stock-info-search', market, searchText.trim()],
		queryFn: () => api.search(searchText.trim()),
		enabled: asset === 'stock' && searchText.trim().length > 0,
		staleTime: 30_000,
	});

	const candidates = useMemo(
		() => (search.data?.results ?? []).filter((row) => row.market === market).slice(0, 50),
		[market, search.data],
	);

	const specialFeed = useQuery({
		queryKey: ['stock-info-special-feed', market],
		queryFn: async () => {
			const response = await authorizedFetch(
				`/api/stocks/special-feed?asset=stock&market=${market}&limit=2000&_ts=${Date.now()}`,
				{ cache: 'no-store' },
			);
			const payload = (await response.json().catch(() => ({}))) as SpecialFeedResponse & {
				error?: string;
				message?: string;
			};
			if (!response.ok) {
				throw new Error(payload.error ?? payload.message ?? `HTTP_${response.status}`);
			}
			return payload;
		},
		enabled: asset === 'stock',
		refetchInterval: 30_000,
		refetchIntervalInBackground: true,
		refetchOnWindowFocus: true,
		retry: 1,
	});

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

	const selectedName = displayStockName(ticker, text(quote.data?.name) ?? text(profile.data?.name) ?? ticker, market);
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

	return (
		<div className="h-full overflow-y-auto overscroll-contain bg-background">
			<header className="sticky top-0 z-30 border-b border-card-border bg-background/95 px-4 pb-3 pt-4 backdrop-blur">
				<h1 className="mb-3 text-left text-xl font-extrabold">정보</h1>

				<div className="grid grid-cols-2 gap-2">
					<Tab active onClick={() => undefined}>정보</Tab>
					<Tab active={false} onClick={() => navigate('/learn')}>공부</Tab>
				</div>

				<div className="mt-2 grid grid-cols-2 gap-2">
					<Tab active={asset === 'stock'} onClick={() => updateSelection({ asset: 'stock' })}>주식</Tab>
					<Tab active={asset === 'coin'} onClick={() => updateSelection({ asset: 'coin' })}>코인</Tab>
				</div>
				{asset === 'stock' && (
					<div className="mt-2 grid grid-cols-2 gap-2">
						<Tab active={market === 'KR'} onClick={() => updateSelection({ market: 'KR' })}>국내</Tab>
						<Tab active={market === 'US'} onClick={() => updateSelection({ market: 'US' })}>해외</Tab>
					</div>
				)}
			</header>

			{asset === 'coin' ? (
				<CoinInfo nowMs={nowMs} />
			) : (
				<main className="space-y-4 px-4 pb-28 pt-4">
					<SpecialFeedPanel
						asset="stock"
						market={market}
						filter={feedFilter}
						onFilter={setFeedFilter}
						items={specialFeed.data?.items ?? []}
						nowMs={nowMs}
						loading={specialFeed.isLoading}
						fetching={specialFeed.isFetching}
						error={specialFeed.isError || specialFeed.data?.ok === false}
						catalogSize={specialFeed.data?.catalogSize}
						onRetry={() => { void specialFeed.refetch(); }}
						onOpenItem={(item) => {
							const nextMarket: MarketTab = item.market === 'US' ? 'US' : 'KR';
							updateSelection({ market: nextMarket, ticker: item.ticker });
							window.setTimeout(() => {
								window.document.getElementById('stock-info-selected')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
							}, 50);
						}}
					/>

					<section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
						<label className="flex h-11 items-center gap-2 rounded-2xl border border-card-border bg-background px-3">
							<Search className="h-4 w-4 text-muted-foreground" />
							<input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder={market === 'KR' ? '국내 종목명·코드 검색' : '해외 종목명·티커·한글명 검색'} className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none" />
						</label>
						{searchText.trim().length > 0 && (
							<div className="mt-3 max-h-44 space-y-1 overflow-y-auto">
								{search.isLoading && <InlineState>종목 목록을 불러오는 중입니다.</InlineState>}
								{search.isError && <InlineState tone="error">종목 목록을 불러오지 못했습니다.</InlineState>}
								{!search.isLoading && !search.isError && candidates.length === 0 && <InlineState>검색 결과가 없습니다.</InlineState>}
								{candidates.map((item: SearchResult) => (
									<button key={`${item.market}:${item.ticker}`} type="button" onClick={() => { setSearchText(''); updateSelection({ ticker: item.ticker }); }} className={cn('flex w-full items-center justify-between rounded-xl px-3 py-2', item.ticker === ticker ? 'bg-primary/10 text-primary' : 'bg-secondary/60')}>
										<span className="min-w-0 flex-1 truncate text-center text-sm font-black">{displayStockName(item.ticker, item.name, item.market)}</span>
										<span className="ml-2 shrink-0 text-[10px] font-bold text-muted-foreground">{item.ticker}</span>
									</button>
								))}
							</div>
						)}
					</section>

					{!ticker && (
						<InlineState>종목을 검색해 선택하면 실제 시세·재무·수급·공매도·뉴스·공시가 아래에 표시됩니다.</InlineState>
					)}

					{ticker && (
						<>
							{/* 항상 표시되는 최상단 종목 헤더 (종목명·현재가·등락률) */}
							<section id="stock-info-selected" className="scroll-mt-4 rounded-3xl border border-primary/20 bg-primary/5 p-4 text-center shadow-sm">
								{quote.isLoading && <InlineState>시세를 불러오는 중입니다.</InlineState>}
								{quote.isError && <InlineState tone="error">시세를 불러오지 못했습니다.</InlineState>}
								{quote.data && (
									<>
										<div className="flex items-center gap-2">
											<div className="min-w-0 flex-1">
												<p className="truncate text-xl font-black">{selectedName}</p>
												<p className="mt-1 text-xs font-bold text-muted-foreground">{ticker} · {market === 'KR' ? '국내' : '해외'} · 기준 {formatDate(quote.data.updatedAt)}</p>
											</div>
											<button type="button" onClick={() => setWatchlisted(toggleWatchlistItem({ ticker, name: selectedName, market, currency }))} aria-label="관심종목" className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full border', watchlisted ? 'border-warning bg-warning/10 text-warning' : 'border-card-border')}>
												<Star className={cn('h-5 w-5', watchlisted && 'fill-current')} />
											</button>
										</div>
										<div className="mt-3 grid grid-cols-2 gap-2">
											<Metric label="현재가" value={money(quote.data.price, currency)} strong />
											<Metric label="등락률" value={finite(quote.data.changePercent) == null ? '데이터 없음' : formatAppPercent(quote.data.changePercent)} tone={Number(quote.data.changePercent) >= 0 ? 'up' : 'down'} />
										</div>
										<button type="button" onClick={() => navigate(`/stock/${encodeURIComponent(ticker)}`)} className="mt-3 flex w-full items-center justify-center gap-1 rounded-2xl bg-primary px-4 py-3 text-sm font-black text-primary-foreground">상세 분석 <ChevronRight className="h-4 w-4" /></button>
									</>
								)}
							</section>

							<Section title="기본정보" state={queryStateText(quote)}>
								{quote.data && (
									<div className="grid grid-cols-2 gap-2">
										<Metric label="전일대비" value={money(quote.data.changeAmount, currency)} />
										<Metric label="거래량" value={metric(quote.data.volume)} />
										<Metric label="시가" value={money(quote.data.open, currency)} />
										<Metric label="고가 / 저가" value={`${money(quote.data.high, currency)} / ${money(quote.data.low, currency)}`} />
										<Metric label="거래대금" value={money(quote.data.tradingValue, currency)} />
										<Metric label="시가총액" value={money(quote.data.marketCap ?? financials.data?.marketCap, currency)} />
									</div>
								)}
							</Section>

							<PriceAlertCard assetType="stock" market={market} symbol={ticker} currentPrice={finite(quote.data?.price)} currency={currency} />

							<Section title="기업·업종" state={queryStateText(profile)}>
								{profile.data && <div className="grid grid-cols-2 gap-2"><Metric label="업종" value={text(profile.data.industry) ?? '데이터 없음'} /><Metric label="산업" value={text(profile.data.sector) ?? '데이터 없음'} /><Metric label="국가" value={text(profile.data.country) ?? '데이터 없음'} /><Metric label="시장상태" value={text(quote.data?.marketStatus) ?? '제공기관 미지원'} /></div>}
							</Section>

							<Section title="재무요약" state={queryStateText(financials)} action={<Toggle values={[['quarterly', '분기별'], ['annual', '연별']]} value={financialPeriod} onChange={(value) => setFinancialPeriod(value as FinancialPeriod)} />}>
								{financials.data && (
									<>
										<p className="mb-2 text-[10px] font-black text-muted-foreground">단위: {market === 'KR' ? '백만원' : 'USD million'}</p>
										<div className="grid grid-cols-2 gap-2">
											<Metric label="매출" value={millions(financeLatest?.revenue)} />
											<Metric label="영업이익" value={millions(financeLatest?.operatingIncome)} />
											<Metric label="순이익" value={millions(financeLatest?.netIncome)} />
											<Metric label="자산" value={millions(financeLatest?.assets)} />
											<Metric label="부채" value={millions(financeLatest?.liabilities ?? financeLatest?.debt)} />
											<Metric label="자본" value={millions(financeLatest?.equity ?? financeLatest?.capital)} />
											<Metric label="영업현금흐름" value={millions(financeLatest?.operatingCashFlow)} />
											<Metric label="PER" value={metric(ratios.per, '배')} />
											<Metric label="PBR" value={metric(ratios.pbr, '배')} />
											<Metric label="ROE" value={metric(ratios.roe, '%')} />
											<Metric label="부채비율" value={metric(ratios.debtRatio, '%')} />
											<Metric label="기준기간" value={text(financeLatest?.periodLabel ?? financeLatest?.period) ?? '데이터 없음'} />
										</div>
									</>
								)}
							</Section>

							<Section title="수급·공매도" state={queryStateText(flow)} action={<Toggle values={[['daily', '일별'], ['weekly', '주별'], ['monthly', '월별']]} value={flowPeriod} onChange={(value) => setFlowPeriod(value as FlowPeriod)} />}>
								<div className="grid grid-cols-2 gap-2">
									<Metric label="개인 순매매" value={flow.data?.available ? metric(flow.data?.totals?.individual) : flow.data?.message ?? '데이터 없음'} />
									<Metric label="기관 순매매" value={flow.data?.available ? metric(flow.data?.totals?.institution) : flow.data?.message ?? '데이터 없음'} />
									<Metric label="외국인 순매매" value={flow.data?.available ? metric(flow.data?.totals?.foreign) : flow.data?.message ?? '데이터 없음'} />
									<Metric label="공매도 거래량" value={shortSelling.data?.available ? metric(shortSelling.data?.latest?.shortVolume) : shortSelling.data?.message ?? '데이터 없음'} />
									<Metric label="공매도 비중" value={shortSelling.data?.available ? metric(shortSelling.data?.latest?.ratio, '%') : '데이터 없음'} />
									<Metric label="대차잔고" value={shortSelling.data?.available ? metric(shortSelling.data?.latest?.balance) : '제공 불가'} />
								</div>
								{flow.data?.note && <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">{flow.data.note}</p>}
							</Section>

							<HistorySection title="최신 뉴스" rows={newsRows} latestCount={5} loading={news.isLoading} error={news.isError} titleOf={(row) => row.title} subtitleOf={(row) => `${row.source ?? '뉴스'} · ${row.date ?? '날짜 없음'}`} />
							<HistorySection title="최신 공시" rows={disclosureRows} latestCount={5} loading={disclosures.isLoading} error={disclosures.isError} titleOf={(row) => row.report ?? `${row.form ?? '공시'} ${row.description ?? ''}`} subtitleOf={(row) => `${row.date ?? '날짜 없음'} · ${market === 'KR' ? 'DART' : 'SEC EDGAR'}`} />
						</>
					)}
				</main>
			)}
			<BottomNav />
		</div>
	);
}


function SpecialFeedPanel({
	asset,
	market,
	filter,
	onFilter,
	items,
	nowMs,
	loading,
	fetching,
	error,
	catalogSize,
	onRetry,
	onOpenItem,
}: {
	asset: AssetTab;
	market: SpecialFeedMarket;
	filter: SpecialFeedFilter;
	onFilter: (value: SpecialFeedFilter) => void;
	items: SpecialFeedItem[];
	nowMs: number;
	loading: boolean;
	fetching: boolean;
	error: boolean;
	catalogSize?: number;
	onRetry: () => void;
	onOpenItem: (item: SpecialFeedItem) => void;
}) {
	const [view, setView] = useState<SpecialFeedView>('latest');
	const [query, setQuery] = useState('');
	const [moreOpen, setMoreOpen] = useState(false);
	const [page, setPage] = useState(1);
	const filters: Array<[SpecialFeedFilter, string]> = [
		['all', '전체'],
		['news', '뉴스'],
		['positive', '호재'],
		['negative', '악재'],
		...(asset === 'stock' ? ([['disclosure', '중요공시']] as Array<[SpecialFeedFilter, string]>) : []),
		['signal', '차트신호'],
	];
	const marketLabel =
		market === 'KR'
			? '국내'
			: market === 'US'
				? '해외'
				: market === 'spot'
					? '업비트 현물'
					: '비트겟 선물';

	const filteredItems = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return [...items]
			.filter((item) => {
				const archiveAt = Date.parse(item.archiveAt);
				const fallbackArchiveAt = Date.parse(item.detectedAt) + 7 * 24 * 60 * 60_000;
				const isLatest = (Number.isFinite(archiveAt) ? archiveAt : fallbackArchiveAt) > nowMs;
				return view === 'latest' ? isLatest : !isLatest;
			})
			.filter((item) => {
				if (filter === 'all') return true;
				if (filter === 'news') return item.kind === 'news';
				if (filter === 'positive') return item.tone === 'positive';
				if (filter === 'negative') return item.tone === 'negative';
				if (filter === 'disclosure') return item.kind === 'disclosure';
				return item.kind === 'signal';
			})
			.filter((item) => {
				if (!needle) return true;
				return [item.name, item.ticker, item.title, item.summary, item.source]
					.some((value) => String(value ?? '').toLowerCase().includes(needle));
			})
			.sort((a, b) => {
				const aTime = Date.parse(a.sourceAt ?? a.detectedAt);
				const bTime = Date.parse(b.sourceAt ?? b.detectedAt);
				return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
			});
	}, [filter, items, nowMs, query, view]);

	const pageCount = Math.max(1, Math.ceil(filteredItems.length / 10));
	const modalItems = filteredItems.slice((page - 1) * 10, page * 10);
	const visibleItems = filteredItems.slice(0, 10);

	useEffect(() => {
		setPage(1);
	}, [asset, filter, market, query, view]);

	useEffect(() => {
		if (page > pageCount) setPage(pageCount);
	}, [page, pageCount]);

	useEffect(() => {
		if (!moreOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setMoreOpen(false);
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [moreOpen]);

	return (
		<>
			<section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
				<div className="text-center">
					<h2 className="text-base font-black">특이정보</h2>
					<p className="mt-1 break-keep text-[10px] font-bold leading-relaxed text-muted-foreground">
						{marketLabel} {asset === 'stock' ? '앱 종목' : '코인'} {catalogSize ? `${catalogSize}개` : '전체'}를 순환 확인합니다.
						1주일 이내는 최신으로, 1주일이 지나면 보관함의 지난 정보로 표시됩니다.
					</p>
					{fetching && !loading && (
						<p className="mt-1 text-[10px] font-black text-primary">새 정보를 확인하는 중입니다.</p>
					)}
				</div>

				<div className="mt-3 grid grid-cols-2 gap-2">
					<button
						type="button"
						onClick={() => setView('latest')}
						className={cn(
							'rounded-xl border px-3 py-2 text-xs font-black',
							view === 'latest'
								? 'border-primary bg-primary text-primary-foreground'
								: 'border-card-border bg-background text-muted-foreground',
						)}
					>
						최신정보
					</button>
					<button
						type="button"
						onClick={() => setView('archive')}
						className={cn(
							'inline-flex items-center justify-center gap-1 rounded-xl border px-3 py-2 text-xs font-black',
							view === 'archive'
								? 'border-primary bg-primary text-primary-foreground'
								: 'border-card-border bg-background text-muted-foreground',
						)}
					>
						<Archive className="h-3.5 w-3.5" />
						보관함
					</button>
				</div>

				<label className="mt-3 flex h-11 items-center gap-2 rounded-2xl border border-card-border bg-background px-3">
					<Search className="h-4 w-4 text-muted-foreground" />
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="종목·코인·제목·내용 검색"
						className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none"
					/>
					{query && (
						<button type="button" onClick={() => setQuery('')} aria-label="검색어 지우기">
							<X className="h-4 w-4 text-muted-foreground" />
						</button>
					)}
				</label>

				<div className="mt-3 grid w-full grid-cols-5 gap-1">
					{filters.map(([key, label]) => (
						<button
							key={key}
							type="button"
							onClick={() => onFilter(key)}
							className={cn(
								'min-w-0 whitespace-nowrap rounded-xl border px-1 py-2 text-[10px] font-black',
								filter === key
									? 'border-primary bg-primary text-primary-foreground'
									: 'border-card-border bg-background text-muted-foreground',
							)}
						>
							{label}
						</button>
					))}
				</div>

				<div className="mt-3 space-y-2">
					{loading && <InlineState>{asset === 'stock' ? '종목' : '코인'}의 뉴스·호재·악재·차트신호를 확인하는 중입니다.</InlineState>}
					{error && (
						<div className="space-y-2">
							<InlineState tone="error">특이정보를 불러오지 못했습니다.</InlineState>
							<button
								type="button"
								onClick={onRetry}
								className="w-full rounded-2xl border border-card-border bg-background px-4 py-3 text-xs font-black"
							>
								다시 불러오기
							</button>
						</div>
					)}
					{!loading && !error && filteredItems.length === 0 && (
						<InlineState>
							{view === 'latest' ? '최근 1주일 이내' : '1주일이 지난 보관함'}에 해당 정보가 없습니다.
						</InlineState>
					)}
					{!loading && !error && visibleItems.map((item) => (
						<SpecialFeedRow
							key={item.id}
							item={item}
							nowMs={nowMs}
							onOpenItem={() => onOpenItem(item)}
						/>
					))}
					{!loading && !error && filteredItems.length > 10 && (
						<button
							type="button"
							onClick={() => {
								setPage(1);
								setMoreOpen(true);
							}}
							className="w-full rounded-2xl border border-card-border bg-background px-4 py-3 text-xs font-black text-primary"
						>
							더보기 ({filteredItems.length}건)
						</button>
					)}
				</div>
			</section>

			{moreOpen && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
					onMouseDown={(event) => {
						if (event.currentTarget === event.target) setMoreOpen(false);
					}}
				>
					<div className="flex max-h-[82vh] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-card-border bg-card shadow-2xl">
						<div className="flex items-center justify-between border-b border-card-border px-4 py-3">
							<div>
								<p className="text-sm font-black">{view === 'latest' ? '최신정보' : '보관함'} 더보기</p>
								<p className="mt-0.5 text-[10px] font-bold text-muted-foreground">페이지당 10개 · 전체 {filteredItems.length}건</p>
							</div>
							<button type="button" onClick={() => setMoreOpen(false)} aria-label="닫기" className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border">
								<X className="h-4 w-4" />
							</button>
						</div>

						<div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
							{modalItems.map((item) => (
								<SpecialFeedRow
									key={`modal:${item.id}`}
									item={item}
									nowMs={nowMs}
									onOpenItem={() => {
										setMoreOpen(false);
										onOpenItem(item);
									}}
								/>
							))}
						</div>

						<div className="flex items-center justify-between border-t border-card-border px-3 py-3">
							<button
								type="button"
								onClick={() => setPage((value) => Math.max(1, value - 1))}
								disabled={page <= 1}
								className="inline-flex items-center gap-1 rounded-xl border border-card-border px-3 py-2 text-xs font-black disabled:opacity-40"
							>
								<ChevronLeft className="h-4 w-4" />
								이전
							</button>
							<span className="text-xs font-black">{page} / {pageCount}</span>
							<button
								type="button"
								onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
								disabled={page >= pageCount}
								className="inline-flex items-center gap-1 rounded-xl border border-card-border px-3 py-2 text-xs font-black disabled:opacity-40"
							>
								다음
								<ChevronRight className="h-4 w-4" />
							</button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}

function SpecialFeedRow({
	item,
	nowMs,
	onOpenItem,
}: {
	item: SpecialFeedItem;
	nowMs: number;
	onOpenItem: () => void;
}) {
	const isArchived = specialFeedArchiveTime(item) <= nowMs;
	const prefix = isArchived ? '지난' : '최신';
	const sourceLabel = item.kind === 'signal' ? '차트' : item.kind === 'disclosure' ? '공시' : '뉴스';
	const label = item.tone === 'positive'
		? `${prefix}${sourceLabel} 호재`
		: item.tone === 'negative'
			? `${prefix}${sourceLabel} 악재`
			: `${prefix}${sourceLabel}`;
	const badgeClass =
		item.tone === 'positive'
			? 'bg-positive/10 text-positive'
			: item.tone === 'negative'
				? 'bg-destructive/10 text-destructive'
				: 'bg-primary/10 text-primary';
	const itemName =
		item.asset === 'coin'
			? displayCoinName(item.ticker, item.name, item.name)
			: displayStockName(item.ticker, item.name, item.market === 'US' ? 'US' : 'KR');

	const content = (
		<div className="rounded-2xl border border-card-border bg-background p-3 text-left">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-1.5">
						<span className={cn('rounded-full px-2 py-1 text-[10px] font-black', badgeClass)}>
							{label}
						</span>
						<span className="truncate text-xs font-black">{itemName}</span>
						<span className="text-[10px] font-bold text-muted-foreground">{item.ticker}</span>
					</div>
					<p className="mt-2 break-keep text-sm font-black leading-relaxed">{item.title}</p>
					{item.summary && (
						<p className="mt-1 break-keep text-xs font-semibold leading-relaxed text-muted-foreground">
							{item.summary}
						</p>
					)}
				</div>
				{item.url && <ExternalLink className="h-4 w-4 shrink-0 text-primary" />}
			</div>

			{item.price != null && (
				<div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] font-black">
					<span>{formatAppPrice(item.price, item.currency)}</span>
					{item.changePercent != null && (
						<span className={item.changePercent >= 0 ? 'text-positive' : 'text-destructive'}>
							{formatAppPercent(item.changePercent)}
						</span>
					)}
					{item.timeframe && <span className="text-primary">{item.timeframe}</span>}
				</div>
			)}

			<div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-[10px] font-bold text-muted-foreground">
				<span>{item.source} · {elapsedFeedText(item.sourceAt ?? item.detectedAt, nowMs)}</span>
				<span>{isArchived ? '보관함' : '1주일 이내'}</span>
			</div>
		</div>
	);

	if (item.url) {
		return (
			<a href={item.url} target="_blank" rel="noreferrer">
				{content}
			</a>
		);
	}

	return (
		<button type="button" onClick={onOpenItem} className="block w-full">
			{content}
		</button>
	);
}

function specialFeedArchiveTime(item: SpecialFeedItem) {
	const archiveAt = Date.parse(item.archiveAt);
	if (Number.isFinite(archiveAt)) return archiveAt;
	const detectedAt = Date.parse(item.detectedAt);
	return Number.isFinite(detectedAt) ? detectedAt + 7 * 24 * 60 * 60_000 : Number.POSITIVE_INFINITY;
}

function elapsedFeedText(value: string, nowMs: number) {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return '방금 전';
	const minutes = Math.max(0, Math.floor((nowMs - timestamp) / 60_000));
	if (minutes < 1) return '방금 전';
	if (minutes < 60) return `${minutes}분 전`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}시간 전`;
	const days = Math.floor(hours / 24);
	return `${days}일 전`;
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
	return <button type="button" onClick={onClick} className={cn('inline-flex items-center justify-center text-center break-keep leading-tight rounded-xl border px-3 py-2 text-sm font-black', active ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-card text-muted-foreground')}>{children}</button>;
}

// 상세 카드 — 기본 접힘, 제목 영역 전체 탭으로 펼침/접힘.
function Section({ title, state, action, children }: { title: string; state?: string | null; action?: ReactNode; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<section className="rounded-3xl border border-card-border bg-card shadow-sm">
			<button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center justify-between gap-2 p-4">
				<span className="flex-1 text-center">
					<span className="block text-sm font-black">{title}</span>
					{!open && <span className="mt-0.5 block text-[10px] font-bold text-muted-foreground">{state ?? '눌러서 펼치기'}</span>}
				</span>
				<ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
			</button>
			{open && (
				<div className="px-4 pb-4">
					{action && <div className="mb-3 flex justify-center">{action}</div>}
					{state ? <InlineState tone={state.includes('못') ? 'error' : undefined}>{state}</InlineState> : children}
				</div>
			)}
		</section>
	);
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
	const [open, setOpen] = useState(false);
	if (!open) {
		return (
			<section className="rounded-3xl border border-card-border bg-card shadow-sm">
				<button type="button" onClick={() => setOpen(true)} aria-expanded={false} className="flex w-full items-center justify-between gap-2 p-4">
					<span className="flex-1 text-center"><span className="block text-sm font-black">{title}</span><span className="mt-0.5 block text-[10px] font-bold text-muted-foreground">{loading ? '불러오는 중' : error ? '불러오기 실패' : `최신 고유 ${latest.length}건 / 전체 ${rows.length}건`}</span></span>
					<ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
				</button>
			</section>
		);
	}
	return <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm"><button type="button" onClick={() => setOpen(false)} aria-expanded className="mb-3 flex w-full items-center justify-between gap-2"><span className="flex-1 text-center text-sm font-black">{title}</span><span className="text-[10px] font-bold text-muted-foreground">최신 고유 {latest.length}건 / 전체 {rows.length}건</span><ChevronDown className="h-4 w-4 rotate-180 text-muted-foreground" /></button>{loading && <InlineState>데이터를 불러오는 중입니다.</InlineState>}{error && <InlineState tone="error">데이터를 불러오지 못했습니다.</InlineState>}{!loading && !error && latest.length === 0 && <InlineState>제공된 데이터가 없습니다.</InlineState>}<div className="space-y-2">{latest.map((row, index) => <HistoryRow key={`${row.url ?? titleOf(row)}:${index}`} row={row} title={String(titleOf(row) || '제목 없음')} subtitle={subtitleOf(row)} />)}</div>{rows.length > latestCount && <details className="mt-3 rounded-2xl border border-card-border bg-background p-3"><summary className="cursor-pointer text-xs font-black">전체 과거 이력 보기 ({rows.length}건)</summary><div className="mt-3 max-h-96 space-y-2 overflow-y-auto">{rows.slice(latestCount).map((row, index) => <HistoryRow key={`history:${row.url ?? titleOf(row)}:${index}`} row={row} title={String(titleOf(row) || '제목 없음')} subtitle={subtitleOf(row)} />)}</div></details>}</section>;
}

function HistoryRow({ row, title, subtitle }: { row: AnyObj; title: string; subtitle: string }) {
	const content = <div className="rounded-2xl bg-secondary/60 p-3"><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="break-keep text-xs font-black leading-relaxed">{title}</p><p className="mt-1 text-[10px] font-bold text-muted-foreground">{subtitle}{Number(row.relatedCount ?? 1) > 1 ? ` · 관련 ${row.relatedCount}건` : ''}</p></div>{row.url && <ExternalLink className="h-3.5 w-3.5 shrink-0 text-primary" />}</div></div>;
	return row.url ? <a href={String(row.url)} target="_blank" rel="noreferrer">{content}</a> : content;
}

function formatDate(value: unknown) {
	const date = new Date(String(value ?? ''));
	return Number.isFinite(date.getTime()) ? date.toLocaleString('ko-KR') : '기준시각 없음';
}

type CoinPlan = {
	fairPrice: number | null;
	targetPrice: number | null;
	stopPrice: number | null;
	basis: string;
};

function normalizedCoinCandles(candles: AnyObj[]) {
	return candles
		.map((row) => {
			const open = finite(row.open ?? row.openPrice ?? row.opening_price);
			const high = finite(row.high ?? row.highPrice ?? row.high_price);
			const low = finite(row.low ?? row.lowPrice ?? row.low_price);
			const close = finite(row.close ?? row.closePrice ?? row.trade_price);
			const volume = finite(row.volume ?? row.candleAccTradeVolume ?? row.candle_acc_trade_volume) ?? 0;
			const rawTime = row.time ?? row.timestamp ?? row.date ?? row.datetime ?? row.candleDateTimeUtc ?? row.candle_date_time_utc;
			const numericTime = finite(rawTime);
			const parsedTime = numericTime != null
				? (numericTime > 10_000_000_000 ? numericTime / 1000 : numericTime)
				: Date.parse(String(rawTime ?? '')) / 1000;
			if (open == null || high == null || low == null || close == null || !Number.isFinite(parsedTime)) return null;
			return { time: Math.floor(parsedTime) as UTCTimestamp, open, high, low, close, volume: Math.max(volume, 0) };
		})
		.filter((row): row is { time: UTCTimestamp; open: number; high: number; low: number; close: number; volume: number } => row != null)
		.sort((left, right) => Number(left.time) - Number(right.time));
}

function buildCoinPlan(candles: AnyObj[], currentPrice: number | null): CoinPlan {
	const rows = normalizedCoinCandles(candles);
	if (currentPrice == null || currentPrice <= 0 || rows.length < 20) {
		return { fairPrice: null, targetPrice: null, stopPrice: null, basis: '현재가와 최소 20개 실제 OHLCV 봉이 필요합니다.' };
	}
	const window = rows.slice(-20);
	const totalVolume = window.reduce((sum, row) => sum + row.volume, 0);
	const fairPrice = totalVolume > 0
		? window.reduce((sum, row) => sum + ((row.high + row.low + row.close) / 3) * row.volume, 0) / totalVolume
		: window.reduce((sum, row) => sum + row.close, 0) / window.length;
	const trueRanges = window.slice(1).map((row, index) => {
		const previousClose = window[index].close;
		return Math.max(row.high - row.low, Math.abs(row.high - previousClose), Math.abs(row.low - previousClose));
	});
	const atrValue = trueRanges.length ? trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length : 0;
	const support = Math.min(...window.map((row) => row.low));
	const resistance = Math.max(...window.map((row) => row.high));
	const stopCandidate = Math.min(support - atrValue * 0.1, currentPrice - Math.max(atrValue * 1.2, currentPrice * 0.008));
	const stopPrice = stopCandidate > 0 && stopCandidate < currentPrice ? stopCandidate : null;
	const targetCandidate = stopPrice == null ? null : Math.max(resistance, currentPrice + (currentPrice - stopPrice) * 1.8);
	const targetPrice = targetCandidate != null && targetCandidate > currentPrice ? targetCandidate : null;
	return {
		fairPrice: Number.isFinite(fairPrice) && fairPrice > 0 ? fairPrice : null,
		targetPrice,
		stopPrice,
		basis: `${totalVolume > 0 ? '최근 20봉 거래량가중평균' : '최근 20봉 종가평균'} · 최근 20봉 지지·저항 · ATR 위험폭`,
	};
}

function CoinAiChart({ candles, plan }: { candles: AnyObj[]; plan: CoinPlan }) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const rows = useMemo(() => normalizedCoinCandles(candles), [candles]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || rows.length < 2) return;
		const dark = document.documentElement.classList.contains('dark');
		const chart = createChart(container, {
			width: Math.max(container.clientWidth, 1),
			height: 320,
			layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: dark ? '#94a3b8' : '#64748b' },
			grid: { vertLines: { color: 'rgba(100,116,139,0.10)' }, horzLines: { color: 'rgba(100,116,139,0.10)' } },
			timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 5 },
			handleScroll: true,
			handleScale: true,
		});
		const series = chart.addCandlestickSeries({ upColor: '#ef4444', downColor: '#3b82f6', wickUpColor: '#ef4444', wickDownColor: '#3b82f6', borderVisible: false });
		series.setData(rows.map((row) => ({ time: row.time, open: row.open, high: row.high, low: row.low, close: row.close })));
		if (plan.fairPrice != null) series.createPriceLine({ price: plan.fairPrice, color: '#f59e0b', lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '기술 적정가' });
		if (plan.targetPrice != null) series.createPriceLine({ price: plan.targetPrice, color: '#16a34a', lineWidth: 3, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'AI 목표가' });
		if (plan.stopPrice != null) series.createPriceLine({ price: plan.stopPrice, color: '#dc2626', lineWidth: 3, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'AI 손절가' });
		chart.timeScale().fitContent();
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width;
			if (width) chart.applyOptions({ width: Math.max(width, 1) });
		});
		observer.observe(container);
		return () => { observer.disconnect(); chart.remove(); };
	}, [plan, rows]);

	if (rows.length < 2) return <InlineState>실제 시간 정보가 있는 캔들이 부족해 차트를 표시할 수 없습니다.</InlineState>;
	return <div ref={containerRef} className="h-80 w-full" />;
}

function CoinAiPanel({ symbol, market, currency, candles, currentPrice, timeframe }: { symbol: string; market: CoinMarketTab; currency: string; candles: AnyObj[]; currentPrice: number | null; timeframe: string }) {
	const plan = useMemo(() => buildCoinPlan(candles, currentPrice), [candles, currentPrice]);
	return (
		<section className="overflow-hidden rounded-3xl border border-card-border bg-card shadow-sm">
			<div className="border-b border-card-border p-4 text-left">
				<p className="text-[10px] font-black text-primary">{symbol} · {market === 'spot' ? '현물' : '선물'} · {timeframe}</p>
				<h2 className="mt-1 text-base font-black">AI 기술 가격 계획</h2>
				<p className="mt-1 break-keep text-[11px] font-bold leading-5 text-muted-foreground">실제 거래소 캔들이 갱신될 때 자동 재산정됩니다. 재무제표는 사용하지 않습니다.</p>
			</div>
			<div className="grid grid-cols-3 gap-1.5 p-3">
				<Metric label="적정가" value={plan.fairPrice == null ? '산출 불가' : money(plan.fairPrice, currency)} />
				<Metric label="목표가" value={plan.targetPrice == null ? '산출 불가' : money(plan.targetPrice, currency)} />
				<Metric label="손절가" value={plan.stopPrice == null ? '산출 불가' : money(plan.stopPrice, currency)} />
			</div>
			<div className="border-y border-card-border bg-background/30"><CoinAiChart candles={candles} plan={plan} /></div>
			<p className="p-3 text-left text-[10px] font-bold leading-5 text-muted-foreground">산출 근거: {plan.basis}. 산출 불가인 가격선은 차트에 추가하지 않습니다.</p>
		</section>
	);
}

export function CoinInfo({ nowMs, basePath = '/stock-info' }: { nowMs: number; basePath?: string }) {
	const [location, navigate] = useLocation();
	const appMode = useAssetMode();
	const locationQuery = location.includes('?') ? location.split('?')[1] ?? '' : '';
	const browserQuery = typeof window !== 'undefined' ? window.location.search.replace(/^\?/, '') : '';
	const params = new URLSearchParams(locationQuery || browserQuery);
	const initialMarket: CoinMarketTab = params.get('coinMarket') === 'futures' ? 'futures' : 'spot';
	const [coinMarket, setCoinMarket] = useState<CoinMarketTab>(initialMarket);
	const [coinView, setCoinView] = useState<CoinViewTab>('market');
	const [symbol, setSymbol] = useState(() => String(params.get('symbol') ?? '').toUpperCase());
	const [searchText, setSearchText] = useState('');
	const [coinFeedFilter, setCoinFeedFilter] = useState<SpecialFeedFilter>('all');

	useEffect(() => {
		const nextLocationQuery = location.includes('?') ? location.split('?')[1] ?? '' : '';
		const nextBrowserQuery = typeof window !== 'undefined' ? window.location.search.replace(/^\?/, '') : '';
		const nextParams = new URLSearchParams(nextLocationQuery || nextBrowserQuery);
		const nextMarket: CoinMarketTab = nextParams.get('coinMarket') === 'futures' ? 'futures' : 'spot';
		setCoinMarket(nextMarket);
		// 기본 코인 자동 선택 없음 — 사용자가 검색·선택해야 상세 정보를 표시한다.
		setSymbol(String(nextParams.get('symbol') ?? '').toUpperCase());
	}, [location]);

	const changeCoin = (nextMarket: CoinMarketTab, nextSymbol?: string) => {
		const resolved = String(nextSymbol ?? '').toUpperCase();

		// 같은 경로에서 쿼리만 바뀌는 경우에도 버튼과 상세 화면이 즉시 갱신되게 한다.
		setCoinMarket(nextMarket);
		setSymbol(resolved);
		setSearchText('');
		setCoinView('market');
		appMode.setAsset('coin');
		appMode.setCoinMarket(nextMarket);

		const next = new URLSearchParams({ asset: 'coin', coinMarket: nextMarket });
		if (resolved) next.set('symbol', resolved);
		navigate(`${basePath}?${next.toString()}`, { replace: true });
	};

	const coinSpecialFeed = useQuery({
		queryKey: ['coin-info-special-feed', coinMarket],
		queryFn: async () => {
			const response = await authorizedFetch(
				`/api/stocks/special-feed?asset=coin&market=${coinMarket}&limit=2000&_ts=${Date.now()}`,
				{ cache: 'no-store' },
			);
			const payload = (await response.json().catch(() => ({}))) as SpecialFeedResponse & {
				error?: string;
				message?: string;
			};
			if (!response.ok) {
				throw new Error(payload.error ?? payload.message ?? `HTTP_${response.status}`);
			}
			return payload;
		},
		refetchInterval: 30_000,
		refetchIntervalInBackground: true,
		refetchOnWindowFocus: true,
		retry: 1,
	});

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
	const [coinTf, setCoinTf] = useState<VisibleChartTimeframe>('15m');
	const [visibleCoinTimeframes, setVisibleCoinTimeframes] = useState<VisibleChartTimeframe[]>(loadVisibleChartTimeframes);
	const [coinChartSettingsOpen, setCoinChartSettingsOpen] = useState(false);
	useEffect(() => {
		if (!visibleCoinTimeframes.includes(coinTf)) setCoinTf(visibleCoinTimeframes[0]);
	}, [coinTf, visibleCoinTimeframes]);
	useEffect(() => {
		if (!coinChartSettingsOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setCoinChartSettingsOpen(false);
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [coinChartSettingsOpen]);
	const toggleCoinTimeframe = (timeframe: VisibleChartTimeframe) => {
		const next = visibleCoinTimeframes.includes(timeframe)
			? visibleCoinTimeframes.filter((item) => item !== timeframe)
			: [...visibleCoinTimeframes, timeframe];
		if (next.length === 0) return;
		const ordered = CHART_TIMEFRAMES.filter((item) => next.includes(item.key)).map((item) => item.key);
		setVisibleCoinTimeframes(ordered);
		saveVisibleChartTimeframes(ordered);
	};
	const coinTfLabel = CHART_TIMEFRAMES.find((item) => item.key === coinTf)?.label ?? coinTf;
	const spotCandles = useQuery({
		queryKey: ['crypto-spot-candles', symbol, coinTf],
		queryFn: () => apiGet<AnyObj>(`/crypto/spot/candles?symbol=${encodeURIComponent(symbol)}&tf=${coinTf}&count=200`),
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
		queryKey: ['crypto-futures-candles', symbol, coinTf],
		queryFn: () => apiGet<AnyObj>(`/crypto/futures/candles?symbol=${encodeURIComponent(symbol)}&granularity=${coinTf}&limit=200`),
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
		<main className="space-y-4 px-4 pb-28 pt-4">
			<SpecialFeedPanel
				asset="coin"
				market={coinMarket}
				filter={coinFeedFilter}
				onFilter={setCoinFeedFilter}
				items={coinSpecialFeed.data?.items ?? []}
				nowMs={nowMs}
				loading={coinSpecialFeed.isLoading}
				fetching={coinSpecialFeed.isFetching}
				error={coinSpecialFeed.isError || coinSpecialFeed.data?.ok === false}
				catalogSize={coinSpecialFeed.data?.catalogSize}
				onRetry={() => { void coinSpecialFeed.refetch(); }}
				onOpenItem={(item) => {
					const nextMarket: CoinMarketTab = item.market === 'futures' ? 'futures' : 'spot';
					changeCoin(nextMarket, item.ticker);
				}}
			/>

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
				{searchText.trim().length > 0 && (
				<div className="mt-3 max-h-52 space-y-1 overflow-y-auto">
					{(coinMarket === 'spot' ? spotTickers.isLoading : futuresTickers.isLoading) && <InlineState>코인 목록을 불러오는 중입니다.</InlineState>}
					{!(coinMarket === 'spot' ? spotTickers.isLoading : futuresTickers.isLoading) && filteredRows.length === 0 && <InlineState>검색 결과가 없습니다.</InlineState>}
					{filteredRows.map((item) => {
						const itemSymbol = String(item.symbol);
						return (
							<button key={itemSymbol} type="button" onClick={() => { setSearchText(''); changeCoin(coinMarket, itemSymbol); }} className={cn('flex w-full items-center justify-between rounded-xl px-3 py-2 text-left', itemSymbol === symbol ? 'bg-primary/10 text-primary' : 'bg-secondary/60')}>
								<span className="min-w-0 truncate text-sm font-black">{displayCoinName(String(itemSymbol), item.koreanName, item.englishName)}</span>
								<span className="ml-2 shrink-0 text-[10px] font-bold text-muted-foreground">{itemSymbol}</span>
							</button>
						);
					})}
				</div>
				)}
			</section>

			{!symbol && <InlineState>코인을 검색해 선택하면 실제 시세·호가·캔들 정보가 아래에 표시됩니다.</InlineState>}

			{symbol && (
			<>
			<section className="rounded-3xl border border-card-border bg-card p-2 shadow-sm">
				<div className="grid grid-cols-2 gap-1">
					<Tab active={coinView === 'market'} onClick={() => setCoinView('market')}>시세·차트</Tab>
					<Tab active={coinView === 'ai'} onClick={() => setCoinView('ai')}>AI분석</Tab>
				</div>
			</section>
			{coinView === 'market' ? (
			<>
			<Section title={coinMarket === 'spot' ? '현물 기본정보' : '선물 기본정보'} state={selected ? null : '선택한 코인의 시세 데이터가 없습니다.'}>
				{selected && (
					<>
						<div className="flex items-start justify-between gap-3">
							<div>
								<p className="text-xl font-black">{displayCoinName(String(selected.symbol), selected.koreanName, selected.englishName)}</p>
								<p className="mt-1 text-xs font-bold text-muted-foreground">{selected.symbol} · {coinMarket === 'spot' ? '업비트 KRW' : '비트겟 USDT 선물'} · 기준 {formatDate(coinMarket === 'spot' ? spotTickers.data?.updatedAt : futuresTickers.data?.updatedAt)}</p>
							</div>
							<button type="button" onClick={() => { void (coinMarket === 'spot' ? spotTickers.refetch() : futuresTickers.refetch()); }} className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border"><RefreshCw className="h-4 w-4" /></button>
						</div>
						<div className="mt-3 flex items-center gap-1 overflow-x-auto pb-1">
							{CHART_TIMEFRAMES.filter((item) => visibleCoinTimeframes.includes(item.key)).map((item) => (
									<button
										key={item.key}
										type="button"
										onClick={() => setCoinTf(item.key)}
										className={cn(
											'shrink-0 rounded-xl border px-2 py-1.5 text-[11px] font-black',
											coinTf === item.key ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-card text-muted-foreground',
										)}
									>
										{item.label}
									</button>
								))}
							<button type="button" onClick={() => setCoinChartSettingsOpen(true)} className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-card-border" aria-label="차트 시간 설정">
								<Settings2 className="h-4 w-4" />
							</button>
						</div>
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
							<Metric label={`${coinTfLabel} 최신 종가`} value={money(latestCandle?.close, currency)} />
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
			</>
			) : (
				<CoinAiPanel
					symbol={symbol}
					market={coinMarket}
					currency={currency}
					candles={candles ?? []}
					currentPrice={finite(selected?.price ?? latestCandle?.close)}
					timeframe={coinTf}
				/>
			)}

			{coinChartSettingsOpen && (
				<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4" onMouseDown={() => setCoinChartSettingsOpen(false)}>
					<section className="w-full max-w-md rounded-3xl border border-card-border bg-card p-5 shadow-2xl" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="차트 시간 설정">
						<div className="flex items-center justify-between gap-3">
							<h3 className="text-left text-lg font-black">차트 시간 설정</h3>
							<button type="button" onClick={() => setCoinChartSettingsOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border" aria-label="닫기"><X className="h-4 w-4" /></button>
						</div>
						<p className="mt-2 text-left text-xs font-bold text-muted-foreground">선택한 항목만 차트 밖에 표시됩니다. 최소 한 개는 유지됩니다.</p>
						<div className="mt-4 grid grid-cols-3 gap-2">
							{CHART_TIMEFRAMES.map((item) => {
								const active = visibleCoinTimeframes.includes(item.key);
								return <button key={item.key} type="button" onClick={() => toggleCoinTimeframe(item.key)} className={cn('rounded-xl border px-2 py-2 text-xs font-black', active ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-background text-muted-foreground')}>{item.label}</button>;
							})}
						</div>
					</section>
				</div>
			)}

			<PriceAlertCard assetType={coinMarket === 'spot' ? 'coin_spot' : 'coin_futures'} market={coinMarket === 'spot' ? 'UPBIT' : 'BITGET'} symbol={symbol} currentPrice={finite(selected?.price)} currency={currency} />
			</>
			)}

			<section className="rounded-3xl border border-card-border bg-card p-4 text-xs font-bold leading-relaxed text-muted-foreground shadow-sm">
				코인 화면에는 PER·PBR·ROE·기관·외국인 수급을 표시하지 않습니다. 공개 시세와 실제 거래소 응답이 없으면 임시 가격을 만들지 않고 데이터 없음으로 표시합니다.
			</section>
		</main>
	);
}
