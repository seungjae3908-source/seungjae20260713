import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
	Activity,
	ArrowLeft,
	BarChart3,
	ChevronDown,
	ChevronUp,
	CirclePause,
	CirclePlay,
	Gauge,
	Loader2,
	Maximize2,
	Minimize2,
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
	type LogicalRange,
	type Time,
	type UTCTimestamp,
} from "lightweight-charts";
import { authorizedFetch } from "@/lib/auth-fetch";
import { api, apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
	CHART_TIMEFRAMES,
	REALTIME_CHART_TIMEFRAMES,
	loadVisibleChartTimeframes,
	normalizeRealtimeTimeframe,
	realtimeTimeframeLabel,
	saveVisibleChartTimeframes,
	toUpbitTimeframe,
	type RealtimeChartTimeframe,
	type VisibleChartTimeframe,
} from "@/lib/chart-preferences";
import {
	useRealtimeChart,
	type RealtimeCandle,
	type RealtimeChartAsset,
} from "@/hooks/use-realtime-chart";
import { FavoriteButton } from "@/components/favorite-button";
import { InstrumentAlertButton } from "@/components/instrument-alert-modal";
import { BottomNav } from "@/components/bottom-nav";
import { useMemberPermissions } from "@/lib/permissions";

export type ChartBroadcastMarket = "KR" | "US";

type AnyObj = Record<string, any>;
type ChartTimeframe = VisibleChartTimeframe;

type OverlayKey =
	| "ma5"
	| "ma10"
	| "ma20"
	| "ma60"
	| "ma120"
	| "ma200"
	| "ema20"
	| "ema60"
	| "bollinger"
	| "vwap"
	| "volume"
	| "levels"
	| "arrows"
	| "rsi"
	| "macd"
	| "atr"
	| "stochastic"
	| "obv";

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
	confidence: number;
	summary: string;
	facts: string[];
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

const TIMEFRAMES: Array<{ key: ChartTimeframe; label: string }> =
	CHART_TIMEFRAMES.map((item) => ({
		key: item,
		label: normalizeRealtimeTimeframe(item)
			? realtimeTimeframeLabel(normalizeRealtimeTimeframe(item)!)
			: item,
	}));

const OVERLAYS: Array<{
	key: OverlayKey;
	label: string;
	group: "차트선" | "신호" | "보조지표";
	description: string;
}> = [
	{ key: "ma5", label: "MA5", group: "차트선", description: "최근 5개 봉의 종가 평균입니다. 현재가가 선 위에서 유지되는지로 매우 짧은 추세를 확인합니다." },
	{ key: "ma10", label: "MA10", group: "차트선", description: "최근 10개 봉 평균으로 초단기 추세의 지속 여부를 확인합니다." },
	{ key: "ma20", label: "MA20", group: "차트선", description: "최근 20개 봉 평균으로 단기 추세와 눌림 구간을 봅니다. 가격의 상향·하향 교차는 거래량과 함께 확인합니다." },
	{ key: "ma60", label: "MA60", group: "차트선", description: "최근 60개 봉 평균으로 중기 추세를 확인합니다. 짧은 이평선보다 반응은 느리지만 잡음이 적습니다." },
	{ key: "ma120", label: "MA120", group: "차트선", description: "최근 120개 봉 평균으로 장기 방향을 확인합니다. 봉 수가 부족하면 표시되지 않습니다." },
	{ key: "ma200", label: "MA200", group: "차트선", description: "최근 200개 봉 평균으로 장기 추세와 큰 지지·저항을 확인합니다. 봉 수가 부족하면 표시되지 않습니다." },
	{ key: "ema20", label: "EMA20", group: "차트선", description: "최근 가격에 더 큰 비중을 두는 20기간 지수이동평균입니다." },
	{ key: "ema60", label: "EMA60", group: "차트선", description: "최근 가격에 더 큰 비중을 두는 60기간 지수이동평균입니다." },
	{ key: "bollinger", label: "볼린저밴드", group: "차트선", description: "20개 봉 평균과 표준편차로 변동 범위를 표시합니다. 밴드 접촉만으로 매수·매도를 확정하지 않습니다." },
	{ key: "vwap", label: "VWAP", group: "차트선", description: "가격과 거래량을 함께 반영한 거래량가중평균가격입니다. 실제 거래량 데이터가 있어야 의미가 있습니다." },
	{ key: "volume", label: "거래량", group: "차트선", description: "각 봉에서 체결된 수량입니다. 돌파나 패턴은 평소보다 거래량이 늘었는지 함께 확인합니다." },
	{ key: "levels", label: "지지·저항", group: "신호", description: "최근 고점·저점 군집으로 계산합니다. 현재 유효선은 굵게, 이미 돌파·이탈된 선은 흐린 점선으로 표시합니다." },
	{ key: "arrows", label: "매수·매도 화살표", group: "신호", description: "이동평균 교차와 현재 분석 신호가 발생한 실제 봉 위치를 표시합니다. 화살표만으로 주문하지 않습니다." },
	{ key: "rsi", label: "RSI", group: "보조지표", description: "최근 상승폭과 하락폭의 비율을 0~100으로 나타냅니다. 일반적으로 70 이상은 과열, 30 이하는 과매도 후보입니다." },
	{ key: "macd", label: "MACD", group: "보조지표", description: "12·26 지수이동평균의 차이와 9기간 신호선을 비교해 추세 변화 가능성을 확인합니다." },
	{ key: "atr", label: "ATR", group: "보조지표", description: "최근 봉의 실제 가격 범위를 평균해 변동성을 나타냅니다. 손절 폭과 포지션 위험을 판단할 때 사용합니다." },
	{ key: "stochastic", label: "스토캐스틱", group: "보조지표", description: "최근 고가·저가 범위에서 현재 종가의 위치를 0~100으로 나타냅니다. 80 이상 과열, 20 이하 과매도 후보로 봅니다." },
	{ key: "obv", label: "OBV", group: "보조지표", description: "상승 봉 거래량은 더하고 하락 봉 거래량은 빼서 가격보다 먼저 움직이는 수급 흐름을 확인합니다." },
];

const DEFAULT_OVERLAYS: Record<OverlayKey, boolean> = {
	ma5: true,
	ma10: false,
	ma20: true,
	ma60: false,
	ma120: false,
	ma200: false,
	ema20: false,
	ema60: false,
	bollinger: false,
	vwap: false,
	volume: true,
	levels: true,
	arrows: true,
	rsi: true,
	macd: true,
	atr: false,
	stochastic: false,
	obv: false,
};

const CHART_OVERLAYS_STORAGE_KEY = "sa-chart-overlays-v2";

function loadOverlays(): Record<OverlayKey, boolean> {
	if (typeof window === "undefined") return DEFAULT_OVERLAYS;
	try {
		const saved = JSON.parse(window.localStorage.getItem(CHART_OVERLAYS_STORAGE_KEY) ?? "{}") as Partial<Record<OverlayKey, boolean>>;
		return { ...DEFAULT_OVERLAYS, ...saved };
	} catch {
		return DEFAULT_OVERLAYS;
	}
}


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
		"8H": 28800,
		"12H": 43200,
		"1D": 86400,
		"3D": 259200,
		"5D": 432000,
		"15D": 1296000,
		"1M": 2592000,
		"3M": 7776000,
		"6M": 15552000,
		"1Y": 31536000,
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

function seriesEma(candles: CandlePoint[], period: number) {
	const rows: Array<{ time: Time; value: number }> = [];
	if (candles.length < period) return rows;
	const k = 2 / (period + 1);
	let value = candles.slice(0, period).reduce((sum, row) => sum + row.close, 0) / period;
	rows.push({ time: candles[period - 1].time, value });
	for (let index = period; index < candles.length; index += 1) {
		value = (candles[index].close - value) * k + value;
		rows.push({ time: candles[index].time, value });
	}
	return rows;
}

function seriesRsi(candles: CandlePoint[], period = 14) {
	const rows: Array<{ time: Time; value: number }> = [];
	for (let index = period; index < candles.length; index += 1) {
		const value = rsi(candles.slice(0, index + 1).map((row) => row.close), period);
		if (value != null) rows.push({ time: candles[index].time, value });
	}
	return rows;
}

function seriesMacd(candles: CandlePoint[]) {
	const macd: Array<{ time: Time; value: number }> = [];
	const signal: Array<{ time: Time; value: number }> = [];
	const values: number[] = [];
	for (let index = 26; index <= candles.length; index += 1) {
		const closes = candles.slice(0, index).map((row) => row.close);
		const fast = ema(closes, 12);
		const slow = ema(closes, 26);
		if (fast == null || slow == null) continue;
		const value = fast - slow;
		values.push(value);
		macd.push({ time: candles[index - 1].time, value });
		const signalValue = ema(values, 9);
		if (signalValue != null) signal.push({ time: candles[index - 1].time, value: signalValue });
	}
	return { macd, signal };
}

function seriesAtr(candles: CandlePoint[], period = 14) {
	const rows: Array<{ time: Time; value: number }> = [];
	for (let index = period; index < candles.length; index += 1) rows.push({ time: candles[index].time, value: atr(candles.slice(0, index + 1), period) });
	return rows;
}

function seriesStochastic(candles: CandlePoint[], period = 14) {
	const rows: Array<{ time: Time; value: number }> = [];
	for (let index = period - 1; index < candles.length; index += 1) {
		const window = candles.slice(index - period + 1, index + 1);
		const high = Math.max(...window.map((row) => row.high));
		const low = Math.min(...window.map((row) => row.low));
		const value = high === low ? 50 : ((candles[index].close - low) / (high - low)) * 100;
		rows.push({ time: candles[index].time, value });
	}
	return rows;
}

function seriesObv(candles: CandlePoint[]) {
	let value = 0;
	return candles.map((row, index) => {
		if (index > 0) value += row.close > candles[index - 1].close ? row.volume : row.close < candles[index - 1].close ? -row.volume : 0;
		return { time: row.time as Time, value };
	});
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
		breakdownLevel: crossedLows[0] ?? null,
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

	const recent = candles.slice(-60);
	const pivotHighs = recent.map((row, index) => ({ value: row.high, index })).filter((row) => row.index >= 2 && row.index < recent.length - 2 && row.value >= recent[row.index - 1].high && row.value >= recent[row.index - 2].high && row.value >= recent[row.index + 1].high && row.value >= recent[row.index + 2].high);
	const pivotLows = recent.map((row, index) => ({ value: row.low, index })).filter((row) => row.index >= 2 && row.index < recent.length - 2 && row.value <= recent[row.index - 1].low && row.value <= recent[row.index - 2].low && row.value <= recent[row.index + 1].low && row.value <= recent[row.index + 2].low);
	const similar = (left: number, right: number, tolerance = 0.025) => Math.abs(left - right) / Math.max(Math.abs(left), 1) <= tolerance;
	if (pivotLows.length >= 3) {
		const [left, head, right] = pivotLows.slice(-3);
		if (head.value < left.value && head.value < right.value && similar(left.value, right.value)) { patterns.push("역헤드앤숄더 후보"); bullishScore += 10; }
	}
	if (pivotHighs.length >= 3) {
		const [left, head, right] = pivotHighs.slice(-3);
		if (head.value > left.value && head.value > right.value && similar(left.value, right.value)) { patterns.push("헤드앤숄더 후보"); bearishScore += 10; }
	}
	if (pivotHighs.length >= 2 && pivotLows.length >= 2) {
		const firstHigh = pivotHighs.at(-2)!;
		const lastHigh = pivotHighs.at(-1)!;
		const firstLow = pivotLows.at(-2)!;
		const lastLow = pivotLows.at(-1)!;
		const highSlope = (lastHigh.value - firstHigh.value) / Math.max(1, lastHigh.index - firstHigh.index);
		const lowSlope = (lastLow.value - firstLow.value) / Math.max(1, lastLow.index - firstLow.index);
		const scale = Math.max(latest.close, 1);
		const highFlat = Math.abs(highSlope) / scale < 0.0007;
		const lowFlat = Math.abs(lowSlope) / scale < 0.0007;
		if (highFlat && lowSlope > scale * 0.0007) { patterns.push("상승 삼각형 후보"); bullishScore += 8; }
		else if (lowFlat && highSlope < -scale * 0.0007) { patterns.push("하락 삼각형 후보"); bearishScore += 8; }
		else if (highSlope < 0 && lowSlope > 0) patterns.push("대칭 삼각형 후보");
		else if (highSlope > 0 && lowSlope > 0 && lowSlope > highSlope) { patterns.push("상승 쐐기 후보"); bearishScore += 7; }
		else if (highSlope < 0 && lowSlope < 0 && highSlope > lowSlope) { patterns.push("하락 쐐기 후보"); bullishScore += 7; }
	}
	if (recent.length >= 20) {
		const poleStart = recent.at(-20)!.close;
		const poleEnd = recent.at(-10)!.close;
		const poleChange = (poleEnd - poleStart) / Math.max(poleStart, 1);
		const flagChange = (latest.close - poleEnd) / Math.max(poleEnd, 1);
		if (poleChange >= 0.05 && flagChange < 0 && flagChange > -0.035) { patterns.push("상승 깃발 후보"); bullishScore += 7; }
		if (poleChange <= -0.05 && flagChange > 0 && flagChange < 0.035) { patterns.push("하락 깃발 후보"); bearishScore += 7; }
	}
	if (recent.length >= 40) {
		const leftRim = recent[0].high;
		const rightRim = recent.at(-8)!.high;
		const cupLow = Math.min(...recent.slice(5, -8).map((row) => row.low));
		const handleLow = Math.min(...recent.slice(-8).map((row) => row.low));
		if (similar(leftRim, rightRim, 0.035) && cupLow < leftRim * 0.92 && handleLow > cupLow * 1.04 && latest.close >= rightRim * 0.98) { patterns.push("컵앤핸들 후보"); bullishScore += 10; }
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

function markerRows(candles: CandlePoint[], opinion: LiveOpinion, patterns: string[]) {
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
		patterns.slice(0, 3).forEach((pattern, index) => markers.push({
			time: latest.time,
			position: index % 2 === 0 ? "aboveBar" : "belowBar",
			color: index === 0 ? "#7c3aed" : "#a855f7",
			shape: "circle",
			text: pattern,
		}));
	}

	return markers.slice(-18);
}

function ChartCanvas({
	candles,
	timeframe,
	overlays,
	snapshot,
	opinion,
	focusTime,
	fullscreen = false,
}: {
	candles: CandlePoint[];
	timeframe: ChartTimeframe;
	overlays: Record<OverlayKey, boolean>;
	snapshot: TechnicalSnapshot;
	opinion: LiveOpinion;
	focusTime?: UTCTimestamp | null;
	fullscreen?: boolean;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const visibleRangeRef = useRef<{ timeframe: ChartTimeframe; range: LogicalRange } | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || candles.length < 2) return;
		const dark = document.documentElement.classList.contains("dark");
		const chart = createChart(container, {
			width: Math.max(container.clientWidth, 1),
			height: fullscreen ? Math.max(window.innerHeight - 96, 420) : 390,
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
		if (overlays.ma10) addLine(chart, seriesSma(candles, 10), { color: "#fb7185", lineWidth: 1, title: "MA10" });
		if (overlays.ma20) addLine(chart, seriesSma(candles, 20), { color: "#8b5cf6", lineWidth: 2, title: "MA20" });
		if (overlays.ma60) addLine(chart, seriesSma(candles, 60), { color: "#10b981", lineWidth: 1, title: "MA60" });
		if (overlays.ma120) addLine(chart, seriesSma(candles, 120), { color: "#ec4899", lineWidth: 1, title: "MA120" });
		if (overlays.ma200) addLine(chart, seriesSma(candles, 200), { color: "#64748b", lineWidth: 2, title: "MA200" });
		if (overlays.ema20) addLine(chart, seriesEma(candles, 20), { color: "#14b8a6", lineWidth: 2, lineStyle: LineStyle.Dashed, title: "EMA20" });
		if (overlays.ema60) addLine(chart, seriesEma(candles, 60), { color: "#0ea5e9", lineWidth: 2, lineStyle: LineStyle.Dashed, title: "EMA60" });

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
				{ price: snapshot.levels.resistance2, color: "#f97316", title: "2차 저항", style: LineStyle.Dotted, width: 2 },
				{ price: snapshot.levels.resistance1, color: "#ef4444", title: "현재 유효 저항", style: LineStyle.Solid, width: 3 },
				{ price: snapshot.levels.support1, color: "#2563eb", title: "현재 유효 지지", style: LineStyle.Solid, width: 3 },
				{ price: snapshot.levels.support2, color: "#06b6d4", title: "2차 지지", style: LineStyle.Dotted, width: 2 },
				...(snapshot.levels.breakoutLevel == null ? [] : [{ price: snapshot.levels.breakoutLevel, color: "rgba(239,68,68,0.45)", title: "돌파된 이전 저항", style: LineStyle.Dashed, width: 1 }]),
				...(snapshot.levels.breakdownLevel == null ? [] : [{ price: snapshot.levels.breakdownLevel, color: "rgba(37,99,235,0.45)", title: "이탈된 이전 지지", style: LineStyle.Dashed, width: 1 }]),
			];
			for (const line of priceLines) {
				if (!Number.isFinite(line.price)) continue;
				candleSeries.createPriceLine({
					price: line.price,
					color: line.color,
					lineWidth: line.width as 1 | 2 | 3,
					lineStyle: line.style,
					axisLabelVisible: true,
					title: line.title,
				});
			}
		}

		for (const line of [
			{ price: opinion.targetPrice, color: "#16a34a", title: "AI 목표가" },
			{ price: opinion.stopPrice, color: "#dc2626", title: "AI 손절가" },
		]) {
			if (!Number.isFinite(line.price)) continue;
			candleSeries.createPriceLine({ price: line.price, color: line.color, title: line.title, lineStyle: LineStyle.Solid, lineWidth: 3, axisLabelVisible: true });
		}

		if (overlays.arrows) candleSeries.setMarkers(markerRows(candles, opinion, snapshot.patterns) as any);

		if (focusTime) {
			const index = candles.findIndex((row) => row.time === focusTime);
			if (index >= 0) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, index - 18), to: Math.min(candles.length - 1, index + 18) });
		}

		const savedRange = visibleRangeRef.current;
		if (savedRange?.timeframe === timeframe) chart.timeScale().setVisibleLogicalRange(savedRange.range);
		else chart.timeScale().fitContent();
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width;
			if (width) chart.applyOptions({ width: Math.max(width, 1) });
		});
		observer.observe(container);
		return () => {
			const range = chart.timeScale().getVisibleLogicalRange();
			if (range) visibleRangeRef.current = { timeframe, range };
			observer.disconnect();
			chart.remove();
		};
	}, [candles, timeframe, overlays, snapshot, opinion, focusTime, fullscreen]);

	return <div ref={containerRef} className={cn("w-full", fullscreen ? "h-[calc(100dvh-96px)] min-h-[420px]" : "h-[390px]")} />;
}

function IndicatorPanel({ title, candles, lines, height = 120 }: { title: string; candles: CandlePoint[]; lines: Array<{ label: string; data: Array<{ time: Time; value: number }>; color: string }>; height?: number }) {
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const container = ref.current;
		if (!container || !lines.some((line) => line.data.length)) return;
		const chart = createChart(container, { width: Math.max(container.clientWidth, 1), height, layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#94a3b8", fontSize: 10 }, grid: { vertLines: { color: "rgba(148,163,184,0.07)" }, horzLines: { color: "rgba(148,163,184,0.07)" } }, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: false }, crosshair: { mode: CrosshairMode.Normal } });
		for (const line of lines) addLine(chart, line.data, { color: line.color, lineWidth: 2, title: line.label });
		chart.timeScale().fitContent();
		const observer = new ResizeObserver((entries) => { const width = entries[0]?.contentRect.width; if (width) chart.applyOptions({ width }); });
		observer.observe(container);
		return () => { observer.disconnect(); chart.remove(); };
	}, [candles, height, lines]);
	return <section className="border-t border-card-border bg-background/30"><div className="px-3 pt-2 text-[10px] font-black text-muted-foreground">{title}</div><div ref={ref} style={{ height }} /></section>;
}

type DetectedChartSignal = { id: string; title: string; detail: string; time: UTCTimestamp; tone: "buy" | "sell" | "neutral" };

function detectedChartSignals(candles: CandlePoint[], snapshot: TechnicalSnapshot): DetectedChartSignal[] {
	const latest = candles.at(-1);
	if (!latest) return [];
	const rows: DetectedChartSignal[] = snapshot.patterns.map((pattern, index) => ({ id: `pattern:${pattern}:${latest.time}`, title: `${pattern} 감지`, detail: "최근 고점·저점과 캔들 구조 조건을 충족한 패턴 후보입니다. 거래량과 돌파 마감을 함께 확인합니다.", time: latest.time, tone: pattern.includes("하락") || pattern.includes("유성") || pattern.includes("쌍봉") ? "sell" : pattern.includes("상승") || pattern.includes("망치") || pattern.includes("쌍바닥") ? "buy" : "neutral" }));
	if (snapshot.volumeRatio >= 1.5) rows.push({ id: `volume:${latest.time}`, title: `거래량 급증 ${snapshot.volumeRatio.toFixed(1)}배`, detail: "최근 20개 봉 평균보다 거래량이 크게 증가했습니다. 가격 방향과 함께 해석해야 합니다.", time: latest.time, tone: latest.close >= latest.open ? "buy" : "sell" });
	if (snapshot.rsi != null && (snapshot.rsi >= 70 || snapshot.rsi <= 30)) rows.push({ id: `rsi:${latest.time}`, title: snapshot.rsi >= 70 ? `RSI 과열 ${snapshot.rsi.toFixed(0)}` : `RSI 과매도 ${snapshot.rsi.toFixed(0)}`, detail: "RSI 극단 구간은 즉시 반전 확정이 아니라 과열 또는 과매도 경고입니다.", time: latest.time, tone: snapshot.rsi >= 70 ? "sell" : "buy" });
	return rows.slice(0, 8);
}

export function ChartBroadcastPanel({ market: initialMarket, onSignalChange }: Props) {
	const [market, setMarket] = useState<ChartBroadcastMarket>(initialMarket);
	const [marketMenuOpen, setMarketMenuOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [selectedStock, setSelectedStock] = useState<SearchRow>(() => DEFAULT_STOCKS[market]);

	useEffect(() => {
		setMarket(initialMarket);
	}, [initialMarket]);
	const [timeframe, setTimeframe] = useState<ChartTimeframe>("5m");
	const [visibleTimeframes, setVisibleTimeframes] = useState<ChartTimeframe[]>(() => loadVisibleChartTimeframes());
	const [live, setLive] = useState(true);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>(() => loadOverlays());
	const [chartFullscreen, setChartFullscreen] = useState(false);
	const [feedFullscreen, setFeedFullscreen] = useState(false);
	const [focusTime, setFocusTime] = useState<UTCTimestamp | null>(null);
	const [feed, setFeed] = useState<FeedItem[]>([]);
	const [selectedFeed, setSelectedFeed] = useState<FeedItem | null>(null);
	const [selectedExplanation, setSelectedExplanation] = useState<{ title: string; body: string } | null>(null);
	const lastFeedKey = useRef("");
	const trimmed = query.trim();

	useEffect(() => {
		if (!selectedFeed && !selectedExplanation) return;
		const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSelectedFeed(null); setSelectedExplanation(null); } };
		document.addEventListener('keydown', close);
		return () => document.removeEventListener('keydown', close);
	}, [selectedFeed, selectedExplanation]);

	useEffect(() => {
		const fallback = DEFAULT_STOCKS[market];
		setSelectedStock((current) => (current.market === market ? current : fallback));
		setQuery("");
	}, [market]);

	useEffect(() => {
		if (!visibleTimeframes.includes(timeframe)) setTimeframe(visibleTimeframes[0] ?? "1m");
	}, [timeframe, visibleTimeframes]);

	useEffect(() => {
		window.localStorage.setItem(CHART_OVERLAYS_STORAGE_KEY, JSON.stringify(overlays));
	}, [overlays]);

	useEffect(() => {
		document.body.style.overflow = chartFullscreen || feedFullscreen ? "hidden" : "";
		return () => { document.body.style.overflow = ""; };
	}, [chartFullscreen, feedFullscreen]);

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
		if (!opinion || candles.length < 2) return;
		const start = Math.max(2, candles.length - 10);
		const next: FeedItem[] = [];
		for (let index = start; index < candles.length; index += 1) {
			const slice = candles.slice(0, index + 1);
			const itemSnapshot = technicalSnapshot(slice, marketContext);
			const itemOpinion = buildOpinion(itemSnapshot);
			const candle = slice.at(-1)!;
			next.push({
				id: `${selectedStock.ticker}:${timeframe}:${candle.time}:${itemOpinion.signal}`,
				at: new Date(Number(candle.time) * 1000),
				signal: itemOpinion.signal,
				text: itemOpinion.event,
				confidence: itemOpinion.confidence,
				summary: itemOpinion.summary,
				facts: [
					`추세 ${itemSnapshot.trend}`,
					`거래량 평균 대비 ${itemSnapshot.volumeRatio.toFixed(2)}배`,
					itemSnapshot.rsi == null ? 'RSI 데이터 부족' : `RSI ${itemSnapshot.rsi.toFixed(1)}`,
					itemSnapshot.macd == null || itemSnapshot.macdSignal == null ? 'MACD 데이터 부족' : `MACD ${itemSnapshot.macd.toFixed(2)} / 신호 ${itemSnapshot.macdSignal.toFixed(2)}`,
					...(itemSnapshot.patterns.length ? itemSnapshot.patterns : ['확정 패턴 없음']),
				],
			});
		}
		setFeed(next.reverse().slice(0, 10));
	}, [candles, marketContext.bias, marketContext.changePercent, marketContext.label, opinion, selectedStock.ticker, timeframe]);

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
	const toggleVisibleTimeframe = (frame: ChartTimeframe) => {
		setVisibleTimeframes((current) => {
			const next = current.includes(frame) ? current.filter((item) => item !== frame) : [...current, frame];
			const ordered = TIMEFRAMES.filter((item) => next.includes(item.key)).map((item) => item.key);
			const safe = ordered.length ? ordered : [frame];
			saveVisibleChartTimeframes(safe);
			return safe;
		});
	};

	const detectedSignals = snapshot ? detectedChartSignals(candles, snapshot) : [];
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
					<button
						type="button"
						onClick={() => setMarketMenuOpen((current) => !current)}
						className="flex w-full items-center justify-center gap-1 rounded-xl border border-card-border bg-background px-3 py-2.5 text-xs font-black"
					>
						주식
						<ChevronDown className="h-3.5 w-3.5" />
					</button>

					{marketMenuOpen && (
						<div className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 overflow-hidden rounded-xl border border-card-border bg-card p-1 shadow-xl">
							{([
								{ key: "KR" as ChartBroadcastMarket, label: "국내주식" },
								{ key: "US" as ChartBroadcastMarket, label: "해외주식" },
							] as const).map((item) => (
								<button
									key={item.key}
									type="button"
									onClick={() => {
										setMarket(item.key);
										setMarketMenuOpen(false);
									}}
									className={cn(
										"block w-full rounded-lg px-3 py-2 text-center text-xs font-black",
										market === item.key
											? "bg-primary text-primary-foreground"
											: "text-foreground hover:bg-secondary",
									)}
								>
									{item.label}
								</button>
							))}
						</div>
					)}
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
						<div className="flex items-center gap-2">
							<button type="button" onClick={() => setChartFullscreen(true)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-background" title="가로 전체화면">
								<Maximize2 className="h-4 w-4" />
							</button>
							<button
								type="button"
								onClick={() => void chart.refetch()}
								className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-background"
								title="차트 새로고침"
							>
								<RefreshCw className={cn("h-4 w-4", chart.isFetching && "animate-spin")} />
							</button>
						</div>
					</div>

					<div className="mt-3 flex gap-2 overflow-x-auto pb-1">
						{TIMEFRAMES.filter((item) => visibleTimeframes.includes(item.key)).map((item) => (
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
							<div>
								<p className="mb-2 text-[10px] font-black text-muted-foreground">차트 밖에 표시할 시간</p>
								<div className="flex flex-wrap gap-2">
									{TIMEFRAMES.map((item) => (
										<button key={`frame-setting:${item.key}`} type="button" onClick={() => toggleVisibleTimeframe(item.key)} className={cn("rounded-full border px-3 py-1.5 text-[11px] font-extrabold", visibleTimeframes.includes(item.key) ? "border-primary/30 bg-primary/10 text-primary" : "border-card-border bg-card text-muted-foreground")}>{visibleTimeframes.includes(item.key) ? "✓ " : "+ "}{item.label}</button>
									))}
								</div>
							</div>
							{(["차트선", "신호", "보조지표"] as const).map((group) => (
								<div key={group}>
									<p className="mb-2 text-[10px] font-black text-muted-foreground">{group}</p>
									<div className="flex flex-wrap gap-2">
										{OVERLAYS.filter((item) => item.group === group).map((item) => (
											<span key={item.key} className="inline-flex overflow-hidden rounded-full border border-card-border">
											<button
												type="button"
												onClick={() => toggleOverlay(item.key)}
												className={cn(
													"px-3 py-1.5 text-[11px] font-extrabold",
													overlays[item.key]
														? "bg-primary/10 text-primary"
														: "bg-card text-muted-foreground",
												)}
											>
												{overlays[item.key] ? "✓ " : "+ "}{item.label}
											</button>
											<button type="button" aria-label={`${item.label} 설명`} onClick={() => setSelectedExplanation({ title: item.label, body: item.description })} className="border-l border-card-border bg-background px-2 text-[11px] font-black text-primary">?</button>
											</span>
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
						<><ChartCanvas candles={candles} timeframe={timeframe} overlays={overlays} snapshot={snapshot} opinion={opinion} focusTime={focusTime} />
						{overlays.rsi && <IndicatorPanel title="RSI(14)" candles={candles} lines={[{ label: "RSI", data: seriesRsi(candles), color: "#8b5cf6" }]} />}
						{overlays.macd && (() => { const data = seriesMacd(candles); return <IndicatorPanel title="MACD(12,26,9)" candles={candles} lines={[{ label: "MACD", data: data.macd, color: "#0ea5e9" }, { label: "Signal", data: data.signal, color: "#f59e0b" }]} />; })()}
						{overlays.atr && <IndicatorPanel title="ATR(14)" candles={candles} lines={[{ label: "ATR", data: seriesAtr(candles), color: "#ef4444" }]} />}
						{overlays.stochastic && <IndicatorPanel title="스토캐스틱 %K" candles={candles} lines={[{ label: "%K", data: seriesStochastic(candles), color: "#14b8a6" }]} />}
						{overlays.obv && <IndicatorPanel title="OBV" candles={candles} lines={[{ label: "OBV", data: seriesObv(candles), color: "#6366f1" }]} />}
					</>
					)}
				</div>
			</section>

			{detectedSignals.length > 0 && (
				<section className="rounded-3xl border border-card-border bg-card p-3 shadow-sm">
					<div className="mb-2 flex items-center justify-between"><h2 className="text-xs font-black">차트 감지 신호</h2><span className="text-[10px] font-bold text-muted-foreground">누르면 해당 봉으로 이동</span></div>
					<div className="flex gap-2 overflow-x-auto pb-1">{detectedSignals.map((signal) => <button key={signal.id} type="button" onClick={() => { setFocusTime(signal.time); setSelectedExplanation({ title: signal.title, body: signal.detail }); }} className={cn("shrink-0 rounded-2xl border px-3 py-2 text-left", signal.tone === "buy" ? "border-destructive/20 bg-destructive/5" : signal.tone === "sell" ? "border-blue-500/20 bg-blue-500/5" : "border-card-border bg-background")}><p className="text-[11px] font-black">{signal.title}</p><p className="mt-1 text-[9px] font-bold text-muted-foreground">{new Date(Number(signal.time) * 1000).toLocaleString("ko-KR")}</p></button>)}</div>
				</section>
			)}

			{snapshot && opinion && (
				<>
					<section className="overflow-hidden rounded-3xl border border-card-border bg-card shadow-sm">
						<div className="flex items-center justify-between border-b border-card-border px-4 py-3">
							<div className="flex items-center gap-2">
								<span className={cn("h-2.5 w-2.5 rounded-full", live ? "animate-pulse bg-destructive" : "bg-muted-foreground")} />
								<h2 className="text-sm font-black">AI 차트 생중계</h2>
							</div>
							<button type="button" onClick={() => setFeedFullscreen(true)} className="rounded-full border border-card-border bg-background px-3 py-1.5 text-[10px] font-black">AI 분석 전체보기</button>
						</div>
						<div className="max-h-72 overflow-y-auto p-3">
							{feed.length ? (
								<div className="space-y-2">
									{feed.map((item) => (
									<button type="button" key={item.id} onClick={() => setSelectedFeed(item)} className="grid w-full grid-cols-[70px_minmax(0,1fr)] gap-2 rounded-2xl bg-background px-3 py-3 text-left">
											<time className="text-[10px] font-bold text-muted-foreground">{item.at.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
											<div>
												<span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[9px] font-black", signalClass(item.signal))}>{signalLabel(item.signal)}</span>
												<p className="mt-1.5 break-keep text-[11px] font-bold leading-5 text-foreground">{item.text}</p>
												<p className="mt-1 text-[10px] font-black text-primary">신뢰도 {item.confidence}% · 눌러서 근거 보기</p>
											</div>
									</button>
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
							<MetricCard icon={<Activity className="h-4 w-4" />} label="현재 추세" value={snapshot.trend} onClick={() => setSelectedExplanation({ title: "현재 추세", body: "현재가와 5·20·60 이동평균의 배열로 상승·중립·하락을 구분합니다." })} />
							<MetricCard icon={<Gauge className="h-4 w-4" />} label="신뢰도" value={`${opinion.confidence}/100`} onClick={() => setSelectedExplanation({ title: "신뢰도", body: "추세, 거래량, RSI, 신호 조건, 감지 패턴과 시장 방향의 실제 계산값을 합산한 기술분석 점수입니다." })} />
							<MetricCard icon={<TrendingUp className="h-4 w-4" />} label="현재가" value={formatPrice(snapshot.currentPrice, market)} onClick={() => setSelectedExplanation({ title: "현재가", body: "선택한 시간 프레임에서 가장 최근 봉의 종가입니다. 화면의 데이터 시각과 제공처를 함께 확인하세요." })} />
							<MetricCard icon={<Gauge className="h-4 w-4" />} label={snapshot.marketLabel} value={`${snapshot.marketChangePercent >= 0 ? "+" : ""}${snapshot.marketChangePercent.toFixed(2)}%`} onClick={() => setSelectedExplanation({ title: snapshot.marketLabel, body: "시장 대표 지수들의 실제 등락률 평균을 종목 기술분석의 보조 조건으로 사용합니다." })} />
							<MetricCard icon={<BarChart3 className="h-4 w-4" />} label="거래량" value={`${snapshot.volumeRatio.toFixed(2)}배`} onClick={() => setSelectedExplanation({ title: "거래량 비율", body: "최신 봉 거래량을 직전 20개 봉 평균 거래량으로 나눈 값입니다." })} />
						</div>

						<div className="mt-3 grid grid-cols-3 gap-2">
							<PlanCard tone="entry" label="진입 기준" value={formatPrice(opinion.entryPrice, market)} onClick={() => setSelectedExplanation({ title: "진입 기준", body: "진입 신호면 현재가, 대기 신호면 1차 저항과 ATR 완충폭을 넘는 가격을 기준으로 계산합니다." })} />
							<PlanCard tone="target" label="목표가" value={formatPrice(opinion.targetPrice, market)} onClick={() => setSelectedExplanation({ title: "AI 목표가", body: "2차 저항과 진입 대비 위험폭의 1.8배 중 더 높은 값을 사용하며 차트의 진한 초록 실선으로 표시합니다." })} />
							<PlanCard tone="stop" label="손절 기준" value={formatPrice(opinion.stopPrice, market)} onClick={() => setSelectedExplanation({ title: "AI 손절가", body: "1차 지지 이탈선과 ATR 1.25배 위험폭 중 더 보수적인 값을 사용하며 차트의 진한 빨강 실선으로 표시합니다." })} />
						</div>

						<div className="mt-3 grid grid-cols-2 gap-2">
							<LevelCard label="1차 저항" value={formatPrice(snapshot.levels.resistance1, market)} tone="resistance" onClick={() => setSelectedExplanation({ title: "1차 저항", body: "현재가 위에서 가장 가까운 최근 고점 군집입니다. 돌파되면 흐린 과거선으로 바뀌고 다음 저항이 진하게 표시됩니다." })} />
							<LevelCard label="2차 저항" value={formatPrice(snapshot.levels.resistance2, market)} tone="resistance" onClick={() => setSelectedExplanation({ title: "2차 저항", body: "현재가 위 두 번째 최근 고점 군집으로 목표가의 보조 기준입니다." })} />
							<LevelCard label="1차 지지" value={formatPrice(snapshot.levels.support1, market)} tone="support" onClick={() => setSelectedExplanation({ title: "1차 지지", body: "현재가 아래에서 가장 가까운 최근 저점 군집입니다. 이탈되면 흐린 과거선으로 바뀌고 새 지지가 진하게 표시됩니다." })} />
							<LevelCard label="2차 지지" value={formatPrice(snapshot.levels.support2, market)} tone="support" onClick={() => setSelectedExplanation({ title: "2차 지지", body: "현재가 아래 두 번째 최근 저점 군집으로 위험 관리의 보조 기준입니다." })} />
						</div>

						<div className="mt-3 grid grid-cols-3 gap-2">
							{overlays.rsi && <SmallIndicator label="RSI" value={snapshot.rsi == null ? "-" : snapshot.rsi.toFixed(1)} onClick={() => setSelectedExplanation({ title: "RSI", body: OVERLAYS.find((item) => item.key === "rsi")!.description })} />}
							{overlays.macd && <SmallIndicator label="MACD" value={snapshot.macd == null ? "-" : snapshot.macd.toFixed(3)} onClick={() => setSelectedExplanation({ title: "MACD", body: OVERLAYS.find((item) => item.key === "macd")!.description })} />}
							{overlays.atr && <SmallIndicator label="ATR" value={formatPrice(snapshot.atr, market)} onClick={() => setSelectedExplanation({ title: "ATR", body: OVERLAYS.find((item) => item.key === "atr")!.description })} />}
							{snapshot.patterns.map((pattern) => <SmallIndicator key={pattern} label="차트패턴" value={pattern} onClick={() => setSelectedExplanation({ title: pattern, body: "최근 고점·저점 간 거리, 기울기와 가격 허용오차를 충족해 감지된 후보입니다. 보라색 마커로 최신 감지 위치를 표시하며 거래량과 돌파 확인이 필요합니다." })} />)}
						</div>
					</section>
				</>
			)}

			<p className="px-1 text-[10px] font-semibold leading-4 text-muted-foreground">
				차트중계는 실제 시세·봉 데이터를 기반으로 한 기술적 분석 보조 기능입니다. 진입·매도 문구는 주문 실행이 아니라 조건 알림이며, 자동매매 주문 기능과 분리되어 있습니다.
			</p>

			{chartFullscreen && snapshot && opinion && (
				<div className="fixed inset-0 z-[140] bg-background p-2" style={{ transform: "translateZ(0)" }}>
					<div className="flex h-full flex-col"><div className="flex items-center justify-between gap-2 border-b border-card-border px-2 py-2"><div className="min-w-0"><p className="truncate text-sm font-black">{selectedStock.name} · {TIMEFRAMES.find((item) => item.key === timeframe)?.label}</p><p className="text-[10px] font-bold text-muted-foreground">휴대폰 자동회전을 허용하면 가로 화면으로 볼 수 있습니다.</p></div><button type="button" onClick={() => setChartFullscreen(false)} className="rounded-full border border-card-border bg-card p-2"><Minimize2 className="h-4 w-4" /></button></div><div className="min-h-0 flex-1"><ChartCanvas candles={candles} timeframe={timeframe} overlays={overlays} snapshot={snapshot} opinion={opinion} focusTime={focusTime} fullscreen /></div></div>
				</div>
			)}
			{feedFullscreen && (
				<div className="fixed inset-0 z-[139] flex flex-col bg-background"><div className="flex items-center justify-between border-b border-card-border p-4"><div><p className="text-[10px] font-black text-primary">{selectedStock.name} · {TIMEFRAMES.find((item) => item.key === timeframe)?.label}</p><h2 className="mt-1 text-lg font-black">AI 실시간 분석 전체 기록</h2></div><button type="button" onClick={() => setFeedFullscreen(false)} className="rounded-full bg-secondary p-2"><X className="h-5 w-5" /></button></div><div className="min-h-0 flex-1 overflow-y-auto p-3">{feed.length ? <div className="space-y-2">{feed.map((item) => <button type="button" key={`full:${item.id}`} onClick={() => setSelectedFeed(item)} className="w-full rounded-2xl border border-card-border bg-card p-3 text-left"><div className="flex items-center justify-between"><time className="text-[10px] font-bold text-muted-foreground">{item.at.toLocaleString("ko-KR")}</time><span className={cn("rounded-full border px-2 py-0.5 text-[9px] font-black", signalClass(item.signal))}>{signalLabel(item.signal)}</span></div><p className="mt-2 text-xs font-bold leading-5">{item.text}</p></button>)}</div> : <p className="py-10 text-center text-sm font-bold text-muted-foreground">저장된 중계 기록이 없습니다.</p>}</div></div>
			)}
			{selectedFeed && (
				<div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedFeed(null); }}>
					<section role="dialog" aria-modal="true" aria-labelledby="signal-reason-title" className="max-h-[80dvh] w-full max-w-sm overflow-y-auto rounded-3xl border border-card-border bg-card p-4 text-left shadow-2xl">
						<div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-black text-primary">{selectedStock.name} · {timeframe}</p><h2 id="signal-reason-title" className="mt-1 text-base font-black">{signalLabel(selectedFeed.signal)} {selectedFeed.confidence}점 근거</h2></div><button type="button" onClick={() => setSelectedFeed(null)} aria-label="신호 설명 닫기" className="rounded-full bg-secondary p-2"><X className="h-4 w-4" /></button></div>
						<p className="mt-3 break-keep rounded-2xl bg-secondary/70 p-3 text-xs font-bold leading-6">{selectedFeed.summary}</p>
						<ul className="mt-3 space-y-2">{selectedFeed.facts.map((fact) => <li key={fact} className="rounded-xl border border-card-border bg-background px-3 py-2 text-xs font-bold">{fact}</li>)}</ul>
						<p className="mt-3 text-[10px] font-bold text-muted-foreground">데이터 시각 {selectedFeed.at.toLocaleString('ko-KR')} · 새 봉 수신 시 재계산</p>
					</section>
				</div>
			)}
			{selectedExplanation && (
				<div className="fixed inset-0 z-[121] flex items-center justify-center bg-black/65 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedExplanation(null); }}>
					<section role="dialog" aria-modal="true" aria-labelledby="chart-help-title" className="max-h-[80dvh] w-full max-w-sm overflow-y-auto rounded-3xl border border-card-border bg-card p-4 text-left shadow-2xl">
						<div className="flex items-start justify-between gap-3"><h2 id="chart-help-title" className="text-base font-black">{selectedExplanation.title}</h2><button type="button" onClick={() => setSelectedExplanation(null)} aria-label="설명 닫기" className="rounded-full bg-secondary p-2"><X className="h-4 w-4" /></button></div>
						<p className="mt-3 break-keep text-sm font-semibold leading-6 text-muted-foreground">{selectedExplanation.body}</p>
						<button type="button" onClick={() => setSelectedExplanation(null)} className="mt-4 w-full rounded-2xl bg-primary px-4 py-2.5 text-sm font-black text-primary-foreground">닫기</button>
					</section>
				</div>
			)}
		</div>
	);
}

type LiveBroadcastFeed = {
	id: string;
	at: string;
	text: string;
	kind: "candle" | "signal" | "plan" | "connection";
};

type LiveBroadcastBanner = {
	id: string;
	name: string;
	price: number | null;
	at: string;
	importance: string;
};

function broadcastRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function broadcastAsset(value: unknown): RealtimeChartAsset {
	return value === "stockUS" ||
		value === "coinSpot" ||
		value === "coinFutures"
		? value
		: "stockKR";
}

function broadcastCandleUrl(
	asset: RealtimeChartAsset,
	symbol: string,
	interval: RealtimeChartTimeframe,
): string {
	const encoded = encodeURIComponent(symbol);
	if (asset === "stockKR" || asset === "stockUS") {
		return `/stocks/${encoded}/candles?tf=${encodeURIComponent(interval)}`;
	}
	if (asset === "coinSpot") {
		const provider = toUpbitTimeframe(interval);
		if (provider?.tf) {
			return `/crypto/spot/candles?symbol=${encoded}&tf=${provider.tf}&count=200`;
		}
		if (provider?.unit) {
			return `/crypto/spot/candles?symbol=${encoded}&unit=${provider.unit}&count=200`;
		}
		throw new Error(`UNSUPPORTED_UPBIT_INTERVAL:${interval}`);
	}
	return `/crypto/futures/candles?symbol=${encoded}&granularity=${encodeURIComponent(interval)}&limit=200`;
}

function broadcastCandleRows(payload: unknown): RealtimeCandle[] {
	if (!broadcastRecord(payload)) return [];
	const candidates =
		Array.isArray(payload.candles)
			? payload.candles
			: broadcastRecord(payload.data) && Array.isArray(payload.data.candles)
				? payload.data.candles
				: [];
	const rows: RealtimeCandle[] = [];
	for (const raw of candidates) {
		if (!broadcastRecord(raw) || raw.time == null) continue;
		const open = Number(raw.open);
		const high = Number(raw.high);
		const low = Number(raw.low);
		const close = Number(raw.close);
		const volume = Number(raw.volume ?? 0);
		if (
			!Number.isFinite(open) ||
			!Number.isFinite(high) ||
			!Number.isFinite(low) ||
			!Number.isFinite(close)
		) {
			continue;
		}
		rows.push({
			time: typeof raw.time === "number" ? raw.time : String(raw.time),
			open,
			high,
			low,
			close,
			volume: Number.isFinite(volume) ? Math.max(0, volume) : 0,
		});
	}
	return rows;
}

function broadcastTime(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
	}
	const parsed = Date.parse(String(value ?? ""));
	return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function broadcastPrice(value: unknown, asset: RealtimeChartAsset): string {
	const number = finite(value);
	if (number == null) return "산출 불가";
	if (asset === "stockUS") {
		return `$${number.toLocaleString("ko-KR", {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		})}`;
	}
	return number.toLocaleString("ko-KR", {
		maximumFractionDigits: asset === "stockKR" ? 0 : 6,
	});
}

function broadcastStatusLabel(status: string): string {
	if (status === "live") return "🟢 Live";
	if (status === "connecting" || status === "connected") return "🟡 Connecting";
	if (status === "reconnecting") return "🟡 Reconnecting";
	if (status === "error") return "🔴 Error";
	return "⚪ REST fallback";
}

function providerContract(asset: RealtimeChartAsset): {
	assetParam: "stock" | "coin";
	coinMarket: "spot" | "futures" | null;
} {
	if (asset === "coinSpot") return { assetParam: "coin", coinMarket: "spot" };
	if (asset === "coinFutures") {
		return { assetParam: "coin", coinMarket: "futures" };
	}
	return { assetParam: "stock", coinMarket: null };
}

function RealtimeBroadcastCanvas({ candles }: { candles: RealtimeCandle[] }) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const chartRef = useRef<IChartApi | null>(null);
	const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
	const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
	const fittedRef = useRef(false);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const chart = createChart(host, {
			width: Math.max(host.clientWidth, 280),
			height: 330,
			layout: {
				background: { type: ColorType.Solid, color: "transparent" },
				textColor: "#94a3b8",
			},
			grid: {
				vertLines: { color: "rgba(148,163,184,0.10)" },
				horzLines: { color: "rgba(148,163,184,0.10)" },
			},
			crosshair: { mode: CrosshairMode.Normal },
			rightPriceScale: { borderVisible: false },
			timeScale: {
				borderVisible: false,
				timeVisible: true,
				secondsVisible: false,
			},
		});
		const candleSeries = chart.addCandlestickSeries({
			upColor: "#ef4444",
			downColor: "#3b82f6",
			borderVisible: false,
			wickUpColor: "#ef4444",
			wickDownColor: "#3b82f6",
			priceScaleId: "right",
		});
		const volumeSeries = chart.addHistogramSeries({
			priceFormat: { type: "volume" },
			priceScaleId: "volume",
		});
		chart.priceScale("volume").applyOptions({
			scaleMargins: { top: 0.82, bottom: 0 },
		});
		chartRef.current = chart;
		candleSeriesRef.current = candleSeries;
		volumeSeriesRef.current = volumeSeries;
		const observer = new ResizeObserver(() => {
			if (host.clientWidth > 0) chart.applyOptions({ width: host.clientWidth });
		});
		observer.observe(host);
		return () => {
			observer.disconnect();
			chart.remove();
			chartRef.current = null;
			candleSeriesRef.current = null;
			volumeSeriesRef.current = null;
		};
	}, []);

	useEffect(() => {
		const normalized = candles
			.map((row) => ({ ...row, normalizedTime: broadcastTime(row.time) }))
			.filter((row) => row.normalizedTime > 0)
			.sort((left, right) => left.normalizedTime - right.normalizedTime);
		const deduped = [
			...new Map(normalized.map((row) => [row.normalizedTime, row])).values(),
		];
		candleSeriesRef.current?.setData(
			deduped.map((row) => ({
				time: row.normalizedTime as UTCTimestamp,
				open: row.open,
				high: row.high,
				low: row.low,
				close: row.close,
			})),
		);
		volumeSeriesRef.current?.setData(
			deduped.map((row) => ({
				time: row.normalizedTime as UTCTimestamp,
				value: row.volume,
				color:
					row.close >= row.open
						? "rgba(239,68,68,0.35)"
						: "rgba(59,130,246,0.35)",
			})),
		);
		if (!fittedRef.current) {
			chartRef.current?.timeScale().fitContent();
			fittedRef.current = true;
		}
	}, [candles]);

	return <div ref={hostRef} className="h-[330px] w-full" />;
}

export default function RealtimeChartBroadcastPage() {
	const [, navigate] = useLocation();
	const permissions = useMemberPermissions();
	const initial = useMemo(() => {
		const params = new URLSearchParams(
			typeof window === "undefined" ? "" : window.location.search,
		);
		const asset = broadcastAsset(params.get("asset"));
		const symbol =
			params.get("symbol")?.trim().toUpperCase() ||
			(asset === "stockKR"
				? "005930"
				: asset === "stockUS"
					? "AAPL"
					: asset === "coinSpot"
						? "BTC"
						: "BTCUSDT");
		const interval = normalizeRealtimeTimeframe(params.get("interval")) ?? "5m";
		return { asset, symbol, interval };
	}, []);
	const [asset, setAsset] = useState<RealtimeChartAsset>(initial.asset);
	const [symbol, setSymbol] = useState(initial.symbol);
	const [symbolInput, setSymbolInput] = useState("");
	const [interval, setInterval] =
		useState<RealtimeChartTimeframe>(initial.interval);
	const [feed, setFeed] = useState<LiveBroadcastFeed[]>([]);
	const [banners, setBanners] = useState<LiveBroadcastBanner[]>([]);
	const previousStatusRef = useRef<string>("idle");
	const previousSnapshotRef = useRef<{
		key: string;
		lastCandle: number;
		lastClose: number;
		planSignature: string;
		signalIds: Set<string>;
	} | null>(null);

	const sourceKey = `${asset}:${symbol}:${interval}`;
	const futuresLocked =
		asset === "coinFutures" && !permissions.has("futures");
	const realtime = useRealtimeChart({
		asset,
		symbol,
		interval,
		enabled: Boolean(symbol) && !futuresLocked,
	});
	// 실제 WebSocket 스냅샷이 오기 전에는 REST 조회를 함께 유지한다.
	// 연결 중/구독 중 상태에서 REST까지 꺼져 무한 로딩되는 것을 방지한다.
	const restFallback = realtime.status !== "live" || !realtime.snapshot;
	const contract = providerContract(asset);
	const candleQuery = useQuery({
		queryKey: ["chart-relay-candles", asset, symbol, interval],
		queryFn: () =>
			apiGet<Record<string, unknown>>(
				broadcastCandleUrl(asset, symbol, interval),
			),
		enabled: Boolean(symbol) && !futuresLocked && restFallback,
		refetchInterval: restFallback ? 20_000 : false,
		refetchIntervalInBackground: true,
		retry: 2,
	});
	const signalQuery = useQuery({
		queryKey: ["chart-relay-signals", asset, symbol, interval],
		queryFn: () =>
			apiGet<Record<string, unknown>>(
				`/market/chart-signals?asset=${contract.assetParam}${
					contract.coinMarket ? `&coinMarket=${contract.coinMarket}` : ""
				}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
			),
		enabled: Boolean(symbol) && !futuresLocked && restFallback,
		refetchInterval: restFallback ? 30_000 : false,
		retry: 1,
	});
	const planQuery = useQuery({
		queryKey: ["chart-relay-ai", asset, symbol, interval],
		queryFn: () =>
			apiGet<Record<string, unknown>>(
				`/market/ai-chart-plan?asset=${contract.assetParam}${
					contract.coinMarket ? `&coinMarket=${contract.coinMarket}` : ""
				}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
			),
		enabled: Boolean(symbol) && !futuresLocked && restFallback,
		refetchInterval: restFallback ? 30_000 : false,
		retry: 1,
	});

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		params.set("asset", asset);
		params.set("symbol", symbol);
		params.set("interval", interval);
		window.history.replaceState(
			window.history.state,
			"",
			`${window.location.pathname}?${params.toString()}`,
		);
	}, [asset, interval, symbol]);

	useEffect(() => {
		setFeed([]);
		setBanners([]);
		previousSnapshotRef.current = null;
	}, [sourceKey]);

	const appendFeed = (item: LiveBroadcastFeed) => {
		setFeed((current) => {
			if (current.some((row) => row.id === item.id)) return current;
			return [item, ...current].slice(0, 100);
		});
	};

	useEffect(() => {
		if (previousStatusRef.current === realtime.status) return;
		const previous = previousStatusRef.current;
		previousStatusRef.current = realtime.status;
		if (realtime.status === "reconnecting") {
			appendFeed({
				id: `${sourceKey}:status:reconnecting:${Date.now()}`,
				at: new Date().toISOString(),
				text: "실시간 연결이 끊겨 자동 재연결을 시작했습니다.",
				kind: "connection",
			});
		} else if (
			realtime.status === "live" &&
			(previous === "reconnecting" || previous === "error")
		) {
			appendFeed({
				id: `${sourceKey}:status:restored:${Date.now()}`,
				at: new Date().toISOString(),
				text: "실시간 연결이 복구되었습니다.",
				kind: "connection",
			});
		}
	}, [realtime.status, sourceKey]);

	const matchingSnapshot =
		realtime.snapshot?.asset === asset &&
		realtime.snapshot.symbol === symbol &&
		realtime.snapshot.interval === interval
			? realtime.snapshot
			: null;
	const restCandles = broadcastCandleRows(candleQuery.data);
	const candles = matchingSnapshot?.candles?.length
		? matchingSnapshot.candles
		: restCandles;
	const signalRows =
		matchingSnapshot?.signals ??
		(Array.isArray(signalQuery.data?.signals)
			? signalQuery.data.signals.filter(broadcastRecord)
			: []);
	const plan =
		matchingSnapshot?.plan ??
		(planQuery.data && planQuery.data.ok !== false ? planQuery.data : null);

	useEffect(() => {
		if (!matchingSnapshot) return;
		const latest = matchingSnapshot.candles.at(-1);
		if (!latest) return;
		const lastCandle = broadcastTime(latest.time);
		const planSignature = JSON.stringify({
			view: plan?.view ?? null,
			target: plan?.target ?? null,
			stop: plan?.stop ?? null,
		});
		const ids = new Set(
			signalRows.map((row) => String(row.id ?? "")).filter(Boolean),
		);
		const previous = previousSnapshotRef.current;
		if (!previous || previous.key !== sourceKey) {
			previousSnapshotRef.current = {
				key: sourceKey,
				lastCandle,
				lastClose: latest.close,
				planSignature,
				signalIds: ids,
			};
			appendFeed({
				id: `${sourceKey}:snapshot:${matchingSnapshot.fetchedAt}`,
				at: matchingSnapshot.fetchedAt,
				text: `실시간 스냅샷 수신 · 캔들 ${matchingSnapshot.candles.length}개`,
				kind: "candle",
			});
			return;
		}

		if (
			previous.lastCandle !== lastCandle ||
			previous.lastClose !== latest.close
		) {
			appendFeed({
				id: `${sourceKey}:candle:${lastCandle}:${latest.close}`,
				at: matchingSnapshot.fetchedAt,
				text:
					previous.lastCandle !== lastCandle
						? `새 캔들 수신 · ${broadcastPrice(latest.close, asset)}`
						: `현재 캔들 갱신 · ${broadcastPrice(latest.close, asset)}`,
				kind: "candle",
			});
		}

		const freshSignals = signalRows.filter((row) => {
			const id = String(row.id ?? "");
			return id && !previous.signalIds.has(id);
		});
		for (const row of freshSignals) {
			const id = String(row.id);
			const at = String(row.occurredAt ?? matchingSnapshot.fetchedAt);
			const name = String(row.name ?? "기술 신호");
			appendFeed({
				id: `${sourceKey}:signal:${id}`,
				at,
				text: `${name} 신호 · ${String(row.meaningHere ?? "")}`.trim(),
				kind: "signal",
			});
		}
		if (freshSignals.length > 0) {
			setBanners((current) =>
				[
					...freshSignals.map((row) => ({
						id: String(row.id),
						name: String(row.name ?? "기술 신호"),
						price: finite(row.price),
						at: String(row.occurredAt ?? matchingSnapshot.fetchedAt),
						importance: String(row.importance ?? "산출 불가"),
					})),
					...current,
				].slice(0, 3),
			);
		}

		if (previous.planSignature !== planSignature) {
			appendFeed({
				id: `${sourceKey}:plan:${matchingSnapshot.fetchedAt}:${planSignature}`,
				at: matchingSnapshot.fetchedAt,
				text: `AI 계획 갱신 · ${String(plan?.view ?? "관점 산출 불가")}`,
				kind: "plan",
			});
		}
		previousSnapshotRef.current = {
			key: sourceKey,
			lastCandle,
			lastClose: latest.close,
			planSignature,
			signalIds: ids,
		};
	}, [asset, matchingSnapshot, plan, signalRows, sourceKey]);

	useEffect(() => {
		if (banners.length === 0) return;
		const timer = window.setTimeout(
			() => setBanners((current) => current.slice(0, -1)),
			5_000,
		);
		return () => window.clearTimeout(timer);
	}, [banners]);

	const latest = candles.at(-1) ?? null;
	const previous = candles.at(-2) ?? null;
	const changePercent =
		latest && previous && previous.close !== 0
			? ((latest.close - previous.close) / previous.close) * 100
			: null;
	const latestSignal = signalRows
		.slice()
		.sort(
			(left, right) =>
				Date.parse(String(right.occurredAt ?? "")) -
				Date.parse(String(left.occurredAt ?? "")),
		)[0];
	const riskValue =
		plan?.risk ?? plan?.riskLevel ?? plan?.riskScore ?? "산출 불가";
	const confidenceRaw =
		plan?.confidence ?? plan?.confidenceScore ?? plan?.probability;
	const confidenceNumber = finite(confidenceRaw);
	const confidence =
		confidenceNumber == null
			? "산출 불가"
			: `${Math.max(
					0,
					Math.min(100, confidenceNumber <= 1 ? confidenceNumber * 100 : confidenceNumber),
				).toFixed(0)}%`;
	const marketLabel =
		asset === "stockKR"
			? "국내주식"
			: asset === "stockUS"
				? "해외주식"
				: asset === "coinSpot"
					? "코인 현물"
					: "코인 선물";
	const market =
		asset === "stockUS"
			? "US"
			: asset === "stockKR"
				? "KR"
				: asset === "coinSpot"
					? "UPBIT"
					: "BITGET";
	const currency =
		asset === "stockUS" ? "USD" : asset === "coinFutures" ? "USDT" : "KRW";

	return (
		<div className="h-full overflow-y-auto bg-background">
			<div className="mx-auto max-w-md px-4 pb-28 pt-4">
				<header className="grid grid-cols-[40px_1fr_40px] items-center gap-3">
					<button
						type="button"
						onClick={() =>
							navigate(
								`/tech/chart-relay?asset=${encodeURIComponent(asset)}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
							)
						}
						aria-label="상세 차트로 돌아가기"
						className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"
					>
						<ArrowLeft className="h-4 w-4" />
					</button>
					<div className="text-center">
						<h1 className="text-lg font-extrabold">실시간 차트 생중계</h1>
						<p className="text-[11px] font-bold text-muted-foreground">
							실제 수신 이벤트만 표시
						</p>
					</div>
					<FavoriteButton
						symbol={symbol}
						name={symbol}
						assetType={asset}
						market={market}
						currency={currency}
						className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card text-warning"
					/>
				</header>

				{banners.length > 0 && (
					<div className="mt-3 space-y-2" aria-live="polite">
						{banners.map((banner) => (
							<div
								key={banner.id}
								className="flex items-center gap-2 rounded-2xl border border-primary/40 bg-primary/10 p-3"
							>
								<div className="min-w-0 flex-1">
									<p className="truncate text-xs font-black">
										{banner.name} · {symbol}
									</p>
									<p className="text-[10px] font-bold text-muted-foreground">
										{broadcastPrice(banner.price, asset)} ·{" "}
										{new Date(banner.at).toLocaleTimeString("ko-KR")} ·{" "}
										{banner.importance}
									</p>
								</div>
								<button
									type="button"
									onClick={() =>
										setBanners((current) =>
											current.filter((item) => item.id !== banner.id),
										)
									}
									aria-label="신호 알림 닫기"
								>
									<X className="h-4 w-4" />
								</button>
							</div>
						))}
					</div>
				)}

				<div className="mt-3 grid grid-cols-2 gap-2">
					<select
						value={asset}
						onChange={(event) => {
							const next = broadcastAsset(event.target.value);
							if (next === "coinFutures" && !permissions.has("futures")) return;
							setAsset(next);
							setSymbol(
								next === "stockKR"
									? "005930"
									: next === "stockUS"
										? "AAPL"
										: next === "coinSpot"
											? "BTC"
											: "BTCUSDT",
							);
						}}
						className="rounded-xl border border-card-border bg-card px-3 py-2 text-xs font-black"
						aria-label="시장 선택"
					>
						<option value="stockKR">국내주식</option>
						<option value="stockUS">해외주식</option>
						<option value="coinSpot">코인 현물</option>
						<option value="coinFutures" disabled={!permissions.has("futures")}>
							코인 선물
						</option>
					</select>
					<div className="flex gap-1">
						<input
							value={symbolInput}
							onChange={(event) => setSymbolInput(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && symbolInput.trim()) {
									setSymbol(symbolInput.trim().toUpperCase());
									setSymbolInput("");
								}
							}}
							placeholder="종목 코드"
							className="min-w-0 flex-1 rounded-xl border border-card-border bg-card px-2 text-xs font-bold"
						/>
						<button
							type="button"
							onClick={() => {
								if (!symbolInput.trim()) return;
								setSymbol(symbolInput.trim().toUpperCase());
								setSymbolInput("");
							}}
							className="rounded-xl bg-primary px-2 text-[10px] font-black text-primary-foreground"
						>
							선택
						</button>
					</div>
				</div>

				<div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
					{REALTIME_CHART_TIMEFRAMES.map((value) => (
						<button
							key={value}
							type="button"
							onClick={() => setInterval(value)}
							className={cn(
								"shrink-0 rounded-xl border px-3 py-2 text-xs font-black",
								value === interval
									? "border-primary bg-primary text-primary-foreground"
									: "border-card-border bg-card text-muted-foreground",
							)}
						>
							{realtimeTimeframeLabel(value)}
						</button>
					))}
				</div>

				<div className="mt-3 rounded-2xl border border-card-border bg-card p-3">
					<div className="flex items-start justify-between gap-2">
						<div>
							<p className="text-sm font-black">
								{marketLabel} · {symbol}
							</p>
							<p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
								{broadcastStatusLabel(realtime.status)}
								{realtime.provider ? ` · ${realtime.provider}` : ""}
								{restFallback ? " · REST fallback" : ""}
							</p>
						</div>
						<InstrumentAlertButton
							symbol={symbol}
							name={symbol}
							assetType={asset}
							market={market}
							currency={currency}
							currentPrice={latest?.close ?? null}
							className="rounded-full border border-card-border p-2"
						/>
					</div>
					<div className="mt-3 grid grid-cols-3 gap-2 text-center">
						<div className="rounded-xl bg-secondary/60 p-2">
							<p className="text-[10px] font-bold text-muted-foreground">현재가</p>
							<p className="mt-1 text-xs font-black">
								{broadcastPrice(latest?.close, asset)}
							</p>
						</div>
						<div className="rounded-xl bg-secondary/60 p-2">
							<p className="text-[10px] font-bold text-muted-foreground">
								직전 봉 대비
							</p>
							<p className="mt-1 text-xs font-black">
								{changePercent == null
									? "-"
									: `${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%`}
							</p>
						</div>
						<div className="rounded-xl bg-secondary/60 p-2">
							<p className="text-[10px] font-bold text-muted-foreground">시간봉</p>
							<p className="mt-1 text-xs font-black">
								{realtimeTimeframeLabel(interval)}
							</p>
						</div>
					</div>
				</div>

				<section className="mt-3 overflow-hidden rounded-2xl border border-card-border bg-card">
					{futuresLocked ? (
						<p className="p-8 text-center text-sm font-bold text-muted-foreground">
							코인 선물은 정회원 권한이 필요합니다.
						</p>
					) : candleQuery.isLoading && candles.length === 0 ? (
						<div className="flex h-[330px] items-center justify-center gap-2 text-sm font-bold text-muted-foreground">
							<Loader2 className="h-5 w-5 animate-spin" /> 차트 불러오는 중
						</div>
					) : candles.length < 2 ? (
						<p className="p-8 text-center text-sm font-bold text-muted-foreground">
							실제 차트 데이터가 없습니다.
						</p>
					) : (
						<RealtimeBroadcastCanvas key={sourceKey} candles={candles} />
					)}
				</section>

				<section className="mt-3 rounded-2xl border border-card-border bg-card p-3">
					<h2 className="text-sm font-black">최신 AI 계획·신호</h2>
					<div className="mt-3 grid grid-cols-3 gap-2 text-center">
						<div className="rounded-xl bg-secondary/60 p-2">
							<p className="text-[10px] font-bold text-muted-foreground">추천 진입가</p>
							<p className="mt-1 text-xs font-black">
								{broadcastPrice(
									Array.isArray(plan?.buyLevels) ? plan.buyLevels[0] : null,
									asset,
								)}
							</p>
						</div>
						<div className="rounded-xl bg-secondary/60 p-2">
							<p className="text-[10px] font-bold text-muted-foreground">목표가</p>
							<p className="mt-1 text-xs font-black">
								{broadcastPrice(plan?.target, asset)}
							</p>
						</div>
						<div className="rounded-xl bg-secondary/60 p-2">
							<p className="text-[10px] font-bold text-muted-foreground">손절가</p>
							<p className="mt-1 text-xs font-black">
								{broadcastPrice(plan?.stop, asset)}
							</p>
						</div>
					</div>
					<div className="mt-2 grid grid-cols-3 gap-2 text-center">
						<div className="rounded-xl bg-secondary/60 p-2">
							<p className="text-[10px] font-bold text-muted-foreground">최신 신호</p>
							<p className="mt-1 text-xs font-black">
								{String(latestSignal?.name ?? plan?.view ?? "산출 불가")}
							</p>
						</div>
						<div className="rounded-xl bg-secondary/60 p-2">
							<p className="text-[10px] font-bold text-muted-foreground">AI 위험도</p>
							<p className="mt-1 text-xs font-black">{String(riskValue)}</p>
						</div>
						<div className="rounded-xl bg-secondary/60 p-2">
							<p className="text-[10px] font-bold text-muted-foreground">AI 신뢰도</p>
							<p className="mt-1 text-xs font-black">{confidence}</p>
						</div>
					</div>
					{Array.isArray(plan?.basis) && plan.basis.length > 0 ? (
						<ul className="mt-3 space-y-1 rounded-xl bg-secondary/60 p-3 text-[11px] font-bold leading-5">
							{plan.basis.slice(0, 5).map((item, index) => (
								<li key={`${String(item)}:${index}`}>• {String(item)}</li>
							))}
						</ul>
					) : (
						<p className="mt-3 text-center text-[11px] font-bold text-muted-foreground">
							AI 추천 근거를 수신하지 못했습니다.
						</p>
					)}
					<p className="mt-2 text-center text-[10px] font-bold text-muted-foreground">
						위험도·신뢰도는 AI 응답 필드가 있을 때만 표시합니다.
					</p>
				</section>

				<section className="mt-3 rounded-2xl border border-card-border bg-card p-3">
					<div className="flex items-center justify-between gap-2">
						<h2 className="text-sm font-black">실시간 이벤트 피드</h2>
						<span className="text-[10px] font-bold text-muted-foreground">
							최근 {feed.length}/100
						</span>
					</div>
					{feed.length === 0 ? (
						<p className="py-8 text-center text-xs font-bold text-muted-foreground">
							실제 이벤트 수신을 기다리는 중입니다.
						</p>
					) : (
						<ol className="mt-3 space-y-2">
							{feed.map((item) => (
								<li
									key={item.id}
									className="rounded-xl border border-card-border bg-background p-2"
								>
									<time className="text-[10px] font-bold text-muted-foreground">
										{new Date(item.at).toLocaleTimeString("ko-KR")}
									</time>
									<p className="mt-0.5 text-xs font-bold">{item.text}</p>
								</li>
							))}
						</ol>
					)}
				</section>

				<p className="mt-3 rounded-2xl border border-warning/40 bg-warning/10 px-3 py-2 text-center text-[10px] font-black text-warning">
					AI 신호와 추천 가격은 참고용이며 실제 주문을 실행하지 않습니다.
				</p>
				<button
					type="button"
					onClick={() =>
						navigate(
							`/tech/chart-relay?asset=${encodeURIComponent(asset)}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
						)
					}
					className="mt-3 w-full rounded-2xl bg-primary py-3 text-sm font-black text-primary-foreground"
				>
					상세 차트 보기
				</button>
			</div>
			<BottomNav />
		</div>
	);
}

function MetricCard({ icon, label, value, onClick }: { icon: ReactNode; label: string; value: string; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} className="rounded-2xl border border-card-border bg-background p-3 text-left">
			<div className="flex items-center gap-1.5 text-primary">{icon}<span className="text-[10px] font-extrabold text-muted-foreground">{label}</span></div>
			<p className="mt-2 text-sm font-black">{value}</p>
		</button>
	);
}

function PlanCard({ tone, label, value, onClick }: { tone: "entry" | "target" | "stop"; label: string; value: string; onClick: () => void }) {
	const Icon = tone === "entry" ? TrendingUp : tone === "target" ? Target : TrendingDown;
	return (
		<button type="button" onClick={onClick} className={cn("rounded-2xl border p-3 text-left", tone === "entry" ? "border-destructive/20 bg-destructive/5" : tone === "target" ? "border-warning/20 bg-warning/5" : "border-blue-500/20 bg-blue-500/5")}>
			<Icon className={cn("h-4 w-4", tone === "entry" ? "text-destructive" : tone === "target" ? "text-warning" : "text-blue-500")} />
			<p className="mt-2 text-[10px] font-extrabold text-muted-foreground">{label}</p>
			<p className="mt-1 break-keep text-xs font-black">{value}</p>
		</button>
	);
}

function LevelCard({ label, value, tone, onClick }: { label: string; value: string; tone: "support" | "resistance"; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} className="flex items-center justify-between gap-2 rounded-2xl border border-card-border bg-background px-3 py-2.5 text-left">
			<span className={cn("text-[10px] font-extrabold", tone === "support" ? "text-blue-500" : "text-destructive")}>{label}</span>
			<strong className="text-xs">{value}</strong>
		</button>
	);
}

function SmallIndicator({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} className="rounded-2xl bg-secondary/70 px-3 py-2.5 text-center">
			<p className="text-[10px] font-extrabold text-muted-foreground">{label}</p>
			<p className="mt-1 text-xs font-black">{value}</p>
		</button>
	);
}
