import { Router, type IRouter } from "express";
import {
	MarketDataService,
	type QuoteRow,
} from "../services/market-data.service";
import * as naver from "../providers/naver";
import * as yahoo from "../providers/yahoo";
import {
	getKiwoomRankings,
	type KiwoomRankingRow,
} from "../providers/kiwoom";
import { ThemesService } from "../services/themes.service";
import { SectorPopularService } from "../services/sector-popular.service";
import { RankingMoversService } from "../services/ranking-movers.service";
import { MarketIssuesService } from "../services/market-issues.service";
import { RecommendationService } from "../services/recommendation.service";

const router: IRouter = Router();

function hasCompanyThemeAdminAccess(req: { header(name: string): string | undefined }): boolean {
	const expected = process.env.COMPANY_THEME_ADMIN_KEY?.trim();
	if (!expected) return false;
	const direct = req.header('x-admin-key')?.trim();
	const authorization = req.header('authorization')?.trim();
	const bearer = authorization?.toLowerCase().startsWith('bearer ')
		? authorization.slice(7).trim()
		: '';
	return direct === expected || bearer === expected;
}

type MarketScope = "ALL" | "KR" | "US";
type ConcreteMarket = "KR" | "US";

interface BasicStock {
	ticker: string;
	name: string;
	market: ConcreteMarket;
	currency: "KRW" | "USD";
}

const FALLBACK_UNIVERSE: BasicStock[] = [
	{ ticker: "005930", name: "삼성전자", market: "KR", currency: "KRW" },
	{ ticker: "000660", name: "SK하이닉스", market: "KR", currency: "KRW" },
	{ ticker: "005380", name: "현대차", market: "KR", currency: "KRW" },
	{ ticker: "000270", name: "기아", market: "KR", currency: "KRW" },
	{ ticker: "035420", name: "NAVER", market: "KR", currency: "KRW" },
	{ ticker: "035720", name: "카카오", market: "KR", currency: "KRW" },
	{ ticker: "AAPL", name: "Apple", market: "US", currency: "USD" },
	{ ticker: "MSFT", name: "Microsoft", market: "US", currency: "USD" },
	{ ticker: "NVDA", name: "NVIDIA", market: "US", currency: "USD" },
	{ ticker: "AMZN", name: "Amazon", market: "US", currency: "USD" },
	{ ticker: "META", name: "Meta Platforms", market: "US", currency: "USD" },
	{ ticker: "TSLA", name: "Tesla", market: "US", currency: "USD" },
];

function normalizeTicker(value: unknown): string {
	return String(value ?? "").trim().toUpperCase();
}

function normalizeMarket(value: unknown): MarketScope {
	const raw = String(value ?? "ALL").toUpperCase();
	if (raw === "KR") return "KR";
	if (raw === "US") return "US";
	return "ALL";
}

function uniqueTickers(values: string[]): string[] {
	return Array.from(
		new Set(values.map((value) => normalizeTicker(value)).filter(Boolean)),
	);
}

function isKrTicker(ticker: string): boolean {
	return /^\d{6}$/.test(ticker);
}

function numberFromSeed(ticker: string, min: number, max: number): number {
	const seed = [...ticker].reduce((sum, char) => sum + char.charCodeAt(0), 0);
	return min + (seed % (max - min));
}

function findFallbackStock(ticker: string): BasicStock {
	const clean = normalizeTicker(ticker);
	return (
		FALLBACK_UNIVERSE.find((stock) => stock.ticker === clean) ?? {
			ticker: clean,
			name: clean,
			market: isKrTicker(clean) ? "KR" : "US",
			currency: isKrTicker(clean) ? "KRW" : "USD",
		}
	);
}

function fallbackQuote(stock: BasicStock): QuoteRow {
	const seed = [...stock.ticker].reduce(
		(sum, char) => sum + char.charCodeAt(0),
		0,
	);
	const basePrice =
		stock.market === "KR"
			? numberFromSeed(stock.ticker, 3500, 300000)
			: numberFromSeed(stock.ticker, 20, 900);
	const changePercent = Number((((seed % 1800) - 900) / 100).toFixed(2));
	const price =
		stock.market === "KR"
			? Math.round(basePrice / 50) * 50
			: Number(basePrice.toFixed(2));
	const previousClose = price / (1 + changePercent / 100);
	const changeAmount = price - previousClose;
	const volume = numberFromSeed(stock.ticker, 100000, 9000000);

	return {
		ticker: stock.ticker,
		name: stock.name,
		market: stock.market,
		currency: stock.currency,
		assetType: "stock" as any,
		price,
		changeAmount,
		changePercent,
		volume,
		tradingValue: price * volume,
		open: previousClose,
		high: Math.max(price, previousClose) * 1.02,
		low: Math.min(price, previousClose) * 0.98,
		previousClose,
		updatedAt: new Date().toISOString(),
		rating: {
			score: Math.max(1, Math.min(100, 50 + changePercent * 3)),
			rating: changePercent > 3 ? "BUY" : changePercent < -3 ? "SELL" : "HOLD",
		} as any,
		reason: "임시 fallback 시세입니다.",
	};
}

function providerQuoteToRow(
	providerQuote: any,
	stock: BasicStock,
	provider: "naver" | "yahoo",
): QuoteRow {
	const price = Number(
		providerQuote.price ??
			providerQuote.currentPrice ??
			providerQuote.regularMarketPrice ??
			0,
	);
	const previousClose = Number(
		providerQuote.previousClose ?? providerQuote.prevClose ?? price,
	);
	const changeAmount = Number(
		providerQuote.changeAmount ?? providerQuote.change ?? price - previousClose,
	);
	const changePercent = Number(
		providerQuote.changePercent ??
			providerQuote.regularMarketChangePercent ??
			(previousClose ? (changeAmount / previousClose) * 100 : 0),
	);
	const volume = Number(providerQuote.volume ?? 0);
	const tradingValue = Number(providerQuote.tradingValue ?? price * volume);

	return {
		ticker: stock.ticker,
		name: String(providerQuote.name ?? stock.name),
		market: stock.market,
		currency: stock.currency,
		assetType: "stock" as any,
		price,
		changeAmount,
		changePercent,
		volume,
		tradingValue,
		open: Number(providerQuote.open ?? 0),
		high: Number(providerQuote.high ?? 0),
		low: Number(providerQuote.low ?? 0),
		previousClose,
		updatedAt: String(providerQuote.updatedAt ?? new Date().toISOString()),
		rating: {
			score: Math.max(1, Math.min(100, 50 + changePercent * 3)),
			rating: changePercent > 3 ? "BUY" : changePercent < -3 ? "SELL" : "HOLD",
		} as any,
		reason:
			provider === "naver"
				? "네이버 실시간 시세입니다."
				: "Yahoo 실시간 시세입니다.",
	};
}

function kiwoomRankingToQuoteRow(row: KiwoomRankingRow): QuoteRow {
	const price = Number(row.price ?? 0);
	const changePercent = Number(row.changePercent ?? 0);
	const previousClose =
		price > 0 && changePercent !== -100
			? price / (1 + changePercent / 100)
			: price;
	const changeAmount = price - previousClose;

	return {
		ticker: row.ticker,
		name: row.name,
		market: row.market,
		currency: row.currency,
		assetType: row.assetType.toLowerCase() as any,
		price,
		changeAmount,
		changePercent,
		volume: Number(row.volume ?? 0),
		tradingValue: Number(row.tradingValue ?? 0),
		open: previousClose,
		high: price,
		low: price,
		previousClose,
		updatedAt: new Date().toISOString(),
		rating: {
			score: Math.max(1, Math.min(100, 50 + changePercent * 3)),
			rating: changePercent > 3 ? "BUY" : changePercent < -3 ? "SELL" : "HOLD",
		} as any,
		reason: row.reason,
	};
}

async function getProviderQuote(ticker: string): Promise<QuoteRow | null> {
	const stock = findFallbackStock(ticker);

	try {
		if (stock.market === "KR") {
			const q = await naver.getQuote(stock.ticker);
			if (q && Number((q as any).price ?? 0) > 0) {
				return providerQuoteToRow(q, stock, "naver");
			}
		}

		const q = await yahoo.getQuote(stock.ticker);
		if (q && Number((q as any).price ?? 0) > 0) {
			return providerQuoteToRow(q, stock, "yahoo");
		}
	} catch {
		// fallback below
	}

	return null;
}

function filterUniverseByMarket(market: MarketScope): BasicStock[] {
	if (market === "ALL") return FALLBACK_UNIVERSE;
	return FALLBACK_UNIVERSE.filter((stock) => stock.market === market);
}

function sortByRecommended(rows: QuoteRow[]): QuoteRow[] {
	return [...rows].sort((a, b) => {
		const bScore = (b.rating as any)?.score ?? Math.abs(b.changePercent ?? 0);
		const aScore = (a.rating as any)?.score ?? Math.abs(a.changePercent ?? 0);
		return bScore - aScore;
	});
}

async function getRowsForTickers(tickers: string[]): Promise<QuoteRow[]> {
	const cleanTickers = uniqueTickers(tickers);
	if (cleanTickers.length === 0) return [];

	return Promise.all(
		cleanTickers.map(async (ticker) => {
			const providerRow = await getProviderQuote(ticker);
			if (providerRow) return providerRow;

			try {
				const serviceRow = await MarketDataService.getQuoteRow(ticker);
				if (serviceRow && Number(serviceRow.price ?? 0) > 0) {
					const suspiciousFallback =
						serviceRow.price === 3800 ||
						serviceRow.reason?.includes("fallback") ||
						serviceRow.name === serviceRow.ticker;
					if (!suspiciousFallback) return serviceRow;
				}
			} catch {
				// fallback below
			}

			return fallbackQuote(findFallbackStock(ticker));
		}),
	);
}

async function searchNaverStocks(query: string) {
	const q = query.trim();
	if (!q) return [];

	try {
		const response = await fetch(
			`https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`,
			{
				headers: {
					"User-Agent": "Mozilla/5.0 seungjae-stock-app/1.0",
					Accept: "application/json,text/plain,*/*",
					Referer: "https://finance.naver.com/",
				},
			},
		);
		if (!response.ok) return [];

		const data: any = await response.json();
		const candidates = Array.isArray(data?.items)
			? data.items
			: Array.isArray(data?.result?.items)
				? data.result.items
				: Array.isArray(data?.stocks)
					? data.stocks
					: [];

		return candidates
			.map((item: any) => {
				const ticker = String(
					item.code ?? item.stockCode ?? item.localCode ?? item.symbol ?? "",
				)
					.replace(/\D/g, "")
					.slice(-6);
				const name = String(
					item.name ?? item.stockName ?? item.koreanName ?? item.label ?? "",
				).trim();
				const marketText = String(
					item.typeCode ?? item.typeName ?? item.market ?? item.exchange ?? "",
				).toUpperCase();
				if (!/^\d{6}$/.test(ticker) || !name) return null;

				return {
					ticker,
					name,
					market: "KR" as const,
					currency: "KRW" as const,
					assetType: /ETF/.test(marketText)
						? "ETF"
						: /ETN/.test(marketText)
							? "ETN"
							: "stock",
					exchange: marketText.includes("KOSDAQ")
						? "KOSDAQ"
						: marketText.includes("KONEX")
							? "KONEX"
							: "KOSPI",
					aliases: [],
				};
			})
			.filter(Boolean)
			.slice(0, 80);
	} catch {
		return [];
	}
}

router.get("/config", (_req, res) => {
	res.json({
		ok: true,
		service: "seungjae-stock-api",
		time: new Date().toISOString(),
		providers: {
			kiwoom: true,
			naver: true,
			yahoo: true,
			quotes: true,
			search: true,
			movers: true,
		},
	});
});

router.get("/search", async (req, res) => {
	const q = String(req.query.q ?? "").trim();
	if (!q) {
		res.json({ q, results: [] });
		return;
	}

	const [serviceResult, naverResult] = await Promise.allSettled([
		MarketDataService.search(q, 80),
		searchNaverStocks(q),
	]);
	const combined = [
		...(serviceResult.status === "fulfilled" ? serviceResult.value : []),
		...(naverResult.status === "fulfilled" ? naverResult.value : []),
	];

	const unique = new Map<string, (typeof combined)[number]>();
	for (const result of combined) {
		const key = `${String(result.market).toUpperCase()}:${normalizeTicker(result.ticker)}`;
		const existing = unique.get(key);
		if (!existing || (!existing.name && result.name)) unique.set(key, result);
	}

	const needle = q
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9가-힣]/g, "");
	const score = (result: (typeof combined)[number]): number => {
		const ticker = normalizeTicker(result.ticker).toLowerCase();
		const name = String(result.name ?? "")
			.normalize("NFKC")
			.toLowerCase()
			.replace(/[^a-z0-9가-힣]/g, "");
		const aliases: string[] = (result.aliases ?? []).map((alias: unknown) =>
			String(alias)
				.normalize("NFKC")
				.toLowerCase()
				.replace(/[^a-z0-9가-힣]/g, ""),
		);
		if (ticker === needle) return 1000;
		if (name === needle) return 950;
		if (name.startsWith(needle)) return 850;
		if (ticker.startsWith(needle)) return 800;
		if (aliases.some((alias: string) => alias.startsWith(needle))) return 750;
		if (name.includes(needle)) return 650;
		if (ticker.includes(needle)) return 600;
		if (aliases.some((alias: string) => alias.includes(needle))) return 550;
		return 0;
	};

	const results = [...unique.values()]
		.map((result) => ({ result, rank: score(result) }))
		.filter(({ rank }) => rank > 0)
		.sort((left, right) =>
			right.rank !== left.rank
				? right.rank - left.rank
				: String(left.result.ticker).localeCompare(String(right.result.ticker)),
		)
		.slice(0, 80)
		.map(({ result }) => result);

	res.json({ q, results });
});

router.get("/quotes", async (req, res) => {
	const raw =
		req.query.tickers ??
		req.query.symbols ??
		req.query.symbol ??
		req.query.ticker ??
		"";
	const tickers = uniqueTickers(String(raw).split(","));
	const quotes = await getRowsForTickers(tickers);
	res.json({ quotes });
});

router.get("/market/sector-popular", async (req, res) => {
	const market =
		String(req.query.market ?? "KR").toUpperCase() === "US" ? "US" : "KR";

	try {
		const data = await SectorPopularService.getSectorPopular(market);
		res.json(data);
	} catch (error) {
		console.error("market sector popular route error:", error);
		res.status(502).json({
			ok: false,
			error: "MARKET_SECTOR_POPULAR_ROUTE_ERROR",
			market,
			sectors: [],
			message:
				error instanceof Error
					? error.message
					: "섹터별 인기종목 조회에 실패했습니다.",
			updatedAt: new Date().toISOString(),
		});
	}
});

router.get("/market/movers", async (req, res) => {
	const scope = normalizeMarket(req.query.market);

	try {
		const markets: ConcreteMarket[] =
			scope === "ALL" ? ["KR", "US"] : [scope];

		const results = await Promise.all(
			markets.map(async (market) => {
				const [popularRows, volumeRows, gainerRows, loserRows] =
					await Promise.all([
						getKiwoomRankings(market, "tradingValue", 30, {
							excludeHighRisk: true,
						}),
						getKiwoomRankings(market, "volume", 30, {
							excludeHighRisk: true,
						}),
						getKiwoomRankings(market, "gainers", 30, {
							excludeHighRisk: true,
						}),
						getKiwoomRankings(market, "losers", 30, {
							excludeHighRisk: true,
						}),
					]);

				return {
					popular: popularRows.map(kiwoomRankingToQuoteRow),
					volume: volumeRows.map(kiwoomRankingToQuoteRow),
					gainers: gainerRows.map(kiwoomRankingToQuoteRow),
					losers: loserRows.map(kiwoomRankingToQuoteRow),
				};
			}),
		);

		const popular = results
			.flatMap((result) => result.popular)
			.sort(
				(a, b) =>
					Number(b.tradingValue ?? 0) - Number(a.tradingValue ?? 0),
			)
			.slice(0, 30)
			.map((row, index) => ({ ...row, rank: index + 1 }));

		const volume = results
			.flatMap((result) => result.volume)
			.sort((a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0))
			.slice(0, 30)
			.map((row, index) => ({ ...row, rank: index + 1 }));

		const gainers = results
			.flatMap((result) => result.gainers)
			.sort(
				(a, b) =>
					Number(b.changePercent ?? 0) - Number(a.changePercent ?? 0),
			)
			.slice(0, 30)
			.map((row, index) => ({ ...row, rank: index + 1 }));

		const losers = results
			.flatMap((result) => result.losers)
			.sort(
				(a, b) =>
					Number(a.changePercent ?? 0) - Number(b.changePercent ?? 0),
			)
			.slice(0, 30)
			.map((row, index) => ({ ...row, rank: index + 1 }));

		const recommended = [...gainers]
			.sort(
				(a, b) =>
					Number((b.rating as any)?.score ?? 0) -
					Number((a.rating as any)?.score ?? 0),
			)
			.slice(0, 30)
			.map((row, index) => ({
				...row,
				rank: index + 1,
				reason: "키움 실시간 데이터 기반 추천 종목입니다.",
			}));

		res.json({
			market: scope,
			provider: "kiwoom",
			popular,
			volume,
			recommended,
			gainers,
			losers,
			risky: losers,
			updatedAt: new Date().toISOString(),
		});
	} catch (error) {
		console.error("Kiwoom market movers error:", error);

		// 키움 인증·지정단말·실전/모의 설정 오류가 발생해도 홈과 종목 목록 전체가
		// 502로 멈추지 않도록 국내는 네이버, 미국은 Yahoo 기반 랭킹으로 전환합니다.
		try {
			const fallbackMarkets =
				scope === "KR"
					? (["KRX"] as const)
					: scope === "US"
						? (["NASDAQ", "NYSE"] as const)
						: (["KRX", "NASDAQ", "NYSE"] as const);

			const settled = await Promise.allSettled(
				fallbackMarkets.map((market) =>
					RankingMoversService.getMarketListings(market),
				),
			);

			const fulfilled = settled
				.filter(
					(result): result is PromiseFulfilledResult<
						Awaited<ReturnType<typeof RankingMoversService.getMarketListings>>
					> => result.status === "fulfilled",
				)
				.map((result) => result.value);

			const unique = (rows: QuoteRow[]): QuoteRow[] => {
				const seen = new Set<string>();
				return rows.filter((row) => {
					const key = `${row.market}:${row.ticker.toUpperCase()}`;
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				});
			};

			const allRows = unique(
				fulfilled.flatMap(({ listings }) => [
					...listings.popular,
					...listings.gainers,
					...listings.losers,
					...listings.recommended,
				]),
			);

			const popular = unique(
				fulfilled.flatMap(({ listings }) => listings.popular),
			)
				.sort(
					(a, b) =>
						Number(b.tradingValue ?? 0) - Number(a.tradingValue ?? 0) ||
						Number(b.volume ?? 0) - Number(a.volume ?? 0),
				)
				.slice(0, 30)
				.map((row, index) => ({ ...row, rank: index + 1 }));

			const volume = [...allRows]
				.sort((a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0))
				.slice(0, 30)
				.map((row, index) => ({ ...row, rank: index + 1 }));

			const gainers = unique(
				fulfilled.flatMap(({ listings }) => listings.gainers),
			)
				.sort(
					(a, b) =>
						Number(b.changePercent ?? 0) - Number(a.changePercent ?? 0),
				)
				.slice(0, 30)
				.map((row, index) => ({ ...row, rank: index + 1 }));

			const losers = unique(
				fulfilled.flatMap(({ listings }) => listings.losers),
			)
				.sort(
					(a, b) =>
						Number(a.changePercent ?? 0) - Number(b.changePercent ?? 0),
				)
				.slice(0, 30)
				.map((row, index) => ({ ...row, rank: index + 1 }));

			const recommended = unique(
				fulfilled.flatMap(({ listings }) => listings.recommended),
			)
				.sort(
					(a, b) =>
						Number((b.rating as any)?.score ?? 0) -
						Number((a.rating as any)?.score ?? 0),
				)
				.slice(0, 30)
				.map((row, index) => ({ ...row, rank: index + 1 }));

			if (fulfilled.length === 0 || allRows.length === 0) {
				throw new Error("대체 시장 데이터도 조회되지 않았습니다.");
			}

			res.json({
				market: scope,
				provider: "market-fallback",
				sources: Array.from(new Set(fulfilled.map((item) => item.source))),
				rankingSource: fulfilled[0]?.rankingSource,
				popular,
				volume,
				recommended,
				gainers,
				losers,
				risky: losers,
				warning:
					error instanceof Error
						? error.message
						: "키움 조회 실패로 대체 제공기관 데이터를 사용했습니다.",
				updatedAt: new Date().toISOString(),
			});
		} catch (fallbackError) {
			console.error("Market movers fallback error:", fallbackError);
			res.status(502).json({
				ok: false,
				provider: "kiwoom",
				error:
					error instanceof Error
						? error.message
						: "키움 시장 순위 조회에 실패했습니다.",
				fallbackError:
					fallbackError instanceof Error
						? fallbackError.message
						: "대체 시장 순위 조회에도 실패했습니다.",
			});
		}
	}
});

router.get("/market/summary", async (_req, res) => {
	res.setHeader("Cache-Control", "no-store, max-age=0");

	try {
		const items = await MarketDataService.getMarketSummary();
		const available = items.filter((item) => item.ok && item.price > 0);

		res.status(available.length > 0 ? 200 : 503).json({
			ok: available.length > 0,
			items,
			updatedAt: new Date().toISOString(),
		});
	} catch (error) {
		console.error("market summary route error:", error);

		res.status(502).json({
			ok: false,
			items: [],
			error: "MARKET_SUMMARY_ROUTE_ERROR",
			message:
				error instanceof Error
					? error.message
					: "시장현황 데이터를 불러오지 못했습니다.",
			updatedAt: new Date().toISOString(),
		});
	}
});

// 오늘의 이슈: 시장 종합요약 1개 + 실제 뉴스 이슈 최대 5개.
router.get("/market/issues", async (_req, res) => {
	res.setHeader("Cache-Control", "no-store, max-age=0");
	try {
		const data = await MarketIssuesService.getMarketIssues();
		res.status(data.ok ? 200 : 503).json(data);
	} catch (error) {
		console.error("market issues route error:", error);
		res.status(502).json({
			ok: false,
			overview: null,
			issues: [],
			error: "MARKET_ISSUES_ROUTE_ERROR",
			updatedAt: new Date().toISOString(),
		});
	}
});

// 시가총액 순위 전용 소스 — 국내: 네이버 시가총액 목록(억원), 미국: 야후 스크리너(시총 내림차순).
async function getMarketCapRankingRows(market: ConcreteMarket): Promise<QuoteRow[]> {
	const parseNum = (v: unknown): number => {
		const n = Number(String(v ?? "").replace(/,/g, ""));
		return Number.isFinite(n) ? n : 0;
	};
	const headers = { "user-agent": "Mozilla/5.0" } as Record<string, string>;

	if (market === "KR") {
		const codes = ["KOSPI", "KOSDAQ"] as const;
		const settled = await Promise.allSettled(
			codes.map(async (code) => {
				const res = await fetch(
					`https://m.stock.naver.com/api/stocks/marketValue/${code}?page=1&pageSize=100`,
					{ headers },
				);
				if (!res.ok) throw new Error(`naver marketValue ${code} ${res.status}`);
				return (await res.json()) as { stocks?: Array<Record<string, unknown>> };
			}),
		);
		const rows: QuoteRow[] = [];
		for (const result of settled) {
			if (result.status !== "fulfilled") continue;
			for (const stock of result.value.stocks ?? []) {
				const ticker = String(stock.itemCode ?? "").trim();
				const name = String(stock.stockName ?? "").trim();
				const price = parseNum(stock.closePrice);
				const marketCap = parseNum(stock.marketValue) * 100_000_000; // 억원 → 원
				if (!ticker || !name || price <= 0 || marketCap <= 0) continue;
				rows.push({
					ticker,
					name,
					market: "KR",
					currency: "KRW",
					assetType: "stock",
					price,
					changeAmount: 0,
					changePercent: parseNum(stock.fluctuationsRatio),
					volume: parseNum(stock.accumulatedTradingVolume),
					tradingValue: parseNum(stock.accumulatedTradingValue) * 1_000_000, // 백만원 → 원
					marketCap,
					updatedAt: new Date().toISOString(),
				} as unknown as QuoteRow);
			}
		}
		return rows
			.sort((a, b) => Number(b.marketCap ?? 0) - Number(a.marketCap ?? 0))
			.slice(0, 100);
	}

	const res = await fetch(
		"https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=most_actives&count=100&sortField=intradaymarketcap&sortType=DESC",
		{ headers },
	);
	if (!res.ok) throw new Error(`yahoo marketCap screener ${res.status}`);
	const json = (await res.json()) as {
		finance?: { result?: Array<{ quotes?: Array<Record<string, unknown>> }> };
	};
	const quotes = json.finance?.result?.[0]?.quotes ?? [];
	return quotes
		.map((q) => {
			const ticker = String(q.symbol ?? "").trim().toUpperCase();
			const name = String(q.shortName ?? q.longName ?? ticker).trim();
			const price = Number(q.regularMarketPrice ?? 0);
			const marketCap = Number(q.marketCap ?? 0);
			if (!ticker || price <= 0 || marketCap <= 0) return null;
			const volume = Number(q.regularMarketVolume ?? 0);
			return {
				ticker,
				name,
				market: "US",
				currency: "USD",
				assetType: "stock",
				price,
				changeAmount: 0,
				changePercent: Number(q.regularMarketChangePercent ?? 0),
				volume,
				tradingValue: volume * price,
				marketCap,
				updatedAt: new Date().toISOString(),
			} as unknown as QuoteRow;
		})
		.filter((row): row is QuoteRow => row != null)
		.sort((a, b) => Number(b.marketCap ?? 0) - Number(a.marketCap ?? 0))
		.slice(0, 100);
}

// 순위 화면용 서버 페이지네이션 API.
// GET /market/rankings?market=KR&category=volume&page=1&limit=20&sort=changePercent_desc
router.get("/market/rankings", async (req, res) => {
	const market: ConcreteMarket =
		String(req.query.market ?? "KR").toUpperCase() === "US" ? "US" : "KR";
	const category = String(req.query.category ?? req.query.type ?? "tradingValue");
	const page = Math.max(1, Math.min(5, Math.floor(Number(req.query.page ?? 1)) || 1));
	const limit = Math.max(1, Math.min(20, Math.floor(Number(req.query.limit ?? 20)) || 20));
	const sort = String(req.query.sort ?? "default");

	try {
		let rows: QuoteRow[] = [];
		let provider = "kiwoom";

		if (category === "ai") {
			// AI 분석 순위: 규칙 기반 추천 점수순 (전 분류 통합).
			const reco = await RecommendationService.getRecommendations(market);
			rows = reco.rows
				.map((r) => ({
					ticker: r.ticker,
					name: r.name,
					market: r.market,
					currency: r.currency,
					price: r.price,
					changePercent: r.changePercent,
					volume: null,
					tradingValue: null,
					marketCap: null,
					reason: r.reasons[0] ?? r.categoryLabel,
					rating: { score: r.score },
					categoryLabel: r.categoryLabel,
				})) as unknown as QuoteRow[];
			rows = [...rows].sort(
				(a, b) => Number((b as any).rating?.score ?? 0) - Number((a as any).rating?.score ?? 0),
			);
			provider = reco.provider;
		} else {
			const kiwoomType =
				category === "gainers" || category === "losers" || category === "volume"
					? category
					: "tradingValue";
			const loadFallbackRows = async (): Promise<QuoteRow[]> => {
				// 키움 실패·빈 결과 시 대체 제공기관 (기존 movers 폴백과 동일한 소스).
				const fallbackMarkets =
					market === "KR" ? (["KRX"] as const) : (["NASDAQ", "NYSE"] as const);
				const settled = await Promise.allSettled(
					fallbackMarkets.map((m) => RankingMoversService.getMarketListings(m)),
				);
				const fulfilled = settled
					.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof RankingMoversService.getMarketListings>>> => r.status === "fulfilled")
					.map((r) => r.value);
				const seen = new Set<string>();
				return fulfilled
					.flatMap(({ listings }) => [
						...listings.popular,
						...listings.gainers,
						...listings.losers,
						...listings.recommended,
					])
					.filter((row) => {
						const key = `${row.market}:${row.ticker.toUpperCase()}`;
						if (seen.has(key)) return false;
						seen.add(key);
						return true;
					});
			};

			try {
				const ranked = await getKiwoomRankings(market, kiwoomType as any, 100, {
					excludeHighRisk: true,
				});
				rows = ranked.map(kiwoomRankingToQuoteRow);
			} catch {
				rows = await loadFallbackRows();
				provider = "market-fallback";
			}
			if (rows.length === 0 && provider === "kiwoom") {
				rows = await loadFallbackRows();
				provider = "market-fallback";
			}

			if (category === "marketCap") {
				// 키움 순위 응답에는 시가총액이 없어 시가총액 전용 소스를 사용한다.
				rows = await getMarketCapRankingRows(market);
				provider = market === "KR" ? "naver" : "yahoo";
			} else if (category === "volume") {
				rows = [...rows].sort((a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0));
			} else if (category === "gainers") {
				rows = [...rows]
					.filter((r) => Number(r.changePercent ?? 0) > 0)
					.sort((a, b) => Number(b.changePercent ?? 0) - Number(a.changePercent ?? 0));
			} else if (category === "losers") {
				rows = [...rows]
					.filter((r) => Number(r.changePercent ?? 0) < 0)
					.sort((a, b) => Number(a.changePercent ?? 0) - Number(b.changePercent ?? 0));
			} else {
				rows = [...rows].sort(
					(a, b) => Number(b.tradingValue ?? 0) - Number(a.tradingValue ?? 0),
				);
			}
		}

		// 순위는 기본 정렬 기준으로 부여하고, 등락률 재정렬은 그 위에 적용한다.
		let ranked = rows.slice(0, 100).map((row, index) => ({ ...row, rank: index + 1 }));
		if (sort === "changePercent_desc") {
			ranked = [...ranked].sort((a, b) => Number(b.changePercent ?? 0) - Number(a.changePercent ?? 0));
		} else if (sort === "changePercent_asc") {
			ranked = [...ranked].sort((a, b) => Number(a.changePercent ?? 0) - Number(b.changePercent ?? 0));
		}

		const total = ranked.length;
		const start = (page - 1) * limit;
		const rowsPage = ranked.slice(start, start + limit);

		res.json({
			ok: true,
			provider,
			market,
			category,
			page,
			limit,
			sort,
			total,
			totalPages: Math.max(1, Math.ceil(total / limit)),
			rows: rowsPage,
			updatedAt: new Date().toISOString(),
		});
	} catch (error) {
		console.error("market rankings route error:", error);
		res.status(502).json({
			ok: false,
			market,
			category,
			page,
			limit,
			sort,
			total: 0,
			totalPages: 0,
			rows: [],
			error: "MARKET_RANKINGS_ROUTE_ERROR",
			message: error instanceof Error ? error.message : "순위 데이터를 불러오지 못했습니다.",
			updatedAt: new Date().toISOString(),
		});
	}
});

router.get("/market/briefing", (_req, res) => {
	res.json({
		ok: true,
		items: [
			{
				sector: "반도체",
				title: "반도체",
				summary: "AI 반도체와 고성능 메모리 수요 흐름을 확인합니다.",
			},
			{
				sector: "바이오",
				title: "바이오",
				summary: "임상·승인·계약 뉴스에 따른 종목별 변동성을 확인합니다.",
			},
			{
				sector: "자동차",
				title: "자동차",
				summary: "완성차 판매와 전기차 전환 흐름을 확인합니다.",
			},
			{
				sector: "항공",
				title: "항공",
				summary: "여행 수요와 유가, 환율에 따른 항공주 흐름을 확인합니다.",
			},
			{
				sector: "건설",
				title: "건설",
				summary: "부동산 정책과 수주 흐름을 확인합니다.",
			},
		],
		updatedAt: new Date().toISOString(),
	});
});

router.get("/market/themes", async (req, res) => {
	const market =
		String(req.query.market ?? "KR").toUpperCase() === "US" ? "US" : "KR";

	try {
		const data = await ThemesService.getThemes(market);
		res.json(data);
	} catch (error) {
		console.error("market themes route error:", error);
		res.status(500).json({
			error: "MARKET_THEMES_ROUTE_ERROR",
			market,
			themes: [],
		});
	}
});

router.get('/market/themes/status', async (req, res) => {
	const market = String(req.query.market ?? 'KR').toUpperCase() === 'US' ? 'US' : 'KR';
	try {
		res.json(await ThemesService.getStatus(market));
	} catch (error) {
		console.error('market themes status error:', error);
		res.status(500).json({ error: 'MARKET_THEMES_STATUS_ERROR', market });
	}
});

router.post('/market/themes/rebuild', async (req, res) => {
	if (!hasCompanyThemeAdminAccess(req)) {
		res.status(403).json({ error: 'COMPANY_THEME_ADMIN_ACCESS_DENIED' });
		return;
	}

	const market = String(req.body?.market ?? req.query.market ?? 'KR').toUpperCase() === 'US' ? 'US' : 'KR';
	const rawLimit = Number(req.body?.limit ?? req.query.limit ?? 250);
	const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(10_000, Math.floor(rawLimit))) : 250;
	const reset = Boolean(req.body?.reset === true || String(req.query.reset ?? '') === '1');

	try {
		const result = await ThemesService.startRebuild(market, { limit, reset });
		res.status(result.started ? 202 : 200).json({ ok: true, market, limit, reset, ...result });
	} catch (error) {
		console.error('market themes rebuild error:', error);
		res.status(500).json({
			ok: false,
			error: 'MARKET_THEMES_REBUILD_ERROR',
			market,
			message: error instanceof Error ? error.message : String(error),
		});
	}
});

router.post('/market/themes/review', async (req, res) => {
	if (!hasCompanyThemeAdminAccess(req)) {
		res.status(403).json({ error: 'COMPANY_THEME_ADMIN_ACCESS_DENIED' });
		return;
	}

	const market = String(req.body?.market ?? 'KR').toUpperCase() === 'US' ? 'US' : 'KR';
	const ticker = String(req.body?.ticker ?? '').trim().toUpperCase();
	const themeKey = String(req.body?.themeKey ?? '').trim();
	const action = req.body?.action === 'reject' ? 'reject' : 'approve';

	if (!ticker || !themeKey) {
		res.status(400).json({ error: 'MISSING_TICKER_OR_THEME_KEY' });
		return;
	}

	try {
		const relation = await ThemesService.reviewRelation({
			market,
			ticker,
			themeKey,
			action,
			relationLevel: req.body?.relationLevel,
			reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
		});
		if (!relation) {
			res.status(404).json({ error: 'THEME_RELATION_NOT_FOUND', market, ticker, themeKey });
			return;
		}
		res.json({ ok: true, relation });
	} catch (error) {
		console.error('market themes review error:', error);
		res.status(500).json({
			ok: false,
			error: 'MARKET_THEMES_REVIEW_ERROR',
			message: error instanceof Error ? error.message : String(error),
		});
	}
});

router.get("/market/scan", async (req, res) => {
	const scope = normalizeMarket(req.query.market);
	const rows = await getRowsForTickers(
		filterUniverseByMarket(scope).map((stock) => stock.ticker),
	);

	res.json({
		market: scope,
		results: sortByRecommended(rows).slice(0, 30),
		updatedAt: new Date().toISOString(),
	});
});

router.get("/market/alerts", async (req, res) => {
	const scope = normalizeMarket(req.query.market);
	const rows = await getRowsForTickers(
		filterUniverseByMarket(scope).map((stock) => stock.ticker),
	);

	const alerts = [...rows]
		.sort((a, b) => Number(b.changePercent ?? 0) - Number(a.changePercent ?? 0))
		.slice(0, 20);

	res.json({
		market: scope,
		alerts,
		updatedAt: new Date().toISOString(),
	});
});

router.get("/market/undervalued", async (req, res) => {
	const scope = normalizeMarket(req.query.market);
	const rows = await getRowsForTickers(
		filterUniverseByMarket(scope).map((stock) => stock.ticker),
	);

	res.json({
		market: scope,
		results: sortByRecommended(rows).slice(0, 20),
		updatedAt: new Date().toISOString(),
	});
});

export default router;