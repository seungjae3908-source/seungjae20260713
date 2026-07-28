import { useDeferredValue, useMemo, useState  } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import {
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	ChevronDown,
	ChevronRight,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { AssetSwitch } from '@/components/asset-switch';
import { AppModal } from '@/components/app-modal';
import { SearchField } from '@/components/search-field';
import { ErrorState, LoadingState } from '@/components/data-state';
import { api, apiGet, type QuoteRow } from '@/lib/api';
import { useAssetMode } from '@/lib/asset-mode';
import {
	displayCoinName,
	displayStockName,
	formatAppPercent,
	formatAppPrice,
} from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;
type CategoryKey =
	| 'marketCap'
	| 'volume'
	| 'tradingValue'
	| 'gainers'
	| 'losers'
	| 'ai';
type SortDirection = 'default' | 'asc' | 'desc';
type AiGroup =
	| 'shortSurge'
	| 'breakout'
	| 'undervalued'
	| 'accumulation';

const CATEGORIES: { key: CategoryKey; label: string }[] = [
	{ key: 'marketCap', label: '시가총액' },
	{ key: 'volume', label: '거래량' },
	{ key: 'tradingValue', label: '거래대금' },
	{ key: 'gainers', label: '급상승' },
	{ key: 'losers', label: '급하락' },
	{ key: 'ai', label: 'AI추천' },
];

const PAGE_SIZE = 20;

const AI_GROUPS: { key: AiGroup; label: string }[] = [
	{ key: 'shortSurge', label: '단기급등' },
	{ key: 'breakout', label: '추세돌파' },
	{ key: 'undervalued', label: '저평가' },
	{ key: 'accumulation', label: '매집' },
];

interface RecoRow {
	ticker: string;
	name: string;
	market: 'KR' | 'US';
	currency: 'KRW' | 'USD';
	category: string;
	categoryLabel?: string;
	aiType?: AiGroup;
	price: number;
	changePercent: number;
	reasons: string[];
	risks?: string[];
	score: number;
	entry?: number;
	entryLow?: number;
	entryHigh?: number;
	breakoutPrice?: number;
	target?: number;
	targetPrice1?: number;
	targetPrice2?: number;
	stop?: number;
	stopLossPrice?: number;
	summary?: string[];
	chartAnalysis?: string[];
	volumeAnalysis?: string[];
	trendAnalysis?: string[];
	supplyDemandAnalysis?: string[];
	financialAnalysis?: string[];
	positiveFactors?: string[];
	warningFactors?: string[];
	overallOpinion?: string[];
	analyzedAt?: string;
	status?: 'ACTIVE' | 'EXITED';
	conditionPassed?: boolean;
	exitReasons?: string[];
	confidence?: number;
}

interface RecoResponse {
	market: 'KR' | 'US';
	rows: RecoRow[];
}

interface CandidateDetail {
	kind: 'stock' | 'coin';
	name: string;
	symbol: string;
	marketLabel: string;
	aiLabel: string;
	opinion: string;
	score: number | null;
	confidence: number | null;
	reasons: string[];
	risks: string[];
	summary: string[];
	chartAnalysis: string[];
	volumeAnalysis: string[];
	trendAnalysis: string[];
	supplyDemandAnalysis: string[];
	financialAnalysis: string[];
	positiveFactors: string[];
	warningFactors: string[];
	overallOpinion: string[];
	price: number | null;
	changePercent: number | null;
	entryLow: number | null;
	entryHigh: number | null;
	breakoutPrice: number | null;
	target1: number | null;
	target2: number | null;
	stop: number | null;
	analyzedAt: string | null;
	status: 'ACTIVE' | 'EXITED';
	exitReasons: string[];
	currency: string;
	moveTo: string;
}

function finite(value: unknown): number | null {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function stringRows(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => String(item ?? '').trim())
		.filter(Boolean);
}

function nextSort(value: SortDirection): SortDirection {
	return value === 'default'
		? 'asc'
		: value === 'asc'
			? 'desc'
			: 'default';
}

function aiLabelOf(group: AiGroup): string {
	return AI_GROUPS.find((item) => item.key === group)?.label ?? 'AI 분석';
}

function activeRecommendation(row: RecoRow): boolean {
	if (row.status === 'EXITED') return false;
	if (row.conditionPassed === false) return false;
	return true;
}

function formatAnalysisTime(value: string | null): string {
	if (!value) return '확인 불가';

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;

	return date.toLocaleString('ko-KR', {
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	});
}

export default function StocksPage() {
	const [, navigate] = useLocation();
	const mode = useAssetMode();
	const [query, setQuery] = useState('');
	const [category, setCategory] = useState<CategoryKey | null>(null);
	const [aiGroup, setAiGroup] = useState<AiGroup>('shortSurge');
	const [nameSort, setNameSort] =
		useState<SortDirection>('default');
	const [metricSort, setMetricSort] =
		useState<SortDirection>('default');
	const [candidate, setCandidate] =
		useState<CandidateDetail | null>(null);
	const [page, setPage] = useState(1);

	const trimmed = query.trim();
	const deferredTrimmed = useDeferredValue(trimmed);
	const searching = deferredTrimmed.length > 0;
	const isStock = mode.asset === 'stock';

	const stockRows = useQuery({
		queryKey: ['stocks-directory', mode.stockMarket, deferredTrimmed],
		queryFn: () => api.searchRows(deferredTrimmed),
		enabled: isStock && searching,
		staleTime: 2 * 60_000,
		gcTime: 15 * 60_000,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: true,
		retry: 1,
		placeholderData: (previous) => previous,
	});

	const recommendations = useQuery({
		queryKey: [
			'stocks-recommendations',
			mode.stockMarket,
			aiGroup,
		],
		queryFn: () =>
			apiGet<RecoResponse>(
				`/market/recommendations?market=${mode.stockMarket}&aiType=${aiGroup}&_ts=${Date.now()}`,
			),
		enabled: isStock && !searching,
		staleTime: 30_000,
		gcTime: 10 * 60_000,
		refetchInterval: 60_000,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: true,
		retry: 1,
	});

	const movers = useQuery({
		queryKey: ['stocks-movers', mode.stockMarket],
		queryFn: () =>
			apiGet<AnyObj>(
				`/market/movers?market=${mode.stockMarket}&limit=100&_ts=${Date.now()}`,
			),
		enabled: isStock && !searching,
		staleTime: 30_000,
		gcTime: 10 * 60_000,
		refetchInterval: 60_000,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: true,
		retry: 1,
	});

	const spotMarkets = useQuery({
		queryKey: ['stocks-crypto-spot-markets'],
		queryFn: () => apiGet<AnyObj>('/crypto/spot/markets'),
		enabled: !isStock && mode.coinMarket === 'spot',
		staleTime: 10 * 60_000,
	});

	const spotTickers = useQuery({
		queryKey: ['crypto-spot-tickers'],
		queryFn: () => apiGet<AnyObj>('/crypto/spot/tickers'),
		enabled: !isStock && mode.coinMarket === 'spot',
		staleTime: 5_000,
		refetchInterval: 10_000,
		refetchIntervalInBackground: false,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: true,
		placeholderData: (previous) => previous,
	});

	const futuresTickers = useQuery({
		queryKey: ['crypto-futures-tickers'],
		queryFn: () => apiGet<AnyObj>('/crypto/futures/tickers'),
		enabled: !isStock && mode.coinMarket === 'futures',
		staleTime: 5_000,
		refetchInterval: 10_000,
		refetchIntervalInBackground: false,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: true,
		placeholderData: (previous) => previous,
	});

	const spotNames = useMemo(
		() =>
			new Map<string, AnyObj>(
				((spotMarkets.data?.markets ?? []) as AnyObj[]).map(
					(row) => [String(row.symbol), row],
				),
			),
		[spotMarkets.data],
	);

	const coinRows = useMemo<AnyObj[]>(() => {
		if (isStock) return [];

		return mode.coinMarket === 'spot'
			? ((spotTickers.data?.tickers ?? []) as AnyObj[]).map(
					(row) => ({
						...row,
						...(spotNames.get(String(row.symbol)) ?? {}),
					}),
				)
			: ((futuresTickers.data?.tickers ?? []) as AnyObj[]);
	}, [
		futuresTickers.data,
		isStock,
		mode.coinMarket,
		spotNames,
		spotTickers.data,
	]);

	const stockSearchResults = useMemo(() => {
		const rows = (stockRows.data?.results ?? []) as QuoteRow[];
		return rows
			.filter((row) => row.market === mode.stockMarket)
			.slice(0, 30);
	}, [mode.stockMarket, stockRows.data]);

	const coinSearchResults = useMemo(() => {
		if (!searching) return [];

		const needle = trimmed.toLowerCase();

		return coinRows
			.filter((row) =>
				[
					row.symbol,
					row.koreanName,
					row.englishName,
					displayCoinName(
						String(row.symbol),
						row.koreanName,
						row.englishName,
					),
				].some((value) =>
					String(value ?? '').toLowerCase().includes(needle),
				),
			)
			.slice(0, 30);
	}, [coinRows, searching, trimmed]);

	const stockCategoryRows = useMemo<AnyObj[]>(() => {
		if (!category || category === 'ai') return [];

		const source =
			category === 'marketCap'
				? movers.data?.marketCap
				: category === 'volume'
					? movers.data?.volume
					: category === 'tradingValue'
						? movers.data?.popular
						: category === 'gainers'
							? movers.data?.gainers
							: movers.data?.losers;

		return dedupe(
			((source ?? []) as AnyObj[]),
			(row) => `${row.market}:${row.ticker}`,
		).filter((row) => row.market === mode.stockMarket);
	}, [category, mode.stockMarket, movers.data]);

	const coinCategoryRows = useMemo<AnyObj[]>(() => {
		if (!category || category === 'ai') return [];

		const rows = [...coinRows];
		const metric = categoryMetric(category);

		return rows
			.filter(
				(row) =>
					category !== 'marketCap' ||
					finite(row.marketCap) != null,
			)
			.sort(
				(a, b) =>
					metricValue(b, metric) - metricValue(a, metric),
			);
	}, [category, coinRows]);

	const stockAiRows = useMemo(
		() =>
			(recommendations.data?.rows ?? [])
				.filter((row) => row.market === mode.stockMarket)
				.filter(activeRecommendation),
		[mode.stockMarket, recommendations.data],
	);

	const coinAiRows = useMemo(
		() => buildCoinCandidates(coinRows, mode.coinMarket),
		[coinRows, mode.coinMarket],
	);

	const modalRows = useMemo<AnyObj[]>(() => {
		const base =
			category === 'ai'
				? isStock
					? stockAiRows.filter(
							(row) => classifyStockAi(row) === aiGroup,
						)
					: coinAiRows.filter(
							(row) => row.aiGroup === aiGroup,
						)
				: isStock
					? stockCategoryRows
					: coinCategoryRows;

		const metric = categoryMetric(
			category ?? 'tradingValue',
		);
		const rows = [...base];

		if (nameSort !== 'default') {
			rows.sort(
				(a, b) =>
					nameOf(a, isStock).localeCompare(
						nameOf(b, isStock),
						isStock
							? mode.stockMarket === 'KR'
								? 'ko'
								: 'en'
							: 'ko',
					) * (nameSort === 'asc' ? 1 : -1),
			);
		} else if (metricSort !== 'default') {
			rows.sort(
				(a, b) =>
					(metricValue(a, metric) -
						metricValue(b, metric)) *
					(metricSort === 'asc' ? 1 : -1),
			);
		}

		return rows.slice(0, 100);
	}, [
		aiGroup,
		category,
		coinAiRows,
		coinCategoryRows,
		isStock,
		metricSort,
		mode.stockMarket,
		nameSort,
		stockAiRows,
		stockCategoryRows,
	]);

	const pageCount = Math.max(1, Math.ceil(modalRows.length / PAGE_SIZE));
	const safePage = Math.min(page, pageCount);
	const pagedModalRows = modalRows.slice(
		(safePage - 1) * PAGE_SIZE,
		safePage * PAGE_SIZE,
	);

	const openCategory = (key: CategoryKey) => {
		setCategory(key);
		setPage(1);
		setNameSort('default');
		setMetricSort('default');
	};

	const openAiCandidate = (row: AnyObj) => {
		if (isStock) {
			const ticker = String(row.ticker);
			const detectedGroup = classifyStockAi(row);
			const currency = String(
				row.currency ??
					(row.market === 'KR' ? 'KRW' : 'USD'),
			);

			setCandidate({
				kind: 'stock',
				name: displayStockName(
					ticker,
					String(row.name ?? ticker),
					String(row.market),
				),
				symbol: ticker,
				marketLabel:
					row.market === 'KR' ? '국내주식' : '해외주식',
				aiLabel:
					String(row.categoryLabel ?? '').trim() ||
					aiLabelOf(detectedGroup),
				opinion: String(
					row.opinion ??
						row.overallRating ??
						'차트 조건 확인 후보',
				),
				score: finite(row.score),
				confidence: finite(
					row.confidence ?? row.dataConfidence,
				),
				reasons: stringRows(row.reasons),
				risks: stringRows(row.risks),
				summary: stringRows(
					row.summary ?? row.coreSummary,
				),
				chartAnalysis: stringRows(row.chartAnalysis),
				volumeAnalysis: stringRows(row.volumeAnalysis),
				trendAnalysis: stringRows(row.trendAnalysis),
				supplyDemandAnalysis: stringRows(
					row.supplyDemandAnalysis ??
						row.flowAnalysis,
				),
				financialAnalysis: stringRows(
					row.financialAnalysis,
				),
				positiveFactors: stringRows(
					row.positiveFactors,
				),
				warningFactors: stringRows(
					row.warningFactors,
				),
				overallOpinion: stringRows(
					row.overallOpinion ??
						row.aiOpinion,
				),
				price: finite(row.price),
				changePercent: finite(row.changePercent),
				entryLow: finite(
					row.entryLow ?? row.entry ?? row.buyPriceLow,
				),
				entryHigh: finite(
					row.entryHigh ?? row.entry ?? row.buyPriceHigh,
				),
				breakoutPrice: finite(
					row.breakoutPrice ?? row.confirmPrice,
				),
				target1: finite(
					row.targetPrice1 ?? row.target1 ?? row.target,
				),
				target2: finite(
					row.targetPrice2 ?? row.target2,
				),
				stop: finite(
					row.stopLossPrice ?? row.stop,
				),
				analyzedAt:
					String(
						row.analyzedAt ??
							row.updatedAt ??
							row.dataTimestamp ??
							'',
					).trim() || null,
				status:
					row.status === 'EXITED' ||
					row.conditionPassed === false
						? 'EXITED'
						: 'ACTIVE',
				exitReasons: stringRows(row.exitReasons),
				currency,
				moveTo: `/stock/${encodeURIComponent(ticker)}`,
			});
		} else {
			const symbol = String(row.symbol);
			const currency =
				mode.coinMarket === 'spot' ? 'KRW' : 'USDT';

			setCandidate({
				kind: 'coin',
				name: displayCoinName(
					symbol,
					row.koreanName,
					row.englishName,
				),
				symbol,
				marketLabel:
					mode.coinMarket === 'spot'
						? '코인 현물'
						: '코인 선물',
				aiLabel: String(
					row.aiLabel ?? row.categoryLabel ?? 'AI 분석',
				),
				opinion:
					mode.coinMarket === 'futures'
						? String(row.opinion ?? '롱 후보')
						: String(row.opinion ?? '매수 후보'),
				score: finite(row.score),
				confidence: finite(
					row.confidence ?? row.dataConfidence,
				),
				reasons: stringRows(row.reasons),
				risks: stringRows(row.risks),
				summary: stringRows(
					row.summary ?? row.coreSummary,
				),
				chartAnalysis: stringRows(row.chartAnalysis),
				volumeAnalysis: stringRows(row.volumeAnalysis),
				trendAnalysis: stringRows(row.trendAnalysis),
				supplyDemandAnalysis: stringRows(
					row.supplyDemandAnalysis,
				),
				financialAnalysis: stringRows(
					row.financialAnalysis,
				),
				positiveFactors: stringRows(
					row.positiveFactors,
				),
				warningFactors: stringRows(
					row.warningFactors,
				),
				overallOpinion: stringRows(
					row.overallOpinion ?? row.aiOpinion,
				),
				price: finite(row.price),
				changePercent: finite(
					row.changePercent ?? row.changePercent24h,
				),
				entryLow: finite(
					row.entryLow ?? row.entry ?? row.buyPriceLow,
				),
				entryHigh: finite(
					row.entryHigh ?? row.entry ?? row.buyPriceHigh,
				),
				breakoutPrice: finite(
					row.breakoutPrice ?? row.confirmPrice,
				),
				target1: finite(
					row.targetPrice1 ?? row.target1 ?? row.target,
				),
				target2: finite(
					row.targetPrice2 ?? row.target2,
				),
				stop: finite(
					row.stopLossPrice ?? row.stop,
				),
				analyzedAt:
					String(
						row.analyzedAt ??
							row.updatedAt ??
							row.dataTimestamp ??
							'',
					).trim() || null,
				status:
					row.status === 'EXITED' ||
					row.conditionPassed === false
						? 'EXITED'
						: 'ACTIVE',
				exitReasons: stringRows(row.exitReasons),
				currency,
				moveTo: `/stock-info?asset=coin&coinMarket=${mode.coinMarket}&symbol=${encodeURIComponent(symbol)}`,
			});
		}
	};

	const tickerQuery =
		mode.coinMarket === 'spot'
			? spotTickers
			: futuresTickers;

	return (
		<div data-ui-page="stocks" className="h-full overflow-y-auto overscroll-contain bg-background">
			<header data-ui-component="stocks.header" className="border-b border-card-border px-4 pb-3 pt-4">
				<h1 className="text-center text-xl font-extrabold">
					종목
				</h1>

				<AssetSwitch className="mt-3" />

<SearchField
					value={query}
					onChange={setQuery}
					className="mt-3"
					ariaLabel={
						isStock ? '종목 검색' : '코인 검색'
					}
					placeholder={
						isStock
							? '종목명·티커·상품코드 검색'
							: '한글·영문 코인명·심볼 검색'
					}
				/>
			
        <section
          data-stocks-category-layout="compact-grid"
          className="mt-3 rounded-3xl border border-card-border bg-card p-3 shadow-sm"
        >
          <div className="grid grid-cols-2 gap-2">
            {CATEGORIES.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => openCategory(item.key)}
                className="flex min-h-12 w-full items-center justify-center rounded-2xl border border-card-border bg-background px-4 py-3 text-center text-sm font-black"
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>
      </header>

			<main data-ui-component="stocks.list" className="space-y-3 px-4 pb-28 pt-4">
				{!searching && (
					<EmptyBox>
						{isStock
							? '위 분류를 누르거나 종목을 검색하세요.'
							: '위 분류를 누르거나 코인을 검색하세요.'}
					</EmptyBox>
				)}

				{searching &&
					isStock &&
					stockRows.isLoading && (
						<LoadingState label="종목을 검색하는 중입니다." />
					)}

				{searching &&
					isStock &&
					stockRows.isError && (
						<ErrorState
							onRetry={() => void stockRows.refetch()}
						/>
					)}

				{searching &&
					!isStock &&
					tickerQuery.isLoading && (
						<LoadingState label="코인 시세를 불러오는 중입니다." />
					)}

				{searching &&
					!isStock &&
					tickerQuery.isError && (
						<ErrorState
							onRetry={() => void tickerQuery.refetch()}
						/>
					)}

				{searching && (
					<div className="space-y-2">
						{(
							(isStock
								? stockSearchResults
								: coinSearchResults) as AnyObj[]
						).map((row) =>
							isStock ? (
								<AssetRow
									key={`${row.market}:${row.ticker}`}
									row={row}
									stock
									onClick={() =>
										navigate(
											`/stock/${encodeURIComponent(
												String(row.ticker),
											)}`,
										)
									}
								/>
							) : (
								<AssetRow
									key={String(row.symbol)}
									row={row}
									stock={false}
									coinMarket={mode.coinMarket}
									onClick={() =>
										navigate(
											`/stock-info?asset=coin&coinMarket=${mode.coinMarket}&symbol=${encodeURIComponent(
												String(row.symbol),
											)}`,
										)
									}
								/>
							),
						)}
					</div>
				)}

				{searching &&
					(isStock
						? !stockRows.isLoading &&
							stockSearchResults.length === 0
						: !tickerQuery.isLoading &&
							coinSearchResults.length === 0) && (
						<EmptyBox>검색 결과가 없습니다.</EmptyBox>
					)}
			</main>

			<BottomNav />

			<AppModal
				open={Boolean(category)}
				title={
					CATEGORIES.find(
						(item) => item.key === category,
					)?.label ?? ''
				}
				onClose={() => {
					setCategory(null);
					setPage(1);
				}}
			>
				{category === 'ai' && (
					<div className="mb-3 grid grid-cols-4 gap-1.5">
						{AI_GROUPS.map((item) => (
							<button
								key={item.key}
								type="button"
								onClick={() => {
									setAiGroup(item.key);
									setPage(1);
								}}
								className={cn(
									'rounded-xl border px-1 py-2 text-[10px] font-black',
									aiGroup === item.key
										? 'border-primary bg-primary text-primary-foreground'
										: 'border-card-border bg-background',
								)}
							>
								{item.label}
							</button>
						))}
					</div>
				)}

				<div className="mb-3 grid grid-cols-2 gap-2">
					<SortButton
						label={isStock ? '주식명' : '코인명'}
						direction={nameSort}
						onClick={() => {
							setNameSort(nextSort(nameSort));
							setMetricSort('default');
							setPage(1);
						}}
					/>

					<SortButton
						label={metricLabel(
							category ?? 'tradingValue',
						)}
						direction={metricSort}
						onClick={() => {
							setMetricSort(nextSort(metricSort));
							setNameSort('default');
							setPage(1);
						}}
					/>
				</div>

				{category === 'ai' &&
					isStock &&
					recommendations.isLoading && (
						<LoadingState label="최신 차트로 AI 추천 후보를 다시 분석하는 중입니다." />
					)}

				{category === 'ai' &&
					isStock &&
					recommendations.isError && (
						<ErrorState
							onRetry={() =>
								void recommendations.refetch()
							}
						/>
					)}

				{category !== 'ai' &&
					isStock &&
					movers.isLoading && (
						<LoadingState label="실시간 순위 데이터를 불러오는 중입니다." />
					)}

				{category !== 'ai' &&
					isStock &&
					movers.isError && (
						<ErrorState
							onRetry={() => void movers.refetch()}
						/>
					)}

				{!isStock && tickerQuery.isLoading && (
					<LoadingState label="실시간 코인 데이터를 불러오는 중입니다." />
				)}

				{!isStock && tickerQuery.isError && (
					<ErrorState
						onRetry={() => void tickerQuery.refetch()}
					/>
				)}

				{modalRows.length > 0 && (
					<div className="overflow-x-auto rounded-2xl border border-card-border bg-card">
						<div className="min-w-[560px]">
							<div className="grid grid-cols-[56px_minmax(150px,1fr)_120px_120px_90px] items-center border-b border-card-border bg-secondary/60 px-2 py-2 text-[11px] font-black text-muted-foreground">
								<span className="text-center">순위</span>
								<span>이름</span>
								<span className="text-right">가격</span>
								<span className="text-right">시가총액</span>
								<span className="text-right">등락률</span>
							</div>

							{pagedModalRows.map((row, index) => (
								<RankingRow
									key={
										isStock
											? `${row.market}:${row.ticker}:${index}`
											: `${row.symbol}:${index}`
									}
									row={row}
									stock={isStock}
									coinMarket={mode.coinMarket}
									rank={(safePage - 1) * PAGE_SIZE + index + 1}
									category={category ?? undefined}
									onClick={() => {
										if (category === 'ai') {
											openAiCandidate(row);
										} else if (isStock) {
											navigate(
												`/stock/${encodeURIComponent(
													String(row.ticker),
												)}`,
											);
										} else {
											navigate(
												`/stock-info?asset=coin&coinMarket=${mode.coinMarket}&symbol=${encodeURIComponent(
													String(row.symbol),
												)}`,
											);
										}
									}}
								/>
							))}
						</div>
					</div>
				)}

				{modalRows.length > PAGE_SIZE && (
					<div className="mt-3 flex items-center justify-center gap-2 whitespace-nowrap">
						<button
							type="button"
							disabled={safePage <= 1}
							onClick={() => setPage((value) => Math.max(1, value - 1))}
							className="h-7 rounded-lg border border-card-border bg-background px-2.5 text-[10px] font-black disabled:cursor-not-allowed disabled:opacity-40"
						>
							이전
						</button>
						<span className="min-w-[52px] text-center text-[10px] font-black text-muted-foreground">
							{safePage} / {pageCount}
						</span>
						<button
							type="button"
							disabled={safePage >= pageCount}
							onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
							className="h-7 rounded-lg border border-card-border bg-background px-2.5 text-[10px] font-black disabled:cursor-not-allowed disabled:opacity-40"
						>
							다음
						</button>
					</div>
				)}

				{modalRows.length === 0 && (
					<EmptyBox>
						{category === 'marketCap' && !isStock
							? '현재 거래소 공개 응답에는 코인 시가총액이 없어 표시할 수 없습니다.'
							: category === 'ai'
								? '현재 차트 조건을 계속 충족하는 추천 종목이 없습니다.'
								: '현재 조건을 충족하는 실제 데이터가 없습니다.'}
					</EmptyBox>
				)}
			</AppModal>

			<AppModal
				open={Boolean(candidate)}
				title={candidate ? `${candidate.name} 분석` : ''}
				onClose={() => setCandidate(null)}
				footer={
					candidate ? (
						<div className="grid grid-cols-2 gap-2">
							<button
								type="button"
								onClick={() => setCandidate(null)}
								className="rounded-2xl border border-card-border bg-secondary px-3 py-3 text-sm font-black"
							>
								닫기
							</button>

							<button
								type="button"
								onClick={() =>
									navigate(candidate.moveTo)
								}
								className="rounded-2xl bg-primary px-3 py-3 text-sm font-black text-primary-foreground"
							>
								{candidate.name}으로 이동
							</button>
						</div>
					) : undefined
				}
			>
				{candidate && (
					<CandidateContent candidate={candidate} />
				)}
			</AppModal>
		</div>
	);
}

function CandidateContent({
	candidate,
}: {
	candidate: CandidateDetail;
}) {
	return (
		<div className="space-y-3">
			<section className="rounded-3xl border border-card-border bg-card p-4">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<p className="truncate text-base font-black">
							{candidate.name}
						</p>
						<p className="mt-1 text-[11px] font-bold text-muted-foreground">
							{candidate.symbol} · {candidate.marketLabel}
						</p>
					</div>

					<span
						className={cn(
							'shrink-0 rounded-full px-2.5 py-1 text-[10px] font-black',
							candidate.status === 'ACTIVE'
								? 'bg-primary/10 text-primary'
								: 'bg-destructive/10 text-destructive',
						)}
					>
						{candidate.status === 'ACTIVE'
							? candidate.aiLabel
							: '추천 종료'}
					</span>
				</div>

				<div className="mt-4 space-y-2 rounded-2xl bg-secondary/60 p-3">
					<PriceLine
						label="현재가"
						value={formatCandidatePrice(
							candidate.price,
							candidate.currency,
						)}
						subValue={
							candidate.changePercent == null
								? '등락률 확인 불가'
								: formatAppPercent(
										candidate.changePercent,
									)
						}
					/>

					<PriceLine
						label="1차 목표가"
						value={formatCandidatePrice(
							candidate.target1,
							candidate.currency,
						)}
						subValue={distanceText(
							candidate.price,
							candidate.target1,
						)}
					/>

					<PriceLine
						label="2차 목표가"
						value={formatCandidatePrice(
							candidate.target2,
							candidate.currency,
						)}
						subValue={distanceText(
							candidate.price,
							candidate.target2,
						)}
					/>

					<PriceLine
						label="손절가"
						value={formatCandidatePrice(
							candidate.stop,
							candidate.currency,
						)}
						subValue={distanceText(
							candidate.price,
							candidate.stop,
						)}
					/>
				</div>

				<div className="mt-3 grid grid-cols-2 gap-2">
					<Metric
						label="종합의견"
						value={candidate.opinion}
					/>
					<Metric
						label="AI 점수"
						value={
							candidate.score == null
								? '확인 불가'
								: `${Math.round(candidate.score)}점`
						}
					/>
				</div>

				<p className="mt-3 text-center text-[10px] font-bold text-muted-foreground">
					분석 기준 {formatAnalysisTime(candidate.analyzedAt)}
					{candidate.confidence != null
						? ` · 데이터 신뢰도 ${Math.round(
								candidate.confidence,
							)}%`
						: ''}
				</p>
			</section>

			{candidate.status === 'EXITED' && (
				<section className="rounded-2xl border border-destructive/30 bg-destructive/5 p-3">
					<h3 className="text-sm font-black text-destructive">
						추천 조건 이탈
					</h3>
					<p className="mt-1 text-xs font-bold leading-5">
						최신 차트 재분석에서 추천 조건을 더 이상
						충족하지 않아 추천 목록에서 제외됩니다.
					</p>
					<BulletRows
						rows={candidate.exitReasons}
						emptyText="조건 이탈 사유를 확인할 수 없습니다."
					/>
				</section>
			)}

			<AccordionSection title="종목 정보">
				<div className="grid grid-cols-2 gap-2">
					<Metric
						label="현재가"
						value={formatCandidatePrice(
							candidate.price,
							candidate.currency,
						)}
					/>
					<Metric
						label="등락률"
						value={
							candidate.changePercent == null
								? '확인 불가'
								: formatAppPercent(
										candidate.changePercent,
									)
						}
					/>
					<Metric
						label="AI 유형"
						value={candidate.aiLabel}
					/>
					<Metric
						label="데이터 신뢰도"
						value={
							candidate.confidence == null
								? '확인 불가'
								: `${Math.round(
										candidate.confidence,
									)}%`
						}
					/>
				</div>
			</AccordionSection>

			<AccordionSection title="핵심 요약">
				<BulletRows
					rows={
						candidate.summary.length
							? candidate.summary
							: candidate.reasons
					}
					emptyText="최신 차트에서 확인된 핵심 요약이 없습니다."
				/>
			</AccordionSection>

			<AccordionSection title="상세 분석">
				<div className="space-y-2">
					<NestedAnalysis
						title="차트 분석"
						rows={candidate.chartAnalysis}
					/>
					<NestedAnalysis
						title="거래량 분석"
						rows={candidate.volumeAnalysis}
					/>
					<NestedAnalysis
						title="추세 분석"
						rows={candidate.trendAnalysis}
					/>
					<NestedAnalysis
						title="수급 분석"
						rows={candidate.supplyDemandAnalysis}
					/>
					<NestedAnalysis
						title="재무 분석"
						rows={candidate.financialAnalysis}
					/>
					<NestedAnalysis
						title="긍정 요소"
						rows={candidate.positiveFactors}
					/>
					<NestedAnalysis
						title="주의 요소"
						rows={
							candidate.warningFactors.length
								? candidate.warningFactors
								: candidate.risks
						}
					/>
					<NestedAnalysis
						title="AI 종합 의견"
						rows={candidate.overallOpinion}
					/>
				</div>
			</AccordionSection>

			<AccordionSection title="가격 전략">
				<div className="grid grid-cols-2 gap-2">
					<Metric
						label="관심 매수가 하단"
						value={formatCandidatePrice(
							candidate.entryLow,
							candidate.currency,
						)}
					/>
					<Metric
						label="관심 매수가 상단"
						value={formatCandidatePrice(
							candidate.entryHigh,
							candidate.currency,
						)}
					/>
					<Metric
						label="돌파 확인가"
						value={formatCandidatePrice(
							candidate.breakoutPrice,
							candidate.currency,
						)}
					/>
					<Metric
						label="1차 목표가"
						value={formatCandidatePrice(
							candidate.target1,
							candidate.currency,
						)}
					/>
					<Metric
						label="2차 목표가"
						value={formatCandidatePrice(
							candidate.target2,
							candidate.currency,
						)}
					/>
					<Metric
						label="손절 기준"
						value={formatCandidatePrice(
							candidate.stop,
							candidate.currency,
						)}
					/>
					<Metric
						label="예상 손익비"
						value={riskRewardText(candidate)}
					/>
					<Metric
						label="분석 시각"
						value={formatAnalysisTime(
							candidate.analyzedAt,
						)}
					/>
				</div>
			</AccordionSection>
		</div>
	);
}

function AccordionSection({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);

	return (
		<section className="overflow-hidden rounded-2xl border border-card-border bg-background">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
				aria-expanded={open}
			>
				<span className="text-sm font-black">{title}</span>
				<ChevronDown
					className={cn(
						'h-4 w-4 shrink-0 transition-transform',
						open && 'rotate-180',
					)}
				/>
			</button>

			{open && (
				<div className="border-t border-card-border px-3 py-3">
					{children}
				</div>
			)}
		</section>
	);
}

function NestedAnalysis({
	title,
	rows,
}: {
	title: string;
	rows: string[];
}) {
	const [open, setOpen] = useState(false);

	return (
		<section className="overflow-hidden rounded-xl bg-secondary/50">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
				aria-expanded={open}
			>
				<span className="text-xs font-black">{title}</span>
				<ChevronDown
					className={cn(
						'h-3.5 w-3.5 transition-transform',
						open && 'rotate-180',
					)}
				/>
			</button>

			{open && (
				<div className="border-t border-card-border/70 px-3 pb-3 pt-2">
					<BulletRows
						rows={rows}
						emptyText={`${title} 확인 불가`}
					/>
				</div>
			)}
		</section>
	);
}

function BulletRows({
	rows,
	emptyText,
}: {
	rows: string[];
	emptyText: string;
}) {
	const values = rows.length ? rows : [emptyText];

	return (
		<ul className="list-disc space-y-1.5 pl-5 text-left text-xs font-bold leading-5">
			{values.map((row, index) => (
				<li key={`${row}:${index}`}>{row}</li>
			))}
		</ul>
	);
}

function PriceLine({
	label,
	value,
	subValue,
}: {
	label: string;
	value: string;
	subValue: string;
}) {
	return (
		<div className="flex items-center justify-between gap-3">
			<span className="text-xs font-bold text-muted-foreground">
				{label}
			</span>
			<div className="text-right">
				<p className="text-sm font-black">{value}</p>
				<p className="text-[10px] font-bold text-muted-foreground">
					{subValue}
				</p>
			</div>
		</div>
	);
}

function formatCandidatePrice(
	value: number | null,
	currency: string,
): string {
	return value == null
		? '계산 불가'
		: formatAppPrice(value, currency);
}

function distanceText(
	currentPrice: number | null,
	targetPrice: number | null,
): string {
	if (
		currentPrice == null ||
		targetPrice == null ||
		currentPrice === 0
	) {
		return '변동률 계산 불가';
	}

	const percent =
		((targetPrice - currentPrice) / currentPrice) * 100;

	return formatAppPercent(percent);
}

function riskRewardText(
	candidate: CandidateDetail,
): string {
	const entry =
		candidate.entryLow ??
		candidate.entryHigh ??
		candidate.price;

	if (
		entry == null ||
		candidate.target1 == null ||
		candidate.stop == null
	) {
		return '계산 불가';
	}

	const reward = candidate.target1 - entry;
	const risk = entry - candidate.stop;

	if (reward <= 0 || risk <= 0) {
		return '계산 불가';
	}

	return `1 : ${(reward / risk).toFixed(2)}`;
}

function Metric({
	label,
	value,
}: {
	label: string;
	value: string;
}) {
	return (
		<div className="rounded-2xl bg-secondary/60 p-3 text-center">
			<p className="text-[10px] font-bold text-muted-foreground">
				{label}
			</p>
			<p className="mt-1 break-words text-sm font-black">
				{value}
			</p>
		</div>
	);
}

function SortButton({
	label,
	direction,
	onClick,
}: {
	label: string;
	direction: SortDirection;
	onClick: () => void;
}) {
	const Icon =
		direction === 'asc'
			? ArrowUp
			: direction === 'desc'
				? ArrowDown
				: ArrowUpDown;

	return (
		<button
			type="button"
			onClick={onClick}
			className="flex items-center justify-center gap-1 rounded-xl border border-card-border bg-background px-2 py-2 text-xs font-black"
		>
			{label}
			<Icon className="h-3.5 w-3.5" />
		</button>
	);
}

function RankingRow({
	row,
	stock,
	coinMarket = 'spot',
	rank,
	category,
	onClick,
}: {
	row: AnyObj;
	stock: boolean;
	coinMarket?: 'spot' | 'futures';
	rank: number;
	category?: CategoryKey;
	onClick: () => void;
}) {
	const symbol = stock ? String(row.ticker) : String(row.symbol);
	const name = stock
		? displayStockName(symbol, String(row.name ?? symbol), String(row.market))
		: displayCoinName(symbol, row.koreanName, row.englishName);
	const price = finite(row.price);
	const change = finite(row.changePercent ?? row.changePercent24h);
	const marketCap = finite(
		row.marketCap ?? row.market_cap ?? row.marketCapitalization ?? row.market_capitalization,
	);
	const currency = stock
		? String(row.currency ?? (row.market === 'KR' ? 'KRW' : 'USD'))
		: coinMarket === 'spot'
			? 'KRW'
			: 'USDT';

	return (
		<button
			type="button"
			onClick={onClick}
			className="grid w-full grid-cols-[56px_minmax(150px,1fr)_120px_120px_90px] items-center border-b border-card-border px-2 py-2.5 text-left last:border-b-0 hover:bg-secondary/40"
		>
			<span className="text-center text-xs font-black text-primary">{rank}위</span>
			<span className="min-w-0 pr-2">
				<span className="block truncate text-xs font-black">{name}</span>
				<span className="mt-0.5 block truncate text-[9px] font-bold text-muted-foreground">
					{symbol}{category === 'ai' ? ` · ${row.categoryLabel ?? row.aiLabel ?? 'AI 후보'}` : ''}
				</span>
			</span>
			<span className="text-right text-[11px] font-black">
				{price == null ? '확인 불가' : formatAppPrice(price, currency)}
			</span>
			<span className="text-right text-[11px] font-black">
				{marketCap == null ? '확인 불가' : formatMarketCap(marketCap, currency)}
			</span>
			<span
				className={cn(
					'text-right text-[11px] font-black',
					change == null
						? 'text-muted-foreground'
						: change >= 0
							? 'text-positive'
							: 'text-destructive',
				)}
			>
				{change == null ? '—' : formatAppPercent(change)}
			</span>
		</button>
	);
}

function formatMarketCap(value: number, currency: string): string {
	if (!Number.isFinite(value)) return '확인 불가';

	if (currency === 'KRW') {
		const jo = value / 1_000_000_000_000;
		if (jo >= 1) return `${jo >= 100 ? jo.toFixed(0) : jo.toFixed(1)}조`;
		const eok = value / 100_000_000;
		if (eok >= 1) return `${eok.toFixed(0)}억`;
		return `${Math.round(value).toLocaleString('ko-KR')}원`;
	}

	if (value >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(1)}T`;
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return value.toLocaleString('en-US');
}

function AssetRow({
	row,
	stock,
	coinMarket = 'spot',
	rank,
	category,
	onClick,
}: {
	row: AnyObj;
	stock: boolean;
	coinMarket?: 'spot' | 'futures';
	rank?: number;
	category?: CategoryKey;
	onClick: () => void;
}) {
	const symbol = stock
		? String(row.ticker)
		: String(row.symbol);

	const name = stock
		? displayStockName(
				symbol,
				String(row.name ?? symbol),
				String(row.market),
			)
		: displayCoinName(
				symbol,
				row.koreanName,
				row.englishName,
			);

	const change = finite(
		row.changePercent ?? row.changePercent24h,
	);
	const price = finite(row.price);
	const target = finite(
		row.targetPrice1 ?? row.target1 ?? row.target,
	);

	const currency = stock
		? String(
				row.currency ??
					(row.market === 'KR' ? 'KRW' : 'USD'),
			)
		: coinMarket === 'spot'
			? 'KRW'
			: 'USDT';

	return (
		<button
			type="button"
			onClick={onClick}
			className="flex w-full items-center gap-3 rounded-2xl border border-card-border bg-card p-3 text-left shadow-sm"
		>
			{rank != null && (
				<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-sm font-black text-primary">
					{rank}
				</span>
			)}

			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-black">
					{name}
				</p>

				<p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
					{symbol}
					{category === 'ai'
						? ` · ${
								row.categoryLabel ??
								row.aiLabel ??
								'AI 후보'
							}`
						: ''}
				</p>

				{category === 'ai' &&
					Array.isArray(row.reasons) && (
						<p className="mt-1 line-clamp-2 text-[10px] font-bold leading-4 text-foreground/80">
							{row.reasons.slice(0, 2).join(' · ')}
						</p>
					)}
			</div>

			<div className="shrink-0 text-right">
				<p className="text-xs font-black">
					{price == null
						? '데이터 없음'
						: formatAppPrice(price, currency)}
				</p>

				{category === 'ai' && (
					<p className="mt-0.5 text-[10px] font-black text-primary">
						목표{' '}
						{target == null
							? '계산 불가'
							: formatAppPrice(target, currency)}
					</p>
				)}

				<p
					className={cn(
						'mt-0.5 text-[10px] font-black',
						change == null
							? 'text-muted-foreground'
							: change >= 0
								? 'text-positive'
								: 'text-destructive',
					)}
				>
					{change == null
						? '—'
						: formatAppPercent(change)}
				</p>

				<ChevronRight className="ml-auto mt-1 h-3.5 w-3.5 text-muted-foreground" />
			</div>
		</button>
	);
}

function EmptyBox({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<div className="rounded-3xl border border-card-border bg-card p-5 text-center text-sm font-bold text-muted-foreground">
			{children}
		</div>
	);
}

function dedupe<T>(
	rows: T[],
	keyOf: (row: T) => string,
): T[] {
	const seen = new Set<string>();

	return rows.filter((row) => {
		const key = keyOf(row);

		if (seen.has(key)) return false;

		seen.add(key);
		return true;
	});
}

function nameOf(
	row: AnyObj,
	stock: boolean,
): string {
	return stock
		? String(row.name ?? row.ticker ?? '')
		: String(
				row.koreanName ??
					row.englishName ??
					row.symbol ??
					'',
			);
}

function categoryMetric(
	category: CategoryKey,
): string {
	if (category === 'marketCap') return 'marketCap';
	if (category === 'volume') return 'volume';
	if (category === 'tradingValue')
		return 'tradingValue';
	if (
		category === 'gainers' ||
		category === 'losers'
	) {
		return 'changePercent';
	}
	return 'score';
}

function metricLabel(
	category: CategoryKey,
): string {
	if (category === 'marketCap') return '시가총액';
	if (category === 'volume') return '거래량';
	if (category === 'tradingValue') return '거래대금';
	if (category === 'gainers') return '상승률';
	if (category === 'losers') return '하락률';
	return 'AI점수';
}

function metricValue(
	row: AnyObj,
	metric: string,
): number {
	if (metric === 'volume') {
		return finite(row.volume ?? row.volume24h) ??
			-Infinity;
	}

	if (metric === 'tradingValue') {
		return finite(
			row.tradingValue ?? row.tradingValue24h,
		) ?? -Infinity;
	}

	if (metric === 'changePercent') {
		return finite(
			row.changePercent ?? row.changePercent24h,
		) ?? -Infinity;
	}

	return finite(row[metric]) ?? -Infinity;
}

function classifyStockAi(row: AnyObj): AiGroup {
	if (
		row.aiType === 'shortSurge' ||
		row.aiType === 'breakout' ||
		row.aiType === 'undervalued' ||
		row.aiType === 'accumulation'
	) {
		return row.aiType;
	}

	const text = `${row.category} ${
		row.categoryLabel ?? ''
	} ${(row.reasons ?? []).join(' ')}`.toLowerCase();

	if (
		/단기급등|급등|모멘텀|거래량 급증|short.?surge/.test(
			text,
		)
	) {
		return 'shortSurge';
	}

	if (
		/저평가|per|pbr|가치|undervalued/.test(text)
	) {
		return 'undervalued';
	}

	if (
		/매집|수급|외국인|기관|obv|accumulation/.test(
			text,
		)
	) {
		return 'accumulation';
	}

	return 'breakout';
}

function buildCoinCandidates(
	rows: AnyObj[],
	market: 'spot' | 'futures',
) {
	const valid = rows.filter(
		(row) =>
			finite(row.price) != null &&
			finite(
				row.changePercent ?? row.changePercent24h,
			) != null,
	);

	const tradingValues = valid
		.map(
			(row) =>
				finite(row.tradingValue24h) ?? 0,
		)
		.sort((a, b) => b - a);

	const highValue =
		tradingValues[
			Math.min(
				Math.floor(tradingValues.length * 0.25),
				Math.max(0, tradingValues.length - 1),
			)
		] ?? 0;

	return valid
		.map((row) => {
			const change =
				finite(
					row.changePercent ??
						row.changePercent24h,
				) ?? 0;
			const value =
				finite(row.tradingValue24h) ?? 0;
			const price = finite(row.price) ?? 0;

			let aiGroup: AiGroup = 'undervalued';
			let aiLabel = '저평가';
			let opinion = '관망';
			const reasons: string[] = [];

			if (change >= 6) {
				aiGroup = 'shortSurge';
				aiLabel = '단기급등';
				opinion =
					market === 'futures'
						? '단기 롱 관찰'
						: '단기 매수 관찰';
				reasons.push(
					`24시간 등락률이 ${change.toFixed(
						2,
					)}%로 단기 상승 탄력이 강합니다.`,
				);
			} else if (change >= 3) {
				aiGroup = 'breakout';
				aiLabel = '추세돌파';
				opinion =
					market === 'futures'
						? '롱 후보'
						: '매수 후보';
				reasons.push(
					`24시간 등락률이 ${change.toFixed(
						2,
					)}%로 상승 추세입니다.`,
				);
			} else if (
				value >= highValue &&
				Math.abs(change) <= 3
			) {
				aiGroup = 'accumulation';
				aiLabel = '매집';
				opinion =
					market === 'futures'
						? '방향 확인'
						: '매수 관찰';
				reasons.push(
					'등락폭 대비 거래대금이 상위권이라 수급 집중 여부를 확인할 후보입니다.',
				);
			} else {
				reasons.push(
					'가격 변동과 거래대금을 함께 비교했을 때 즉시 추격보다 추가 확인이 필요한 후보입니다.',
				);
			}

			if (value > 0) {
				reasons.push(
					`24시간 거래대금 ${value.toLocaleString()} 기준입니다.`,
				);
			}

			const score = Math.max(
				1,
				Math.min(
					99,
					Math.round(
						50 +
							change * 4 +
							(value >= highValue ? 12 : 0),
					),
				),
			);

			const target1 =
				price > 0
					? price *
						(1 +
							Math.min(
								0.08,
								Math.max(
									0.02,
									Math.abs(change) / 100,
								),
							))
					: null;

			const target2 =
				target1 != null
					? target1 * 1.04
					: null;

			const stop =
				price > 0 ? price * 0.97 : null;

			return {
				...row,
				aiGroup,
				aiType: aiGroup,
				aiLabel,
				categoryLabel: aiLabel,
				opinion,
				score,
				reasons,
				risks: [
					'급격한 시장 방향 전환과 거래량 감소 시 신호가 무효화될 수 있습니다.',
				],
				target1,
				target2,
				target: target1,
				stop,
				status: 'ACTIVE',
				conditionPassed: true,
			};
		})
		.sort((a, b) => b.score - a.score);
}