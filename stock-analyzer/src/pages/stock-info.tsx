import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import {
	Archive,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ExternalLink,
	RefreshCw,
	Search,
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

type AnyObj = Record<string, any>;
type AssetTab = 'stock' | 'coin';
type MarketTab = 'KR' | 'US';
type FinancialPeriod = 'annual' | 'quarterly';
type FlowPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

type CoinMarketTab = 'spot' | 'futures';
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
	const coinMarket: CoinMarketTab = params.get('coinMarket') === 'futures' ? 'futures' : 'spot';
	const ticker = String(params.get('ticker') ?? params.get('symbol') ?? '').toUpperCase();
	return { asset, market, ticker, coinMarket };
}

function infoArrayRows(value: unknown, keys: string[] = []): AnyObj[] {
	if (Array.isArray(value)) return value as AnyObj[];
	if (!value || typeof value !== 'object') return [];
	const record = value as AnyObj;
	for (const key of keys) {
		if (Array.isArray(record[key])) return record[key] as AnyObj[];
	}
	for (const key of ['items', 'rows', 'data', 'markets', 'tickers']) {
		if (Array.isArray(record[key])) return record[key] as AnyObj[];
	}
	return [];
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

function specialFeedIdentity(item: SpecialFeedItem): string {
	return [item.kind, item.ticker, normalizeTitle(item.title), item.url ?? ''].join('|');
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
		appMode.setAsset(next.asset);
		if (next.asset === 'stock') appMode.setStockMarket(next.market);
		else appMode.setCoinMarket(next.coinMarket);
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
		queryFn: () =>
			apiGet<{ results: SearchResult[] }>(
				`/search/quotes?q=${encodeURIComponent(searchText.trim())}&market=${market}&limit=50&enrich=0`,
			),
		enabled: asset === 'stock' && searchText.trim().length >= 1,
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
		enabled: false,
		refetchInterval: 30_000,
	});
	const profile = useQuery({
		queryKey: ['stock-info-profile', ticker],
		queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/profile`),
		enabled: false,
		staleTime: 5 * 60_000,
	});
	const financials = useQuery({
		queryKey: ['stock-info-financials', ticker],
		queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/financials`),
		enabled: false,
		staleTime: 5 * 60_000,
	});
	const flow = useQuery({
		queryKey: ['stock-info-flow', ticker, flowPeriod],
		queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/market-flow?period=${flowPeriod}`),
		enabled: false,
	});
	const shortSelling = useQuery({
		queryKey: ['stock-info-short', ticker, flowPeriod],
		queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/short-selling?period=${flowPeriod}`),
		enabled: false,
	});
	const news = useQuery({
		queryKey: ['stock-info-news-all', ticker],
		queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/news?all=1`),
		enabled: false,
	});
	const disclosures = useQuery({
		queryKey: ['stock-info-disclosures-all', ticker],
		queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/disclosures?all=1`),
		enabled: false,
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
			{/* 상단 고정 없음 — 제목·탭·상세가 한 페이지로 함께 스크롤. */}
			<header className="border-b border-card-border px-4 pb-3 pt-4">
				<h1 className="mb-3 text-center text-xl font-extrabold">정보</h1>

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

				<div className="mt-3 grid grid-cols-2 gap-2">
					<AnalysisEntry label="국내시장" onClick={() => navigate('/analysis/kr')} />
					<AnalysisEntry label="해외시장" onClick={() => navigate('/analysis/us')} />
					<AnalysisEntry label="코인시장" onClick={() => navigate('/analysis/coin')} />
					<AnalysisEntry label="포트폴리오" onClick={() => navigate('/portfolio')} />
				</div>
			</header>

			{asset === 'coin' ? (
				<CoinInfo nowMs={nowMs} />
			) : (
				<main className="space-y-4 px-4 pb-28 pt-4">
					<section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
						<label className="flex h-11 items-center gap-2 rounded-2xl border border-slate-600 bg-slate-950 px-3 text-white shadow-lg">
							<Search className="h-4 w-4 text-muted-foreground" />
							<input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="이름·티커·상품코드 검색" className="min-w-0 flex-1 bg-transparent text-sm font-bold text-white outline-none placeholder:text-slate-400" />
						{searchText && <button type="button" onClick={() => setSearchText('')} aria-label="검색 닫기"><X className="h-4 w-4 text-white" /></button>}
						</label>
						{searchText.trim().length > 0 && (
							<div className="mt-3 max-h-44 space-y-1 overflow-y-auto">
								{search.isLoading && <InlineState>종목 목록을 불러오는 중입니다.</InlineState>}
								{search.isError && <InlineState tone="error">종목 목록을 불러오지 못했습니다.</InlineState>}
								{!search.isLoading && !search.isError && candidates.length === 0 && <InlineState>검색 결과가 없습니다.</InlineState>}
								{candidates.map((item: SearchResult) => (
									<button key={`${item.market}:${item.ticker}`} type="button" onClick={() => { setSearchText(''); updateSelection({ ticker: item.ticker }); }} className={cn('flex w-full items-center justify-between rounded-xl border px-3 py-2 text-white', item.ticker === ticker ? 'border-primary bg-primary/30' : 'border-slate-700 bg-slate-900')}>
										<span className="min-w-0 flex-1 truncate text-center text-sm font-black">{displayStockName(item.ticker, item.name, item.market)}</span>
										<span className="ml-2 shrink-0 text-[10px] font-bold text-muted-foreground">{item.ticker}</span>
									</button>
								))}
							</div>
						)}
					</section>

					<SpecialFeedPanel
						asset="stock"
						market={market}
						selectedTicker={ticker}
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


					{false && ticker && (
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
												<p className="mt-1 text-xs font-bold text-muted-foreground">{ticker} · {market === 'KR' ? '국내' : '해외'} · 기준 {formatDate(quote.data?.updatedAt)}</p>
											</div>
											<button type="button" onClick={() => setWatchlisted(toggleWatchlistItem({ ticker, name: selectedName, market, currency }))} aria-label="관심종목" className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full border', watchlisted ? 'border-warning bg-warning/10 text-warning' : 'border-card-border')}>
												<Star className={cn('h-5 w-5', watchlisted && 'fill-current')} />
											</button>
										</div>
										<div className="mt-3 grid grid-cols-2 gap-2">
											<Metric label="현재가" value={money(quote.data?.price, currency)} strong />
											<Metric label="등락률" value={finite(quote.data?.changePercent) == null ? '데이터 없음' : formatAppPercent(quote.data?.changePercent)} tone={Number(quote.data?.changePercent) >= 0 ? 'up' : 'down'} />
										</div>
										<button type="button" onClick={() => navigate(`/stock/${encodeURIComponent(ticker)}`)} className="mt-3 flex w-full items-center justify-center gap-1 rounded-2xl bg-primary px-4 py-3 text-sm font-black text-primary-foreground">상세 분석 <ChevronRight className="h-4 w-4" /></button>
									</>
								)}
							</section>

							<Section title="기본정보" state={queryStateText(quote)}>
								{quote.data && (
									<div className="grid grid-cols-2 gap-2">
										<Metric label="전일대비" value={money(quote.data?.changeAmount, currency)} />
										<Metric label="거래량" value={metric(quote.data?.volume)} />
										<Metric label="시가" value={money(quote.data?.open, currency)} />
										<Metric label="고가 / 저가" value={`${money(quote.data?.high, currency)} / ${money(quote.data?.low, currency)}`} />
										<Metric label="거래대금" value={money(quote.data?.tradingValue, currency)} />
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
	selectedTicker,
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
	selectedTicker?: string;
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
	const [moreOpen, setMoreOpen] = useState(false);
	const [page, setPage] = useState(1);
	const filters: Array<[SpecialFeedFilter, string]> = [
		['all', '전체'],
		['news', '뉴스'],
		['positive', '호재'],
		['negative', '악재'],
		['disclosure', '주요공시'],
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
		return Array.from(new Map(items.map((item) => [specialFeedIdentity(item), item])).values())
			.filter((item) =>
				!selectedTicker ||
				item.ticker.trim().toUpperCase() === selectedTicker.trim().toUpperCase(),
			)
			.filter((item) => {
				const archiveAt = Date.parse(item.archiveAt);
				const fallbackArchiveAt = Date.parse(item.detectedAt) + 7 * 24 * 60 * 60_000;
				const isLatest = (Number.isFinite(archiveAt) ? archiveAt : fallbackArchiveAt) > nowMs;
				return view === 'latest' ? isLatest : !isLatest;
			})
			.filter((item) => {
				if (filter === 'all') return true;
				if (filter === 'news') return item.kind === 'news';
				if (filter === 'positive') return item.kind === 'news' && item.tone === 'positive';
				if (filter === 'negative') return item.kind === 'news' && item.tone === 'negative';
				if (filter === 'disclosure') return item.kind === 'disclosure';
				return item.kind === 'signal';
			})
			.sort((a, b) => {
				const aTime = Date.parse(a.sourceAt ?? a.detectedAt);
				const bTime = Date.parse(b.sourceAt ?? b.detectedAt);
				return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
			});
	}, [filter, items, nowMs, selectedTicker, view]);

	const pageCount = Math.max(1, Math.ceil(filteredItems.length / 5));
	const modalItems = filteredItems.slice(0, page * 5);
	const visibleItems = filteredItems.slice(0, 5);

	useEffect(() => {
		setPage(1);
	}, [asset, filter, market, selectedTicker, view]);

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
				<div className="grid grid-cols-2 gap-2">
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


				<div className="mt-3 grid w-full grid-cols-6 gap-1">
					{filters.map(([key, label]) => (
						<button
							key={key}
							type="button"
							onClick={() => { onFilter(key); setPage(1); setMoreOpen(true); }}
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
							<InlineState tone="error">정보를 불러오지 못했습니다.</InlineState>
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
					{!loading && !error && filteredItems.length > 5 && (
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
								<p className="mt-0.5 text-[10px] font-bold text-muted-foreground">페이지당 5개 · 전체 {filteredItems.length}건</p>
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
							<span className="text-xs font-black">{modalItems.length} / {filteredItems.length}건</span>
							<button
								type="button"
								onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
								disabled={page >= pageCount}
								className="inline-flex items-center gap-1 rounded-xl border border-card-border px-4 py-2 text-xs font-black text-primary disabled:opacity-40"
							>
								더보기
								<ChevronDown className="h-4 w-4" />
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
	const label =
		item.kind === 'signal'
			? `${prefix}차트`
			: item.kind === 'disclosure'
				? `${prefix}공시`
				: item.tone === 'positive'
					? `${prefix}호재`
					: item.tone === 'negative'
						? `${prefix}악재`
						: `${prefix}뉴스`;
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

// 시장분석 진입 카드 — 전체 화면으로 이동한다.
function AnalysisEntry({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex items-center justify-between gap-2 rounded-2xl border border-card-border bg-card px-3 py-3 text-left shadow-sm"
		>
			<span className="min-w-0 flex-1 truncate text-sm font-black">{label}</span>
			<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
		</button>
	);
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

export function CoinInfo({ nowMs, basePath = '/stock-info' }: { nowMs: number; basePath?: string }) {
	const [location, navigate] = useLocation();
	const appMode = useAssetMode();
	const locationQuery = location.includes('?') ? location.split('?')[1] ?? '' : '';
	const browserQuery = typeof window !== 'undefined' ? window.location.search.replace(/^\?/, '') : '';
	const params = new URLSearchParams(locationQuery || browserQuery);
	const initialMarket: CoinMarketTab = params.get('coinMarket') === 'futures' ? 'futures' : 'spot';
	const [coinMarket, setCoinMarket] = useState<CoinMarketTab>(initialMarket);
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

	const spotMarketRows = infoArrayRows(spotMarkets.data, ['markets']);
	const spotTickerRows = infoArrayRows(spotTickers.data, ['tickers']);
	const futuresRows = infoArrayRows(futuresTickers.data, ['tickers']);
	const marketNames = new Map<string, AnyObj>(
		spotMarketRows.map((item): [string, AnyObj] => [String(item.symbol), item]),
	);
	const spotRows = spotTickerRows.map((item) => ({ ...item, ...(marketNames.get(String(item.symbol)) ?? {}) }));
	const futureRows = futuresRows;
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
	const candles = infoArrayRows(coinMarket === 'spot' ? spotCandles.data : futuresCandles.data, ['candles']);
	const latestCandle = candles?.at(-1);
	const connectionOk = coinMarket === 'spot' ? status.data?.upbit?.ok : status.data?.bitget?.ok;

	return (
		<main className="space-y-4 px-4 pb-28 pt-4">
			<section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
				<div className="grid grid-cols-2 gap-2">
					<Tab active={coinMarket === 'spot'} onClick={() => changeCoin('spot')}>현물 · 업비트</Tab>
					<Tab active={coinMarket === 'futures'} onClick={() => changeCoin('futures')}>선물 · 비트겟</Tab>
				</div>
				<div className={cn('mt-3 rounded-2xl px-3 py-2 text-xs font-black', connectionOk ? 'bg-positive/10 text-positive' : 'bg-destructive/10 text-destructive')}>
					{coinMarket === 'spot' ? '업비트' : '비트겟'} 공개 시세 · {status.isLoading ? '연결 확인 중' : connectionOk ? '정상' : '연결 오류'}
				</div>
				<label className="mt-3 flex h-11 items-center gap-2 rounded-2xl border border-slate-600 bg-slate-950 px-3 text-white shadow-lg">
					<Search className="h-4 w-4 text-muted-foreground" />
					<input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="이름·티커·상품코드 검색" className="min-w-0 flex-1 bg-transparent text-sm font-bold text-white outline-none placeholder:text-slate-400" />
				{searchText && <button type="button" onClick={() => setSearchText('')} aria-label="검색 닫기"><X className="h-4 w-4 text-white" /></button>}
				</label>
				{searchText.trim().length > 0 && (
				<div className="mt-3 max-h-52 space-y-1 overflow-y-auto">
					{(coinMarket === 'spot' ? spotTickers.isLoading : futuresTickers.isLoading) && <InlineState>코인 목록을 불러오는 중입니다.</InlineState>}
					{!(coinMarket === 'spot' ? spotTickers.isLoading : futuresTickers.isLoading) && filteredRows.length === 0 && <InlineState>검색 결과가 없습니다.</InlineState>}
					{filteredRows.map((item) => {
						const itemSymbol = String(item.symbol);
						return (
							<button key={itemSymbol} type="button" onClick={() => { setSearchText(''); changeCoin(coinMarket, itemSymbol); }} className={cn('flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-white', itemSymbol === symbol ? 'border-primary bg-primary/30' : 'border-slate-700 bg-slate-900')}>
								<span className="min-w-0 truncate text-sm font-black">{displayCoinName(String(itemSymbol), item.koreanName, item.englishName)}</span>
								<span className="ml-2 shrink-0 text-[10px] font-bold text-muted-foreground">{itemSymbol}</span>
							</button>
						);
					})}
				</div>
				)}
			</section>

			<SpecialFeedPanel
				asset="coin"
				market={coinMarket}
				filter={coinFeedFilter}
				onFilter={setCoinFeedFilter}
				items={infoArrayRows(coinSpecialFeed.data, ['items']) as SpecialFeedItem[]}
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


			{symbol && (
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
						{infoArrayRows(orderbook.data, ['units']).slice(0, 15).map((unit, index) => (
							<div key={index} className="grid grid-cols-4 gap-1 rounded-xl bg-secondary/60 p-2 text-center text-[10px] font-bold">
								<span className="text-destructive">{money(unit.askPrice, 'KRW')}</span><span>{metric(unit.askSize)}</span><span>{metric(unit.bidSize)}</span><span className="text-positive">{money(unit.bidPrice, 'KRW')}</span>
							</div>
						))}
					</div>
				</Section>
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
