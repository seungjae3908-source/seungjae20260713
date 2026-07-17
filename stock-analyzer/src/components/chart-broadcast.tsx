import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
	Activity,
	BarChart3,
	ChevronDown,
	ChevronUp,
	CirclePause,
	CirclePlay,
	Gauge,
	Loader2,
	RefreshCw,
	Search,
	Settings2,
	ShieldAlert,
	Target,
	TrendingDown,
	TrendingUp,
	X,
} from "lucide-react";
import {
	ColorType,
	CrosshairMode,
	LineStyle,
	createChart,
	type IChartApi,
	type ISeriesApi,
	type Time,
	type UTCTimestamp,
} from "lightweight-charts";
import { authorizedFetch } from "@/lib/auth-fetch";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export type ChartBroadcastMarket = "KR" | "US";

type AnyObj = Record<string, any>;
type ChartTimeframe =
	| "1m"
	| "3m"
	| "5m"
	| "15m"
	| "30m"
	| "1H"
	| "4H"
	| "1D"
	| "5D"
	| "20D";

type OverlayKey =
	| "ma5"
	| "ma20"
	| "ma60"
	| "ma120"
	| "bollinger"
	| "vwap"
	| "volume"
	| "levels"
	| "arrows"
	| "rsi"
	| "macd"
	| "atr";

type SignalKind =
	| "ENTER"
	| "WATCH"
	| "HOLD"
	| "TAKE_PROFIT"
	| "EXIT"
	| "STOP";

type CandlePoint = {
	time: UTCTimestamp;
	sourceTime: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
};

type SearchRow = {
	ticker: string;
	name: string;
	market: ChartBroadcastMarket;
	currency: "KRW" | "USD";
	price: number | null;
	changePercent: number | null;
};

type LevelSnapshot = {
	support1: number;
	support2: number;
	resistance1: number;
	resistance2: number;
	breakoutLevel: number | null;
	breakdownLevel: number | null;
};

type MarketContext = {
	label: string;
	changePercent: number;
	bias: number;
	sources: string[];
};

type TechnicalSnapshot = {
	currentPrice: number;
	previousClose: number;
	changePercent: number;
	sma5: number | null;
	sma20: number | null;
	sma60: number | null;
	sma120: number | null;
	rsi: number | null;
	macd: number | null;
	macdSignal: number | null;
	atr: number;
	volumeRatio: number;
	trend: "상승" | "중립" | "하락";
	levels: LevelSnapshot;
	patterns: string[];
	bullishPatternScore: number;
	bearishPatternScore: number;
	marketLabel: string;
	marketChangePercent: number;
	marketBias: number;
};

type LiveOpinion = {
	signal: SignalKind;
	title: string;
	summary: string;
	confidence: number;
	entryPrice: number;
	targetPrice: number;
	stopPrice: number;
	event: string;
};

type FeedItem = {
	id: string;
	at: Date;
	signal: SignalKind;
	text: string;
};

type ChartPayload = {
	ticker: string;
	timeframe: string;
	provider?: string;
	fetchedAt?: string;
	updatedAt?: string;
	candles: AnyObj[];
	signals?: AnyObj[];
	indicators?: AnyObj;
};

export type ChartBroadcastSignal = {
	ticker: string;
	market: ChartBroadcastMarket;
	signal: SignalKind;
	confidence: number;
	title: string;
	summary: string;
	currentPrice: number;
	marketBias: number;
	patterns: string[];
	generatedAt: string;
};

type Props = {
	market: ChartBroadcastMarket;
	onSignalChange?: (signal: ChartBroadcastSignal) => void;
};

const TIMEFRAMES: Array<{ key: ChartTimeframe; label: string }> = [
	{ key: "1m", label: "1분" },
	{ key: "3m", label: "3분" },
	{ key: "5m", label: "5분" },
	{ key: "15m", label: "15분" },
	{ key: "30m", label: "30분" },
	{ key: "1H", label: "1시간" },
	{ key: "4H", label: "4시간" },
	{ key: "1D", label: "1일" },
	{ key: "5D", label: "5일" },
	{ key: "20D", label: "20일" },
];

const OVERLAYS: Array<{
	key: OverlayKey;
	label: string;
	group: "차트선" | "신호" | "보조지표";
}> = [
	{ key: "ma5", label: "5이평", group: "차트선" },
	{ key: "ma20", label: "20이평", group: "차트선" },
	{ key: "ma60", label: "60이평", group: "차트선" },
	{ key: "ma120", label: "120이평", group: "차트선" },
	{ key: "bollinger", label: "볼린저밴드", group: "차트선" },
	{ key: "vwap", label: "VWAP", group: "차트선" },
	{ key: "volume", label: "거래량", group: "차트선" },
	{ key: "levels", label: "지지·저항", group: "신호" },
	{ key: "arrows", label: "매수·매도 화살표", group: "신호" },
	{ key: "rsi", label: "RSI", group: "보조지표" },
	{ key: "macd", label: "MACD", group: "보조지표" },
	{ key: "atr", label: "ATR", group: "보조지표" },
];

const DEFAULT_OVERLAYS: Record<OverlayKey, boolean> = {
	ma5: true,
	ma20: true,
	ma60: false,
	ma120: false,
	bollinger: false,
	vwap: false,
	volume: true,
	levels: true,
	arrows: true,
	rsi: true,
	macd: true,
	atr: false,
};

const DEFAULT_STOCKS: Record<ChartBroadcastMarket, SearchRow> = {
	KR: {
		ticker: "005930",
		name: "삼성전자",
		market: "KR",
		currency: "KRW",
		price: null,
		changePercent: null,
	},
	US: {
		ticker: "AAPL",
		name: "애플",
		market: "US",
		currency: "USD",
		price: null,
		changePercent: null,
	},
};

function finite(value: unknown): number | null {
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

function marketOf(ticker: string, raw?: unknown): ChartBroadcastMarket {
	if (raw === "US") return "US";
	if (raw === "KR") return "KR";
	return /^\d{6}$/.test(ticker) ? "KR" : "US";
}

function currencyOf(market: ChartBroadcastMarket, raw?: unknown): "KRW" | "USD" {
	if (raw === "USD") return "USD";
	if (raw === "KRW") return "KRW";
	return market === "KR" ? "KRW" : "USD";
}

function normalizeSearchRows(payload: AnyObj, market: ChartBroadcastMarket): SearchRow[] {
	const source = Array.isArray(payload?.results)
		? payload.results
		: Array.isArray(payload?.rows)
			? payload.rows
			: [];

	return source
		.map((row: AnyObj) => {
			const ticker = String(row?.ticker ?? row?.symbol ?? "")
				.trim()
				.toUpperCase();
			if (!ticker) return null;
			const rowMarket = marketOf(ticker, row?.market);
			if (rowMarket !== market) return null;
			return {
				ticker,
				name: String(row?.name ?? row?.companyName ?? ticker).trim() || ticker,
				market: rowMarket,
				currency: currencyOf(rowMarket, row?.currency),
				price: finite(row?.price ?? row?.currentPrice ?? row?.close),
				changePercent: finite(row?.changePercent ?? row?.changeRate),
			} satisfies SearchRow;
		})
		.filter((row: SearchRow | null): row is SearchRow => row != null)
		.slice(0, 20);
}

function timeframeSeconds(timeframe: ChartTimeframe): number {
	const map: Record<ChartTimeframe, number> = {
		"1m": 60,
		"3m": 180,
		"5m": 300,
		"15m": 900,
		"30m": 1800,
		"1H": 3600,
		"4H": 14400,
		"1D": 86400,
		"5D": 432000,
		"20D": 1728000,
	};
	return map[timeframe];
}

function parseCompactDate(value: string): number | null {
	const digits = value.replace(/\D/g, "");
	if (digits.length < 8) return null;
	const year = Number(digits.slice(0, 4));
	const month = Number(digits.slice(4, 6)) - 1;
	const day = Number(digits.slice(6, 8));
	const hour = digits.length >= 10 ? Number(digits.slice(8, 10)) : 0;
	const minute = digits.length >= 12 ? Number(digits.slice(10, 12)) : 0;
	const second = digits.length >= 14 ? Number(digits.slice(12, 14)) : 0;
	const timestamp = Date.UTC(year, month, day, hour, minute, second);
	return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function candleTime(
	raw: unknown,
	index: number,
	total: number,
	timeframe: ChartTimeframe,
): UTCTimestamp {
	if (typeof raw === "number" && Number.isFinite(raw)) {
		if (raw > 10_000_000_000) return Math.floor(raw / 1000) as UTCTimestamp;
		if (raw > 1_000_000_000) return Math.floor(raw) as UTCTimestamp;
	}

	const text = String(raw ?? "").trim();
	if (text) {
		if (/^\d{8,14}$/.test(text)) {
			const parsed = parseCompactDate(text);
			if (parsed != null) return parsed as UTCTimestamp;
		}
		const numeric = Number(text);
		if (Number.isFinite(numeric) && numeric > 1_000_000_000) {
			return Math.floor(numeric > 10_000_000_000 ? numeric / 1000 : numeric) as UTCTimestamp;
		}
		const parsed = Date.parse(text);
		if (Number.isFinite(parsed)) return Math.floor(parsed / 1000) as UTCTimestamp;
	}

	const end = Math.floor(Date.now() / 1000);
	return (end - Math.max(total - index - 1, 0) * timeframeSeconds(timeframe)) as UTCTimestamp;
}

function normalizeCandles(rows: AnyObj[], timeframe: ChartTimeframe): CandlePoint[] {
	const normalized = rows
		.map((row, index) => {
			const close = finite(
				row?.close ?? row?.closePrice ?? row?.cur_prc ?? row?.currentPrice ?? row?.price,
			);
			const open = finite(row?.open ?? row?.openPrice ?? row?.open_prc ?? close);
			const high = finite(row?.high ?? row?.highPrice ?? row?.high_prc ?? open ?? close);
			const low = finite(row?.low ?? row?.lowPrice ?? row?.low_prc ?? open ?? close);
			const volume = finite(
				row?.volume ?? row?.acc_trde_qty ?? row?.tradeVolume ?? row?.tradingVolume ?? 0,
			);
			if (close == null || open == null || high == null || low == null) return null;

			const sourceTime = String(
				row?.time ?? row?.date ?? row?.datetime ?? row?.timestamp ?? row?.dt ?? "",
			);
			return {
				time: candleTime(sourceTime, index, rows.length, timeframe),
				sourceTime,
				open,
				high: Math.max(high, open, close),
				low: Math.min(low, open, close),
				close,
				volume: Math.max(volume ?? 0, 0),
			} satisfies CandlePoint;
		})
		.filter((row: CandlePoint | null): row is CandlePoint => row != null)
		.sort((a, b) => Number(a.time) - Number(b.time));

	return [...new Map(normalized.map((row) => [Number(row.time), row])).values()];
}

async function fetchChart(ticker: string, timeframe: ChartTimeframe): Promise<ChartPayload> {
	const encodedTicker = encodeURIComponent(ticker);
	const encodedFrame = encodeURIComponent(timeframe);
	const urls = [
		`/api/stocks/${encodedTicker}/chart?tf=${encodedFrame}`,
		`/api/stocks/${encodedTicker}/candles?tf=${encodedFrame}`,
	];

	let lastError = "차트 데이터를 불러오지 못했습니다.";
	for (const url of urls) {
		try {
			const response = await authorizedFetch(url, { cache: "no-store" });
			const payload = (await response.json().catch(() => ({}))) as AnyObj;
			if (!response.ok) {
				lastError = String(payload?.message ?? payload?.error ?? `HTTP ${response.status}`);
				continue;
			}
			const candles = Array.isArray(payload?.candles)
				? payload.candles
				: Array.isArray(payload?.data?.candles)
					? payload.data.candles
					: Array.isArray(payload?.items)
						? payload.items
						: [];
			return {
				ticker,
				timeframe: String(payload?.timeframe ?? timeframe),
				provider: payload?.provider,
				fetchedAt: payload?.fetchedAt,
				updatedAt: payload?.updatedAt,
				candles,
				signals: Array.isArray(payload?.signals) ? payload.signals : [],
				indicators: payload?.indicators,
			};
		} catch (error) {
			lastError = error instanceof Error ? error.message : lastError;
		}
	}
	throw new Error(lastError);
}

async function fetchMarketContext(market: ChartBroadcastMarket): Promise<MarketContext> {
	const tickers = market === "KR" ? ["^KS11", "^KQ11"] : ["^GSPC", "^IXIC"];
	const response = await authorizedFetch(`/api/quotes?tickers=${encodeURIComponent(tickers.join(","))}`, { cache: "no-store" });
	const payload = (await response.json().catch(() => ({}))) as AnyObj;
	if (!response.ok) throw new Error(String(payload?.message ?? payload?.error ?? `HTTP_${response.status}`));
	const source = Array.isArray(payload?.quotes)
		? payload.quotes
		: Array.isArray(payload?.rows)
			? payload.rows
			: Array.isArray(payload?.data)
				? payload.data
				: [];
	const changes = source
		.map((row: AnyObj) => Number(row?.changePercent ?? row?.change_pct ?? row?.flu_rt ?? row?.changeRate))
		.filter((value: number) => Number.isFinite(value));
	const averageChange = changes.length ? changes.reduce((sum: number, value: number) => sum + value, 0) / changes.length : 0;
	return {
		label: market === "KR" ? "코스피·코스닥" : "S&P500·나스닥",
		changePercent: averageChange,
		bias: clamp(averageChange * 4, -10, 10),
		sources: tickers,
	};
}

function average(values: number[]): number | null {
	if (!values.length) return null;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sma(values: number[], period: number): number | null {
	if (values.length < period) return null;
	return average(values.slice(-period));
}

function ema(values: number[], period: number): number | null {
	if (values.length < period) return null;
	const multiplier = 2 / (period + 1);
	let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
	for (let index = period; index < values.length; index += 1) {
		value = (values[index] - value) * multiplier + value;
	}
	return value;
}

function rsi(values: number[], period = 14): number | null {
	if (values.length <= period) return null;
	const changes = values
		.slice(1)
		.map((value, index) => value - values[index])
		.slice(-period);
	const gain = changes.reduce((sum, value) => sum + Math.max(value, 0), 0) / period;
	const loss = changes.reduce((sum, value) => sum + Math.max(-value, 0), 0) / period;
	if (loss === 0) return 100;
	return 100 - 100 / (1 + gain / loss);
}

function atr(candles: CandlePoint[], period = 14): number {
	if (candles.length < 2) return 0;
	const rows = candles.slice(-(period + 1));
	const ranges: number[] = [];
	for (let index = 1; index < rows.length; index += 1) {
		const current = rows[index];
		const previous = rows[index - 1];
		ranges.push(
			Math.max(
				current.high - current.low,
				Math.abs(current.high - previous.close),
				Math.abs(current.low - previous.close),
			),
		);
	}
	return average(ranges) ?? 0;
}

function seriesSma(candles: CandlePoint[], period: number) {
	const rows: Array<{ time: Time; value: number }> = [];
	for (let index = period - 1; index < candles.length; index += 1) {
		const value = average(candles.slice(index - period + 1, index + 1).map((row) => row.close));
		if (value != null) rows.push({ time: candles[index].time, value });
	}
	return rows;
}

function seriesBollinger(candles: CandlePoint[], period = 20, multiplier = 2) {
	const upper: Array<{ time: Time; value: number }> = [];
	const middle: Array<{ time: Time; value: number }> = [];
	const lower: Array<{ time: Time; value: number }> = [];
	for (let index = period - 1; index < candles.length; index += 1) {
		const values = candles.slice(index - period + 1, index + 1).map((row) => row.close);
		const mean = average(values);
		if (mean == null) continue;
		const variance = average(values.map((value) => (value - mean) ** 2)) ?? 0;
		const deviation = Math.sqrt(variance);
		upper.push({ time: candles[index].time, value: mean + deviation * multiplier });
		middle.push({ time: candles[index].time, value: mean });
		lower.push({ time: candles[index].time, value: mean - deviation * multiplier });
	}
	return { upper, middle, lower };
}

function seriesVwap(candles: CandlePoint[]) {
	let cumulativeValue = 0;
	let cumulativeVolume = 0;
	return candles
		.map((row) => {
			const typical = (row.high + row.low + row.close) / 3;
			cumulativeValue += typical * row.volume;
			cumulativeVolume += row.volume;
			if (cumulativeVolume <= 0) return null;
			return { time: row.time as Time, value: cumulativeValue / cumulativeVolume };
		})
		.filter((row): row is { time: Time; value: number } => row != null);
}

function clusterLevels(values: number[], tolerance = 0.0035): number[] {
	const sorted = [...values].sort((a, b) => a - b);
	const clusters: number[][] = [];
	for (const value of sorted) {
		const current = clusters.at(-1);
		if (!current) {
			clusters.push([value]);
			continue;
		}
		const center = average(current) ?? value;
		if (Math.abs(value - center) / Math.max(center, 1) <= tolerance) current.push(value);
		else clusters.push([value]);
	}
	return clusters
		.filter((cluster) => cluster.length >= 1)
		.map((cluster) => average(cluster) ?? cluster[0]);
}

function detectLevels(candles: CandlePoint[]): LevelSnapshot {
	const latest = candles.at(-1)!;
	const history = candles.slice(-141, -1);
	const highs: number[] = [];
	const lows: number[] = [];

	for (let index = 2; index < history.length - 2; index += 1) {
		const row = history[index];
		if (
			row.high >= history[index - 1].high &&
			row.high >= history[index - 2].high &&
			row.high >= history[index + 1].high &&
			row.high >= history[index + 2].high
		) {
			highs.push(row.high);
		}
		if (
			row.low <= history[index - 1].low &&
			row.low <= history[index - 2].low &&
			row.low <= history[index + 1].low &&
			row.low <= history[index + 2].low
		) {
			lows.push(row.low);
		}
	}

	if (!highs.length) highs.push(...history.slice(-40).map((row) => row.high));
	if (!lows.length) lows.push(...history.slice(-40).map((row) => row.low));

	const highLevels = clusterLevels(highs);
	const lowLevels = clusterLevels(lows);
	const current = latest.close;
	const fallbackAtr = Math.max(atr(candles), current * 0.008);
	const supports = lowLevels.filter((value) => value < current).sort((a, b) => b - a);
	const resistances = highLevels.filter((value) => value > current).sort((a, b) => a - b);
	const crossedHighs = highLevels.filter((value) => value <= current).sort((a, b) => b - a);
	const crossedLows = lowLevels.filter((value) => value >= current).sort((a, b) => a - b);

	return {
		support1: supports[0] ?? current - fallbackAtr,
		support2: supports[1] ?? current - fallbackAtr * 2,
		resistance1: resistances[0] ?? current + fallbackAtr,
		resistance2: resistances[1] ?? current + fallbackAtr * 2,
		breakoutLevel: crossedHighs[0] ?? null,
		breakdownLevel: crossedLows[0] ?? supports[0] ?? null,
	};
}

function detectChartPatterns(candles: CandlePoint[]) {
	const patterns: string[] = [];
	let bullishScore = 0;
	let bearishScore = 0;
	if (candles.length < 8) return { patterns, bullishScore, bearishScore };
	const latest = candles.at(-1)!;
	const previous = candles.at(-2)!;
	const body = Math.abs(latest.close - latest.open);
	const range = Math.max(latest.high - latest.low, Number.EPSILON);
	const lowerWick = Math.min(latest.open, latest.close) - latest.low;
	const upperWick = latest.high - Math.max(latest.open, latest.close);

	if (previous.close < previous.open && latest.close > latest.open && latest.open <= previous.close && latest.close >= previous.open) {
		patterns.push("상승 장악형");
		bullishScore += 8;
	}
	if (previous.close > previous.open && latest.close < latest.open && latest.open >= previous.close && latest.close <= previous.open) {
		patterns.push("하락 장악형");
		bearishScore += 8;
	}
	if (lowerWick > body * 2 && lowerWick > upperWick * 1.5 && latest.close > latest.open) {
		patterns.push("망치형 반등");
		bullishScore += 7;
	}
	if (upperWick > body * 2 && upperWick > lowerWick * 1.5 && latest.close < latest.open) {
		patterns.push("유성형 반락");
		bearishScore += 7;
	}
	if (body / range < 0.12) patterns.push("도지·방향 대기");

	const closes = candles.slice(-40).map((row) => row.close);
	const lows = closes
		.map((value, index) => ({ value, index }))
		.filter((row) => row.index > 0 && row.index < closes.length - 1 && row.value <= closes[row.index - 1] && row.value <= closes[row.index + 1]);
	const highs = closes
		.map((value, index) => ({ value, index }))
		.filter((row) => row.index > 0 && row.index < closes.length - 1 && row.value >= closes[row.index - 1] && row.value >= closes[row.index + 1]);
	if (lows.length >= 2) {
		const [left, right] = lows.slice(-2);
		if (right.index - left.index >= 4 && Math.abs(right.value - left.value) / Math.max(left.value, 1) < 0.012) {
			patterns.push("쌍바닥 후보");
			bullishScore += 9;
		}
	}
	if (highs.length >= 2) {
		const [left, right] = highs.slice(-2);
		if (right.index - left.index >= 4 && Math.abs(right.value - left.value) / Math.max(left.value, 1) < 0.012) {
			patterns.push("쌍봉 후보");
			bearishScore += 9;
		}
	}
	return { patterns: [...new Set(patterns)].slice(0, 5), bullishScore, bearishScore };
}

function technicalSnapshot(candles: CandlePoint[], marketContext: MarketContext): TechnicalSnapshot {
	const latest = candles.at(-1)!;
	const previous = candles.at(-2) ?? latest;
	const closes = candles.map((row) => row.close);
	const volumes = candles.map((row) => row.volume);
	const sma5 = sma(closes, 5);
	const sma20 = sma(closes, 20);
	const sma60 = sma(closes, 60);
	const sma120 = sma(closes, 120);
	const rsiValue = rsi(closes);
	const ema12 = ema(closes, 12);
	const ema26 = ema(closes, 26);
	const macd = ema12 != null && ema26 != null ? ema12 - ema26 : null;
	const macdValues: number[] = [];
	for (let index = 26; index <= closes.length; index += 1) {
		const fast = ema(closes.slice(0, index), 12);
		const slow = ema(closes.slice(0, index), 26);
		if (fast != null && slow != null) macdValues.push(fast - slow);
	}
	const macdSignal = ema(macdValues, 9);
	const averageVolume = average(volumes.slice(-21, -1));
	const volumeRatio = averageVolume && averageVolume > 0 ? latest.volume / averageVolume : 1;
	const upTrend =
		sma5 != null &&
		sma20 != null &&
		latest.close > sma5 &&
		sma5 > sma20 &&
		(sma60 == null || sma20 >= sma60 * 0.995);
	const downTrend =
		sma5 != null &&
		sma20 != null &&
		latest.close < sma5 &&
		sma5 < sma20 &&
		(sma60 == null || sma20 <= sma60 * 1.005);
	const patternSnapshot = detectChartPatterns(candles);

	return {
		currentPrice: latest.close,
		previousClose: previous.close,
		changePercent:
			previous.close !== 0 ? ((latest.close - previous.close) / previous.close) * 100 : 0,
		sma5,
		sma20,
		sma60,
		sma120,
		rsi: rsiValue,
		macd,
		macdSignal,
		atr: atr(candles),
		volumeRatio,
		trend: upTrend ? "상승" : downTrend ? "하락" : "중립",
		levels: detectLevels(candles),
		patterns: patternSnapshot.patterns,
		bullishPatternScore: patternSnapshot.bullishScore,
		bearishPatternScore: patternSnapshot.bearishScore,
		marketLabel: marketContext.label,
		marketChangePercent: marketContext.changePercent,
		marketBias: marketContext.bias,
	};
}

function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, value));
}

function buildOpinion(snapshot: TechnicalSnapshot): LiveOpinion {
	const { currentPrice, previousClose, rsi: rsiValue, volumeRatio, trend, levels } = snapshot;
	const buffer = Math.max(snapshot.atr * 0.12, currentPrice * 0.001);
	const breakout =
		levels.breakoutLevel != null &&
		previousClose <= levels.breakoutLevel &&
		currentPrice > levels.breakoutLevel + buffer &&
		volumeRatio >= 1.35;
	const breakdown =
		levels.breakdownLevel != null &&
		previousClose >= levels.breakdownLevel &&
		currentPrice < levels.breakdownLevel - buffer &&
		volumeRatio >= 1.15;
	const nearResistance = currentPrice >= levels.resistance1 * 0.995;
	const nearSupport = currentPrice <= levels.support1 * 1.005;
	const overbought = rsiValue != null && rsiValue >= 72;
	const oversold = rsiValue != null && rsiValue <= 30;

	let signal: SignalKind = "WATCH";
	let title = "진입 조건 대기";
	let summary = `${formatRawPrice(levels.resistance1)} 저항 돌파 또는 ${formatRawPrice(levels.support1)} 지지 반등을 확인하세요.`;

	if (breakdown) {
		signal = "STOP";
		title = "지지선 이탈 · 매도 우선";
		summary = `${formatRawPrice(levels.breakdownLevel!)} 지지선을 거래량과 함께 이탈했습니다. 봉 마감까지 회복하지 못하면 손절 또는 비중 축소가 우선입니다.`;
	} else if (breakout && !overbought) {
		signal = "ENTER";
		title = "돌파 진입 조건 충족";
		summary = `${formatRawPrice(levels.breakoutLevel!)} 저항을 거래량 ${volumeRatio.toFixed(1)}배로 돌파했습니다. 현재 봉이 돌파선 위에서 마감하면 분할 진입 신호입니다.`;
	} else if (nearResistance && overbought) {
		signal = "TAKE_PROFIT";
		title = "저항선 · 과열 구간";
		summary = `저항선 근처에서 RSI가 ${rsiValue?.toFixed(0)}입니다. 신규 추격보다 보유 물량 분할매도를 우선 확인하세요.`;
	} else if (trend === "상승" && nearSupport && !overbought) {
		signal = "ENTER";
		title = "지지선 반등 진입 후보";
		summary = `${formatRawPrice(levels.support1)} 지지선 부근에서 상승 추세가 유지됩니다. 반등 양봉과 거래량 증가가 확인되면 분할 진입 후보입니다.`;
	} else if (trend === "상승") {
		signal = "HOLD";
		title = "상승 추세 유지";
		summary = `단기 이동평균이 상승 배열입니다. ${formatRawPrice(levels.support1)} 이탈 전까지 보유 관점이며, ${formatRawPrice(levels.resistance1)} 돌파 시 추가 상승을 확인합니다.`;
	} else if (trend === "하락" && !oversold) {
		signal = "EXIT";
		title = "하락 추세 · 신규 진입 보류";
		summary = `단기 이동평균이 하락 배열입니다. 반등 시 비중 축소를 우선하고 ${formatRawPrice(levels.resistance1)} 회복 전까지 신규 진입을 보류합니다.`;
	} else if (oversold) {
		signal = "WATCH";
		title = "과매도 반등 관찰";
		summary = `RSI가 ${rsiValue?.toFixed(0)}로 과매도권입니다. 지지선 반등이 확인되기 전에는 하락 중 물타기를 피하세요.`;
	}

	const entryPrice =
		signal === "ENTER"
			? currentPrice
			: Math.max(currentPrice, levels.resistance1 + buffer);
	const stopByAtr = entryPrice - Math.max(snapshot.atr * 1.25, entryPrice * 0.008);
	const stopPrice = Math.min(levels.support1 - buffer, stopByAtr);
	const risk = Math.max(entryPrice - stopPrice, entryPrice * 0.005);
	const targetPrice = Math.max(levels.resistance2, entryPrice + risk * 1.8);
	const trendScore = trend === "상승" ? 18 : trend === "하락" ? -15 : 0;
	const volumeScore = clamp((volumeRatio - 1) * 18, -8, 20);
	const rsiScore =
		rsiValue == null ? 0 : rsiValue >= 42 && rsiValue <= 68 ? 10 : rsiValue >= 78 ? -12 : 0;
	const signalScore =
		signal === "ENTER" ? 20 : signal === "HOLD" ? 12 : signal === "STOP" ? -15 : 0;
	const patternScore = snapshot.bullishPatternScore - snapshot.bearishPatternScore;
	const directionAdjustedMarket = signal === "ENTER" || signal === "HOLD"
		? snapshot.marketBias
		: signal === "STOP" || signal === "EXIT" || signal === "TAKE_PROFIT"
			? -snapshot.marketBias
			: 0;
	const confidence = Math.round(clamp(52 + trendScore + volumeScore + rsiScore + signalScore + patternScore + directionAdjustedMarket, 5, 95));
	const marketText = `${snapshot.marketLabel} ${snapshot.marketChangePercent >= 0 ? "+" : ""}${snapshot.marketChangePercent.toFixed(2)}%`;
	const patternText = snapshot.patterns.length ? ` · 패턴 ${snapshot.patterns.join("/")}` : "";
	summary = `${summary} · 시장 ${marketText}${patternText}`;

	return {
		signal,
		title,
		summary,
		confidence,
		entryPrice,
		targetPrice,
		stopPrice,
		event: `${title}: ${summary}`,
	};
}

function formatRawPrice(value: number): string {
	if (!Number.isFinite(value)) return "확인 필요";
	return value >= 1000
		? Math.round(value).toLocaleString()
		: value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatPrice(value: number | null, market: ChartBroadcastMarket): string {
	if (value == null || !Number.isFinite(value)) return "확인 필요";
	if (market === "US") {
		return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	}
	return `${Math.round(value).toLocaleString()}원`;
}

function formatPercent(value: number | null): string {
	if (value == null || !Number.isFinite(value)) return "-";
	return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function signalLabel(signal: SignalKind): string {
	const labels: Record<SignalKind, string> = {
		ENTER: "진입",
		WATCH: "관찰",
		HOLD: "보유",
		TAKE_PROFIT: "분할매도",
		EXIT: "비중축소",
		STOP: "손절경고",
	};
	return labels[signal];
}

function signalClass(signal: SignalKind): string {
	if (signal === "ENTER" || signal === "HOLD") return "border-destructive/30 bg-destructive/10 text-destructive";
	if (signal === "STOP" || signal === "EXIT") return "border-blue-500/30 bg-blue-500/10 text-blue-500";
	if (signal === "TAKE_PROFIT") return "border-warning/30 bg-warning/10 text-warning";
	return "border-card-border bg-secondary text-muted-foreground";
}

function addLine(
	chart: IChartApi,
	data: Array<{ time: Time; value: number }>,
	options: AnyObj,
): ISeriesApi<"Line"> | null {
	if (!data.length) return null;
	const series = chart.addLineSeries(options);
	series.setData(data);
	return series;
}

function markerRows(candles: CandlePoint[], opinion: LiveOpinion) {
	const markers: AnyObj[] = [];
	const ma20 = seriesSma(candles, 20);
	const maByTime = new Map(ma20.map((row) => [Number(row.time), row.value]));

	for (let index = Math.max(20, candles.length - 70); index < candles.length; index += 1) {
		const previous = candles[index - 1];
		const current = candles[index];
		const previousMa = maByTime.get(Number(previous.time));
		const currentMa = maByTime.get(Number(current.time));
		if (previousMa == null || currentMa == null) continue;
		if (previous.close <= previousMa && current.close > currentMa) {
			markers.push({
				time: current.time,
				position: "belowBar",
				color: "#ef4444",
				shape: "arrowUp",
				text: "20이평 상향",
			});
		} else if (previous.close >= previousMa && current.close < currentMa) {
			markers.push({
				time: current.time,
				position: "aboveBar",
				color: "#3b82f6",
				shape: "arrowDown",
				text: "20이평 하향",
			});
		}
	}

	const latest = candles.at(-1);
	if (latest) {
		const isBuy = opinion.signal === "ENTER" || opinion.signal === "HOLD";
		markers.push({
			time: latest.time,
			position: isBuy ? "belowBar" : "aboveBar",
			color: isBuy ? "#ef4444" : "#3b82f6",
			shape: isBuy ? "arrowUp" : "arrowDown",
			text: signalLabel(opinion.signal),
		});
	}

	return markers.slice(-18);
}

function ChartCanvas({
	candles,
	timeframe,
	overlays,
	snapshot,
	opinion,
}: {
	candles: CandlePoint[];
	timeframe: ChartTimeframe;
	overlays: Record<OverlayKey, boolean>;
	snapshot: TechnicalSnapshot;
	opinion: LiveOpinion;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || candles.length < 2) return;
		const dark = document.documentElement.classList.contains("dark");
		const chart = createChart(container, {
			width: Math.max(container.clientWidth, 1),
			height: 390,
			layout: {
				background: { type: ColorType.Solid, color: "transparent" },
				textColor: dark ? "#94a3b8" : "#64748b",
				fontSize: 11,
			},
			grid: {
				vertLines: { color: dark ? "rgba(148,163,184,0.08)" : "rgba(100,116,139,0.10)" },
				horzLines: { color: dark ? "rgba(148,163,184,0.08)" : "rgba(100,116,139,0.10)" },
			},
			crosshair: { mode: CrosshairMode.Normal },
			rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: overlays.volume ? 0.22 : 0.08 } },
			timeScale: {
				borderVisible: false,
				timeVisible: /m|H/.test(timeframe),
				secondsVisible: false,
				rightOffset: 5,
				barSpacing: /m|H/.test(timeframe) ? 8 : 7,
			},
			handleScroll: true,
			handleScale: true,
		});

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
			candles.map((row) => ({
				time: row.time,
				open: row.open,
				high: row.high,
				low: row.low,
				close: row.close,
			})),
		);

		if (overlays.ma5) addLine(chart, seriesSma(candles, 5), { color: "#f59e0b", lineWidth: 1, title: "MA5" });
		if (overlays.ma20) addLine(chart, seriesSma(candles, 20), { color: "#8b5cf6", lineWidth: 2, title: "MA20" });
		if (overlays.ma60) addLine(chart, seriesSma(candles, 60), { color: "#10b981", lineWidth: 1, title: "MA60" });
		if (overlays.ma120) addLine(chart, seriesSma(candles, 120), { color: "#ec4899", lineWidth: 1, title: "MA120" });

		if (overlays.bollinger) {
			const band = seriesBollinger(candles);
			addLine(chart, band.upper, { color: "rgba(14,165,233,0.72)", lineWidth: 1, title: "BB 상단" });
			addLine(chart, band.middle, { color: "rgba(14,165,233,0.35)", lineWidth: 1, lineStyle: LineStyle.Dashed, title: "BB 중심" });
			addLine(chart, band.lower, { color: "rgba(14,165,233,0.72)", lineWidth: 1, title: "BB 하단" });
		}

		if (overlays.vwap) {
			addLine(chart, seriesVwap(candles), {
				color: "#06b6d4",
				lineWidth: 2,
				lineStyle: LineStyle.Dashed,
				title: "VWAP",
			});
		}

		if (overlays.volume) {
			const volumeSeries = chart.addHistogramSeries({
				priceFormat: { type: "volume" },
				priceScaleId: "volume",
				lastValueVisible: false,
				priceLineVisible: false,
			});
			volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
			volumeSeries.setData(
				candles.map((row) => ({
					time: row.time,
					value: row.volume,
					color: row.close >= row.open ? "rgba(239,68,68,0.42)" : "rgba(59,130,246,0.42)",
				})),
			);
		}

		if (overlays.levels) {
			const priceLines = [
				{ price: snapshot.levels.resistance2, color: "#f97316", title: "2차 저항", style: LineStyle.Dotted },
				{ price: snapshot.levels.resistance1, color: "#ef4444", title: "1차 저항", style: LineStyle.Dashed },
				{ price: snapshot.levels.support1, color: "#3b82f6", title: "1차 지지", style: LineStyle.Dashed },
				{ price: snapshot.levels.support2, color: "#06b6d4", title: "2차 지지", style: LineStyle.Dotted },
			];
			for (const line of priceLines) {
				if (!Number.isFinite(line.price)) continue;
				candleSeries.createPriceLine({
					price: line.price,
					color: line.color,
					lineWidth: 1,
					lineStyle: line.style,
					axisLabelVisible: true,
					title: line.title,
				});
			}
		}

		if (overlays.arrows) candleSeries.setMarkers(markerRows(candles, opinion) as any);

		chart.timeScale().fitContent();
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width;
			if (width) chart.applyOptions({ width: Math.max(width, 1) });
		});
		observer.observe(container);
		return () => {
			observer.disconnect();
			chart.remove();
		};
	}, [candles, timeframe, overlays, snapshot, opinion]);

	return <div ref={containerRef} className="h-[390px] w-full" />;
}

export function ChartBroadcastPanel({ market, onSignalChange }: Props) {
	const [query, setQuery] = useState("");
	const [selectedStock, setSelectedStock] = useState<SearchRow>(() => DEFAULT_STOCKS[market]);
	const [timeframe, setTimeframe] = useState<ChartTimeframe>("5m");
	const [live, setLive] = useState(true);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>(DEFAULT_OVERLAYS);
	const [feed, setFeed] = useState<FeedItem[]>([]);
	const lastFeedKey = useRef("");
	const trimmed = query.trim();

	useEffect(() => {
		const fallback = DEFAULT_STOCKS[market];
		setSelectedStock((current) => (current.market === market ? current : fallback));
		setQuery("");
	}, [market]);

	const search = useQuery({
		queryKey: ["chart-broadcast-search", market, trimmed],
		queryFn: async () => normalizeSearchRows(await api.searchRows(trimmed), market),
		enabled: trimmed.length > 0,
		staleTime: 30_000,
	});

	const chart = useQuery({
		queryKey: ["chart-broadcast", selectedStock.ticker, timeframe],
		queryFn: () => fetchChart(selectedStock.ticker, timeframe),
		enabled: Boolean(selectedStock.ticker),
		refetchInterval: live ? (/m|H/.test(timeframe) ? 5_000 : 15_000) : false,
		refetchIntervalInBackground: true,
		refetchOnWindowFocus: true,
		refetchOnReconnect: true,
	});

	const marketContextQuery = useQuery({
		queryKey: ["chart-broadcast-market-context", market],
		queryFn: () => fetchMarketContext(market),
		refetchInterval: live ? 15_000 : false,
		refetchIntervalInBackground: true,
		retry: 1,
	});
	const marketContext: MarketContext = marketContextQuery.data ?? {
		label: market === "KR" ? "코스피·코스닥" : "S&P500·나스닥",
		changePercent: 0,
		bias: 0,
		sources: [],
	};

	const candles = useMemo(
		() => normalizeCandles(chart.data?.candles ?? [], timeframe),
		[chart.data?.candles, timeframe],
	);
	const snapshot = useMemo(
		() => (candles.length >= 2 ? technicalSnapshot(candles, marketContext) : null),
		[candles, marketContext.bias, marketContext.changePercent, marketContext.label],
	);
	const opinion = useMemo(
		() => (snapshot ? buildOpinion(snapshot) : null),
		[snapshot],
	);

	useEffect(() => {
		if (!opinion || !candles.length) return;
		const latest = candles.at(-1)!;
		const key = `${selectedStock.ticker}:${timeframe}:${latest.time}:${opinion.signal}:${Math.round(opinion.entryPrice)}`;
		if (lastFeedKey.current === key) return;
		lastFeedKey.current = key;
		setFeed((current) => [
			{
				id: `${Date.now()}:${key}`,
				at: new Date(),
				signal: opinion.signal,
				text: opinion.event,
			},
			...current,
		].slice(0, 20));
	}, [candles, opinion, selectedStock.ticker, timeframe]);

	useEffect(() => {
		if (!opinion || !snapshot || !onSignalChange) return;
		onSignalChange({
			ticker: selectedStock.ticker,
			market,
			signal: opinion.signal,
			confidence: opinion.confidence,
			title: opinion.title,
			summary: opinion.summary,
			currentPrice: snapshot.currentPrice,
			marketBias: snapshot.marketBias,
			patterns: snapshot.patterns,
			generatedAt: new Date().toISOString(),
		});
	}, [market, onSignalChange, opinion, selectedStock.ticker, snapshot]);

	const toggleOverlay = (key: OverlayKey) => {
		setOverlays((current) => ({ ...current, [key]: !current[key] }));
	};

	const updatedAt = chart.data?.updatedAt ?? chart.data?.fetchedAt;
	const searchRows = search.data ?? [];

	return (
		<div className="space-y-4">
			<section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
				<div className="flex items-start justify-between gap-3">
					<div>
						<p className="text-[11px] font-extrabold text-primary">종목 검색</p>
						<h2 className="mt-1 text-base font-black">차트 불러오기</h2>
					</div>
					<button
						type="button"
						onClick={() => setLive((current) => !current)}
						className={cn(
							"inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-extrabold",
							live
								? "border-destructive/30 bg-destructive/10 text-destructive"
								: "border-card-border bg-background text-muted-foreground",
						)}
					>
						{live ? <CirclePause className="h-3.5 w-3.5" /> : <CirclePlay className="h-3.5 w-3.5" />}
						{live ? "생중계 중" : "일시정지"}
					</button>
				</div>

				<div className="relative mt-3">
					<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={market === "KR" ? "종목명 또는 종목코드 검색" : "회사명 또는 티커 검색"}
						className="h-11 w-full rounded-2xl border border-card-border bg-background pl-10 pr-10 text-sm font-bold outline-none focus:border-primary"
					/>
					{query && (
						<button
							type="button"
							onClick={() => setQuery("")}
							className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
						>
							<X className="h-4 w-4" />
						</button>
					)}
				</div>

				{trimmed && (
					<div className="mt-2 max-h-64 overflow-y-auto rounded-2xl border border-card-border bg-background p-2">
						{search.isLoading ? (
							<div className="flex items-center justify-center gap-2 px-3 py-5 text-xs font-bold text-muted-foreground">
								<Loader2 className="h-4 w-4 animate-spin" /> 검색 중...
							</div>
						) : searchRows.length ? (
							searchRows.map((row) => (
								<button
									key={`${row.market}:${row.ticker}`}
									type="button"
									onClick={() => {
										setSelectedStock(row);
										setQuery("");
										setFeed([]);
										lastFeedKey.current = "";
									}}
									className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-secondary"
								>
									<div className="min-w-0">
										<p className="truncate text-sm font-extrabold">{row.name}</p>
										<p className="mt-0.5 text-[11px] font-bold text-muted-foreground">{row.ticker}</p>
									</div>
									<div className="text-right">
										<p className="text-xs font-extrabold">{formatPrice(row.price, row.market)}</p>
										<p className={cn("mt-0.5 text-[11px] font-bold", (row.changePercent ?? 0) > 0 ? "text-destructive" : (row.changePercent ?? 0) < 0 ? "text-blue-500" : "text-muted-foreground")}>{formatPercent(row.changePercent)}</p>
									</div>
								</button>
							))
						) : (
							<p className="px-3 py-5 text-center text-xs font-bold text-muted-foreground">검색 결과가 없습니다.</p>
						)}
					</div>
				)}
			</section>

			<section className="overflow-hidden rounded-3xl border border-card-border bg-card shadow-sm">
				<div className="border-b border-card-border p-4">
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-2">
								<h2 className="truncate text-lg font-black">{selectedStock.name}</h2>
								<span className="rounded-full bg-secondary px-2 py-1 text-[10px] font-extrabold text-muted-foreground">{selectedStock.ticker}</span>
							</div>
							<p className="mt-1 text-[11px] font-bold text-muted-foreground">
								{chart.data?.provider ? `제공처 ${chart.data.provider}` : "실제 차트 데이터 연결"}
								{updatedAt ? ` · ${new Date(updatedAt).toLocaleTimeString("ko-KR")}` : ""}
							</p>
						</div>
						<button
							type="button"
							onClick={() => void chart.refetch()}
							className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-background"
							title="차트 새로고침"
						>
							<RefreshCw className={cn("h-4 w-4", chart.isFetching && "animate-spin")} />
						</button>
					</div>

					<div className="mt-3 flex gap-2 overflow-x-auto pb-1">
						{TIMEFRAMES.map((item) => (
							<button
								key={item.key}
								type="button"
								onClick={() => {
									setTimeframe(item.key);
									setFeed([]);
									lastFeedKey.current = "";
								}}
								className={cn(
									"shrink-0 rounded-xl border px-3 py-2 text-xs font-extrabold",
									timeframe === item.key
										? "border-primary bg-primary text-primary-foreground"
										: "border-card-border bg-background text-muted-foreground",
								)}
							>
								{item.label}
							</button>
						))}
					</div>

					<button
						type="button"
						onClick={() => setSettingsOpen((current) => !current)}
						className="mt-3 flex w-full items-center justify-between rounded-2xl border border-card-border bg-background px-3 py-2.5 text-left"
					>
						<span className="inline-flex items-center gap-2 text-xs font-extrabold">
							<Settings2 className="h-4 w-4 text-primary" />
							차트 지표 선택 · 추가/해제
						</span>
						{settingsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
					</button>

					{settingsOpen && (
						<div className="mt-2 space-y-3 rounded-2xl border border-card-border bg-background p-3">
							{(["차트선", "신호", "보조지표"] as const).map((group) => (
								<div key={group}>
									<p className="mb-2 text-[10px] font-black text-muted-foreground">{group}</p>
									<div className="flex flex-wrap gap-2">
										{OVERLAYS.filter((item) => item.group === group).map((item) => (
											<button
												key={item.key}
												type="button"
												onClick={() => toggleOverlay(item.key)}
												className={cn(
													"rounded-full border px-3 py-1.5 text-[11px] font-extrabold",
													overlays[item.key]
														? "border-primary bg-primary/10 text-primary"
														: "border-card-border bg-card text-muted-foreground",
												)}
											>
												{overlays[item.key] ? "✓ " : "+ "}{item.label}
											</button>
										))}
									</div>
								</div>
							))}
						</div>
					)}
				</div>

				<div className="min-h-[390px] bg-background/30">
					{chart.isLoading ? (
						<div className="flex h-[390px] items-center justify-center gap-2 text-sm font-bold text-muted-foreground">
							<Loader2 className="h-5 w-5 animate-spin" /> 차트 불러오는 중...
						</div>
					) : chart.isError ? (
						<div className="flex h-[390px] flex-col items-center justify-center px-6 text-center">
							<ShieldAlert className="h-8 w-8 text-warning" />
							<p className="mt-3 text-sm font-extrabold">차트 데이터를 불러오지 못했습니다.</p>
							<p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">{chart.error instanceof Error ? chart.error.message : "해당 시간봉 데이터 제공 여부를 확인하세요."}</p>
							<button type="button" onClick={() => void chart.refetch()} className="mt-4 rounded-full bg-primary px-4 py-2 text-xs font-extrabold text-primary-foreground">다시 시도</button>
						</div>
					) : candles.length < 2 || !snapshot || !opinion ? (
						<div className="flex h-[390px] flex-col items-center justify-center px-6 text-center">
							<BarChart3 className="h-8 w-8 text-muted-foreground" />
							<p className="mt-3 text-sm font-extrabold">표시할 실제 봉 데이터가 없습니다.</p>
							<p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">다른 시간봉을 선택하거나 제공처 연결 상태를 확인하세요. 임시 가격은 만들지 않습니다.</p>
						</div>
					) : (
						<ChartCanvas candles={candles} timeframe={timeframe} overlays={overlays} snapshot={snapshot} opinion={opinion} />
					)}
				</div>
			</section>

			{snapshot && opinion && (
				<>
					<section className="overflow-hidden rounded-3xl border border-card-border bg-card shadow-sm">
						<div className="flex items-center justify-between border-b border-card-border px-4 py-3">
							<div className="flex items-center gap-2">
								<span className={cn("h-2.5 w-2.5 rounded-full", live ? "animate-pulse bg-destructive" : "bg-muted-foreground")} />
								<h2 className="text-sm font-black">AI 차트 생중계</h2>
							</div>
							<span className="text-[10px] font-extrabold text-muted-foreground">{TIMEFRAMES.find((item) => item.key === timeframe)?.label}봉</span>
						</div>
						<div className="max-h-72 overflow-y-auto p-3">
							{feed.length ? (
								<div className="space-y-2">
									{feed.map((item) => (
										<article key={item.id} className="grid grid-cols-[70px_minmax(0,1fr)] gap-2 rounded-2xl bg-background px-3 py-3">
											<time className="text-[10px] font-bold text-muted-foreground">{item.at.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
											<div>
												<span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[9px] font-black", signalClass(item.signal))}>{signalLabel(item.signal)}</span>
												<p className="mt-1.5 break-keep text-[11px] font-bold leading-5 text-foreground">{item.text}</p>
											</div>
										</article>
									))}
								</div>
							) : (
								<p className="rounded-2xl bg-background px-3 py-5 text-center text-xs font-bold text-muted-foreground">새 봉과 분석 신호를 기다리는 중입니다.</p>
							)}
						</div>
					</section>

					<section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<p className="text-[11px] font-extrabold text-primary">실시간 AI 기술분석</p>
								<h2 className="mt-1 text-lg font-black">{opinion.title}</h2>
							</div>
							<div className={cn("shrink-0 rounded-full border px-3 py-1.5 text-xs font-black", signalClass(opinion.signal))}>{signalLabel(opinion.signal)}</div>
						</div>

						<p className="mt-3 break-keep rounded-2xl bg-secondary/70 px-3 py-3 text-xs font-bold leading-6 text-foreground">{opinion.summary}</p>

						<div className="mt-3 grid grid-cols-2 gap-2">
							<MetricCard icon={<Activity className="h-4 w-4" />} label="현재 추세" value={snapshot.trend} />
							<MetricCard icon={<Gauge className="h-4 w-4" />} label="신뢰도" value={`${opinion.confidence}/100`} />
							<MetricCard icon={<TrendingUp className="h-4 w-4" />} label="현재가" value={formatPrice(snapshot.currentPrice, market)} />
							<MetricCard icon={<Gauge className="h-4 w-4" />} label={snapshot.marketLabel} value={`${snapshot.marketChangePercent >= 0 ? "+" : ""}${snapshot.marketChangePercent.toFixed(2)}%`} />
							<MetricCard icon={<BarChart3 className="h-4 w-4" />} label="거래량" value={`${snapshot.volumeRatio.toFixed(2)}배`} />
						</div>

						<div className="mt-3 grid grid-cols-3 gap-2">
							<PlanCard tone="entry" label="진입 기준" value={formatPrice(opinion.entryPrice, market)} />
							<PlanCard tone="target" label="목표가" value={formatPrice(opinion.targetPrice, market)} />
							<PlanCard tone="stop" label="손절 기준" value={formatPrice(opinion.stopPrice, market)} />
						</div>

						<div className="mt-3 grid grid-cols-2 gap-2">
							<LevelCard label="1차 저항" value={formatPrice(snapshot.levels.resistance1, market)} tone="resistance" />
							<LevelCard label="2차 저항" value={formatPrice(snapshot.levels.resistance2, market)} tone="resistance" />
							<LevelCard label="1차 지지" value={formatPrice(snapshot.levels.support1, market)} tone="support" />
							<LevelCard label="2차 지지" value={formatPrice(snapshot.levels.support2, market)} tone="support" />
						</div>

						<div className="mt-3 grid grid-cols-3 gap-2">
							{overlays.rsi && <SmallIndicator label="RSI" value={snapshot.rsi == null ? "-" : snapshot.rsi.toFixed(1)} />}
							{overlays.macd && <SmallIndicator label="MACD" value={snapshot.macd == null ? "-" : snapshot.macd.toFixed(3)} />}
							{overlays.atr && <SmallIndicator label="ATR" value={formatPrice(snapshot.atr, market)} />}
							{snapshot.patterns.map((pattern) => <SmallIndicator key={pattern} label="차트패턴" value={pattern} />)}
						</div>
					</section>
				</>
			)}

			<p className="px-1 text-[10px] font-semibold leading-4 text-muted-foreground">
				차트중계는 실제 시세·봉 데이터를 기반으로 한 기술적 분석 보조 기능입니다. 진입·매도 문구는 주문 실행이 아니라 조건 알림이며, 자동매매 주문 기능과 분리되어 있습니다.
			</p>
		</div>
	);
}

function MetricCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
	return (
		<div className="rounded-2xl border border-card-border bg-background p-3">
			<div className="flex items-center gap-1.5 text-primary">{icon}<span className="text-[10px] font-extrabold text-muted-foreground">{label}</span></div>
			<p className="mt-2 text-sm font-black">{value}</p>
		</div>
	);
}

function PlanCard({ tone, label, value }: { tone: "entry" | "target" | "stop"; label: string; value: string }) {
	const Icon = tone === "entry" ? TrendingUp : tone === "target" ? Target : TrendingDown;
	return (
		<div className={cn("rounded-2xl border p-3", tone === "entry" ? "border-destructive/20 bg-destructive/5" : tone === "target" ? "border-warning/20 bg-warning/5" : "border-blue-500/20 bg-blue-500/5")}>
			<Icon className={cn("h-4 w-4", tone === "entry" ? "text-destructive" : tone === "target" ? "text-warning" : "text-blue-500")} />
			<p className="mt-2 text-[10px] font-extrabold text-muted-foreground">{label}</p>
			<p className="mt-1 break-keep text-xs font-black">{value}</p>
		</div>
	);
}

function LevelCard({ label, value, tone }: { label: string; value: string; tone: "support" | "resistance" }) {
	return (
		<div className="flex items-center justify-between gap-2 rounded-2xl border border-card-border bg-background px-3 py-2.5">
			<span className={cn("text-[10px] font-extrabold", tone === "support" ? "text-blue-500" : "text-destructive")}>{label}</span>
			<strong className="text-xs">{value}</strong>
		</div>
	);
}

function SmallIndicator({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-2xl bg-secondary/70 px-3 py-2.5 text-center">
			<p className="text-[10px] font-extrabold text-muted-foreground">{label}</p>
			<p className="mt-1 text-xs font-black">{value}</p>
		</div>
	);
}