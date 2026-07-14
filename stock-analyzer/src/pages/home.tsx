import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw, Search, X } from "lucide-react";
import { BottomNav } from "@/components/bottom-nav";
import { cn } from "@/lib/utils";

type IndexKey = "KOSPI" | "KOSDAQ" | "NASDAQ";
type SectorMarketFilter = "KR" | "US";

interface MarketIndexItem {
	key: IndexKey;
	label: string;
	value: number | null;
	changeAmount: number | null;
	changePercent: number | null;
	direction: "up" | "down" | "flat";
	updatedAt?: string;
}

interface SectorBriefingItem {
	sector: string;
	company: string;
	ticker?: string;
	headline: string;
	tone: "positive" | "negative" | "neutral";
	source?: string;
}

interface HomeMarketData {
	indices: MarketIndexItem[];
	sectorBriefings: SectorBriefingItem[];
	updatedAt: string;
}

interface SearchResult {
	ticker: string;
	name: string;
	market?: string;
	currency?: string;
}

interface QuoteRow {
	ticker: string;
	name: string;
	market?: string;
	currency?: string;
	price?: number;
	changePercent?: number;
	tradingValue?: number;
	volume?: number;
}

interface SectorStockRow {
	ticker: string;
	name: string;
	market?: string;
	currency?: string;
	price?: number;
	changePercent?: number;
	tradingValue?: number;
	volume?: number;
}

const FALLBACK_SECTORS: SectorBriefingItem[] = [
	{
		sector: "반도체",
		company: "주요 종목",
		headline: "AI 반도체와 고성능칩 수요 흐름 확인",
		tone: "neutral",
	},
	{
		sector: "바이오",
		company: "주요 종목",
		headline: "임상·승인·계약 뉴스 흐름 확인",
		tone: "neutral",
	},
	{
		sector: "자동차",
		company: "주요 종목",
		headline: "완성차 판매와 전기차 흐름 확인",
		tone: "neutral",
	},
	{
		sector: "항공",
		company: "주요 종목",
		headline: "여행 수요와 운임 흐름 확인",
		tone: "neutral",
	},
	{
		sector: "건설",
		company: "주요 종목",
		headline: "부동산 정책과 수주 흐름 확인",
		tone: "neutral",
	},
];

const SECTOR_FALLBACK_STOCKS: Record<string, SearchResult[]> = {
	반도체: [
		{ ticker: "005930", name: "삼성전자", market: "KR", currency: "KRW" },
		{ ticker: "000660", name: "SK하이닉스", market: "KR", currency: "KRW" },
		{ ticker: "NVDA", name: "NVIDIA", market: "US", currency: "USD" },
		{ ticker: "AMD", name: "AMD", market: "US", currency: "USD" },
		{ ticker: "AVGO", name: "Broadcom", market: "US", currency: "USD" },
		{ ticker: "INTC", name: "Intel", market: "US", currency: "USD" },
	],
	바이오: [
		{
			ticker: "207940",
			name: "삼성바이오로직스",
			market: "KR",
			currency: "KRW",
		},
		{ ticker: "068270", name: "셀트리온", market: "KR", currency: "KRW" },
	],
	자동차: [
		{ ticker: "005380", name: "현대차", market: "KR", currency: "KRW" },
		{ ticker: "000270", name: "기아", market: "KR", currency: "KRW" },
		{ ticker: "TSLA", name: "Tesla", market: "US", currency: "USD" },
	],
	항공: [
		{ ticker: "003490", name: "대한항공", market: "KR", currency: "KRW" },
		{ ticker: "089590", name: "제주항공", market: "KR", currency: "KRW" },
		{ ticker: "AAL", name: "American Airlines", market: "US", currency: "USD" },
		{ ticker: "DAL", name: "Delta Air Lines", market: "US", currency: "USD" },
		{ ticker: "UAL", name: "United Airlines", market: "US", currency: "USD" },
	],
	건설: [
		{ ticker: "000720", name: "현대건설", market: "KR", currency: "KRW" },
		{ ticker: "006360", name: "GS건설", market: "KR", currency: "KRW" },
		{ ticker: "047040", name: "대우건설", market: "KR", currency: "KRW" },
	],
};

function pad(value: number) {
	return String(value).padStart(2, "0");
}

function formatDateTime(now: Date) {
	const year = now.getFullYear();
	const month = now.getMonth() + 1;
	const date = now.getDate();

	const hour24 = now.getHours();
	const minute = pad(now.getMinutes());
	const ampm = hour24 < 12 ? "오전" : "오후";
	const hour12 = hour24 % 12 || 12;

	return {
		date: `${year}년 ${month}월 ${date}일`,
		time: `${ampm} ${hour12}시 ${minute}분`,
	};
}

function fallbackHomeData(): HomeMarketData {
	return {
		updatedAt: new Date().toISOString(),
		indices: [
			{
				key: "KOSPI",
				label: "코스피",
				value: null,
				changeAmount: null,
				changePercent: null,
				direction: "flat",
			},
			{
				key: "KOSDAQ",
				label: "코스닥",
				value: null,
				changeAmount: null,
				changePercent: null,
				direction: "flat",
			},
			{
				key: "NASDAQ",
				label: "나스닥",
				value: null,
				changeAmount: null,
				changePercent: null,
				direction: "flat",
			},
		],
		sectorBriefings: FALLBACK_SECTORS,
	};
}

function indexNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;

	if (typeof value === "string") {
		const parsed = Number(value.replace(/,/g, "").replace(/%/g, "").trim());
		return Number.isFinite(parsed) ? parsed : null;
	}

	return null;
}

function firstIndexNumber(...values: unknown[]): number | null {
	for (const value of values) {
		const parsed = indexNumber(value);
		if (parsed != null) return parsed;
	}

	return null;
}

function resolveIndexKey(item: Record<string, unknown>): IndexKey | null {
	const text = [
		item.key,
		item.code,
		item.symbol,
		item.name,
		item.label,
		item.indexName,
		item.index_name,
	]
		.filter(Boolean)
		.join(" ")
		.toUpperCase();

	if (text.includes("KOSDAQ") || text.includes("코스닥")) return "KOSDAQ";
	if (text.includes("KOSPI") || text.includes("코스피")) return "KOSPI";
	if (text.includes("NASDAQ") || text.includes("나스닥")) return "NASDAQ";

	return null;
}

function normalizeIndexItem(raw: unknown): MarketIndexItem | null {
	if (!raw || typeof raw !== "object") return null;

	const item = raw as Record<string, unknown>;
	const key = resolveIndexKey(item);

	if (!key) return null;

	const value = firstIndexNumber(
		item.value,
		item.price,
		item.current,
		item.currentPrice,
		item.current_price,
		item.cur_prc,
		item.now,
		item.index,
		item.close,
	);

	const changeAmount = firstIndexNumber(
		item.changeAmount,
		item.change_amount,
		item.change,
		item.netChange,
		item.net_change,
		item.diff,
		item.pre_sig,
	);

	const changePercent = firstIndexNumber(
		item.changePercent,
		item.change_percent,
		item.changeRate,
		item.change_rate,
		item.rate,
		item.flu_rt,
		item.percent,
	);

	const directionText = String(
		item.direction ?? item.sign ?? item.trend ?? "",
	).toLowerCase();

	const direction: MarketIndexItem["direction"] =
		changePercent != null && changePercent > 0
			? "up"
			: changePercent != null && changePercent < 0
				? "down"
				: changeAmount != null && changeAmount > 0
					? "up"
					: changeAmount != null && changeAmount < 0
						? "down"
						: /up|rise|상승|\+/.test(directionText)
							? "up"
							: /down|fall|하락|-/.test(directionText)
								? "down"
								: "flat";

	return {
		key,
		label: key === "KOSPI" ? "코스피" : key === "KOSDAQ" ? "코스닥" : "나스닥",
		value,
		changeAmount,
		changePercent,
		direction,
		updatedAt:
			typeof item.updatedAt === "string"
				? item.updatedAt
				: typeof item.updated_at === "string"
					? item.updated_at
					: undefined,
	};
}

function collectIndexRows(payload: unknown): MarketIndexItem[] {
	if (!payload) return [];

	const candidates: unknown[] = [];

	if (Array.isArray(payload)) {
		candidates.push(...payload);
	} else if (typeof payload === "object") {
		const object = payload as Record<string, unknown>;
		const nested =
			object.data && typeof object.data === "object"
				? (object.data as Record<string, unknown>)
				: {};

		for (const value of [
			object.indices,
			object.items,
			object.indexes,
			object.marketIndices,
			object.market_indices,
			nested.indices,
			nested.items,
			nested.indexes,
			nested.marketIndices,
			nested.market_indices,
		]) {
			if (Array.isArray(value)) candidates.push(...value);
		}
	}

	const map = new Map<IndexKey, MarketIndexItem>();

	for (const candidate of candidates) {
		const normalized = normalizeIndexItem(candidate);
		if (normalized) map.set(normalized.key, normalized);
	}

	return Array.from(map.values());
}

function mergeIndexRows(
	primary: MarketIndexItem[],
	secondary: MarketIndexItem[],
): MarketIndexItem[] {
	const fallback = fallbackHomeData().indices;
	const map = new Map<IndexKey, MarketIndexItem>();

	for (const row of [...fallback, ...secondary, ...primary]) {
		const previous = map.get(row.key);

		map.set(row.key, {
			...(previous ?? row),
			...row,
			value: row.value ?? previous?.value ?? null,
			changeAmount: row.changeAmount ?? previous?.changeAmount ?? null,
			changePercent: row.changePercent ?? previous?.changePercent ?? null,
			direction:
				row.direction !== "flat"
					? row.direction
					: previous?.direction ?? row.direction,
		});
	}

	return ["KOSPI", "KOSDAQ", "NASDAQ"].map(
		(key) => map.get(key as IndexKey) ?? fallbackHomeData().indices[0],
	);
}

async function fetchNoCache(url: string): Promise<unknown> {
	const separator = url.includes("?") ? "&" : "?";
	const response = await fetch(`${url}${separator}_ts=${Date.now()}`, {
		cache: "no-store",
		headers: {
			"Cache-Control": "no-cache, no-store, max-age=0",
			Pragma: "no-cache",
		},
	});

	if (!response.ok) {
		throw new Error(`HTTP_${response.status}`);
	}

	return response.json();
}

function inferSector(name: string) {
	const text = name.toLowerCase();
	if (/삼성전자|하이닉스|nvidia|amd|broadcom|micron|반도체/.test(text)) return "반도체";
	if (/바이오|셀트리온|제약|pharma|therapeutics|lilly|pfizer/.test(text)) return "바이오";
	if (/현대차|기아|tesla|motor|rivian|자동차/.test(text)) return "자동차";
	if (/은행|증권|금융|bank|jpmorgan|visa/.test(text)) return "금융";
	if (/에너지|화학|oil|gas|exxon|battery/.test(text)) return "에너지";
	return "시장 인기";
}

function moverBriefings(payloads: unknown[]): SectorBriefingItem[] {
	const rows: any[] = [];
	for (const payload of payloads) {
		if (!payload || typeof payload !== "object") continue;
		const data = payload as any;
		for (const value of [data.popular, data.recommended, data.gainers, data.items, data.rows, data.data?.popular, data.data?.recommended]) {
			if (Array.isArray(value)) rows.push(...value);
		}
	}
	const unique = new Map<string, any>();
	rows.forEach((row) => {
		const ticker = String(row?.ticker ?? row?.symbol ?? row?.code ?? row?.stk_cd ?? "").trim().toUpperCase();
		if (ticker && !unique.has(ticker)) unique.set(ticker, row);
	});
	return [...unique.entries()].map(([ticker, row]) => {
		const company = String(row?.name ?? row?.stockName ?? row?.item_name ?? ticker).trim();
		const pct = firstIndexNumber(row?.changePercent, row?.changeRate, row?.flu_rt) ?? 0;
		return {
			ticker, company, sector: inferSector(company),
			headline: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% · ${row?.reason ?? row?.recommendationReason ?? "거래량·등락률 기준 인기 흐름"}`,
			tone: pct > 0.1 ? "positive" as const : pct < -0.1 ? "negative" as const : "neutral" as const,
			source: String(row?.provider ?? "실시간 시세"),
		};
	}).slice(0, 5);
}

async function fetchHomeMarketData(): Promise<HomeMarketData> {
	const fallback = fallbackHomeData();

	const [homeResult, summaryResult, krMoversResult, usMoversResult] = await Promise.allSettled([
		fetchNoCache("/api/market/home"),
		fetchNoCache("/api/market/summary"),
		fetchNoCache("/api/market/movers?market=KR"),
		fetchNoCache("/api/market/movers?market=US"),
	]);

	const homePayload = homeResult.status === "fulfilled" ? homeResult.value : null;
	const summaryPayload =
		summaryResult.status === "fulfilled" ? summaryResult.value : null;
	const krMoversPayload = krMoversResult.status === "fulfilled" ? krMoversResult.value : null;
	const usMoversPayload = usMoversResult.status === "fulfilled" ? usMoversResult.value : null;

	const homeObject =
		homePayload && typeof homePayload === "object"
			? (homePayload as Record<string, unknown>)
			: {};

	const nestedData =
		homeObject.data && typeof homeObject.data === "object"
			? (homeObject.data as Record<string, unknown>)
			: {};

	const rawBriefings = Array.isArray(homeObject.sectorBriefings)
		? homeObject.sectorBriefings
		: Array.isArray(homeObject.sector_briefings)
			? homeObject.sector_briefings
			: Array.isArray(nestedData.sectorBriefings)
				? nestedData.sectorBriefings
				: Array.isArray(nestedData.sector_briefings)
					? nestedData.sector_briefings
					: [];

	const updatedAt =
		typeof homeObject.updatedAt === "string"
			? homeObject.updatedAt
			: typeof homeObject.updated_at === "string"
				? homeObject.updated_at
				: typeof nestedData.updatedAt === "string"
					? nestedData.updatedAt
					: new Date().toISOString();

	return {
		updatedAt,
		indices: mergeIndexRows(
			collectIndexRows(homePayload),
			collectIndexRows(summaryPayload),
		),
		sectorBriefings: (() => {
			const live = moverBriefings([krMoversPayload, usMoversPayload]);
			if (live.length) return live;
			return rawBriefings.length > 0 ? (rawBriefings as SectorBriefingItem[]).slice(0, 5) : fallback.sectorBriefings;
		})(),
	};
}

async function fetchSectorStocks(sector: string): Promise<SectorStockRow[]> {
	const fallback = SECTOR_FALLBACK_STOCKS[sector] ?? [];

	let searchResults: SearchResult[] = [];

	try {
		const searchRes = await fetch(
			`/api/search?q=${encodeURIComponent(sector)}`,
		);

		if (searchRes.ok) {
			const searchData = await searchRes.json();
			const rawResults = Array.isArray(searchData.results)
				? searchData.results
				: [];

			searchResults = rawResults
				.filter((item: Partial<SearchResult>) => item.ticker && item.name)
				.map((item: Partial<SearchResult>) => ({
					ticker: String(item.ticker),
					name: String(item.name),
					market: item.market,
					currency: item.currency,
				}));
		}
	} catch {
		searchResults = [];
	}

	const baseResults = searchResults.length > 0 ? searchResults : fallback;
	const tickers = baseResults.map((item) => item.ticker).filter(Boolean);

	if (tickers.length === 0) return [];

	try {
		const quoteRes = await fetch(
			`/api/quotes?tickers=${encodeURIComponent(tickers.join(","))}`,
		);

		if (!quoteRes.ok) {
			return baseResults.map((item) => ({
				...item,
				changePercent: 0,
			}));
		}

		const quoteData = await quoteRes.json();
		const quotes = Array.isArray(quoteData.quotes)
			? (quoteData.quotes as QuoteRow[])
			: [];

		const quoteMap = new Map(quotes.map((quote) => [quote.ticker, quote]));

		return baseResults
			.map((item) => {
				const quote = quoteMap.get(item.ticker);

				return {
					ticker: item.ticker,
					name: quote?.name ?? item.name,
					market: quote?.market ?? item.market,
					currency: quote?.currency ?? item.currency,
					price: quote?.price,
					changePercent: quote?.changePercent ?? 0,
					tradingValue: quote?.tradingValue,
					volume: quote?.volume,
				};
			})
			.sort((a, b) => {
				const scoreA =
					Math.abs(a.changePercent ?? 0) * 100000000 +
					(a.tradingValue ?? a.volume ?? 0);
				const scoreB =
					Math.abs(b.changePercent ?? 0) * 100000000 +
					(b.tradingValue ?? b.volume ?? 0);

				return scoreB - scoreA;
			});
	} catch {
		return baseResults.map((item) => ({
			...item,
			changePercent: 0,
		}));
	}
}

function formatChangePercent(value: number | null | undefined) {
	if (value == null || !Number.isFinite(value)) return "확인 중";

	return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function directionText(direction: MarketIndexItem["direction"]) {
	if (direction === "up") return "상승";
	if (direction === "down") return "하락";

	return "보합";
}

function directionClass(direction: MarketIndexItem["direction"]) {
	if (direction === "up") return "text-positive";
	if (direction === "down") return "text-destructive";

	return "text-muted-foreground";
}

function changeClass(value: number | null | undefined) {
	if (value == null || !Number.isFinite(value) || Math.abs(value) < 0.01) {
		return "text-muted-foreground";
	}

	return value > 0 ? "text-positive" : "text-destructive";
}

function toneLabel(tone: SectorBriefingItem["tone"]) {
	if (tone === "positive") return "강세";
	if (tone === "negative") return "약세";

	return "혼조";
}

function toneClass(tone: SectorBriefingItem["tone"]) {
	if (tone === "positive") return "bg-positive/10 text-positive";
	if (tone === "negative") return "bg-destructive/10 text-destructive";

	return "bg-secondary text-muted-foreground";
}

function normalizeMarket(row: SectorStockRow): "KR" | "US" {
	const market = String(row.market ?? "").toUpperCase();

	if (market.includes("KR")) return "KR";
	if (market.includes("US")) return "US";

	return /^\d/.test(row.ticker) ? "KR" : "US";
}

function buildAiSummary(row: SectorStockRow, sector: string) {
	const pct = row.changePercent ?? 0;
	const hasVolume = Boolean(row.tradingValue || row.volume);

	if (pct >= 3) {
		return `${sector} 섹터 수급과 거래량 유입이 강하게 붙으며 급등 흐름입니다.`;
	}

	if (pct >= 0.3) {
		return hasVolume
			? `거래량 증가와 섹터 매수세 유입으로 인한 상승 흐름입니다.`
			: `${sector} 섹터 흐름에 따른 상승입니다.`;
	}

	if (pct <= -3) {
		return `차익실현 또는 매도세 확대로 인해 급락 흐름입니다.`;
	}

	if (pct <= -0.3) {
		return `${sector} 섹터 내 매도세가 우세해 하락 흐름입니다.`;
	}

	return `현재 뚜렷한 특이 이슈는 부족하며, 추가 뉴스 확인이 필요합니다.`;
}

function findIndexItem(
	indices: MarketIndexItem[],
	key: IndexKey,
	fallbackIndex: number,
) {
	return (
		indices.find((item) => item.key === key) ??
		fallbackHomeData().indices[fallbackIndex]
	);
}

export default function HomePage() {
	const [, navigate] = useLocation();
	const [now, setNow] = useState(() => new Date());
	const [selectedSector, setSelectedSector] = useState<string | null>(null);
	const [sectorFilter, setSectorFilter] = useState<SectorMarketFilter>("KR");

	useEffect(() => {
		const id = window.setInterval(() => {
			setNow(new Date());
		}, 1000);

		return () => window.clearInterval(id);
	}, []);

	const dateTime = useMemo(() => formatDateTime(now), [now]);

	const homeMarket = useQuery({
		queryKey: ["home-market-data-live"],
		queryFn: fetchHomeMarketData,
		staleTime: 0,
		gcTime: 5 * 60_000,
		refetchInterval: 5_000,
		refetchIntervalInBackground: true,
		refetchOnWindowFocus: true,
		retry: 2,
	});

	const sectorStocks = useQuery({
		queryKey: ["sector-stocks", selectedSector],
		queryFn: () => fetchSectorStocks(selectedSector ?? ""),
		enabled: Boolean(selectedSector),
		staleTime: 0,
		gcTime: 5 * 60_000,
		refetchInterval: 15_000,
		refetchIntervalInBackground: true,
		refetchOnWindowFocus: true,
	});

	const data = homeMarket.data ?? fallbackHomeData();

	const kospi = findIndexItem(data.indices, "KOSPI", 0);
	const kosdaq = findIndexItem(data.indices, "KOSDAQ", 1);
	const nasdaq = findIndexItem(data.indices, "NASDAQ", 2);

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain bg-background">
			<header className="px-5 pb-2 pt-5">
				<div className="flex items-start gap-3">
					<h1 className="shrink-0 text-[2.35rem] font-black leading-none tracking-tight">
						승재주식
					</h1>

					<div className="ml-auto shrink-0 pt-0.5 text-right text-[11px] font-black leading-tight text-muted-foreground">
						<p className="whitespace-nowrap">{dateTime.date}</p>
						<p className="mt-0.5 whitespace-nowrap">{dateTime.time}</p>
					</div>
				</div>

				<button
					type="button"
					onClick={() => navigate("/search")}
					className="mt-3 flex w-full items-center gap-3 rounded-[1.45rem] border border-card-border bg-card px-4 py-3 text-left shadow-sm transition active:scale-[0.99]"
				>
					<Search className="h-4 w-4 shrink-0 text-muted-foreground" />

					<span className="text-sm font-extrabold text-muted-foreground">
						종목검색
					</span>
				</button>
			</header>

			<main className="flex-none px-5 pb-[78px]">
				<section className="grid grid-cols-2 gap-3">
					<MarketBox
						title="국내주식"
						onTitleClick={() => navigate("/search?market=KR")}
						items={[
							{
								data: kospi,
								onClick: () => navigate("/search?market=KR&board=KOSPI"),
							},
							{
								data: kosdaq,
								onClick: () => navigate("/search?market=KR&board=KOSDAQ"),
							},
						]}
					/>

					<MarketBox
						title="해외주식"
						onTitleClick={() => navigate("/search?market=US")}
						items={[
							{
								data: nasdaq,
								onClick: () => navigate("/search?market=US&board=NASDAQ"),
							},
						]}
					/>
				</section>

				<section className="mt-3 rounded-[1.55rem] border border-primary/30 bg-primary/10 p-3 shadow-sm">
					<div className="mb-2.5 flex items-center justify-between gap-3">
						<p className="text-[1.38rem] font-black leading-none text-primary">
							오늘 인기종목
						</p>

						<button
							type="button"
							onClick={() => void homeMarket.refetch()}
							className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-card-border bg-card shadow-sm transition active:scale-[0.96]"
							aria-label="오늘의 시황 새로고침"
						>
							<RefreshCw
								className={cn(
									"h-4 w-4",
									homeMarket.isFetching && "animate-spin",
								)}
							/>
						</button>
					</div>

					<div className="space-y-1.5">
						{data.sectorBriefings.slice(0, 5).map((item, index) => (
							<SectorBriefingCard
								key={`${item.sector}:${item.company}:${index}`}
								item={item}
								onClick={() => {
									if (item.ticker) {
										navigate(
											`/stock/${item.ticker}?back=${encodeURIComponent("/")}`,
										);
										return;
									}
									setSectorFilter("KR");
									setSelectedSector(item.sector);
								}}
							/>
						))}
					</div>
				</section>
			</main>

			<BottomNav />

			{selectedSector && (
				<SectorStockModal
					sector={selectedSector}
					rows={sectorStocks.data ?? []}
					loading={sectorStocks.isLoading || sectorStocks.isFetching}
					filter={sectorFilter}
					onFilterChange={setSectorFilter}
					onClose={() => setSelectedSector(null)}
					onSelect={(ticker) => {
						setSelectedSector(null);
						navigate(`/stock/${ticker}?back=${encodeURIComponent("/")}`);
					}}
				/>
			)}
		</div>
	);
}

function MarketBox({
	title,
	items,
	onTitleClick,
}: {
	title: string;
	items: {
		data: MarketIndexItem;
		onClick: () => void;
	}[];
	onTitleClick: () => void;
}) {
	return (
		<section className="flex min-h-[112px] flex-col rounded-[1.55rem] bg-card/75 px-3.5 py-3 shadow-sm">
			<button
				type="button"
				onClick={onTitleClick}
				className="mb-2.5 w-full text-center"
			>
				<p className="whitespace-nowrap text-[1.32rem] font-black leading-none">
					{title}
				</p>
			</button>

			<div className="space-y-1">
				{items.map((item) => (
					<IndexRow
						key={item.data.key}
						data={item.data}
						onClick={item.onClick}
					/>
				))}
			</div>
		</section>
	);
}

function formatIndexValue(value: number | null | undefined) {
	if (value == null || !Number.isFinite(value)) return "불러오는 중";

	return value.toLocaleString("ko-KR", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

function IndexRow({
	data,
	onClick,
}: {
	data: MarketIndexItem;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex w-full items-center justify-between gap-2 rounded-lg px-0.5 py-0.5 text-left transition active:scale-[0.99]"
		>
			<div className="min-w-0">
				<p className="whitespace-nowrap text-[11px] font-black text-foreground">
					{data.label}
				</p>
				<p className="mt-0.5 truncate text-[10px] font-extrabold text-muted-foreground">
					{formatIndexValue(data.value)}
				</p>
			</div>

			<p
				className={cn(
					"shrink-0 whitespace-nowrap text-[10px] font-black",
					directionClass(data.direction),
				)}
			>
				{directionText(data.direction)} {formatChangePercent(data.changePercent)}
			</p>
		</button>
	);
}

function SectorBriefingCard({
	item,
	onClick,
}: {
	item: SectorBriefingItem;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="w-full rounded-[1.1rem] border border-card-border bg-card px-3 py-2 text-left shadow-sm transition active:scale-[0.99]"
		>
			<div className="flex items-center gap-2">
				<p className="truncate text-[13px] font-black">{item.company}</p>

				<span
					className={cn(
						"shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-extrabold",
						toneClass(item.tone),
					)}
				>
					{toneLabel(item.tone)}
				</span>
				<span className="ml-auto shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[9px] font-extrabold text-muted-foreground">
					{item.sector}
				</span>
			</div>

			<p className="mt-0.5 truncate text-[10.5px] font-semibold text-muted-foreground">
				{item.headline}
			</p>
		</button>
	);
}

function FilterButton({
	label,
	active,
	onClick,
}: {
	label: string;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"rounded-full px-3 py-1 text-xs font-black transition active:scale-[0.96]",
				active
					? "bg-primary text-primary-foreground"
					: "bg-secondary text-muted-foreground",
			)}
		>
			{label}
		</button>
	);
}

function SectorStockModal({
	sector,
	rows,
	loading,
	filter,
	onFilterChange,
	onClose,
	onSelect,
}: {
	sector: string;
	rows: SectorStockRow[];
	loading: boolean;
	filter: SectorMarketFilter;
	onFilterChange: (filter: SectorMarketFilter) => void;
	onClose: () => void;
	onSelect: (ticker: string) => void;
}) {
	const filteredRows = rows.filter((row) => normalizeMarket(row) === filter);

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-5 backdrop-blur-sm">
			<div className="w-full max-w-[370px] rounded-[2rem] border border-card-border bg-card p-4 shadow-2xl">
				<div className="mb-3 flex items-start justify-between gap-3">
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<p className="text-xl font-black">{sector} 종목</p>

							<div className="flex shrink-0 items-center gap-1">
								<FilterButton
									label="국내"
									active={filter === "KR"}
									onClick={() => onFilterChange("KR")}
								/>

								<FilterButton
									label="해외"
									active={filter === "US"}
									onClick={() => onFilterChange("US")}
								/>
							</div>
						</div>

						<p className="mt-1 text-xs font-bold text-muted-foreground">
							변동성·거래 기준 순위
						</p>
					</div>

					<button
						type="button"
						onClick={onClose}
						className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground transition active:scale-[0.96]"
						aria-label="닫기"
					>
						<X className="h-5 w-5" />
					</button>
				</div>

				<div className="max-h-[430px] space-y-2 overflow-y-auto pr-1">
					{loading ? (
						<div className="flex items-center justify-center gap-2 rounded-2xl bg-secondary/70 py-8 text-sm font-bold text-muted-foreground">
							<Loader2 className="h-5 w-5 animate-spin" />
							종목 불러오는 중
						</div>
					) : filteredRows.length === 0 ? (
						<div className="rounded-2xl bg-secondary/70 px-4 py-8 text-center text-sm font-bold text-muted-foreground">
							해당 조건의 종목이 없습니다.
						</div>
					) : (
						filteredRows.map((row, index) => (
							<button
								key={`${row.ticker}:${index}`}
								type="button"
								onClick={() => onSelect(row.ticker)}
								className="w-full rounded-2xl bg-secondary/70 px-3 py-3 text-left transition active:scale-[0.99]"
							>
								<div className="flex items-center justify-between gap-3">
									<div className="min-w-0 flex-1">
										<div className="flex min-w-0 items-center gap-2">
											<span className="shrink-0 text-sm font-black text-muted-foreground">
												{index + 1}
											</span>

											<p className="truncate text-sm font-black">{row.name}</p>

											<p className="shrink-0 text-xs font-bold text-muted-foreground">
												{row.ticker} · {normalizeMarket(row)}
											</p>
										</div>
									</div>

									<p
										className={cn(
											"shrink-0 whitespace-nowrap text-sm font-black",
											changeClass(row.changePercent),
										)}
									>
										{formatChangePercent(row.changePercent)}
									</p>
								</div>

								<div className="mt-2">
									<p className="text-xs font-black text-foreground">AI요약</p>

									<p className="mt-1 break-keep text-xs font-bold leading-relaxed text-muted-foreground">
										{buildAiSummary(row, sector)}
									</p>
								</div>
							</button>
						))
					)}
				</div>
			</div>
		</div>
	);
}
