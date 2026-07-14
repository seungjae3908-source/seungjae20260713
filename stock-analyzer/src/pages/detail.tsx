import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Maximize2, Minimize2, Settings2 } from "lucide-react";
import {
	ColorType,
	CrosshairMode,
	LineStyle,
	createChart,
	type IChartApi,
	type Time,
	type UTCTimestamp,
} from "lightweight-charts";
import { BottomNav } from "@/components/bottom-nav";
import { buildAiInsights } from "@/lib/ai-insights";
import {
	displayStockName,
	eventLabelKo,
	formatAppPercent,
	formatAppPrice,
	isInWatchlist,
	summarizeText,
	toggleWatchlistItem,
	translateMarketText,
} from "@/lib/stock-display";
import { stockClassBadgeClass } from "@/lib/stock-classifier";
import { cn } from "@/lib/utils";
import { getAutoTradeSignal } from "@/lib/auto-trading";
import {
	getPortfolioChartOverlay,
	type PortfolioChartOverlay,
} from "@/lib/portfolio-overlay";
import {
	getStudyChartFocus,
	type StudyChartFocus,
	type StudyMarkerStrategy,
} from "@/lib/study-chart";

type AnyObj = Record<string, any>;
type Market = "KR" | "US";
type Currency = "KRW" | "USD";
type DetailTab =
	| "overview"
	| "ai"
	| "chart"
	| "financials"
	| "filings"
	| "news";
type ChartTimeframe =
	| "1m"
	| "3m"
	| "5m"
	| "15m"
	| "30m"
	| "1H"
	| "4H"
	| "1D"
	| "3D"
	| "5D"
	| "10D"
	| "1M"
	| "1Y"
	| "ALL";
type FinancialPeriod = "annual" | "quarterly";
type Tone = "positive" | "negative" | "neutral";
type RiskLabel = "낮음" | "보통" | "높음" | "매우 높음";
type FinancialMetricKey = "roe" | "pbr" | "per" | "psr";

interface DetailData {
	ticker: string;
	quote: AnyObj | null;
	company: AnyObj | null;
	candles: AnyObj[];
	financials: AnyObj | null;
	risk: AnyObj | null;
	filings: AnyObj[];
	news: AnyObj[];
}

interface CandlePoint {
	date: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

interface CoreMetrics {
	fairPrice: number | null;
	targetPrice: number | null;
	stopPrice: number | null;
	riskLabel: RiskLabel;
	riskCaption: string;
}

interface FinancialMetric {
	key: FinancialMetricKey;
	label: string;
	valueText: string;
	status: string;
	tone: Tone;
	meaning: string;
	interpretation: string;
	caution: string;
}

interface ChartStats {
	rsi: number | null;
	macd: number | null;
	macdSignal: number | null;
	sma5: number | null;
	sma20: number | null;
	volumeRatio: number | null;
	trend: string;
}

const TABS: Array<{ key: DetailTab; label: string }> = [
	{ key: "overview", label: "개요" },
	{ key: "ai", label: "AI분석" },
	{ key: "chart", label: "차트" },
	{ key: "financials", label: "재무제표" },
	{ key: "filings", label: "공시" },
	{ key: "news", label: "뉴스" },
];

const TIMEFRAMES: Array<{ key: ChartTimeframe; label: string }> = [
	{ key: "1m", label: "1분봉" },
	{ key: "3m", label: "3분봉" },
	{ key: "5m", label: "5분봉" },
	{ key: "15m", label: "15분봉" },
	{ key: "30m", label: "30분봉" },
	{ key: "1H", label: "1시간봉" },
	{ key: "4H", label: "4시간봉" },
	{ key: "1D", label: "1일봉" },
	{ key: "3D", label: "3일봉" },
	{ key: "5D", label: "5일봉" },
	{ key: "10D", label: "10일봉" },
	{ key: "1M", label: "1달봉" },
	{ key: "1Y", label: "1년봉" },
	{ key: "ALL", label: "전체" },
];

interface ChartIndicatorSettings {
	sma5: boolean;
	sma20: boolean;
	sma60: boolean;
	sma120: boolean;
	volume: boolean;
	priceGrid: boolean;
	bollinger: boolean;
	vwap: boolean;
	rsi: boolean;
	macd: boolean;
	stochastic: boolean;
	ichimoku: boolean;
	atr: boolean;
	cci: boolean;
	obv: boolean;
	williamsR: boolean;
	roc: boolean;
}

const DEFAULT_CHART_INDICATORS: ChartIndicatorSettings = {
	sma5: true,
	sma20: true,
	sma60: false,
	sma120: false,
	volume: true,
	priceGrid: true,
	bollinger: false,
	vwap: false,
	rsi: false,
	macd: false,
	stochastic: false,
	ichimoku: false,
	atr: false,
	cci: false,
	obv: false,
	williamsR: false,
	roc: false,
};

function toNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;

	if (typeof value === "string") {
		const parsed = Number(
			value
				.replace(/,/g, "")
				.replace(/%/g, "")
				.replace(/[₩$원배]/g, "")
				.trim(),
		);

		if (Number.isFinite(parsed)) return parsed;
	}

	return null;
}

function firstNumber(...values: unknown[]): number | null {
	for (const value of values) {
		const parsed = toNumber(value);
		if (parsed != null) return parsed;
	}

	return null;
}

function firstText(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}

	return null;
}

function isKrTicker(ticker: string): boolean {
	return /^\d/.test(ticker);
}

function marketOf(
	ticker: string,
	quote?: AnyObj | null,
	company?: AnyObj | null,
): Market {
	if (quote?.market === "US" || company?.market === "US") return "US";
	if (quote?.market === "KR" || company?.market === "KR") return "KR";

	return isKrTicker(ticker) ? "KR" : "US";
}

function currencyOf(market: Market, quote?: AnyObj | null): Currency {
	if (quote?.currency === "USD") return "USD";
	if (quote?.currency === "KRW") return "KRW";

	return market === "US" ? "USD" : "KRW";
}

async function tryJson<T>(urls: string[], fallback: T): Promise<T> {
	for (const url of urls) {
		try {
			const response = await fetch(url, {
				cache: "no-store",
			});

			if (!response.ok) continue;

			return (await response.json()) as T;
		} catch {
			// 다음 API 주소를 시도합니다.
		}
	}

	return fallback;
}

function normalizeQuote(ticker: string, data: AnyObj): AnyObj | null {
	if (Array.isArray(data?.quotes)) {
		return (
			data.quotes.find(
				(item: AnyObj) => String(item.ticker ?? "").toUpperCase() === ticker,
			) ??
			data.quotes[0] ??
			null
		);
	}

	if (data?.quote) return data.quote;
	if (data?.ticker || data?.price) return data;

	return null;
}

function normalizeObject(data: AnyObj, keys: string[]): AnyObj | null {
	for (const key of keys) {
		const value = data?.[key];

		if (value && typeof value === "object" && !Array.isArray(value)) {
			return value;
		}
	}

	if (
		data &&
		typeof data === "object" &&
		!Array.isArray(data) &&
		Object.keys(data).length > 0
	) {
		return data;
	}

	return null;
}

function uniqueItems(
	items: AnyObj[],
	keyOf: (item: AnyObj) => string,
): AnyObj[] {
	const seen = new Set<string>();

	return items.filter((item) => {
		const key = keyOf(item);

		if (seen.has(key)) return false;

		seen.add(key);
		return true;
	});
}

function collectFilings(data: AnyObj): AnyObj[] {
	const nested = data?.data && typeof data.data === "object" ? data.data : {};

	return uniqueItems(
		[
			...(Array.isArray(data?.filings) ? data.filings : []),
			...(Array.isArray(data?.disclosures) ? data.disclosures : []),
			...(Array.isArray(data?.items) ? data.items : []),
			...(Array.isArray(nested?.filings) ? nested.filings : []),
			...(Array.isArray(nested?.disclosures) ? nested.disclosures : []),
			...(Array.isArray(nested?.items) ? nested.items : []),
			...(Array.isArray(data?.data) ? data.data : []),
		],
		(item) =>
			`${item.rcept_no ?? item.accessionNumber ?? item.url ?? ""}:${
				item.title ?? item.report_nm ?? item.report ?? item.form ?? ""
			}`,
	);
}

function collectNews(data: AnyObj): AnyObj[] {
	const nested = data?.data && typeof data.data === "object" ? data.data : {};

	return uniqueItems(
		[
			...(Array.isArray(data?.news) ? data.news : []),
			...(Array.isArray(data?.positive) ? data.positive : []),
			...(Array.isArray(data?.negative) ? data.negative : []),
			...(Array.isArray(data?.items) ? data.items : []),
			...(Array.isArray(nested?.news) ? nested.news : []),
			...(Array.isArray(nested?.articles) ? nested.articles : []),
			...(Array.isArray(nested?.items) ? nested.items : []),
			...(Array.isArray(data?.articles) ? data.articles : []),
			...(Array.isArray(data?.data) ? data.data : []),
		],
		(item) =>
			`${item.url ?? item.link ?? item.articleUrl ?? ""}:${
				item.title ?? item.headline ?? ""
			}`,
	);
}

async function fetchDetail(ticker: string): Promise<DetailData> {
	const upper = ticker.toUpperCase();

	const [
		quoteRaw,
		companyRaw,
		candlesRaw,
		financialRaw,
		riskRaw,
		filingsRaw,
		newsRaw,
	] = await Promise.all([
		tryJson<AnyObj>(
			[`/api/quotes?tickers=${upper}`, `/api/stocks/${upper}/quote`],
			{},
		),

		tryJson<AnyObj>(
			[`/api/stocks/${upper}/company`, `/api/stocks/${upper}/profile`],
			{},
		),

		tryJson<AnyObj>(
			[
				`/api/stocks/${upper}/chart?tf=1D`,
				`/api/stocks/${upper}/candles?tf=1D`,
				`/api/stocks/${upper}/candles?timeframe=1D`,
				`/api/candles?ticker=${upper}&tf=1D`,
			],
			{},
		),

		tryJson<AnyObj>([`/api/stocks/${upper}/financials`], {}),

		tryJson<AnyObj>(
			[`/api/stocks/${upper}/risk`, `/api/stocks/${upper}/analysis`],
			{},
		),

		tryJson<AnyObj>(
			[`/api/stocks/${upper}/filings`, `/api/stocks/${upper}/disclosures`],
			{},
		),

		tryJson<AnyObj>([`/api/stocks/${upper}/news`], {}),
	]);

	const candleRows = Array.isArray(candlesRaw?.candles)
		? candlesRaw.candles
		: Array.isArray(candlesRaw?.data?.candles)
			? candlesRaw.data.candles
			: Array.isArray(candlesRaw?.items)
				? candlesRaw.items
				: Array.isArray(candlesRaw)
					? candlesRaw
					: [];

	return {
		ticker: upper,

		quote: normalizeQuote(upper, quoteRaw),

		company: normalizeObject(companyRaw, ["company", "profile", "data"]),

		candles: candleRows,

		financials: normalizeObject(financialRaw, ["financials", "data"]),

		risk: normalizeObject(riskRaw, ["risk", "analysis", "data"]),

		filings: uniqueItems(
			[...collectFilings(riskRaw), ...collectFilings(filingsRaw)],
			(item) =>
				`${item.rcept_no ?? item.accessionNumber ?? item.url ?? ""}:${
					item.title ?? item.report_nm ?? item.report ?? item.form ?? ""
				}`,
		),

		news: collectNews(newsRaw),
	};
}

function currentBackPath(): string {
	const raw = new URLSearchParams(window.location.search).get("back");

	if (!raw) return "/search";

	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

function roundPrice(price: number, market: Market): number {
	if (market === "US") {
		return Math.round(price * 100) / 100;
	}

	if (price >= 100_000) {
		return Math.round(price / 1_000) * 1_000;
	}

	if (price >= 10_000) {
		return Math.round(price / 100) * 100;
	}

	if (price >= 1_000) {
		return Math.round(price / 10) * 10;
	}

	return Math.round(price);
}

function deriveRiskLabel(
	score: number,
	classification: AnyObj,
	risk: AnyObj | null,
): RiskLabel {
	const text = [
		classification?.label,
		classification?.riskCaption,
		risk?.riskLevel,
		risk?.level,
		risk?.grade,
		risk?.summary,
		risk?.caption,
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();

	if (
		classification?.delistingWarning ||
		text.includes("상장폐지") ||
		text.includes("매우 높") ||
		text.includes("critical")
	) {
		return "매우 높음";
	}

	if (
		text.includes("고위험") ||
		text.includes("높음") ||
		text.includes("high") ||
		score < 40
	) {
		return "높음";
	}

	if (text.includes("우량주") && score >= 70) {
		return "낮음";
	}

	return "보통";
}

function buildCoreMetrics({
	market,
	currentPrice,
	score,
	opinion,
	classification,
	quote,
	company,
	financials,
	risk,
}: {
	market: Market;
	currentPrice: number | null;
	score: number;
	opinion: string;
	classification: AnyObj;
	quote: AnyObj | null;
	company: AnyObj | null;
	financials: AnyObj | null;
	risk: AnyObj | null;
}): CoreMetrics {
	const riskLabel = deriveRiskLabel(score, classification, risk);

	const opinionText = String(opinion ?? "").toLowerCase();

	const fairRate =
		opinionText.includes("매수") || opinionText.includes("buy")
			? Math.min(0.08, 0.02 + Math.max(score - 60, 0) * 0.0015)
			: opinionText.includes("매도") || opinionText.includes("sell")
				? -0.04
				: 0.02;

	const targetRate =
		opinionText.includes("매수") || opinionText.includes("buy")
			? Math.min(0.16, 0.06 + Math.max(score - 60, 0) * 0.003)
			: opinionText.includes("매도") || opinionText.includes("sell")
				? -0.02
				: 0.04;

	const stopRate =
		riskLabel === "매우 높음"
			? 0.12
			: riskLabel === "높음"
				? 0.1
				: riskLabel === "보통"
					? 0.07
					: 0.05;

	return {
		fairPrice:
			firstNumber(
				quote?.fairPrice,
				quote?.fairValue,
				company?.fairPrice,
				financials?.fairPrice,
				risk?.fairPrice,
			) ??
			(currentPrice != null
				? roundPrice(currentPrice * (1 + fairRate), market)
				: null),

		targetPrice:
			firstNumber(
				quote?.targetPrice,
				quote?.analystTargetPrice,
				company?.targetPrice,
				financials?.targetPrice,
				risk?.targetPrice,
			) ??
			(currentPrice != null
				? roundPrice(currentPrice * (1 + targetRate), market)
				: null),

		stopPrice:
			firstNumber(
				quote?.stopPrice,
				quote?.stopLossPrice,
				company?.stopPrice,
				risk?.stopPrice,
			) ??
			(currentPrice != null
				? roundPrice(currentPrice * (1 - stopRate), market)
				: null),

		riskLabel,

		riskCaption: String(
			risk?.summary ??
				risk?.caption ??
				classification?.riskCaption ??
				"가격 변동성과 재무 위험을 함께 확인해야 합니다.",
		),
	};
}

function formatCompactMoney(value: unknown, currency: Currency): string {
	const numberValue = toNumber(value);

	if (numberValue == null) {
		return "확인 필요";
	}

	const absolute = Math.abs(numberValue);

	const sign = numberValue < 0 ? "-" : "";

	if (currency === "USD") {
		if (absolute >= 1_000_000_000_000) {
			return `${sign}$${(absolute / 1_000_000_000_000).toFixed(1)}T`;
		}

		if (absolute >= 1_000_000_000) {
			return `${sign}$${(absolute / 1_000_000_000).toFixed(1)}B`;
		}

		if (absolute >= 1_000_000) {
			return `${sign}$${(absolute / 1_000_000).toFixed(1)}M`;
		}

		return `${sign}$${Math.round(absolute).toLocaleString()}`;
	}

	if (absolute >= 1_000_000_000_000) {
		return `${sign}${(absolute / 1_000_000_000_000).toFixed(1)}조`;
	}

	if (absolute >= 100_000_000) {
		return `${sign}${(absolute / 100_000_000).toFixed(0)}억`;
	}

	if (absolute >= 10_000) {
		return `${sign}${(absolute / 10_000).toFixed(0)}만`;
	}

	return `${sign}${Math.round(absolute).toLocaleString()}`;
}

function formatMoney(value: unknown, currency: Currency): string {
	const numberValue = toNumber(value);

	if (numberValue == null) {
		return "확인 필요";
	}

	if (currency === "USD") {
		return `$${numberValue.toLocaleString(undefined, {
			maximumFractionDigits: 0,
		})}`;
	}

	return `${Math.round(numberValue).toLocaleString()}원`;
}

function positiveSummary(insights: ReturnType<typeof buildAiInsights>): string {
	const rows = [
		...(insights.newsDisclosureSummary ?? []),
		...(insights.financialSummary ?? []),
		...(insights.chartSummary ?? []),
	];

	return (
		rows.find((row) =>
			/상승|증가|개선|성장|호재|긍정|강세|흑자|계약|수주|돌파|우수/.test(row),
		) ??
		rows[0] ??
		"최근 확인된 뚜렷한 호재가 없습니다."
	);
}

function negativeSummary(insights: ReturnType<typeof buildAiInsights>): string {
	const rows = [
		...(insights.riskSummary ?? []),
		...(insights.newsDisclosureSummary ?? []),
		...(insights.financialSummary ?? []),
		...(insights.chartSummary ?? []),
	];

	return (
		rows.find((row) =>
			/하락|감소|악화|부진|악재|부정|약세|적자|위험|과열|부채|주의/.test(row),
		) ??
		rows[0] ??
		"최근 확인된 뚜렷한 악재가 없습니다."
	);
}

function normalizeCandles(rows: AnyObj[]): CandlePoint[] {
	return rows
		.map((row, index) => {
			const close = firstNumber(
				row.close,
				row.closePrice,
				row.cur_prc,
				row.currentPrice,
				row.price,
			);

			const open = firstNumber(row.open, row.openPrice, row.open_prc, close);

			const high = firstNumber(
				row.high,
				row.highPrice,
				row.high_prc,
				open,
				close,
			);

			const low = firstNumber(row.low, row.lowPrice, row.low_prc, open, close);

			const volume = firstNumber(
				row.volume,
				row.acc_trde_qty,
				row.tradeVolume,
				row.tradingVolume,
				0,
			);

			if (close == null || open == null || high == null || low == null) {
				return null;
			}

			return {
				date: String(
					row.date ?? row.time ?? row.datetime ?? row.timestamp ?? index,
				),

				open,

				high: Math.max(high, open, close),

				low: Math.min(low, open, close),

				close,

				volume: Math.max(volume ?? 0, 0),
			};
		})
		.filter((item): item is CandlePoint => item != null);
}

async function fetchChartCandles(
	ticker: string,
	timeframe: ChartTimeframe,
	fallbackRows: AnyObj[],
): Promise<CandlePoint[]> {
	const apiFrame = timeframe;
	const encodedTicker = encodeURIComponent(ticker);
	const encodedFrame = encodeURIComponent(apiFrame);
	const raw = await tryJson<AnyObj>(
		[
			`/api/stocks/${encodedTicker}/chart?tf=${encodedFrame}`,
			`/api/stocks/${encodedTicker}/candles?tf=${encodedFrame}`,
			`/api/stocks/${encodedTicker}/candles?timeframe=${encodedFrame}`,
			`/api/candles?ticker=${encodedTicker}&tf=${encodedFrame}`,
		],
		{},
	);

	const rows = Array.isArray(raw?.candles)
		? raw.candles
		: Array.isArray(raw?.data?.candles)
			? raw.data.candles
			: Array.isArray(raw?.items)
				? raw.items
				: Array.isArray(raw)
					? raw
					: [];

	const normalized = normalizeCandles(rows);

	if (normalized.length >= 2) {
		return normalized;
	}

	// 다른 주기의 일봉을 분봉처럼 보여주면 실제 봉처럼 오해할 수 있으므로,
	// 초기 상세 조회와 같은 1일봉일 때만 기존 데이터를 사용합니다.
	return timeframe === "1D" ? normalizeCandles(fallbackRows) : [];
}

function sma(values: number[], period: number): number | null {
	if (period <= 0 || values.length < period) {
		return null;
	}

	const selected = values.slice(-period);

	return selected.reduce((sum, value) => sum + value, 0) / period;
}

function ema(values: number[], period: number): number | null {
	if (period <= 0 || values.length < period) {
		return null;
	}

	const multiplier = 2 / (period + 1);

	let result =
		values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;

	for (let index = period; index < values.length; index += 1) {
		result = (values[index] - result) * multiplier + result;
	}

	return result;
}

function calculateRsi(values: number[], period = 14): number | null {
	if (values.length <= period) {
		return null;
	}

	const changes = values
		.slice(1)
		.map((value, index) => value - values[index])
		.slice(-period);

	const gain =
		changes.reduce((sum, value) => sum + Math.max(value, 0), 0) / period;

	const loss =
		changes.reduce((sum, value) => sum + Math.max(-value, 0), 0) / period;

	if (loss === 0) {
		return 100;
	}

	return 100 - 100 / (1 + gain / loss);
}

function calculateChartStats(candles: CandlePoint[]): ChartStats {
	const closes = candles.map((item) => item.close);

	const volumes = candles.map((item) => item.volume);

	const sma5 = sma(closes, 5);

	const sma20 = sma(closes, 20);

	const rsi = calculateRsi(closes);

	const ema12 = ema(closes, 12);

	const ema26 = ema(closes, 26);

	const macd = ema12 != null && ema26 != null ? ema12 - ema26 : null;

	const macdSeries: number[] = [];

	for (let index = 26; index <= closes.length; index += 1) {
		const slice = closes.slice(0, index);

		const fast = ema(slice, 12);

		const slow = ema(slice, 26);

		if (fast != null && slow != null) {
			macdSeries.push(fast - slow);
		}
	}

	const macdSignal = ema(macdSeries, 9);

	const latestVolume = volumes.length ? volumes[volumes.length - 1] : null;

	const volumePeriod = Math.min(20, volumes.length);

	const averageVolume = volumePeriod > 0 ? sma(volumes, volumePeriod) : null;

	const volumeRatio =
		latestVolume != null && averageVolume != null && averageVolume > 0
			? latestVolume / averageVolume
			: null;

	const latestClose = closes.length ? closes[closes.length - 1] : null;

	let trend = "확인 중";

	if (latestClose != null && sma5 != null && sma20 != null) {
		if (latestClose > sma5 && sma5 > sma20) {
			trend = "상승 우위";
		} else if (latestClose < sma5 && sma5 < sma20) {
			trend = "하락 우위";
		} else {
			trend = "혼조";
		}
	}

	return {
		rsi,
		macd,
		macdSignal,
		sma5,
		sma20,
		volumeRatio,
		trend,
	};
}

function financialRows(
	financials: AnyObj | null,
	period: FinancialPeriod,
): AnyObj[] {
	let rows: AnyObj[] = [];

	if (Array.isArray(financials?.[period])) {
		rows = financials[period];
	} else if (period === "annual" && Array.isArray(financials?.yearly)) {
		rows = financials.yearly;
	} else if (period === "quarterly" && Array.isArray(financials?.quarters)) {
		rows = financials.quarters;
	} else if (Array.isArray(financials?.rows)) {
		rows = financials.rows;
	}

	return [...rows].sort((a, b) =>
		String(b.period ?? b.date ?? b.year ?? "").localeCompare(
			String(a.period ?? a.date ?? a.year ?? ""),
		),
	);
}

function evaluateFinancialMetric(
	key: FinancialMetricKey,
	value: number | null,
): FinancialMetric {
	const labelMap: Record<FinancialMetricKey, string> = {
		roe: "ROE",

		pbr: "PBR",

		per: "PER",

		psr: "PSR",
	};

	const meaningMap: Record<FinancialMetricKey, string> = {
		roe: "ROE는 주주 자본으로 얼마나 많은 이익을 냈는지 보여주는 수익성 지표입니다.",

		pbr: "PBR은 주가가 기업의 순자산 가치보다 몇 배에 거래되는지 보여줍니다.",

		per: "PER은 현재 주가가 연간 순이익의 몇 배인지 보여줍니다.",

		psr: "PSR은 시가총액이 연간 매출의 몇 배인지 보여줍니다.",
	};

	if (value == null) {
		return {
			key,

			label: labelMap[key],

			valueText: "확인 필요",

			status: "데이터 없음",

			tone: "neutral",

			meaning: meaningMap[key],

			interpretation: "현재 데이터가 없어 정확한 판단이 어렵습니다.",

			caution: "한 지표만 보지 말고 실적과 현금흐름을 함께 확인해야 합니다.",
		};
	}

	if (key === "roe") {
		const status = value < 5 ? "낮음" : value < 15 ? "보통" : "높음";

		return {
			key,

			label: "ROE",

			valueText: `${value.toFixed(1)}%`,

			status,

			tone:
				status === "높음"
					? "positive"
					: status === "낮음"
						? "negative"
						: "neutral",

			meaning: meaningMap[key],

			interpretation:
				value < 0
					? "ROE가 마이너스라 현재 수익성이 부진합니다."
					: `자기자본 대비 수익성이 ${status} 수준입니다.`,

			caution: "부채가 많으면 ROE가 과도하게 높아질 수 있습니다.",
		};
	}

	const lowLimit = key === "per" ? 10 : 1;

	const highLimit = key === "per" ? 25 : 3;

	const status =
		key === "per" && value <= 0
			? "적자"
			: value <= lowLimit
				? "낮음"
				: value <= highLimit
					? "보통"
					: "높음";

	return {
		key,

		label: labelMap[key],

		valueText: `${value.toFixed(key === "per" ? 1 : 2)}배`,

		status,

		tone:
			status === "낮음"
				? "positive"
				: status === "높음" || status === "적자"
					? "negative"
					: "neutral",

		meaning: meaningMap[key],

		interpretation:
			status === "낮음"
				? "현재 평가배수가 낮은 편입니다."
				: status === "높음"
					? "현재 평가배수가 높은 편입니다."
					: status === "적자"
						? "적자로 정상적인 PER 평가가 어렵습니다."
						: "현재 평가배수가 보통 수준입니다.",

		caution: "업종 평균과 성장률, 이익 추세를 함께 비교해야 합니다.",
	};
}

function safeUrl(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) {
		return null;
	}

	try {
		const url = new URL(value.trim());

		return url.protocol === "http:" || url.protocol === "https:"
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

function digits(value: unknown): string {
	return String(value ?? "").replace(/\D/g, "");
}

function normalizeAccession(value: unknown): string | null {
	const number = digits(value);

	if (number.length !== 18) {
		return null;
	}

	return `${number.slice(0, 10)}-${number.slice(10, 12)}-${number.slice(12)}`;
}

function filingOriginalUrl(item: AnyObj, market: Market): string | null {
	if (market === "KR") {
		const directCandidates = [
			item.dartUrl,
			item.dart_url,
			item.originalUrl,
			item.original_url,
			item.url,
			item.link,
		];

		for (const candidate of directCandidates) {
			const url = safeUrl(candidate);

			if (url?.includes("dart.fss.or.kr")) {
				return url;
			}
		}

		const receipt = digits(item.rcept_no ?? item.rceptNo ?? item.receiptNo);

		return receipt.length === 14
			? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${receipt}`
			: null;
	}

	const directCandidates = [
		item.secUrl,
		item.sec_url,
		item.filingUrl,
		item.filing_url,
		item.originalUrl,
		item.original_url,
		item.url,
		item.link,
	];

	for (const candidate of directCandidates) {
		const url = safeUrl(candidate);

		if (url?.includes("sec.gov")) {
			return url;
		}
	}

	const accession = normalizeAccession(
		item.accessionNumber ??
			item.accession_number ??
			item.accessionNo ??
			item.accession_no,
	);

	const cikDigits = digits(
		item.cik ?? item.cikNumber ?? item.companyCik ?? item.company_cik,
	);

	if (!accession || !cikDigits) {
		return null;
	}

	const cik = String(Number(cikDigits));

	if (cik === "NaN") {
		return null;
	}

	return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(
		/-/g,
		"",
	)}/${accession}-index.html`;
}

function articleOriginalUrl(item: AnyObj): string | null {
	const candidates = [
		item.url,
		item.link,
		item.articleUrl,
		item.article_url,
		item.originalUrl,
		item.original_url,
		item.sourceUrl,
	];

	for (const candidate of candidates) {
		const url = safeUrl(candidate);

		if (url) {
			return url;
		}
	}

	return null;
}

function scoreTone(score: number): string {
	if (score >= 70) {
		return "text-positive";
	}

	if (score < 45) {
		return "text-destructive";
	}

	return "text-foreground";
}

function opinionTone(opinion: string): string {
	if (/매수|buy/i.test(opinion)) {
		return "text-positive";
	}

	if (/매도|sell/i.test(opinion)) {
		return "text-destructive";
	}

	return "text-foreground";
}

function riskTone(risk: RiskLabel): string {
	if (risk === "낮음") {
		return "text-positive";
	}

	if (risk === "높음" || risk === "매우 높음") {
		return "text-destructive";
	}

	return "text-foreground";
}

function metricBorder(tone: Tone): string {
	if (tone === "positive") {
		return "border-positive/30 bg-positive/5";
	}

	if (tone === "negative") {
		return "border-destructive/30 bg-destructive/5";
	}

	return "border-card-border bg-secondary/50";
}

function metricText(tone: Tone): string {
	if (tone === "positive") {
		return "text-positive";
	}

	if (tone === "negative") {
		return "text-destructive";
	}

	return "text-primary";
}

function detailTabFromUrl(): DetailTab {
	const raw = new URLSearchParams(window.location.search).get("tab");
	if (raw === "financial") return "financials";

	return TABS.some((item) => item.key === raw)
		? (raw as DetailTab)
		: "overview";
}

export default function DetailPage() {
	const [, params] = useRoute("/stock/:ticker") as [
		boolean,
		{
			ticker?: string;
		} | null,
	];

	const [, navigate] = useLocation();

	const ticker = String(params?.ticker ?? "").toUpperCase();
	const studyId = new URLSearchParams(window.location.search).get("study");

	const [tab, setTab] = useState<DetailTab>(() => detailTabFromUrl());

	const [watched, setWatched] = useState(() => isInWatchlist(ticker));

	const detail = useQuery<DetailData>({
		queryKey: ["stock-detail-v13", ticker],

		queryFn: () => fetchDetail(ticker),

		enabled: Boolean(ticker),

		staleTime: 60_000,

		gcTime: 10 * 60_000,

		refetchOnWindowFocus: false,
	});

	const data = detail.data;

	const market = marketOf(ticker, data?.quote, data?.company);

	const currency = currencyOf(market, data?.quote);

	const companyName = displayStockName(
		ticker,

		String(
			data?.company?.name ??
				data?.quote?.name ??
				data?.company?.companyName ??
				ticker,
		),

		market,
	);

	const insights = useMemo(
		() =>
			buildAiInsights({
				ticker,

				name: companyName,

				market,
				currency,

				quote: data?.quote,

				financials: data?.financials,

				risk: data?.risk,

				news: data?.news ?? [],

				filings: data?.filings ?? [],

				candles: data?.candles ?? [],
			}),
		[ticker, companyName, market, currency, data],
	);

	const currentPrice = toNumber(data?.quote?.price);

	const metrics = useMemo(
		() =>
			buildCoreMetrics({
				market,
				currentPrice,

				score: insights.score,

				opinion: insights.opinion,

				classification: insights.classification,

				quote: data?.quote ?? null,

				company: data?.company ?? null,

				financials: data?.financials ?? null,

				risk: data?.risk ?? null,
			}),
		[market, currentPrice, insights, data],
	);

	const changePositive = (toNumber(data?.quote?.changePercent) ?? 0) >= 0;

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
			<header className="relative z-20 shrink-0 border-b border-card-border bg-background px-3 pb-2 pt-3">
				<div className="grid grid-cols-[36px_minmax(0,1fr)_auto_36px] items-center gap-2">
					<button
						type="button"
						aria-label="뒤로가기"
						onClick={() => navigate(currentBackPath())}
						className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card text-xl font-bold"
					>
						‹
					</button>

					<div className="min-w-0">
						<div className="flex min-w-0 items-center gap-2">
							<h1 className="truncate text-lg font-extrabold">{companyName}</h1>

							<span
								className={cn(
									"shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-extrabold",

									stockClassBadgeClass(insights.classification.label),
								)}
							>
								{insights.classification.label}
							</span>
						</div>

						<p className="mt-0.5 text-[11px] font-bold text-muted-foreground">
							{ticker}
						</p>
					</div>

					<div className="shrink-0 text-right">
						<p className="text-base font-extrabold">
							{formatAppPrice(data?.quote?.price, currency)}
						</p>

						<p
							className={cn(
								"mt-0.5 text-xs font-extrabold",

								changePositive ? "text-positive" : "text-destructive",
							)}
						>
							{formatAppPercent(data?.quote?.changePercent)}
						</p>
					</div>

					<button
						type="button"
						aria-label="관심종목"
						onClick={() =>
							setWatched(
								toggleWatchlistItem({
									ticker,

									name: companyName,

									market,
									currency,
								}),
							)
						}
						className={cn(
							"flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card text-xl",

							watched ? "text-yellow-400" : "text-muted-foreground",
						)}
					>
						{watched ? "★" : "☆"}
					</button>
				</div>

				<div className="mt-2 grid grid-cols-6 gap-1">
					{TABS.map((item) => (
						<button
							key={item.key}
							type="button"
							onClick={() => setTab(item.key)}
							className={cn(
								"flex min-h-9 min-w-0 items-center justify-center break-keep rounded-xl border px-0.5 py-2 text-center text-[9px] font-extrabold leading-4",

								tab === item.key
									? "border-primary bg-primary text-primary-foreground"
									: "border-card-border bg-card text-muted-foreground",
							)}
						>
							{item.label}
						</button>
					))}
				</div>
			</header>

			<main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-28 pt-3">
				{detail.isLoading && (
					<CenterMessage>종목 데이터를 불러오는 중...</CenterMessage>
				)}

				{detail.isError && (
					<CenterMessage error>
						종목 데이터를 불러오지 못했습니다.
					</CenterMessage>
				)}

				{data && tab === "overview" && (
					<OverviewTab
						name={companyName}
						market={market}
						currency={currency}
						data={data}
						insights={insights}
						metrics={metrics}
					/>
				)}

				{data && tab === "ai" && (
					<AiTab
						market={market}
						currency={currency}
						currentPrice={currentPrice}
						insights={insights}
						metrics={metrics}
					/>
				)}

				{data && tab === "chart" && (
					<ChartTab
						ticker={ticker}
						fallbackRows={data.candles}
						insights={insights}
						currentPrice={currentPrice}
						currency={currency}
						studyId={studyId}
					/>
				)}

				{data && tab === "financials" && (
					<FinancialTab financials={data.financials} currency={currency} />
				)}

				{data && tab === "filings" && (
					<FilingTab
						market={market}
						filings={data.filings}
						summary={insights.disclosureAiSummary}
					/>
				)}

				{data && tab === "news" && (
					<NewsTab news={data.news} summary={insights.newsAiSummary} />
				)}
			</main>

			<BottomNav />
		</div>
	);
}

function CenterMessage({
	children,
	error = false,
}: {
	children: ReactNode;
	error?: boolean;
}) {
	return (
		<div className="flex min-h-[50vh] items-center justify-center">
			<p
				className={cn(
					"text-center text-sm font-bold",

					error ? "text-destructive" : "text-muted-foreground",
				)}
			>
				{children}
			</p>
		</div>
	);
}

function SectionCard({
	title,
	subtitle,
	actions,
	children,
}: {
	title: string;
	subtitle?: string;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="rounded-2xl border border-card-border bg-card shadow-sm">
			<div className="flex items-start justify-between gap-3 border-b border-card-border px-4 py-3">
				<div className="min-w-0">
					<h2 className="break-keep text-base font-extrabold leading-6">{title}</h2>

					{subtitle && (
						<p className="mt-0.5 break-keep text-[11px] font-bold leading-5 text-muted-foreground">
							{subtitle}
						</p>
					)}
				</div>

				{actions && <div className="shrink-0">{actions}</div>}
			</div>

			<div className="p-3">{children}</div>
		</section>
	);
}

function OverviewTab({
	name,
	market,
	currency,
	data,
	insights,
	metrics,
}: {
	name: string;
	market: Market;
	currency: Currency;
	data: DetailData;
	insights: ReturnType<typeof buildAiInsights>;
	metrics: CoreMetrics;
}) {
	const description = firstText(
		data.company?.description,
		data.company?.businessSummary,
		data.company?.overview,
		data.company?.summary,
		data.company?.companyDescription,
	);

	const marketCap = firstNumber(
		data.quote?.marketCap,
		data.quote?.market_cap,
		data.quote?.marketCapitalization,
		data.company?.marketCap,
		data.financials?.marketCap,
	);

	return (
		<div className="flex flex-col gap-3">
			<SectionCard title="개요">
				<div className="flex items-center justify-between gap-2">
					<div className="flex min-w-0 items-center gap-2">
						<p className="truncate text-base font-extrabold">{name}</p>
						<span className="shrink-0 rounded-full bg-secondary/70 px-2.5 py-1 text-[10px] font-extrabold text-muted-foreground">
							시총 {formatCompactMoney(marketCap, currency)}
						</span>
					</div>
				</div>

				<div className="mt-3 rounded-xl bg-secondary/60 px-3 py-3">
					<p className="text-[10px] font-extrabold text-primary">
						어떤 회사인가요?
					</p>

					<p className="mt-1 break-keep text-xs font-semibold leading-5 text-muted-foreground">
						{description
							? translateMarketText(description)
							: `${name}은(는) ${
									market === "US" ? "미국" : "대한민국"
								}에 상장된 기업입니다.`}
					</p>
				</div>
			</SectionCard>

			<SectionCard title="AI 간단요약" subtitle="현재 데이터 기준 참고용 분석">
				<div className="grid grid-cols-3 gap-2">
					<MiniMetric
						label="AI 점수"
						value={`${Math.round(insights.score)}점`}
						valueClassName={scoreTone(insights.score)}
					/>

					<MiniMetric
						label="의견"
						value={insights.opinion || "관망"}
						valueClassName={opinionTone(insights.opinion)}
					/>

					<MiniMetric
						label="위험도"
						value={metrics.riskLabel}
						valueClassName={riskTone(metrics.riskLabel)}
					/>
				</div>

				<div className="mt-2 grid grid-cols-3 gap-2">
					<MiniMetric
						label="적정가"
						value={formatAppPrice(metrics.fairPrice, currency)}
						valueClassName="text-primary"
					/>

					<MiniMetric
						label="목표가"
						value={formatAppPrice(metrics.targetPrice, currency)}
						valueClassName="text-positive"
					/>

					<MiniMetric
						label="손절가"
						value={formatAppPrice(metrics.stopPrice, currency)}
						valueClassName="text-destructive"
					/>
				</div>

				<p className="mb-1 mt-3 text-[10px] font-extrabold">핵심 투자 포인트</p>

				<div className="space-y-2">
					<SignalBox label="호재" text={positiveSummary(insights)} positive />

					<SignalBox label="악재" text={negativeSummary(insights)} />
					<SignalBox
						label="리스크"
						text={insights.riskSummary?.[0] ?? metrics.riskCaption}
					/>
				</div>
			</SectionCard>
		</div>
	);
}

function AiTab({
	market,
	currency,
	currentPrice,
	insights,
	metrics,
}: {
	market: Market;
	currency: Currency;
	currentPrice: number | null;
	insights: ReturnType<typeof buildAiInsights>;
	metrics: CoreMetrics;
}) {
	const [selectedPlan, setSelectedPlan] = useState<{
		label: string;
		value: string;
		reason: string;
		checklist: string[];
	} | null>(null);
	const [openSections, setOpenSections] = useState({
		chart: false,
		financial: false,
		news: false,
		plan: false,
	});

	const toggleSection = (key: keyof typeof openSections) =>
		setOpenSections((current) => ({
			...current,
			[key]: !current[key],
		}));

	const firstEntry =
		currentPrice != null ? roundPrice(currentPrice * 0.965, market) : null;

	const secondEntry =
		currentPrice != null ? roundPrice(currentPrice * 0.925, market) : null;

	const thirdEntry =
		currentPrice != null ? roundPrice(currentPrice * 0.88, market) : null;

	const planRows = [
		{
			label: "1차 진입 · 30%",
			value: formatAppPrice(firstEntry, currency),
			reason: `현재가의 약 3.5% 아래 첫 눌림 구간입니다. ${insights.chartSummary?.[0] ?? "일봉이 5일 이동평균선을 지지하거나 다시 돌파하는지 확인한 뒤 소액으로 시작합니다."}`,
			checklist: [
				"일봉 종가가 5일 이동평균선 위에서 마감하는지 확인",
				"하락할 때 거래량이 줄고 반등할 때 늘어나는지 확인",
				"한 번에 전액 매수하지 않고 예정 자금의 30%만 진입",
			],
			negative: false,
		},
		{
			label: "2차 진입 · 30%",
			value: formatAppPrice(secondEntry, currency),
			reason:
				"현재가의 약 7.5% 아래 두 번째 지지 후보입니다. 20일 이동평균선 또는 이전 저점에서 반등이 확인될 때만 추가 진입합니다.",
			checklist: [
				"20일선이나 최근 저점 부근에서 긴 아래꼬리 또는 양봉 확인",
				"RSI가 과매도 구간에서 위로 방향을 바꾸는지 확인",
				"악재 공시나 실적 전망 하향이 없는지 다시 확인",
			],
			negative: false,
		},
		{
			label: "3차 진입 · 20%",
			value: formatAppPrice(thirdEntry, currency),
			reason:
				"급락 뒤 기술적 반등을 노리는 마지막 분할 구간입니다. 가격이 싸다는 이유만으로 매수하지 않고 추세 전환 신호가 나올 때만 진입합니다.",
			checklist: [
				"전일 고가 돌파 또는 5일선 재돌파 확인",
				"MACD 하락 폭 축소와 거래량 회복 확인",
				"신호가 없으면 3차 진입은 취소하고 현금을 보유",
			],
			negative: false,
		},
		{
			label: "손절 기준",
			value: formatAppPrice(metrics.stopPrice, currency),
			reason:
				"이 가격 아래에서 일봉이 마감하면 지지선이 무너져 기존 상승 시나리오가 틀렸을 가능성이 커집니다. 물타기보다 위험 축소를 우선합니다.",
			checklist: [
				"장중 순간 이탈보다 일봉 종가 기준으로 판단",
				"대량 거래를 동반한 이탈이면 더 빠르게 위험 축소",
				"손실을 만회하려고 계획 없는 추가 매수 금지",
			],
			negative: true,
		},
		{
			label: "목표가 · 분할매도",
			value: formatAppPrice(metrics.targetPrice, currency),
			reason:
				"목표가에 한 번에 모두 매도하지 않고 상승 강도와 거래량을 보며 나누어 이익을 확정합니다.",
			checklist: [
				"목표가의 95% 부근에서 30% 이익 실현 검토",
				"목표가 도달 시 추가 40% 이익 실현 검토",
				"나머지는 5일선 이탈 전까지 추세를 따라가기",
			],
			negative: false,
		},
	];

	return (
		<div className="space-y-3">
			<SectionCard title="AI 종합 판단" subtitle="현재 데이터 기준">
				<div className="grid grid-cols-3 gap-2">
					<MiniMetric
						label="AI 점수"
						value={`${Math.round(insights.score)}점`}
						valueClassName={scoreTone(insights.score)}
					/>

					<MiniMetric
						label="AI 의견"
						value={insights.opinion || "관망"}
						valueClassName={opinionTone(insights.opinion)}
					/>

					<MiniMetric
						label="위험도"
						value={metrics.riskLabel}
						valueClassName={riskTone(metrics.riskLabel)}
					/>
				</div>

				<InfoBox>{insights.opinionReason}</InfoBox>
			</SectionCard>

			<CollapsibleSection
				title="차트"
				open={openSections.chart}
				onToggle={() => toggleSection("chart")}
			>
				<SummaryItems items={insights.chartSummary} />
			</CollapsibleSection>

			<CollapsibleSection
				title="재무"
				open={openSections.financial}
				onToggle={() => toggleSection("financial")}
			>
				<SummaryItems items={insights.financialSummary} />
			</CollapsibleSection>

			<CollapsibleSection
				title="최근 소식"
				open={openSections.news}
				onToggle={() => toggleSection("news")}
			>
				<div className="space-y-2">
					<SignalBox label="호재" text={positiveSummary(insights)} positive />

					<SignalBox label="악재" text={negativeSummary(insights)} />
				</div>
			</CollapsibleSection>

			<CollapsibleSection
				title="AI 진입 계획"
				open={openSections.plan}
				onToggle={() => toggleSection("plan")}
			>
				<p className="mb-2 text-[10px] font-bold text-muted-foreground">
					각 계획을 누르면 진입 근거와 확인 조건이 열립니다
				</p>
				<div className="space-y-2">
					{planRows.map((plan) => (
						<PlanRow
							key={plan.label}
							label={plan.label}
							value={plan.value}
							negative={plan.negative}
							onClick={() => setSelectedPlan(plan)}
						/>
					))}
				</div>
			</CollapsibleSection>

			{selectedPlan && (
				<Modal
					title={selectedPlan.label}
					subtitle={selectedPlan.value}
					onClose={() => setSelectedPlan(null)}
				>
					<p>{selectedPlan.reason}</p>
					<div className="mt-3 space-y-2">
						{selectedPlan.checklist.map((item, index) => (
							<div
								key={item}
								className="flex gap-2 rounded-xl bg-secondary/60 p-3"
							>
								<span className="font-extrabold text-primary">{index + 1}</span>
								<p>{item}</p>
							</div>
						))}
					</div>
				</Modal>
			)}
		</div>
	);
}

function ChartTab({
	ticker,
	fallbackRows,
	insights,
	currentPrice,
	currency,
	studyId,
}: {
	ticker: string;
	fallbackRows: AnyObj[];
	insights: ReturnType<typeof buildAiInsights>;
	currentPrice: number | null;
	currency: Currency;
	studyId: string | null;
}) {
	const [timeframe, setTimeframe] = useState<ChartTimeframe>("1D");

	const [explanation, setExplanation] = useState<{
		title: string;
		text: string;
	} | null>(null);

	const [settingsOpen, setSettingsOpen] = useState(false);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [technicalOpen, setTechnicalOpen] = useState(true);
	const [summaryOpen, setSummaryOpen] = useState(true);
	const [indicators, setIndicators] = useState<ChartIndicatorSettings>({
		...DEFAULT_CHART_INDICATORS,
	});
	const chartShellRef = useRef<HTMLDivElement | null>(null);
	const [portfolioOverlay, setPortfolioOverlay] =
		useState<PortfolioChartOverlay | null>(() =>
			getPortfolioChartOverlay(ticker),
		);
	const [autoSignal, setAutoSignal] = useState(() =>
		getAutoTradeSignal(ticker),
	);
	const studyFocus = useMemo(() => getStudyChartFocus(studyId), [studyId]);

	useEffect(() => {
		const refresh = () => {
			setPortfolioOverlay(getPortfolioChartOverlay(ticker));
			setAutoSignal(getAutoTradeSignal(ticker));
		};

		refresh();
		window.addEventListener("storage", refresh);
		window.addEventListener("sa-portfolio-overlay-updated", refresh);
		window.addEventListener("sa-auto-trade-updated", refresh);

		return () => {
			window.removeEventListener("storage", refresh);
			window.removeEventListener("sa-portfolio-overlay-updated", refresh);
			window.removeEventListener("sa-auto-trade-updated", refresh);
		};
	}, [ticker]);

	useEffect(() => {
		if (!studyFocus?.preferredIndicator) return;

		setIndicators((current) => {
			const next = { ...current };
			if (studyFocus.preferredIndicator === "rsi") next.rsi = true;
			if (studyFocus.preferredIndicator === "macd") next.macd = true;
			if (studyFocus.preferredIndicator === "bollinger") next.bollinger = true;
			if (studyFocus.preferredIndicator === "volume") next.volume = true;
			if (studyFocus.preferredIndicator === "moving-average") {
				next.sma20 = true;
				next.sma60 = true;
			}
			return next;
		});
	}, [studyFocus?.id]);

	useEffect(() => {
		const handleFullscreenChange = () => {
			const shell = chartShellRef.current;
			const active = Boolean(shell && document.fullscreenElement === shell);

			if (!active && document.fullscreenElement == null) {
				setIsFullscreen(false);
			}
		};

		document.addEventListener("fullscreenchange", handleFullscreenChange);

		return () => {
			document.removeEventListener("fullscreenchange", handleFullscreenChange);
		};
	}, []);

	useEffect(() => {
		if (!isFullscreen) return;

		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		return () => {
			document.body.style.overflow = previousOverflow;
		};
	}, [isFullscreen]);

	async function toggleFullscreen() {
		const shell = chartShellRef.current;
		if (!shell) return;

		if (document.fullscreenElement === shell) {
			await document.exitFullscreen().catch(() => undefined);
			setIsFullscreen(false);

			const orientation = window.screen.orientation as
				| (ScreenOrientation & { unlock?: () => void })
				| undefined;
			orientation?.unlock?.();
			return;
		}

		try {
			await shell.requestFullscreen();
			setIsFullscreen(true);

			const orientation = window.screen.orientation as
				| (ScreenOrientation & {
						lock?: (mode: string) => Promise<void>;
					})
				| undefined;
			void orientation?.lock?.("landscape").catch(() => undefined);
		} catch {
			// 일부 모바일 브라우저/PWA는 Fullscreen API를 막습니다.
			// 이 경우 CSS 전체화면으로 동일하게 동작시킵니다.
			setIsFullscreen((current) => !current);
		}
	}

	const chartQuery = useQuery<CandlePoint[]>({
		queryKey: ["detail-chart-v9", ticker, timeframe],

		queryFn: () => fetchChartCandles(ticker, timeframe, fallbackRows),

		enabled: Boolean(ticker),

		staleTime: timeframe.endsWith("m") ? 5_000 : 30_000,

		gcTime: 5 * 60_000,

		refetchInterval: timeframe.endsWith("m") ? 5_000 : 30_000,

		refetchIntervalInBackground: true,

		refetchOnWindowFocus: true,
	});

	const candles =
		chartQuery.data ??
		(timeframe === "1D" ? normalizeCandles(fallbackRows) : []);

	const stats = useMemo(() => calculateChartStats(candles), [candles]);

	const recent = candles.slice(-20);
	const latest = recent[recent.length - 1];
	const previous = recent[recent.length - 2];
	const recentHigh = recent.length
		? Math.max(...recent.slice(0, -1).map((item) => item.high))
		: null;
	const recentLow = recent.length
		? Math.min(...recent.map((item) => item.low))
		: null;
	const stochastic =
		latest &&
		recentHigh != null &&
		recentLow != null &&
		recentHigh !== recentLow
			? ((latest.close - recentLow) / (recentHigh - recentLow)) * 100
			: null;
	const momentum =
		latest && candles.length > 5
			? (latest.close / candles[candles.length - 6].close - 1) * 100
			: null;
	const close20 = recent.map((item) => item.close);
	const average20 = close20.length
		? close20.reduce((sum, value) => sum + value, 0) / close20.length
		: null;
	const standardDeviation =
		average20 != null && close20.length
			? Math.sqrt(
					close20.reduce(
						(sum, value) => sum + Math.pow(value - average20, 2),
						0,
					) / close20.length,
				)
			: null;
	const bollingerPosition =
		latest &&
		average20 != null &&
		standardDeviation != null &&
		standardDeviation > 0
			? ((latest.close - (average20 - standardDeviation * 2)) /
					(standardDeviation * 4)) *
				100
			: null;
	const trueRanges = recent
		.slice(1)
		.map((item, index) =>
			Math.max(
				item.high - item.low,
				Math.abs(item.high - recent[index].close),
				Math.abs(item.low - recent[index].close),
			),
		);
	const atr = trueRanges.length
		? trueRanges.slice(-14).reduce((sum, value) => sum + value, 0) /
			Math.min(14, trueRanges.length)
		: null;
	const typicalPrices = recent.map(
		(item) => (item.high + item.low + item.close) / 3,
	);
	const typicalAverage = typicalPrices.length
		? typicalPrices.reduce((sum, value) => sum + value, 0) /
			typicalPrices.length
		: null;
	const meanDeviation =
		typicalAverage != null && typicalPrices.length
			? typicalPrices.reduce(
					(sum, value) => sum + Math.abs(value - typicalAverage),
					0,
				) / typicalPrices.length
			: null;
	const cci =
		latest &&
		typicalAverage != null &&
		meanDeviation != null &&
		meanDeviation > 0
			? ((latest.high + latest.low + latest.close) / 3 - typicalAverage) /
				(0.015 * meanDeviation)
			: null;
	const williamsR = stochastic != null ? stochastic - 100 : null;
	const roc10 =
		latest && candles.length > 10
			? (latest.close / candles[candles.length - 11].close - 1) * 100
			: null;
	const obvPulse = recent.slice(1).reduce((sum, item, index) => {
		if (item.close > recent[index].close) return sum + item.volume;
		if (item.close < recent[index].close) return sum - item.volume;
		return sum;
	}, 0);
	const averageClose = (period: number) =>
		candles.length >= period
			? candles.slice(-period).reduce((sum, item) => sum + item.close, 0) /
				period
			: null;
	const sma60Value = averageClose(60);
	const sma120Value = averageClose(120);
	const enabledIndicatorPanels = [
		indicators.rsi && {
			label: "RSI",
			value: stats.rsi != null ? stats.rsi.toFixed(1) : "-",
		},
		indicators.macd && {
			label: "MACD",
			value: stats.macd != null ? stats.macd.toFixed(2) : "-",
		},
		indicators.stochastic && {
			label: "스토캐스틱",
			value: stochastic != null ? stochastic.toFixed(1) : "-",
		},
		indicators.ichimoku && { label: "일목균형표", value: stats.trend },
		indicators.atr && {
			label: "ATR",
			value: atr != null ? atr.toFixed(2) : "-",
		},
		indicators.cci && {
			label: "CCI",
			value: cci != null ? cci.toFixed(0) : "-",
		},
		indicators.obv && {
			label: "OBV",
			value: obvPulse > 0 ? "매수 우위" : obvPulse < 0 ? "매도 우위" : "중립",
		},
		indicators.williamsR && {
			label: "Williams %R",
			value: williamsR != null ? williamsR.toFixed(1) : "-",
		},
		indicators.roc && {
			label: "ROC",
			value:
				roc10 != null ? `${roc10 >= 0 ? "+" : ""}${roc10.toFixed(1)}%` : "-",
		},
	].filter(Boolean) as { label: string; value: string }[];

	const signals = [
		{
			title:
				stats.rsi == null
					? "RSI 확인 중"
					: stats.rsi <= 30
						? "RSI 과매도"
						: stats.rsi >= 70
							? "RSI 과매수"
							: "RSI 중립",

			value: stats.rsi != null ? stats.rsi.toFixed(1) : "-",

			text: "RSI는 단기 과열과 침체 정도를 보여주는 지표입니다.",
			active: stats.rsi != null && (stats.rsi <= 30 || stats.rsi >= 70),
		},

		{
			title:
				stats.macd == null
					? "MACD 확인 중"
					: stats.macdSignal != null && stats.macd >= stats.macdSignal
						? "MACD 상승 우위"
						: "MACD 약세 우위",

			value: stats.macd != null ? stats.macd.toFixed(2) : "-",

			text: "MACD는 단기 추세와 전환 가능성을 확인하는 지표입니다.",
			active:
				stats.macd != null &&
				stats.macdSignal != null &&
				stats.macd >= stats.macdSignal,
		},

		{
			title: "이동평균선 (5·20·60·120)",

			value:
				latest && sma60Value != null
					? latest.close >= sma60Value
						? "60일선 위"
						: "60일선 아래"
					: stats.trend,

			text: `5·20일선은 단기, 60일선은 중기, 120일선은 장기 추세를 봅니다.${sma120Value != null && latest ? ` 현재가는 120일선 ${latest.close >= sma120Value ? "위" : "아래"}입니다.` : ""}`,
			active: stats.trend === "상승 우위",
		},

		{
			title:
				stats.volumeRatio != null && stats.volumeRatio >= 1.5
					? "거래량 급증"
					: "거래량 상태",

			value:
				stats.volumeRatio != null ? `${stats.volumeRatio.toFixed(1)}배` : "-",

			text: "최근 거래량을 최근 20개 봉 평균과 비교한 값입니다.",
			active: stats.volumeRatio != null && stats.volumeRatio >= 1.5,
		},

		{
			title: "스토캐스틱",
			value: stochastic != null ? stochastic.toFixed(1) : "-",
			text: "최근 가격 범위에서 현재 종가의 위치를 보여줍니다. 20 이하는 과매도, 80 이상은 과매수 후보입니다.",
			active: stochastic != null && (stochastic <= 20 || stochastic >= 80),
		},

		{
			title: "5봉 모멘텀",
			value:
				momentum != null
					? `${momentum >= 0 ? "+" : ""}${momentum.toFixed(1)}%`
					: "-",
			text: "현재 가격을 5개 봉 전과 비교해 상승 또는 하락 속도를 확인합니다.",
			active: momentum != null && momentum > 2,
		},

		{
			title: "20봉 고점 돌파",
			value:
				latest && recentHigh != null && latest.close > recentHigh
					? "돌파"
					: "대기",
			text: "최근 20개 봉의 이전 고점을 종가로 넘어섰는지 확인하는 추세 신호입니다.",
			active: Boolean(
				latest && recentHigh != null && latest.close > recentHigh,
			),
		},

		{
			title: "양봉 전환",
			value:
				latest &&
				previous &&
				latest.close > latest.open &&
				previous.close <= previous.open
					? "발생"
					: "대기",
			text: "직전 음봉 뒤 현재 봉이 양봉으로 전환됐는지 보여주는 단기 반등 신호입니다.",
			active: Boolean(
				latest &&
					previous &&
					latest.close > latest.open &&
					previous.close <= previous.open,
			),
		},
		{
			title: "볼린저밴드 위치",
			value:
				bollingerPosition != null ? `${bollingerPosition.toFixed(0)}%` : "-",
			text: "현재 가격이 볼린저밴드 하단과 상단 사이 어디에 있는지 보여줍니다.",
			active:
				bollingerPosition != null &&
				(bollingerPosition <= 10 || bollingerPosition >= 90),
		},
		{
			title: "ATR 변동성",
			value:
				atr != null && latest
					? `${((atr / latest.close) * 100).toFixed(1)}%`
					: "-",
			text: "ATR은 최근 봉의 평균 가격 변동폭입니다. 높을수록 손절 폭을 넓게 잡아야 합니다.",
			active: Boolean(atr != null && latest && atr / latest.close >= 0.03),
		},
		{
			title: "CCI 추세 강도",
			value: cci != null ? cci.toFixed(0) : "-",
			text: "CCI는 평균 가격에서 얼마나 벗어났는지 보여줍니다. +100 이상은 강세, -100 이하는 약세 후보입니다.",
			active: cci != null && Math.abs(cci) >= 100,
		},
		{
			title: "Williams %R",
			value: williamsR != null ? williamsR.toFixed(1) : "-",
			text: "최근 고가와 저가 범위에서 현재 가격 위치를 확인합니다. -80 이하는 과매도 후보입니다.",
			active: williamsR != null && (williamsR <= -80 || williamsR >= -20),
		},
		{
			title: "10봉 ROC",
			value:
				roc10 != null ? `${roc10 >= 0 ? "+" : ""}${roc10.toFixed(1)}%` : "-",
			text: "10개 봉 전보다 가격이 얼마나 빠르게 상승하거나 하락했는지 보여줍니다.",
			active: roc10 != null && Math.abs(roc10) >= 5,
		},
		{
			title: "OBV 수급 방향",
			value: obvPulse > 0 ? "매수 우위" : obvPulse < 0 ? "매도 우위" : "중립",
			text: "상승일과 하락일의 거래량을 누적해 매수·매도 수급 방향을 추정합니다.",
			active: obvPulse > 0,
		},
	];

	const portfolioRate =
		portfolioOverlay && currentPrice != null && portfolioOverlay.averagePrice > 0
			? ((currentPrice - portfolioOverlay.averagePrice) /
					portfolioOverlay.averagePrice) *
				100
			: portfolioOverlay?.rate ?? null;

	return (
		<div className="space-y-3">
			{portfolioOverlay && (
				<SectionCard
					title="내 포트폴리오 기준"
					subtitle={`구매일 ${portfolioOverlay.purchaseDate} · 수량 ${portfolioOverlay.quantity.toLocaleString("ko-KR")}`}
				>
					<div className="grid grid-cols-2 gap-2">
						<div className="rounded-xl bg-secondary/70 p-3">
							<p className="text-[10px] font-bold text-muted-foreground">내 평단가</p>
							<p className="mt-1 text-sm font-extrabold">
								{formatAppPrice(portfolioOverlay.averagePrice, currency)}
							</p>
						</div>
						<div className="rounded-xl bg-secondary/70 p-3">
							<p className="text-[10px] font-bold text-muted-foreground">현재 수익률</p>
							<p
								className={cn(
									"mt-1 text-sm font-extrabold",
									(portfolioRate ?? 0) >= 0 ? "text-positive" : "text-destructive",
								)}
							>
								{portfolioRate == null
									? "확인 중"
									: `${portfolioRate >= 0 ? "+" : ""}${portfolioRate.toFixed(2)}%`}
							</p>
						</div>
					</div>
					<p className="mt-2 break-keep text-[11px] font-semibold leading-5 text-muted-foreground">
						차트의 ‘내 평단’ 점선과 현재가를 비교하면 손익 위치를 바로 확인할 수 있습니다.
					</p>
				</SectionCard>
			)}

			{autoSignal && (
				<SectionCard
					title={autoSignal.label}
					subtitle={`${autoSignal.candidate.rank}순위 · 조건 충족 확률 ${autoSignal.candidate.probability}%`}
				>
					<p className="break-keep text-sm font-semibold leading-6 text-muted-foreground">
						{autoSignal.candidate.reasons.join(" · ") || "선택 지표와 AI 점수 기준"} 조건으로 활성화되었습니다. 차트 최신 봉에 자동신호 위치와 손절·목표 기준선을 표시합니다.
					</p>
				</SectionCard>
			)}

			{studyFocus && (
				<SectionCard title={`주식공부 · ${studyFocus.title}`}>
					<p className="break-keep text-sm font-semibold leading-6 text-muted-foreground">
						{studyFocus.summary}
					</p>
				</SectionCard>
			)}

			<div
				ref={chartShellRef}
				className={cn(
					isFullscreen &&
						"fixed inset-0 z-[80] overflow-y-auto bg-background p-2 sm:p-4",
				)}
			>
				<SectionCard
					title="차트"
					actions={
						<div className="flex items-center gap-1.5">
							<button
								type="button"
								onClick={() => setSettingsOpen(true)}
								className="flex h-9 w-9 items-center justify-center rounded-xl border border-card-border bg-secondary text-foreground transition active:scale-95"
								aria-label="차트 설정"
								title="차트 설정"
							>
								<Settings2 className="h-4 w-4" />
							</button>

							<button
								type="button"
								onClick={() => void toggleFullscreen()}
								className="flex h-9 w-9 items-center justify-center rounded-xl border border-card-border bg-secondary text-foreground transition active:scale-95"
								aria-label={isFullscreen ? "전체화면 닫기" : "차트 전체화면"}
								title={isFullscreen ? "전체화면 닫기" : "전체화면"}
							>
								{isFullscreen ? (
									<Minimize2 className="h-4 w-4" />
								) : (
									<Maximize2 className="h-4 w-4" />
								)}
							</button>
						</div>
					}
				>
					<div className="mb-2 flex items-center justify-between gap-2 px-1">
						<span className="rounded-lg bg-primary/10 px-2 py-1 text-[10px] font-extrabold text-primary">
							{TIMEFRAMES.find((item) => item.key === timeframe)?.label ?? timeframe}
						</span>

						<span className="text-[10px] font-bold text-muted-foreground">
							{chartQuery.isFetching ? "실시간 갱신 중" : `${candles.length}개 봉`}
						</span>
					</div>

					<ProfessionalChart
						candles={candles}
						loading={chartQuery.isLoading}
						timeframe={timeframe}
						indicators={indicators}
						fullscreen={isFullscreen}
						portfolioOverlay={portfolioOverlay}
						autoSignal={autoSignal}
						studyFocus={studyFocus}
					/>

					{enabledIndicatorPanels.length > 0 && (
						<div className="mt-2 grid grid-cols-3 gap-2">
							{enabledIndicatorPanels.map((item) => (
								<div
									key={item.label}
									className="rounded-xl border border-card-border bg-secondary/60 p-2 text-center"
								>
									<p className="text-[9px] font-bold text-muted-foreground">
										{item.label}
									</p>
									<p className="mt-1 text-xs font-extrabold">{item.value}</p>
								</div>
							))}
						</div>
					)}

					<p className="mt-2 px-1 text-[10px] font-semibold leading-4 text-muted-foreground">
						차트를 드래그하면 이동하고, 두 손가락으로 확대·축소할 수 있습니다.
					</p>
				</SectionCard>

				{settingsOpen && (
				<Modal title="차트 설정" onClose={() => setSettingsOpen(false)}>
					<p className="mb-2 text-xs font-extrabold text-foreground">봉 주기</p>
					<div className="grid grid-cols-3 gap-2 rounded-xl border border-card-border p-2">
						{TIMEFRAMES.map((item) => (
							<button
								key={item.key}
								type="button"
								onClick={() => setTimeframe(item.key)}
								className={cn(
									"rounded-xl px-2 py-2.5 text-[10px] font-extrabold",
									timeframe === item.key
										? "bg-primary text-primary-foreground"
										: "bg-secondary text-muted-foreground",
								)}
							>
								{item.label}
							</button>
						))}
					</div>

					<p className="mb-2 mt-5 text-xs font-extrabold text-foreground">
						가격 차트 지표
					</p>
					<div className="space-y-2">
						{(
							[
								["sma5", "5 이동평균선"],
								["sma20", "20 이동평균선"],
								["sma60", "60 이동평균선"],
								["sma120", "120 이동평균선"],
								["volume", "거래량"],
								["priceGrid", "가격 눈금선"],
								["bollinger", "볼린저 밴드"],
								["vwap", "VWAP 거래량가중평균"],
								["ichimoku", "일목균형표"],
							] as const
						).map(([key, label]) => (
							<ChartSettingToggle
								key={key}
								label={label}
								enabled={indicators[key]}
								onClick={() =>
									setIndicators((current) => ({
										...current,
										[key]: !current[key],
									}))
								}
							/>
						))}
					</div>

					<p className="mb-2 mt-5 text-xs font-extrabold text-foreground">
						보조지표 패널
					</p>
					<div className="space-y-2">
						{(
							[
								["rsi", "RSI 상대강도지수"],
								["macd", "MACD 추세·모멘텀"],
								["stochastic", "스토캐스틱"],
								["atr", "ATR 변동성"],
								["cci", "CCI 추세 강도"],
								["obv", "OBV 수급 방향"],
								["williamsR", "Williams %R"],
								["roc", "ROC 변화율"],
							] as const
						).map(([key, label]) => (
							<ChartSettingToggle
								key={key}
								label={label}
								enabled={indicators[key]}
								onClick={() =>
									setIndicators((current) => ({
										...current,
										[key]: !current[key],
									}))
								}
							/>
						))}
					</div>

					<div className="sticky bottom-0 mt-5 grid grid-cols-2 gap-2 border-t border-card-border bg-card pt-3">
						<button
							type="button"
							onClick={() => setIndicators({ ...DEFAULT_CHART_INDICATORS })}
							className="rounded-xl border border-card-border bg-secondary px-3 py-3 text-xs font-extrabold"
						>
							기본값 복원
						</button>

						<button
							type="button"
							onClick={() => setSettingsOpen(false)}
							className="rounded-xl bg-primary px-3 py-3 text-xs font-extrabold text-primary-foreground"
						>
							설정 완료
						</button>
					</div>
				</Modal>
			)}
			</div>

			<SectionCard
				title="기술지표"
				subtitle="조건이 충족된 지표는 색으로 활성화됩니다"
			>
				<button
					type="button"
					onClick={() => setTechnicalOpen((value) => !value)}
					className="mb-2 flex w-full items-center justify-between rounded-xl bg-secondary px-3 py-2 text-xs font-extrabold"
				>
					<span>
						{technicalOpen ? "기술지표가 펼쳐져 있습니다" : "기술지표 보기"}
					</span>
					<span>{technicalOpen ? "접기 ▲" : "열기 ▼"}</span>
				</button>
				{technicalOpen && (
					<div className="grid grid-cols-2 gap-2">
						{signals.map((item) => (
							<button
								key={item.title}
								type="button"
								onClick={() =>
									setExplanation({
										title: item.title,

										text: item.text,
									})
								}
								className={cn(
									"rounded-xl border p-3 text-left transition",
									item.active
										? "border-positive/50 bg-positive/10 shadow-sm"
										: "border-card-border bg-secondary/50",
								)}
							>
								<p className="text-[10px] font-bold text-muted-foreground">
									{item.title}
								</p>

								<p className="mt-1 text-base font-extrabold">{item.value}</p>
							</button>
						))}
					</div>
				)}
			</SectionCard>

			<SectionCard
				title="AI 차트 요약"
				subtitle="현재 차트 흐름을 간단히 설명합니다"
			>
				<button
					type="button"
					onClick={() => setSummaryOpen((value) => !value)}
					className="mb-2 flex w-full items-center justify-between rounded-xl bg-secondary px-3 py-2 text-xs font-extrabold"
				>
					<span>
						{summaryOpen ? "차트요약이 펼쳐져 있습니다" : "차트요약 보기"}
					</span>
					<span>{summaryOpen ? "접기 ▲" : "열기 ▼"}</span>
				</button>
				{summaryOpen && (
					<div className="space-y-2">
						{insights.chartSummary.map((item, index) => (
							<p
								key={index}
								className="break-keep rounded-xl bg-secondary/70 px-3 py-2 text-xs font-bold leading-relaxed text-muted-foreground"
							>
								{item}
							</p>
						))}
					</div>
				)}
			</SectionCard>

			<MarketFlowPanel ticker={ticker} />

			{explanation && (
				<Modal title={explanation.title} onClose={() => setExplanation(null)}>
					<p>{explanation.text}</p>
				</Modal>
			)}


		</div>
	);
}

function MarketFlowPanel({ ticker }: { ticker: string }) {
	const [mode, setMode] = useState<"investor" | "short">("investor");
	const [period, setPeriod] = useState<
		"daily" | "weekly" | "monthly" | "yearly"
	>("daily");
	const [open, setOpen] = useState(true);
	const [selectedActor, setSelectedActor] = useState<string | null>(null);
	const flow = useQuery<AnyObj>({
		queryKey: ["market-flow", ticker, period],
		queryFn: async () => {
			const response = await fetch(
				`/api/stocks/${ticker}/market-flow?period=${period}`,
			);
			if (!response.ok) throw new Error("market flow unavailable");
			return response.json();
		},
		staleTime: 60_000,
		retry: false,
	});
	const shortSelling = useQuery<AnyObj>({
		queryKey: ["short-selling", ticker],
		queryFn: async () => {
			const response = await fetch(`/api/stocks/${ticker}/short-selling`);
			if (!response.ok) throw new Error("short selling unavailable");
			return response.json();
		},
		staleTime: 60_000,
		retry: false,
	});
	const totals = flow.data?.totals ?? {};
	const actors = [
		{ key: "individual", label: "개인", value: Number(totals.individual ?? 0) },
		{
			key: "institution",
			label: "기관",
			value: Number(totals.institution ?? 0),
		},
		{ key: "foreign", label: "외국인", value: Number(totals.foreign ?? 0) },
	];
	const dominant = [...actors].sort(
		(a, b) => Math.abs(b.value) - Math.abs(a.value),
	)[0];
	const flowSummary = flow.data?.available
		? dominant.value >= 0
			? `${dominant.label} 매수가 가장 많아요. ${dominant.label} 수급이 이어지는지 조금 더 확인해 보세요.`
			: `${dominant.label} 매도가 가장 많아요. 매도세가 이어지면 추가 하락 위험이 있어 주의가 필요합니다.`
		: "투자자별 실제 매매 데이터를 확인 중입니다.";
	const shortRatio = Number(shortSelling.data?.latest?.ratio ?? 0);
	const balanceRatio = Number(shortSelling.data?.latest?.balanceRatio ?? 0);
	const borrowRate = Number(shortSelling.data?.latest?.borrowRate ?? 0);
	const squeezeScore = Math.min(
		100,
		Math.round(shortRatio * 4 + balanceRatio * 6 + borrowRate * 3),
	);
	const squeezeText = !shortSelling.data?.available
		? "공매도 최신 데이터를 확인 중입니다."
		: squeezeScore >= 70
			? "공매도 부담이 높아 주가가 급등하면 숏스퀴즈 가능성도 큽니다."
			: squeezeScore >= 40
				? "공매도 잔고가 다소 있어 거래량 증가 여부를 함께 보세요."
				: "현재 수치만 보면 숏스퀴즈 가능성은 높지 않습니다.";
	const compact = (value: number) =>
		!Number.isFinite(value)
			? "-"
			: Math.abs(value) >= 100000000
				? `${(value / 100000000).toFixed(1)}억`
				: Math.round(value).toLocaleString("ko-KR");

	return (
		<SectionCard
			title="매수·매도·공매도"
			subtitle="실제 제공 데이터가 있을 때만 계산합니다"
		>
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="mb-2 flex w-full items-center justify-between rounded-xl bg-secondary px-3 py-2 text-xs font-extrabold"
			>
				<span>투자자 수급 현황</span>
				<span>{open ? "접기 ▲" : "열기 ▼"}</span>
			</button>
			{open && (
				<>
					<div className="grid grid-cols-2 gap-2">
						<button
							type="button"
							onClick={() => setMode("investor")}
							className={cn(
								"rounded-xl px-3 py-2 text-xs font-extrabold",
								mode === "investor"
									? "bg-primary text-primary-foreground"
									: "bg-secondary",
							)}
						>
							매수·매도 현황
						</button>
						<button
							type="button"
							onClick={() => setMode("short")}
							className={cn(
								"rounded-xl px-3 py-2 text-xs font-extrabold",
								mode === "short"
									? "bg-primary text-primary-foreground"
									: "bg-secondary",
							)}
						>
							공매도 최신
						</button>
					</div>
					{mode === "investor" ? (
						<div className="mt-3">
							<div className="grid grid-cols-4 gap-1.5">
								{(
									[
										["daily", "일별"],
										["weekly", "주별"],
										["monthly", "월별"],
										["yearly", "년별"],
									] as const
								).map(([key, label]) => (
									<button
										key={key}
										type="button"
										onClick={() => setPeriod(key)}
										className={cn(
											"rounded-lg px-2 py-2 text-[10px] font-extrabold",
											period === key
												? "bg-primary/15 text-primary"
												: "bg-secondary text-muted-foreground",
										)}
									>
										{label}
									</button>
								))}
							</div>
							<div className="mt-3 grid grid-cols-3 gap-2">
								{actors.map((actor) => (
									<button
										key={actor.key}
										type="button"
										onClick={() => setSelectedActor(actor.label)}
										className={cn(
											"rounded-xl border p-3 text-center",
											actor.value > 0
												? "border-positive/40 bg-positive/10"
												: actor.value < 0
													? "border-destructive/40 bg-destructive/10"
													: "border-card-border bg-secondary/50",
										)}
									>
										<p className="text-[10px] font-bold text-muted-foreground">
											{actor.label}
										</p>
										<p
											className={cn(
												"mt-1 text-sm font-extrabold",
												actor.value > 0
													? "text-positive"
													: actor.value < 0
														? "text-destructive"
														: "",
											)}
										>
											{actor.value > 0 ? "+" : ""}
											{compact(actor.value)}
										</p>
										<p className="mt-1 text-[9px] font-bold text-muted-foreground">
											{actor.value >= 0 ? "순매수" : "순매도"}
										</p>
									</button>
								))}
							</div>
							<p className="mt-3 break-keep rounded-xl bg-secondary/70 p-3 text-xs font-bold leading-relaxed text-muted-foreground">
								{flowSummary}
							</p>
							{Array.isArray(flow.data?.rows) && flow.data.rows.length > 0 && (
								<div className="mt-3 space-y-1.5">
									{flow.data.rows
										.slice(0, 5)
										.map((row: AnyObj, index: number) => (
											<div
												key={row.date ?? index}
												className="grid grid-cols-4 gap-1 rounded-xl border border-card-border px-2 py-2 text-center text-[10px]"
											>
												<span>{row.date}</span>
												<span
													className={
														Number(row.individual) >= 0
															? "text-positive"
															: "text-destructive"
													}
												>
													개인 {compact(Number(row.individual))}
												</span>
												<span
													className={
														Number(row.institution) >= 0
															? "text-positive"
															: "text-destructive"
													}
												>
													기관 {compact(Number(row.institution))}
												</span>
												<span
													className={
														Number(row.foreign) >= 0
															? "text-positive"
															: "text-destructive"
													}
												>
													외인 {compact(Number(row.foreign))}
												</span>
											</div>
										))}
								</div>
							)}
						</div>
					) : (
						<div className="mt-3">
							<div className="grid grid-cols-3 gap-2">
								<FlowMetric
									label="공매도 비율"
									value={
										shortSelling.data?.available
											? `${shortRatio.toFixed(2)}%`
											: "-"
									}
								/>
								<FlowMetric
									label="잔고 비율"
									value={
										shortSelling.data?.available
											? `${balanceRatio.toFixed(2)}%`
											: "-"
									}
								/>
								<FlowMetric
									label="대차 이자율"
									value={
										shortSelling.data?.latest?.borrowRate != null
											? `${borrowRate.toFixed(2)}%`
											: "미제공"
									}
								/>
							</div>
							<div className="mt-3 rounded-xl bg-secondary/70 p-3">
								<div className="flex items-center justify-between">
									<p className="text-xs font-extrabold">숏스퀴즈 가능성</p>
									<p className="text-sm font-black text-primary">
										{shortSelling.data?.available ? `${squeezeScore}점` : "-"}
									</p>
								</div>
								<p className="mt-2 break-keep text-xs font-bold leading-relaxed text-muted-foreground">
									{squeezeText}
								</p>
							</div>
							{Array.isArray(shortSelling.data?.rows) &&
								shortSelling.data.rows.length > 0 && (
									<div className="mt-3 space-y-1.5">
										{shortSelling.data.rows
											.slice(0, 7)
											.map((row: AnyObj, index: number) => (
												<div
													key={row.date ?? index}
													className="grid grid-cols-3 gap-2 rounded-xl border border-card-border px-3 py-2 text-[10px] font-bold"
												>
													<span>{row.date}</span>
													<span>
														공매도 {compact(Number(row.shortVolume ?? 0))}
													</span>
													<span>비율 {Number(row.ratio ?? 0).toFixed(2)}%</span>
												</div>
											))}
									</div>
								)}
						</div>
					)}
				</>
			)}
			{selectedActor && (
				<Modal
					title={`${selectedActor} 수급 설명`}
					onClose={() => setSelectedActor(null)}
				>
					<p>
						{flow.data?.available
							? flowSummary
							: "현재 API에서 투자자별 순매매 데이터가 제공되지 않았습니다."}
					</p>
				</Modal>
			)}
		</SectionCard>
	);
}

function FlowMetric({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-xl border border-card-border bg-secondary/50 p-3 text-center">
			<p className="text-[10px] font-bold text-muted-foreground">{label}</p>
			<p className="mt-1 text-sm font-extrabold">{value}</p>
		</div>
	);
}

interface ChartCandleRow extends CandlePoint {
	time: UTCTimestamp;
}

interface ChartLineData {
	time: Time;
	value: number;
}

interface ChartHistogramData extends ChartLineData {
	color?: string;
}

type IndicatorPanelKind =
	| "rsi"
	| "macd"
	| "stochastic"
	| "atr"
	| "cci"
	| "obv"
	| "williamsR"
	| "roc";

interface IndicatorPanelSeries {
	label: string;
	color: string;
	data: ChartLineData[];
	lineStyle?: LineStyle;
}

interface IndicatorPanelModel {
	title: string;
	latest: string;
	lines: IndicatorPanelSeries[];
	histogram?: ChartHistogramData[];
}

function chartTimestamp(
	value: string,
	index: number,
	total: number,
): UTCTimestamp {
	const raw = String(value ?? "").trim();
	const digitsOnly = raw.replace(/\D/g, "");

	if (/^\d{14}$/.test(digitsOnly)) {
		const year = Number(digitsOnly.slice(0, 4));
		const month = Number(digitsOnly.slice(4, 6)) - 1;
		const day = Number(digitsOnly.slice(6, 8));
		const hour = Number(digitsOnly.slice(8, 10));
		const minute = Number(digitsOnly.slice(10, 12));
		const second = Number(digitsOnly.slice(12, 14));

		return Math.floor(
			new Date(year, month, day, hour, minute, second).getTime() / 1000,
		) as UTCTimestamp;
	}

	if (/^\d{12}$/.test(digitsOnly)) {
		const year = Number(digitsOnly.slice(0, 4));
		const month = Number(digitsOnly.slice(4, 6)) - 1;
		const day = Number(digitsOnly.slice(6, 8));
		const hour = Number(digitsOnly.slice(8, 10));
		const minute = Number(digitsOnly.slice(10, 12));

		return Math.floor(
			new Date(year, month, day, hour, minute).getTime() / 1000,
		) as UTCTimestamp;
	}

	if (/^\d{8}$/.test(digitsOnly)) {
		const year = Number(digitsOnly.slice(0, 4));
		const month = Number(digitsOnly.slice(4, 6)) - 1;
		const day = Number(digitsOnly.slice(6, 8));

		return Math.floor(new Date(year, month, day).getTime() / 1000) as UTCTimestamp;
	}

	const numeric = Number(raw);

	if (Number.isFinite(numeric) && numeric > 1_000_000_000_000) {
		return Math.floor(numeric / 1000) as UTCTimestamp;
	}

	if (Number.isFinite(numeric) && numeric > 1_000_000_000) {
		return Math.floor(numeric) as UTCTimestamp;
	}

	if (!raw || /^\d{1,6}$/.test(raw)) {
		return Math.floor(Date.now() / 1000 - (total - index) * 60) as UTCTimestamp;
	}

	const parsed = Date.parse(raw);

	if (Number.isFinite(parsed)) {
		return Math.floor(parsed / 1000) as UTCTimestamp;
	}

	return Math.floor(Date.now() / 1000 - (total - index) * 60) as UTCTimestamp;
}

function buildChartRows(candles: CandlePoint[]): ChartCandleRow[] {
	const sorted = candles
		.map((item, index) => ({
			...item,
			time: chartTimestamp(item.date, index, candles.length),
		}))
		.sort((a, b) => Number(a.time) - Number(b.time));

	let previous = 0;

	return sorted.map((item) => {
		const raw = Number(item.time);
		const next = raw <= previous ? previous + 1 : raw;
		previous = next;

		return {
			...item,
			time: next as UTCTimestamp,
		};
	});
}

function average(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function smaArray(values: number[], period: number): Array<number | null> {
	const result = Array<number | null>(values.length).fill(null);
	let sum = 0;

	for (let index = 0; index < values.length; index += 1) {
		sum += values[index];

		if (index >= period) {
			sum -= values[index - period];
		}

		if (index >= period - 1) {
			result[index] = sum / period;
		}
	}

	return result;
}

function emaArray(
	values: Array<number | null>,
	period: number,
): Array<number | null> {
	const result = Array<number | null>(values.length).fill(null);
	const seed: number[] = [];
	const multiplier = 2 / (period + 1);
	let previous: number | null = null;

	for (let index = 0; index < values.length; index += 1) {
		const value = values[index];
		if (value == null) continue;

		if (previous == null) {
			seed.push(value);

			if (seed.length === period) {
				previous = average(seed);
				result[index] = previous;
			}

			continue;
		}

		previous = (value - previous) * multiplier + previous;
		result[index] = previous;
	}

	return result;
}

function lineDataFromValues(
	rows: ChartCandleRow[],
	values: Array<number | null>,
): ChartLineData[] {
	return values.flatMap((value, index) =>
		value == null || !Number.isFinite(value)
			? []
			: [{ time: rows[index].time as Time, value }],
	);
}

function movingAverageData(
	rows: ChartCandleRow[],
	period: number,
): ChartLineData[] {
	return lineDataFromValues(
		rows,
		smaArray(
			rows.map((item) => item.close),
			period,
		),
	);
}

function bollingerData(rows: ChartCandleRow[], period = 20) {
	const upper = Array<number | null>(rows.length).fill(null);
	const middle = Array<number | null>(rows.length).fill(null);
	const lower = Array<number | null>(rows.length).fill(null);

	for (let index = period - 1; index < rows.length; index += 1) {
		const values = rows
			.slice(index + 1 - period, index + 1)
			.map((item) => item.close);
		const mean = average(values);
		const deviation = Math.sqrt(
			average(values.map((value) => Math.pow(value - mean, 2))),
		);

		middle[index] = mean;
		upper[index] = mean + deviation * 2;
		lower[index] = mean - deviation * 2;
	}

	return {
		upper: lineDataFromValues(rows, upper),
		middle: lineDataFromValues(rows, middle),
		lower: lineDataFromValues(rows, lower),
	};
}

function vwapData(rows: ChartCandleRow[]): ChartLineData[] {
	let cumulativeValue = 0;
	let cumulativeVolume = 0;

	return rows.map((item) => {
		const volume = Math.max(item.volume, 0);
		const typicalPrice = (item.high + item.low + item.close) / 3;
		cumulativeValue += typicalPrice * volume;
		cumulativeVolume += volume;

		return {
			time: item.time as Time,
			value:
				cumulativeVolume > 0
					? cumulativeValue / cumulativeVolume
					: item.close,
		};
	});
}

function ichimokuData(rows: ChartCandleRow[]) {
	const conversion = Array<number | null>(rows.length).fill(null);
	const base = Array<number | null>(rows.length).fill(null);
	const spanA = Array<number | null>(rows.length).fill(null);
	const spanB = Array<number | null>(rows.length).fill(null);

	const midpoint = (index: number, period: number) => {
		if (index < period - 1) return null;
		const range = rows.slice(index + 1 - period, index + 1);
		return (
			Math.max(...range.map((item) => item.high)) +
			Math.min(...range.map((item) => item.low))
		) / 2;
	};

	for (let index = 0; index < rows.length; index += 1) {
		conversion[index] = midpoint(index, 9);
		base[index] = midpoint(index, 26);
		spanB[index] = midpoint(index, 52);

		if (conversion[index] != null && base[index] != null) {
			spanA[index] = (conversion[index]! + base[index]!) / 2;
		}
	}

	return {
		conversion: lineDataFromValues(rows, conversion),
		base: lineDataFromValues(rows, base),
		spanA: lineDataFromValues(rows, spanA),
		spanB: lineDataFromValues(rows, spanB),
	};
}

function rsiValues(rows: ChartCandleRow[], period = 14): Array<number | null> {
	const values = rows.map((item) => item.close);
	const result = Array<number | null>(values.length).fill(null);
	if (values.length <= period) return result;

	let averageGain = 0;
	let averageLoss = 0;

	for (let index = 1; index <= period; index += 1) {
		const change = values[index] - values[index - 1];
		averageGain += Math.max(change, 0);
		averageLoss += Math.max(-change, 0);
	}

	averageGain /= period;
	averageLoss /= period;
	result[period] =
		averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);

	for (let index = period + 1; index < values.length; index += 1) {
		const change = values[index] - values[index - 1];
		averageGain =
			(averageGain * (period - 1) + Math.max(change, 0)) / period;
		averageLoss =
			(averageLoss * (period - 1) + Math.max(-change, 0)) / period;
		result[index] =
			averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
	}

	return result;
}

function stochasticValues(
	rows: ChartCandleRow[],
	period = 14,
): Array<number | null> {
	const result = Array<number | null>(rows.length).fill(null);

	for (let index = period - 1; index < rows.length; index += 1) {
		const window = rows.slice(index + 1 - period, index + 1);
		const high = Math.max(...window.map((item) => item.high));
		const low = Math.min(...window.map((item) => item.low));
		result[index] = high === low ? 50 : ((rows[index].close - low) / (high - low)) * 100;
	}

	return result;
}

function atrValues(rows: ChartCandleRow[], period = 14): Array<number | null> {
	const trueRanges = rows.map((item, index) => {
		if (index === 0) return item.high - item.low;
		const previousClose = rows[index - 1].close;
		return Math.max(
			item.high - item.low,
			Math.abs(item.high - previousClose),
			Math.abs(item.low - previousClose),
		);
	});

	const result = Array<number | null>(rows.length).fill(null);
	if (trueRanges.length < period) return result;

	let current = average(trueRanges.slice(0, period));
	result[period - 1] = current;

	for (let index = period; index < trueRanges.length; index += 1) {
		current = (current * (period - 1) + trueRanges[index]) / period;
		result[index] = current;
	}

	return result;
}

function cciValues(rows: ChartCandleRow[], period = 20): Array<number | null> {
	const typical = rows.map((item) => (item.high + item.low + item.close) / 3);
	const result = Array<number | null>(rows.length).fill(null);

	for (let index = period - 1; index < rows.length; index += 1) {
		const values = typical.slice(index + 1 - period, index + 1);
		const mean = average(values);
		const deviation = average(values.map((value) => Math.abs(value - mean)));
		result[index] = deviation === 0 ? 0 : (typical[index] - mean) / (0.015 * deviation);
	}

	return result;
}

function obvValues(rows: ChartCandleRow[]): Array<number | null> {
	const result = Array<number | null>(rows.length).fill(null);
	if (!rows.length) return result;

	let value = 0;
	result[0] = value;

	for (let index = 1; index < rows.length; index += 1) {
		if (rows[index].close > rows[index - 1].close) value += rows[index].volume;
		if (rows[index].close < rows[index - 1].close) value -= rows[index].volume;
		result[index] = value;
	}

	return result;
}

function williamsRValues(
	rows: ChartCandleRow[],
	period = 14,
): Array<number | null> {
	const result = Array<number | null>(rows.length).fill(null);

	for (let index = period - 1; index < rows.length; index += 1) {
		const window = rows.slice(index + 1 - period, index + 1);
		const high = Math.max(...window.map((item) => item.high));
		const low = Math.min(...window.map((item) => item.low));
		result[index] = high === low ? -50 : ((high - rows[index].close) / (high - low)) * -100;
	}

	return result;
}

function rocValues(rows: ChartCandleRow[], period = 10): Array<number | null> {
	const result = Array<number | null>(rows.length).fill(null);

	for (let index = period; index < rows.length; index += 1) {
		const previous = rows[index - period].close;
		result[index] = previous === 0 ? 0 : ((rows[index].close / previous) - 1) * 100;
	}

	return result;
}

function constantLine(
	rows: ChartCandleRow[],
	value: number,
): ChartLineData[] {
	if (!rows.length) return [];

	return [
		{ time: rows[0].time as Time, value },
		{ time: rows[rows.length - 1].time as Time, value },
	];
}

function indicatorPanelModel(
	rows: ChartCandleRow[],
	kind: IndicatorPanelKind,
): IndicatorPanelModel {
	if (kind === "rsi") {
		const values = rsiValues(rows);
		const latest = [...values].reverse().find((value) => value != null) ?? null;
		return {
			title: "RSI (14)",
			latest: latest == null ? "-" : latest.toFixed(1),
			lines: [
				{ label: "RSI", color: "#a855f7", data: lineDataFromValues(rows, values) },
				{ label: "70", color: "#ef4444", data: constantLine(rows, 70), lineStyle: LineStyle.Dashed },
				{ label: "30", color: "#3b82f6", data: constantLine(rows, 30), lineStyle: LineStyle.Dashed },
			],
		};
	}

	if (kind === "macd") {
		const closes = rows.map((item) => item.close);
		const fast = emaArray(closes, 12);
		const slow = emaArray(closes, 26);
		const macd = closes.map((_, index) =>
			fast[index] != null && slow[index] != null ? fast[index]! - slow[index]! : null,
		);
		const signal = emaArray(macd, 9);
		const histogram = macd.map((value, index) =>
			value != null && signal[index] != null ? value - signal[index]! : null,
		);
		const latest = [...macd].reverse().find((value) => value != null) ?? null;

		return {
			title: "MACD (12·26·9)",
			latest: latest == null ? "-" : latest.toFixed(2),
			lines: [
				{ label: "MACD", color: "#3b82f6", data: lineDataFromValues(rows, macd) },
				{ label: "Signal", color: "#f59e0b", data: lineDataFromValues(rows, signal) },
			],
			histogram: histogram.flatMap((value, index) =>
				value == null
					? []
					: [{
						time: rows[index].time as Time,
						value,
						color: value >= 0 ? "rgba(239,68,68,0.55)" : "rgba(59,130,246,0.55)",
					}],
			),
		};
	}

	if (kind === "stochastic") {
		const values = stochasticValues(rows);
		const latest = [...values].reverse().find((value) => value != null) ?? null;
		return {
			title: "스토캐스틱 (14)",
			latest: latest == null ? "-" : latest.toFixed(1),
			lines: [
				{ label: "%K", color: "#06b6d4", data: lineDataFromValues(rows, values) },
				{ label: "80", color: "#ef4444", data: constantLine(rows, 80), lineStyle: LineStyle.Dashed },
				{ label: "20", color: "#3b82f6", data: constantLine(rows, 20), lineStyle: LineStyle.Dashed },
			],
		};
	}

	if (kind === "atr") {
		const values = atrValues(rows);
		const latest = [...values].reverse().find((value) => value != null) ?? null;
		return {
			title: "ATR (14)",
			latest: latest == null ? "-" : latest.toLocaleString(undefined, { maximumFractionDigits: 2 }),
			lines: [{ label: "ATR", color: "#f97316", data: lineDataFromValues(rows, values) }],
		};
	}

	if (kind === "cci") {
		const values = cciValues(rows);
		const latest = [...values].reverse().find((value) => value != null) ?? null;
		return {
			title: "CCI (20)",
			latest: latest == null ? "-" : latest.toFixed(0),
			lines: [
				{ label: "CCI", color: "#22c55e", data: lineDataFromValues(rows, values) },
				{ label: "+100", color: "#ef4444", data: constantLine(rows, 100), lineStyle: LineStyle.Dashed },
				{ label: "-100", color: "#3b82f6", data: constantLine(rows, -100), lineStyle: LineStyle.Dashed },
			],
		};
	}

	if (kind === "obv") {
		const values = obvValues(rows);
		const latest = [...values].reverse().find((value) => value != null) ?? null;
		return {
			title: "OBV",
			latest: latest == null ? "-" : latest.toLocaleString("ko-KR", { notation: "compact" }),
			lines: [{ label: "OBV", color: "#14b8a6", data: lineDataFromValues(rows, values) }],
		};
	}

	if (kind === "williamsR") {
		const values = williamsRValues(rows);
		const latest = [...values].reverse().find((value) => value != null) ?? null;
		return {
			title: "Williams %R (14)",
			latest: latest == null ? "-" : latest.toFixed(1),
			lines: [
				{ label: "%R", color: "#ec4899", data: lineDataFromValues(rows, values) },
				{ label: "-20", color: "#ef4444", data: constantLine(rows, -20), lineStyle: LineStyle.Dashed },
				{ label: "-80", color: "#3b82f6", data: constantLine(rows, -80), lineStyle: LineStyle.Dashed },
			],
		};
	}

	const values = rocValues(rows);
	const latest = [...values].reverse().find((value) => value != null) ?? null;
	return {
		title: "ROC (10)",
		latest: latest == null ? "-" : `${latest >= 0 ? "+" : ""}${latest.toFixed(1)}%`,
		lines: [
			{ label: "ROC", color: "#8b5cf6", data: lineDataFromValues(rows, values) },
			{ label: "0", color: "#64748b", data: constantLine(rows, 0), lineStyle: LineStyle.Dashed },
		],
	};
}

function chartBaseOptions(height: number, showGrid: boolean) {
	return {
		width: 0,
		height,
		layout: {
			background: { type: ColorType.Solid, color: "transparent" },
			textColor: "#94a3b8",
			fontFamily: "inherit",
		},
		grid: {
			vertLines: {
				visible: showGrid,
				color: "rgba(148,163,184,0.12)",
			},
			horzLines: {
				visible: showGrid,
				color: "rgba(148,163,184,0.12)",
			},
		},
		crosshair: {
			mode: CrosshairMode.Normal,
			vertLine: { color: "rgba(148,163,184,0.6)", labelBackgroundColor: "#334155" },
			horzLine: { color: "rgba(148,163,184,0.6)", labelBackgroundColor: "#334155" },
		},
		rightPriceScale: {
			borderColor: "rgba(148,163,184,0.25)",
		},
		timeScale: {
			borderColor: "rgba(148,163,184,0.25)",
			timeVisible: true,
			secondsVisible: false,
			rightOffset: 4,
			barSpacing: 8,
			minBarSpacing: 2,
		},
		handleScroll: {
			mouseWheel: true,
			pressedMouseMove: true,
			horzTouchDrag: true,
			vertTouchDrag: false,
		},
		handleScale: {
			axisPressedMouseMove: true,
			mouseWheel: true,
			pinch: true,
		},
		localization: {
			locale: "ko-KR",
		},
	};
}

function attachChartResize(
	chart: IChartApi | null,
	container: HTMLDivElement | null,
	height: number,
) {
	if (!chart || !container) return () => undefined;

	const resize = () => {
		chart.applyOptions({
			width: Math.max(container.clientWidth, 1),
			height,
		});
	};

	resize();
	const observer = new ResizeObserver(resize);
	observer.observe(container);

	return () => observer.disconnect();
}

function pickStudyMarkerRow(
	rows: ChartCandleRow[],
	strategy: StudyMarkerStrategy,
) {
	if (!rows.length) return null;
	const recent = rows.slice(-60);

	if (strategy === "highest-volume") {
		return [...recent].sort((a, b) => b.volume - a.volume)[0] ?? null;
	}
	if (strategy === "recent-low") {
		return [...recent].sort((a, b) => a.low - b.low)[0] ?? null;
	}
	if (strategy === "recent-high") {
		return [...recent].sort((a, b) => b.high - a.high)[0] ?? null;
	}
	if (strategy === "breakout") {
		for (let index = Math.max(1, recent.length - 20); index < recent.length; index += 1) {
			const previousHigh = Math.max(...recent.slice(0, index).map((row) => row.high));
			if (recent[index].close > previousHigh) return recent[index];
		}
	}

	return recent[recent.length - 1] ?? null;
}

function ProfessionalChart({
	candles,
	loading,
	timeframe,
	indicators,
	fullscreen,
	portfolioOverlay,
	autoSignal,
	studyFocus,
}: {
	candles: CandlePoint[];
	loading: boolean;
	timeframe: ChartTimeframe;
	indicators: ChartIndicatorSettings;
	fullscreen: boolean;
	portfolioOverlay: PortfolioChartOverlay | null;
	autoSignal: ReturnType<typeof getAutoTradeSignal>;
	studyFocus: StudyChartFocus | null;
}) {
	const rows = useMemo(() => buildChartRows(candles), [candles]);
	const enabledPanels = (
		[
			["rsi", indicators.rsi],
			["macd", indicators.macd],
			["stochastic", indicators.stochastic],
			["atr", indicators.atr],
			["cci", indicators.cci],
			["obv", indicators.obv],
			["williamsR", indicators.williamsR],
			["roc", indicators.roc],
		] as Array<[IndicatorPanelKind, boolean]>
	).filter(([, enabled]) => enabled);

	if (loading && rows.length < 2) {
		return <ChartPlaceholder text="실제 봉 데이터를 불러오는 중..." />;
	}

	if (rows.length < 2) {
		return <ChartPlaceholder text="표시할 시가·고가·저가·종가 데이터가 부족합니다." />;
	}

	return (
		<div className="space-y-2">
			<PriceChartCanvas
				rows={rows}
				timeframe={timeframe}
				indicators={indicators}
				fullscreen={fullscreen}
				portfolioOverlay={portfolioOverlay}
				autoSignal={autoSignal}
				studyFocus={studyFocus}
			/>

			{enabledPanels.map(([kind]) => (
				<IndicatorPanel
					key={kind}
					kind={kind}
					rows={rows}
					fullscreen={fullscreen}
				/>
			))}
		</div>
	);
}

function PriceChartCanvas({
	rows,
	timeframe,
	indicators,
	fullscreen,
	portfolioOverlay,
	autoSignal,
	studyFocus,
}: {
	rows: ChartCandleRow[];
	timeframe: ChartTimeframe;
	indicators: ChartIndicatorSettings;
	fullscreen: boolean;
	portfolioOverlay: PortfolioChartOverlay | null;
	autoSignal: ReturnType<typeof getAutoTradeSignal>;
	studyFocus: StudyChartFocus | null;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const height = fullscreen ? Math.max(430, Math.floor(window.innerHeight * 0.68)) : 360;

	useEffect(() => {
		const container = containerRef.current;
		if (!container || rows.length < 2) return;

		const chart = createChart(container, {
			...chartBaseOptions(height, indicators.priceGrid),
			width: Math.max(container.clientWidth, 1),
			timeScale: {
				...chartBaseOptions(height, indicators.priceGrid).timeScale,
				timeVisible: /m|H/.test(timeframe),
			},
		} as AnyObj);

		const candleSeries = chart.addCandlestickSeries({
			upColor: "#ef4444",
			downColor: "#3b82f6",
			wickUpColor: "#ef4444",
			wickDownColor: "#3b82f6",
			borderUpColor: "#ef4444",
			borderDownColor: "#3b82f6",
			priceLineVisible: true,
			lastValueVisible: true,
		});

		candleSeries.setData(
			rows.map((item) => ({
				time: item.time,
				open: item.open,
				high: item.high,
				low: item.low,
				close: item.close,
			})),
		);

		if (portfolioOverlay?.averagePrice && portfolioOverlay.averagePrice > 0) {
			candleSeries.createPriceLine({
				price: portfolioOverlay.averagePrice,
				color: "#f59e0b",
				lineWidth: 2,
				lineStyle: LineStyle.Dashed,
				axisLabelVisible: true,
				title: "내 평단",
			});
		}

		if (autoSignal?.candidate.price && autoSignal.candidate.price > 0) {
			const basePrice = autoSignal.candidate.price;
			candleSeries.createPriceLine({
				price: basePrice * (1 - autoSignal.settings.stopLossPercent / 100),
				color: "#3b82f6",
				lineWidth: 1,
				lineStyle: LineStyle.Dotted,
				axisLabelVisible: true,
				title: "자동 손절",
			});
			candleSeries.createPriceLine({
				price: basePrice * (1 + autoSignal.settings.takeProfitPercent / 100),
				color: "#ef4444",
				lineWidth: 1,
				lineStyle: LineStyle.Dotted,
				axisLabelVisible: true,
				title: "자동 목표",
			});
		}

		const markers: AnyObj[] = [];
		if (studyFocus) {
			const studyRow = pickStudyMarkerRow(rows, studyFocus.markerStrategy);
			if (studyRow) {
				markers.push({
					time: studyRow.time,
					position: "belowBar",
					color: "#a855f7",
					shape: "arrowUp",
					text: studyFocus.markerText,
				});
			}
		}
		if (autoSignal && rows.length) {
			markers.push({
				time: rows[rows.length - 1].time,
				position: "aboveBar",
				color: "#ef4444",
				shape: "arrowDown",
				text: `자동신호 ${autoSignal.candidate.probability}%`,
			});
		}
		if (markers.length) candleSeries.setMarkers(markers as any);

		if (indicators.volume) {
			const volumeSeries = chart.addHistogramSeries({
				priceFormat: { type: "volume" },
				priceScaleId: "volume",
				lastValueVisible: false,
				priceLineVisible: false,
			});

			volumeSeries.priceScale().applyOptions({
				scaleMargins: { top: 0.8, bottom: 0 },
			});

			volumeSeries.setData(
				rows.map((item) => ({
					time: item.time,
					value: item.volume,
					color:
						item.close >= item.open
							? "rgba(239,68,68,0.45)"
							: "rgba(59,130,246,0.45)",
				})),
			);
		}

		const addLine = (
			data: ChartLineData[],
			color: string,
			lineWidth: 1 | 2 = 1,
			lineStyle: LineStyle = LineStyle.Solid,
		) => {
			if (!data.length) return;
			const series = chart.addLineSeries({
				color,
				lineWidth,
				lineStyle,
				priceLineVisible: false,
				lastValueVisible: false,
				crosshairMarkerVisible: false,
			});
			series.setData(data);
		};

		if (indicators.sma5) addLine(movingAverageData(rows, 5), "#f59e0b", 2);
		if (indicators.sma20) addLine(movingAverageData(rows, 20), "#22c55e", 2);
		if (indicators.sma60) addLine(movingAverageData(rows, 60), "#a855f7", 2);
		if (indicators.sma120) addLine(movingAverageData(rows, 120), "#ec4899", 2);

		if (indicators.bollinger) {
			const band = bollingerData(rows);
			addLine(band.upper, "#14b8a6", 1, LineStyle.Dashed);
			addLine(band.middle, "#14b8a6", 1, LineStyle.Dotted);
			addLine(band.lower, "#14b8a6", 1, LineStyle.Dashed);
		}

		if (indicators.vwap) addLine(vwapData(rows), "#06b6d4", 2);

		if (indicators.ichimoku) {
			const cloud = ichimokuData(rows);
			addLine(cloud.conversion, "#ef4444", 1);
			addLine(cloud.base, "#3b82f6", 1);
			addLine(cloud.spanA, "#22c55e", 1, LineStyle.Dashed);
			addLine(cloud.spanB, "#f97316", 1, LineStyle.Dashed);
		}

		chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, rows.length - 120), to: rows.length + 3 });
		const stopResize = attachChartResize(chart, container, height);

		return () => {
			stopResize();
			chart.remove();
		};
	}, [rows, timeframe, indicators, height, portfolioOverlay, autoSignal, studyFocus]);

	return (
		<div className="overflow-hidden rounded-xl border border-card-border bg-secondary/20">
			<div ref={containerRef} className="w-full" style={{ height }} />
			<div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-card-border px-3 py-2 text-[9px] font-bold text-muted-foreground">
				<span className="text-red-500">■ 상승봉</span>
				<span className="text-blue-500">■ 하락봉</span>
				{indicators.sma5 && <span className="text-amber-500">━ 5일선</span>}
				{indicators.sma20 && <span className="text-green-500">━ 20일선</span>}
				{indicators.sma60 && <span className="text-purple-500">━ 60일선</span>}
				{indicators.sma120 && <span className="text-pink-500">━ 120일선</span>}
				{indicators.bollinger && <span className="text-teal-500">┄ 볼린저</span>}
				{indicators.vwap && <span className="text-cyan-500">━ VWAP</span>}
			</div>
		</div>
	);
}

function IndicatorPanel({
	kind,
	rows,
	fullscreen,
}: {
	kind: IndicatorPanelKind;
	rows: ChartCandleRow[];
	fullscreen: boolean;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const model = useMemo(() => indicatorPanelModel(rows, kind), [rows, kind]);
	const height = fullscreen ? 190 : 155;

	useEffect(() => {
		const container = containerRef.current;
		if (!container || rows.length < 2) return;

		const chart = createChart(container, {
			...chartBaseOptions(height, true),
			width: Math.max(container.clientWidth, 1),
			rightPriceScale: {
				borderColor: "rgba(148,163,184,0.25)",
				scaleMargins: { top: 0.12, bottom: 0.12 },
			},
		} as AnyObj);

		if (model.histogram?.length) {
			const histogram = chart.addHistogramSeries({
				priceLineVisible: false,
				lastValueVisible: false,
			});
			histogram.setData(model.histogram);
		}

		for (const line of model.lines) {
			const series = chart.addLineSeries({
				color: line.color,
				lineWidth: 2,
				lineStyle: line.lineStyle ?? LineStyle.Solid,
				priceLineVisible: false,
				lastValueVisible: false,
				crosshairMarkerVisible: false,
			});
			series.setData(line.data);
		}

		chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, rows.length - 120), to: rows.length + 3 });
		const stopResize = attachChartResize(chart, container, height);

		return () => {
			stopResize();
			chart.remove();
		};
	}, [rows, model, height]);

	return (
		<section className="overflow-hidden rounded-xl border border-card-border bg-secondary/20">
			<div className="flex items-center justify-between border-b border-card-border px-3 py-2">
				<p className="text-[11px] font-extrabold">{model.title}</p>
				<p className="text-xs font-black text-primary">{model.latest}</p>
			</div>
			<div ref={containerRef} className="w-full" style={{ height }} />
		</section>
	);
}

function ChartSettingToggle({
	label,
	enabled,
	onClick,
}: {
	label: string;
	enabled: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex w-full items-center justify-between rounded-xl bg-secondary/60 p-3 text-left text-xs font-bold"
		>
			<span>{label}</span>
			<span
				className={cn(
					"relative h-6 w-11 rounded-full transition",
					enabled ? "bg-primary" : "bg-muted",
				)}
			>
				<span
					className={cn(
						"absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
						enabled ? "translate-x-5" : "translate-x-0.5",
					)}
				/>
			</span>
		</button>
	);
}

function ChartPlaceholder({ text }: { text: string }) {
	return (
		<div className="mt-3 flex h-[360px] items-center justify-center rounded-xl bg-secondary/50">
			<p className="text-sm font-bold text-muted-foreground">{text}</p>
		</div>
	);
}

function FinancialTab({
	financials,
	currency,
}: {
	financials: AnyObj | null;
	currency: Currency;
}) {
	const [period, setPeriod] = useState<FinancialPeriod>("annual");

	const [selectedMetric, setSelectedMetric] = useState<FinancialMetric | null>(
		null,
	);

	const ratios = financials?.ratios ?? financials?.metrics ?? {};

	const metrics = [
		evaluateFinancialMetric(
			"roe",

			firstNumber(ratios.roe, ratios.returnOnEquity, financials?.roe),
		),

		evaluateFinancialMetric(
			"pbr",

			firstNumber(
				ratios.pbr,
				ratios.priceToBook,
				ratios.priceBookRatio,
				financials?.pbr,
			),
		),

		evaluateFinancialMetric(
			"per",

			firstNumber(
				ratios.per,
				ratios.pe,
				ratios.priceToEarnings,
				financials?.per,
			),
		),

		evaluateFinancialMetric(
			"psr",

			firstNumber(
				ratios.psr,
				ratios.priceToSales,
				ratios.priceSalesRatio,
				financials?.psr,
			),
		),
	];

	const rows = financialRows(financials, period).slice(0, 4);

	const annualRows = financialRows(financials, "annual").slice(0, 3).reverse();

	const performanceCards = [
		{
			label: "자본금",
			color: "bg-violet-500",
			values: annualRows.map((row) =>
				firstNumber(
					row.capitalStock,
					row.paidInCapital,
					row.capital,
					row.equityCapital,
				),
			),
		},
		{
			label: "매출액",
			color: "bg-blue-500",
			values: annualRows.map((row) =>
				firstNumber(row.revenue, row.sales, row.totalRevenue),
			),
		},
		{
			label: "영업이익",
			color: "bg-emerald-500",
			values: annualRows.map((row) =>
				firstNumber(row.operatingIncome, row.operatingProfit, row.opIncome),
			),
		},
		{
			label: "순이익",
			color: "bg-cyan-500",
			values: annualRows.map((row) =>
				firstNumber(row.netIncome, row.netProfit, row.profit),
			),
		},
		{
			label: "총자산",
			color: "bg-amber-500",
			values: annualRows.map((row) => firstNumber(row.assets, row.totalAssets)),
		},
		{
			label: "총부채",
			color: "bg-rose-500",
			values: annualRows.map((row) =>
				firstNumber(row.debt, row.totalLiabilities, row.liabilities),
			),
		},
	];

	const periodLabels = annualRows.map((row, index) =>
		String(row.period ?? row.year ?? `${index + 1}년`),
	);

	return (
		<div className="flex flex-col gap-3">
			<SectionCard
				title="핵심 지표"
				subtitle="지표를 누르면 자세한 설명이 나옵니다"
			>
				<div className="grid grid-cols-2 gap-2">
					{metrics.map((metric) => (
						<button
							key={metric.key}
							type="button"
							onClick={() => setSelectedMetric(metric)}
							className={cn(
								"rounded-xl border p-3 text-left",

								metricBorder(metric.tone),
							)}
						>
							<p className="text-xs font-extrabold">{metric.label}</p>

							<p
								className={cn(
									"mt-3 text-xl font-extrabold",

									metricText(metric.tone),
								)}
							>
								{metric.valueText}
							</p>

							<p className="mt-1 text-sm font-extrabold text-muted-foreground">
								{metric.status}
							</p>
						</button>
					))}
				</div>
			</SectionCard>

			<div className="order-3">
				<SectionCard
					title="재무 실적"
					subtitle="막대가 높을수록 금액이 큽니다. 항목별 흐름을 쉽게 비교해 보세요"
				>
					{annualRows.length ? (
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							{performanceCards.map((card) => (
								<FinancialTrendCard
									key={card.label}
									label={card.label}
									values={card.values}
									periods={periodLabels}
									currency={currency}
									color={card.color}
								/>
							))}
						</div>
					) : (
						<p className="text-sm font-bold text-muted-foreground">
							연도별 재무 데이터가 부족합니다. 서버의 financials 응답을 확인해
							주세요.
						</p>
					)}
				</SectionCard>
			</div>

			<div className="order-2">
				<SectionCard title="실적" subtitle="기간별 매출과 이익">
					<div className="mb-3 grid grid-cols-2 gap-2">
						<button
							type="button"
							onClick={() => setPeriod("annual")}
							className={cn(
								"rounded-xl px-3 py-2 text-xs font-extrabold",

								period === "annual"
									? "bg-primary text-primary-foreground"
									: "bg-secondary text-muted-foreground",
							)}
						>
							연도별
						</button>

						<button
							type="button"
							onClick={() => setPeriod("quarterly")}
							className={cn(
								"rounded-xl px-3 py-2 text-xs font-extrabold",

								period === "quarterly"
									? "bg-primary text-primary-foreground"
									: "bg-secondary text-muted-foreground",
							)}
						>
							분기별
						</button>
					</div>

					{rows.length ? (
						<div className="space-y-2">
							{rows.map((row, index) => (
								<div
									key={`${row.period ?? row.date ?? index}`}
									className="rounded-xl border border-card-border bg-secondary/50 p-3"
								>
									<p className="text-sm font-extrabold">
										{row.period ?? row.date ?? row.year ?? "기간 확인"}
									</p>

									<div className="mt-2 grid grid-cols-2 gap-2 text-xs font-bold text-muted-foreground">
										<p>매출 {formatMoney(row.revenue, currency)}</p>

										<p>영업이익 {formatMoney(row.operatingIncome, currency)}</p>

										<p>순이익 {formatMoney(row.netIncome, currency)}</p>

										<p>
											부채{" "}
											{formatMoney(
												firstNumber(row.debt, row.totalLiabilities),
												currency,
											)}
										</p>
									</div>
								</div>
							))}
						</div>
					) : (
						<p className="text-sm font-bold text-muted-foreground">
							선택한 기간의 재무 데이터가 부족합니다.
						</p>
					)}
				</SectionCard>
			</div>

			{selectedMetric && (
				<Modal
					title={`${selectedMetric.label} · ${selectedMetric.status}`}
					subtitle={selectedMetric.valueText}
					onClose={() => setSelectedMetric(null)}
				>
					<div className="space-y-3">
						<ExplanationBlock label="지표 뜻" text={selectedMetric.meaning} />

						<ExplanationBlock
							label="현재 수치 해석"
							text={selectedMetric.interpretation}
						/>

						<ExplanationBlock label="주의할 점" text={selectedMetric.caution} />
					</div>
				</Modal>
			)}
		</div>
	);
}

function formatContentDate(value: unknown) {
	const raw = String(value ?? "").trim();
	if (!raw || raw === "날짜 확인") return "날짜 확인";
	if (/^\d{8}$/.test(raw)) {
		return raw.slice(0, 4) + "." + raw.slice(4, 6) + "." + raw.slice(6, 8);
	}
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) return raw;
	return (
		parsed.getFullYear() +
		"." +
		String(parsed.getMonth() + 1).padStart(2, "0") +
		"." +
		String(parsed.getDate()).padStart(2, "0")
	);
}

function cleanContentTitle(value: unknown, source = "") {
	let title = translateMarketText(
		String(value ?? "")
			.replace(/\s+/g, " ")
			.trim(),
	);
	title = title.replace(/^\[[^\]]+\]\s*/, "").trim();
	if (source) {
		const suffix = " - " + source;
		if (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
	}
	return title || "제목 확인 필요";
}

function filingPlainSummary(item: AnyObj | undefined) {
	if (!item) return "최근 확인된 공시가 없습니다.";
	const title = String(
		item.title ?? item.report_nm ?? item.report ?? item.form ?? "",
	).trim();
	if (title.includes("공시 전체보기") || title.includes("공식 전자공시 검색")) {
		return "DART에서 이 종목의 전체 공시 원문을 확인할 수 있습니다.";
	}
	if (/주주총회|주총/.test(title))
		return "주주총회 개최 또는 관련 일정이 공시되었습니다.";
	if (/현금.*배당|배당.*결정|배당금/.test(title))
		return "주주 배당과 관련된 내용이 공시되었습니다.";
	if (/유상증자/.test(title))
		return "유상증자 계획 또는 진행 내용이 공시되었습니다.";
	if (/무상증자/.test(title))
		return "무상증자 계획 또는 진행 내용이 공시되었습니다.";
	if (/자기주식|자사주/.test(title))
		return "자사주 취득·처분과 관련된 내용이 공시되었습니다.";
	if (/단일판매|공급계약|수주/.test(title))
		return "신규 계약 또는 수주 관련 내용이 공시되었습니다.";
	if (/잠정.*실적|영업.*실적|매출액.*손익/.test(title))
		return "최근 경영실적과 관련된 내용이 공시되었습니다.";
	if (/사업보고서/.test(title))
		return "사업보고서가 제출되어 회사의 주요 실적과 현황을 확인할 수 있습니다.";
	if (/분기보고서/.test(title))
		return "분기보고서가 제출되어 최근 분기 실적을 확인할 수 있습니다.";
	if (/반기보고서/.test(title))
		return "반기보고서가 제출되어 상반기 실적을 확인할 수 있습니다.";
	if (/최대주주/.test(title))
		return "최대주주 또는 주요 지분 변동 내용이 공시되었습니다.";
	if (/소송|가처분/.test(title))
		return "소송 또는 법적 절차와 관련된 내용이 공시되었습니다.";
	const shortTitle = title.length > 58 ? title.slice(0, 58) + "…" : title;
	return shortTitle
		? shortTitle + " 관련 공시가 등록되었습니다."
		: "최근 공시 원문이 등록되었습니다.";
}

function newsPlainSummary(item: AnyObj | undefined) {
	if (!item) return "최근 확인된 관련 뉴스가 없습니다.";
	const source = String(
		item.source ?? item.publisher ?? item.provider ?? "",
	).trim();
	const title = cleanContentTitle(
		item.translatedTitle ?? item.title ?? item.headline,
		source,
	);
	const shortTitle = title.length > 68 ? title.slice(0, 68) + "…" : title;
	return shortTitle + " 관련 소식입니다.";
}

function FilingTab({
	market,
	filings,
	summary,
}: {
	market: Market;
	filings: AnyObj[];
	summary: string;
}) {
	const source = market === "KR" ? "DART" : "SEC EDGAR";
	const summaryLines = filings.slice(0, 3).map(filingPlainSummary);
	const recentSummary =
		summaryLines[0] ?? summary ?? "최근 공시 요약 데이터가 부족합니다.";

	return (
		<div className="space-y-3">
			<SectionCard title="최근 공시 요약" subtitle={source + " 최신 공시 기준"}>
				<InfoBox>{recentSummary}</InfoBox>
			</SectionCard>

			<SectionCard
				title="공시 원문"
				subtitle={
					market === "KR"
						? "불러온 전체 공시를 날짜순으로 보여주며 금융감독원 DART 원문으로 연결합니다."
						: "불러온 전체 공시를 날짜순으로 보여주며 SEC EDGAR 원문으로 연결합니다."
				}
			>
				{filings.length ? (
					<div className="space-y-2">
						{filings.map((item, index) => {
							const title = cleanContentTitle(
								item.translatedTitle ??
									item.title ??
									item.report_nm ??
									item.report ??
									item.form ??
									"공시 제목 확인 필요",
							);
							const form = String(
								item.form ?? item.formType ?? item.reportType ?? "",
							).trim();
							const date = formatContentDate(
								item.date ??
									item.filingDate ??
									item.rcept_dt ??
									item.acceptedAt,
							);
							const url = filingOriginalUrl(item, market);

							return (
								<article
									key={
										String(
											item.rcept_no ?? item.accessionNumber ?? url ?? title,
										) +
										":" +
										index
									}
									className="rounded-xl border border-card-border bg-secondary/50 p-3"
								>
									<p className="break-words text-sm font-extrabold leading-6">
										{title}
									</p>
									<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
										<span className="text-[10px] font-bold text-muted-foreground">
											{date}
										</span>
										<span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-extrabold text-primary">
											{source}
										</span>
										{form && (
											<span className="rounded-full bg-background px-2 py-1 text-[10px] font-bold text-muted-foreground">
												{form}
											</span>
										)}
									</div>
									<p className="mt-2 break-words rounded-lg bg-background/70 px-3 py-2 text-xs font-semibold leading-5 text-muted-foreground">
										{filingPlainSummary(item)}
									</p>
									{url ? (
										<a
											href={url}
											target="_blank"
											rel="noopener noreferrer"
											className="mt-3 flex w-full items-center justify-center rounded-xl bg-primary px-3 py-2.5 text-xs font-extrabold text-primary-foreground"
										>
											{source} 원문 보기
										</a>
									) : (
										<div className="mt-3 rounded-xl bg-background px-3 py-2.5 text-center text-xs font-bold text-muted-foreground">
											원문 주소 데이터가 없습니다.
										</div>
									)}
								</article>
							);
						})}
					</div>
				) : (
					<p className="text-sm font-bold text-muted-foreground">
						최근 확인된 공시가 없습니다.
					</p>
				)}
			</SectionCard>

			<SectionCard
				title="공시 간단요약"
				subtitle="최근 공시를 쉬운 문장으로 정리했습니다."
			>
				{summaryLines.length ? (
					<SummaryItems items={summaryLines} />
				) : (
					<InfoBox>{summary || "최근 공시 요약 데이터가 부족합니다."}</InfoBox>
				)}
			</SectionCard>
		</div>
	);
}

function NewsTab({ news, summary }: { news: AnyObj[]; summary: string }) {
	const summaryLines = news.slice(0, 3).map(newsPlainSummary);
	const recentSummary =
		summaryLines[0] ?? summary ?? "최근 뉴스 요약 데이터가 부족합니다.";

	return (
		<div className="space-y-3">
			<SectionCard
				title="최근 뉴스 요약"
				subtitle="해당 종목 관련 최신 기사 기준"
			>
				<InfoBox>{recentSummary}</InfoBox>
			</SectionCard>

			<SectionCard
				title="관련 뉴스"
				subtitle="제목과 출처를 보기 쉽게 정리했으며 버튼을 누르면 기사 원문으로 이동합니다."
			>
				{news.length ? (
					<div className="space-y-2">
						{news.slice(0, 30).map((item, index) => {
							const source = String(
								item.source ?? item.publisher ?? item.provider ?? "출처 확인",
							).trim();
							const title = cleanContentTitle(
								item.translatedTitle ??
									item.title ??
									item.headline ??
									"뉴스 제목 확인 필요",
								source,
							);
							const url = articleOriginalUrl(item);
							const date = formatContentDate(
								item.date ?? item.time ?? item.publishedAt ?? item.published_at,
							);
							const rawSummary = summarizeText(
								item.translatedSummary ??
									item.summary ??
									item.description ??
									item.snippet ??
									"",
								"",
							);
							const summaryText =
								rawSummary && cleanContentTitle(rawSummary, source) !== title
									? cleanContentTitle(rawSummary, source)
									: newsPlainSummary(item);

							return (
								<article
									key={String(url ?? title) + ":" + index}
									className="rounded-xl border border-card-border bg-secondary/50 p-3"
								>
									<p className="w-full break-words text-[15px] font-extrabold leading-6">
										{title}
									</p>
									<div className="mt-2 flex flex-wrap items-center gap-1.5">
										<span className="text-[10px] font-bold text-muted-foreground">
											{source}
										</span>
										<span className="text-[10px] font-bold text-muted-foreground">
											· {date}
										</span>
										<span className="max-w-full truncate rounded-full bg-primary/10 px-2 py-1 text-[10px] font-extrabold text-primary">
											{eventLabelKo(title)}
										</span>
									</div>
									<p className="mt-2 break-words rounded-lg bg-background/70 px-3 py-2 text-xs font-semibold leading-5 text-muted-foreground">
										{summaryText}
									</p>
									{url ? (
										<a
											href={url}
											target="_blank"
											rel="noopener noreferrer"
											className="mt-3 flex w-full items-center justify-center rounded-xl bg-primary px-3 py-2.5 text-xs font-extrabold text-primary-foreground"
										>
											기사 원문 보기
										</a>
									) : (
										<div className="mt-3 rounded-xl bg-background px-3 py-2.5 text-center text-xs font-bold text-muted-foreground">
											기사 링크 데이터가 없습니다.
										</div>
									)}
								</article>
							);
						})}
					</div>
				) : (
					<p className="text-sm font-bold text-muted-foreground">
						최근 관련 뉴스가 없습니다.
					</p>
				)}
			</SectionCard>

			<SectionCard
				title="뉴스 간단요약"
				subtitle="최근 기사 핵심을 짧게 정리했습니다."
			>
				{summaryLines.length ? (
					<SummaryItems items={summaryLines} />
				) : (
					<InfoBox>{summary || "최근 뉴스 요약 데이터가 부족합니다."}</InfoBox>
				)}
			</SectionCard>
		</div>
	);
}

function MiniMetric({
	label,
	value,
	valueClassName,
}: {
	label: string;
	value: string;
	valueClassName?: string;
}) {
	return (
		<div className="min-w-0 rounded-xl bg-secondary/70 px-2 py-2 text-center">
			<p className="truncate text-[9px] font-bold text-muted-foreground">
				{label}
			</p>

			<p className={cn("mt-1 truncate text-xs font-extrabold", valueClassName)}>
				{value}
			</p>
		</div>
	);
}

function SignalBox({
	label,
	text,
	positive = false,
	compact = false,
}: {
	label: string;
	text: string;
	positive?: boolean;
	compact?: boolean;
}) {
	return (
		<div
			className={cn(
				"rounded-xl border px-2.5 py-2",
				compact && "min-w-0 px-2 py-2 text-center",

				positive
					? "border-positive/30 bg-positive/5"
					: "border-destructive/30 bg-destructive/5",
			)}
		>
			<p
				className={cn(
					"text-[9px] font-extrabold",

					positive ? "text-positive" : "text-destructive",
				)}
			>
				{label}
			</p>

			<p
				className={cn(
					"mt-1 break-keep text-[10px] font-semibold leading-4 text-muted-foreground",
					compact && "line-clamp-3 text-[9px] leading-3.5",
				)}
			>
				{text}
			</p>
		</div>
	);
}

function SummaryCard({ title, items }: { title: string; items: string[] }) {
	return (
		<SectionCard title={title}>
			<SummaryItems items={items} />
		</SectionCard>
	);
}

function SummaryItems({ items }: { items: string[] }) {
	return items?.length ? (
		<div className="space-y-2">
			{items.slice(0, 5).map((item, index) => (
				<p
					key={`${item}:${index}`}
					className="rounded-xl bg-secondary/60 px-3 py-2 text-xs font-semibold leading-5 text-muted-foreground"
				>
					{item}
				</p>
			))}
		</div>
	) : (
		<p className="text-sm font-bold text-muted-foreground">
			분석 데이터가 부족합니다.
		</p>
	);
}

function CollapsibleSection({
	title,
	open,
	onToggle,
	children,
}: {
	title: string;
	open: boolean;
	onToggle: () => void;
	children: ReactNode;
}) {
	return (
		<section className="overflow-hidden rounded-2xl border border-card-border bg-card shadow-sm">
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				className="flex w-full items-center justify-between px-4 py-3 text-left"
			>
				<span className="text-base font-extrabold">{title}</span>
				<span className="flex items-center gap-2 text-[10px] font-extrabold text-primary">
					{open ? "접기" : "열기"}
					<span
						className={cn(
							"text-base transition-transform",
							open && "rotate-180",
						)}
					>
						⌄
					</span>
				</span>
			</button>
			{open && (
				<div className="border-t border-card-border p-3">{children}</div>
			)}
		</section>
	);
}

function PlanRow({
	label,
	value,
	negative = false,
	onClick,
}: {
	label: string;
	value: string;
	negative?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="w-full rounded-xl border border-card-border bg-secondary/55 p-3 text-left transition active:scale-[0.99]"
		>
			<div className="flex items-start justify-between gap-3">
				<p className="text-xs font-extrabold">{label}</p>

				<p
					className={cn(
						"shrink-0 text-sm font-extrabold",

						negative ? "text-destructive" : "text-primary",
					)}
				>
					{value}
				</p>
			</div>

			<p className="mt-2 break-keep text-[10px] font-semibold leading-4 text-muted-foreground">
				눌러서 진입 근거와 확인 조건 보기
			</p>
		</button>
	);
}

function InfoBox({ children }: { children: ReactNode }) {
	return (
		<div className="mt-2 break-keep rounded-xl bg-secondary/70 p-3 text-xs font-semibold leading-5 text-muted-foreground">
			{children}
		</div>
	);
}

function FinancialTrendCard({
	label,
	values,
	periods,
	currency,
	color,
}: {
	label: string;
	values: Array<number | null>;
	periods: string[];
	currency: Currency;
	color: string;
}) {
	const available = values.filter(
		(value): value is number => value != null && Number.isFinite(value),
	);
	const maximum = Math.max(...available.map((value) => Math.abs(value)), 1);
	const latest = [...values].reverse().find((value) => value != null) ?? null;
	const first = values.find((value) => value != null) ?? null;
	const growing = latest != null && first != null && latest >= first;

	return (
		<div className="rounded-2xl border border-card-border bg-secondary/35 p-3">
			<div className="flex items-start justify-between gap-2">
				<div>
					<p className="text-sm font-extrabold">{label}</p>
					<p className="mt-1 text-base font-extrabold">
						{formatCompactMoney(latest, currency)}
					</p>
				</div>
				<span
					className={cn(
						"rounded-full px-2 py-1 text-[9px] font-extrabold",
						growing
							? "bg-positive/10 text-positive"
							: "bg-destructive/10 text-destructive",
					)}
				>
					{growing ? "↗ 증가 흐름" : "↘ 감소 흐름"}
				</span>
			</div>

			<div className="mt-4 flex h-28 items-end gap-2">
				{values.map((value, index) => {
					const height =
						value == null ? 4 : Math.max(10, (Math.abs(value) / maximum) * 88);

					return (
						<div
							key={`${periods[index]}:${index}`}
							className="flex min-w-0 flex-1 flex-col items-center justify-end"
						>
							<p className="mb-1 max-w-full truncate text-[8px] font-bold text-muted-foreground">
								{formatCompactMoney(value, currency)}
							</p>
							<div
								className={cn("w-full rounded-t-lg opacity-85", color)}
								style={{ height: `${height}px` }}
							/>
							<p className="mt-1 max-w-full truncate text-[8px] font-bold text-muted-foreground">
								{periods[index]}
							</p>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function ExplanationBlock({ label, text }: { label: string; text: string }) {
	return (
		<div className="rounded-xl bg-secondary/60 p-3">
			<p className="text-[10px] font-extrabold text-primary">{label}</p>

			<p className="mt-1 break-keep text-xs font-semibold leading-5 text-muted-foreground">
				{text}
			</p>
		</div>
	);
}

function Modal({
	title,
	subtitle,
	onClose,
	children,
}: {
	title: string;
	subtitle?: string;
	onClose: () => void;
	children: ReactNode;
}) {
	return (
		<div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-3 sm:items-center">
			<button
				type="button"
				aria-label="닫기"
				onClick={onClose}
				className="absolute inset-0"
			/>

			<section className="relative z-10 flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-card-border bg-card p-4 shadow-2xl">
				<div className="flex items-start justify-between gap-3">
					<div>
						<h3 className="text-lg font-extrabold">{title}</h3>

						{subtitle && (
							<p className="mt-1 text-sm font-bold text-primary">{subtitle}</p>
						)}
					</div>

					<button
						type="button"
						onClick={onClose}
						className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-lg font-bold text-muted-foreground"
					>
						×
					</button>
				</div>

				<div className="mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain break-keep pr-1 text-sm font-semibold leading-6 text-muted-foreground">
					{children}
				</div>
			</section>
		</div>
	);
}

