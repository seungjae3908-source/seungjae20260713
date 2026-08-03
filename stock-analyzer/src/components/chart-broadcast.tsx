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
import {
  buildChartAnalysis,
  shouldAppendTimeline,
  type ChartAnalysis,
} from "@/lib/chart-analysis";

export type ChartBroadcastMarket = "KR" | "US";

type AnyObj = Record<string, any>;
export type ChartTimeframe =
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
	isClosed: boolean;
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
	changePercent: number | null;
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
	trend: "ìƒìŠ¹" | "ì¤‘ë¦½" | "í•˜ë½";
	levels: LevelSnapshot;
	patterns: string[];
	bullishPatternScore: number;
	bearishPatternScore: number;
	marketLabel: string;
	marketChangePercent: number | null;
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
	status: ChartAnalysis["status"];
	analysis: ChartAnalysis;
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
	onAnalysisChange?: (analysis: ChartAnalysis) => void;
	onSelectionChange?: (selection: { ticker: string; name: string; market: ChartBroadcastMarket; timeframe: ChartTimeframe }) => void;
	initialSelection?: { ticker: string; name: string; market: ChartBroadcastMarket; timeframe?: string } | null;
};

const TIMEFRAMES: Array<{ key: ChartTimeframe; label: string }> = [
	{ key: "1m", label: "1ë¶„" },
	{ key: "3m", label: "3ë¶„" },
	{ key: "5m", label: "5ë¶„" },
	{ key: "15m", label: "15ë¶„" },
	{ key: "30m", label: "30ë¶„" },
	{ key: "1H", label: "1ì‹œê°„" },
	{ key: "4H", label: "4ì‹œê°„" },
	{ key: "1D", label: "1ì¼" },
	{ key: "5D", label: "5ì¼" },
	{ key: "20D", label: "20ì¼" },
];

const OVERLAYS: Array<{
	key: OverlayKey;
	label: string;
	group: "ì°¨íŠ¸ì„ " | "ì‹ í˜¸" | "ë³´ì¡°ì§€í‘œ";
}> = [
	{ key: "ma5", label: "5ì´í‰", group: "ì°¨íŠ¸ì„ " },
	{ key: "ma20", label: "20ì´í‰", group: "ì°¨íŠ¸ì„ " },
	{ key: "ma60", label: "60ì´í‰", group: "ì°¨íŠ¸ì„ " },
	{ key: "ma120", label: "120ì´í‰", group: "ì°¨íŠ¸ì„ " },
	{ key: "bollinger", label: "ë³¼ë¦°ì €ë°´ë“œ", group: "ì°¨íŠ¸ì„ " },
	{ key: "vwap", label: "VWAP", group: "ì°¨íŠ¸ì„ " },
	{ key: "volume", label: "ê±°ë˜ëŸ‰", group: "ì°¨íŠ¸ì„ " },
	{ key: "levels", label: "ì§€ì§€Â·ì €í•­", group: "ì‹ í˜¸" },
	{ key: "arrows", label: "ë§¤ìˆ˜Â·ë§¤ë„ í™”ì‚´í‘œ", group: "ì‹ í˜¸" },
	{ key: "rsi", label: "RSI", group: "ë³´ì¡°ì§€í‘œ" },
	{ key: "macd", label: "MACD", group: "ë³´ì¡°ì§€í‘œ" },
	{ key: "atr", label: "ATR", group: "ë³´ì¡°ì§€í‘œ" },
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
		name: "ì‚¼ì„±ì „ì",
		market: "KR",
		currency: "KRW",
		price: null,
		changePercent: null,
	},
	US: {
		ticker: "AAPL",
		name: "ì• í”Œ",
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
				.replace(/[â‚©$ì›ë°°]/g, "")
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
			const time = candleTime(sourceTime, index, rows.length, timeframe);
			const explicitClosed = typeof row?.isClosed === "boolean"
				? row.isClosed
				: typeof row?.closed === "boolean"
					? row.closed
					: typeof row?.final === "boolean"
						? row.final
						: null;
			const derivedClosed = timeframe !== "5D" && timeframe !== "20D" && Date.now() / 1000 >= Number(time) + timeframeSeconds(timeframe) + 60;
			return {
				time,
				sourceTime,
				open,
				high: Math.max(high, open, close),
				low: Math.min(low, open, close),
				close,
				volume: Math.max(volume ?? 0, 0),
				isClosed: explicitClosed ?? derivedClosed,
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

	let lastError = "ì°¨íŠ¸ ë°ì´í„°ë¥¼ ë¶ˆëŸ¬ì˜¤ì§€ ëª»í–ˆìŠµë‹ˆë‹¤.";
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
	const averageChange = changes.length ? changes.reduce((sum: number, value: number) => sum + value, 0) / changes.length : null;
	return {
		label: market === "KR" ? "ì½”ìŠ¤í”¼Â·ì½”ìŠ¤ë‹¥" : "S&P500Â·ë‚˜ìŠ¤ë‹¥",
		changePercent: averageChange,
		bias: averageChange == null ? 0 : clamp(averageChange * 4, -10, 10),
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
				Math.abs(cur×M·ÒÚ$z{-®éÜj×UW6R6Æ74æÖSÒ&‚Ó2ãRrÓ2ãR"óâ¢Ä6—&6ÆUÆ’6Æ74æÖSÒ&‚Ó2ãRrÓ2ãR"óçĞĞ —¶Æ—fRò.Éé¸ù’«ÈºÊI"¢.«ÈºÉÛÎÈ¹ÎÊ	^Êx'Ğ “Âö'WGFöãàĞ “ÂöF—càĞ Ğ “ÆF—b6Æ74æÖSÒ'&VÆF—fR×BÓ2#àĞ “Å6V&6‚6Æ74æÖSÒ'ö–çFW"ÖWfVçG2ÖæöæR'6öÇWFRÆVgBÓ2F÷Óó"‚ÓBrÓB×G&ç6ÆFR×’Óó"FW‡BÖ×WFVBÖf÷&Vw&÷VæB"óàĞ “Æ–çW@Ğ —fÇVS×·VW'—ĞĞ –öä6†ævS×²†WfVçB’Óâ6WEVW'’†WfVçBçF&vWBçfÇVR—ĞĞ —Æ6V†öÆFW#×¶Ö&¶WBÓÓÒ$µ""ò.Ê(^ºªº¨R¹‰¸©BÊ(^ºªËÙN¹9Â«(È8’"¢.Ù¨ÎÈ*Îº¨R¹‰¸©BØ»ËºB«(È8’'ĞĞ –6Æ74æÖSÒ&‚ÓrÖgVÆÂ&÷VæFVBÓ'†Â&÷&FW"&÷&FW"Ö6&BÖ&÷&FW"&rÖ&6¶w&÷VæBÂÓ"ÓFW‡B×6ÒföçBÖ&öÆB÷WFÆ–æRÖæöæRfö7W3¦&÷&FW"×&–Ö'’ Ğ ’óàĞ —·VW'’bb€Ğ “Æ'WGFöàĞ —G—SÒ&'WGFöâ Ğ –öä6Æ–6³×²‚’Óâ6WEVW'’‚""—ĞĞ –6Æ74æÖSÒ&'6öÇWFR&–v‡BÓ2F÷Óó"×G&ç6ÆFR×’Óó"FW‡BÖ×WFVBÖf÷&Vw&÷VæB Ğ “àĞ “Å‚6Æ74æÖSÒ&‚ÓBrÓB"óàĞ “Âö'WGFöãàĞ ’—ĞĞ “ÂöF—càĞ Ğ —·G&–ÖÖVBbb€Ğ “ÆF—b6Æ74æÖSÒ&×BÓ"Ö‚Ö‚ÓcB÷fW&fÆ÷r×’ÖWFò&÷VæFVBÓ'†Â&÷&FW"&÷&FW"Ö6&BÖ&÷&FW"&rÖ&6¶w&÷VæBÓ"#àĞ —·6V&6‚æ—4ÆöF–ærò€Ğ “ÆF—b6Æ74æÖSÒ&fÆW‚—FV×2Ö6VçFW"§W7F–g’Ö6VçFW"vÓ"‚Ó2’ÓRFW‡B×‡2föçBÖ&öÆBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#àĞ “ÄÆöFW#"6Æ74æÖSÒ&‚ÓBrÓBæ–ÖFR×7–â"óâ«(È8’ÊIââàĞ “ÂöF—càĞ ’’¢6V&6…&÷w2æÆVæwF‚ò€Ğ —6V&6…&÷w2æÖ‚‡&÷r’Óâ€Ğ “Æ'WGFöàĞ –¶W“×¶G·&÷ræÖ&¶WGÓ¢G·&÷rçF–6¶W'ÖĞĞ —G—SÒ&'WGFöâ Ğ –öä6Æ–6³×²‚’Óâ°Ğ —6WE6VÆV7FVE7Fö6²‡&÷r“°Ğ —6WEVW'’‚""“° —6WDfVVB…µÒ“° —6WDfö7W5F–ÖR‡VæFVf–æVB“° –Æ7DfVVD¶W’æ7W'&VçBÒ"#°Ğ —×ĞĞ –6Æ74æÖSÒ&fÆW‚rÖgVÆÂ—FV×2Ö6VçFW"§W7F–g’Ö&WGvVVâvÓ2&÷VæFVB×†Â‚Ó2’Ó"ãRFW‡BÖÆVgBG&ç6—F–öâ†÷fW#¦&r×6V6öæF'’ Ğ “àĞ “ÆF—b6Æ74æÖSÒ&Ö–â×rÓ#àĞ “Ç6Æ74æÖSÒ'G'Væ6FRFW‡B×6ÒföçBÖW‡G&&öÆB#ç·&÷rææÖWÓÂ÷àĞ “Ç6Æ74æÖSÒ&×BÓãRFW‡BÕ³…ÒföçBÖ&öÆBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#ç·&÷rçF–6¶W'ÓÂ÷àĞ “ÂöF—càĞ “ÆF—b6Æ74æÖSÒ'FW‡B×&–v‡B#àĞ “Ç6Æ74æÖSÒ'FW‡B×‡2föçBÖW‡G&&öÆB#ç¶f÷&ÖE&–6R‡&÷rç&–6RÂ&÷ræÖ&¶WB—ÓÂ÷àĞ “Ç6Æ74æÖS×¶6â‚&×BÓãRFW‡BÕ³…ÒföçBÖ&öÆB"Â‡&÷ræ6†ævUW&6VçBóò’âò'FW‡BÖFW7G'V7F—fR"¢‡&÷ræ6†ævUW&6VçBóò’Âò'FW‡BÖ&ÇVRÓS"¢'FW‡BÖ×WFVBÖf÷&Vw&÷VæB"—Óç¶f÷&ÖEW&6VçB‡&÷ræ6†ævUW&6VçB—ÓÂ÷àĞ “ÂöF—càĞ “Âö'WGFöãàĞ ’’Ğ ’’¢€Ğ “Ç6Æ74æÖSÒ'‚Ó2’ÓRFW‡BÖ6VçFW"FW‡B×‡2föçBÖ&öÆBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#î«(È8’«+«;Î«ÉxnÈ«^¸¸¸ºBãÂ÷àĞ ’—ĞĞ “ÂöF—càĞ ’—ĞĞ “Â÷6V7F–öãàĞ Ğ “Ç6V7F–öâ6Æ74æÖSÒ&÷fW&fÆ÷rÖ†–FFVâ&÷VæFVBÓ7†Â&÷&FW"&÷&FW"Ö6&BÖ&÷&FW"&rÖ6&B6†F÷r×6Ò#àĞ “ÆF—b6Æ74æÖSÒ&&÷&FW"Ö"&÷&FW"Ö6&BÖ&÷&FW"ÓB#àĞ “ÆF—b6Æ74æÖSÒ&fÆW‚—FV×2×7F'B§W7F–g’Ö&WGvVVâvÓ2#àĞ “ÆF—b6Æ74æÖSÒ&Ö–â×rÓ#àĞ “ÆF—b6Æ74æÖSÒ&fÆW‚fÆW‚×w&—FV×2Ö6VçFW"vÓ"#àĞ “Æƒ"6Æ74æÖSÒ'G'Væ6FRFW‡BÖÆrföçBÖ&Æ6²#ç·6VÆV7FVE7Fö6²ææÖWÓÂöƒ#àĞ “Ç7â6Æ74æÖSÒ'&÷VæFVBÖgVÆÂ&r×6V6öæF'’‚Ó"’ÓFW‡BÕ³…ÒföçBÖW‡G&&öÆBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#ç·6VÆV7FVE7Fö6²çF–6¶W'ÓÂ÷7ãàĞ “ÂöF—càĞ “Ç6Æ74æÖSÒ&×BÓFW‡BÕ³…ÒföçBÖ&öÆBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#à —¶6†'BæFFòç&÷f–FW"òÊ	Î«;^Ë)‚G¶6†'BæFFç&÷f–FW'Ö¢.ÈºNÊ	ÂË
Ø«‚¸ÛÉÛNØKÉ{«+'Ğ —¶+rÈ8Ø9ÂG¶FF7FGW7ÖĞ —·WFFVDBò+rG¶æWrFFR‡WFFVDB’çFôÆö6ÆUF–ÖU7G&–ær‚&¶òÔµ""—Ö¢"'Ğ “Â÷àĞ “ÂöF—càĞ “Æ'WGFöàĞ —G—SÒ&'WGFöâ Ğ –öä6Æ–6³×²‚’Óâfö–B6†'Bç&VfWF6‚‚—ĞĞ –6Æ74æÖSÒ&fÆW‚‚Ó’rÓ’6‡&–æ²Ó—FV×2Ö6VçFW"§W7F–g’Ö6VçFW"&÷VæFVBÖgVÆÂ&÷&FW"&÷&FW"Ö6&BÖ&÷&FW"&rÖ&6¶w&÷VæB Ğ —F—FÆSÒ.Ë
Ø«‚È8ºÎ«:Ëš‚ Ğ “àĞ “Å&Vg&W6„7r6Æ74æÖS×¶6â‚&‚ÓBrÓB"Â6†'Bæ—4fWF6†–ærbb&æ–ÖFR×7–â"—ÒóàĞ “Âö'WGFöãàĞ “ÂöF—càĞ Ğ “ÆF—b6Æ74æÖSÒ&×BÓ2fÆW‚vÓ"÷fW&fÆ÷r×‚ÖWFò"Ó#àĞ —¶f–Æ&ÆUF–ÖVg&ÖW2æÖ‚†—FVÒ’Óâ€ “Æ'WGFöàĞ –¶W“×¶—FVÒæ¶W—ĞĞ —G—SÒ&'WGFöâ Ğ –öä6Æ–6³×²‚’Óâ°Ğ —6WEF–ÖVg&ÖR†—FVÒæ¶W’“° —6WDfVVB…µÒ“° —6WDfö7W5F–ÖR‡VæFVf–æVB“° –Æ7DfVVD¶W’æ7W'&VçBÒ"#°Ğ —×ĞĞ –6Æ74æÖS×¶6â€Ğ ’'6‡&–æ²Ó&÷VæFVB×†Â&÷&FW"‚Ó2’Ó"FW‡B×‡2föçBÖW‡G&&öÆB"ÀĞ —F–ÖVg&ÖRÓÓÒ—FVÒæ¶WĞ “ò&&÷&FW"×&–Ö'’&r×&–Ö'’FW‡B×&–Ö'’Öf÷&Vw&÷VæB Ğ “¢&&÷&FW"Ö6&BÖ&÷&FW"&rÖ&6¶w&÷VæBFW‡BÖ×WFVBÖf÷&Vw&÷VæB"ÀĞ ’—ĞĞ “àĞ —¶—FVÒæÆ&VÇĞĞ “Âö'WGFöãàĞ ’’—ĞĞ “ÂöF—càĞ Ğ “Æ'WGFöàĞ —G—SÒ&'WGFöâ Ğ –öä6Æ–6³×²‚’Óâ6WE6WGF–æw4÷Vâ‚†7W'&VçB’Óâ7W'&VçB—ĞĞ –6Æ74æÖSÒ&×BÓ2fÆW‚rÖgVÆÂ—FV×2Ö6VçFW"§W7F–g’Ö&WGvVVâ&÷VæFVBÓ'†Â&÷&FW"&÷&FW"Ö6&BÖ&÷&FW"&rÖ&6¶w&÷VæB‚Ó2’Ó"ãRFW‡BÖÆVgB Ğ “àĞ “Ç7â6Æ74æÖSÒ&–æÆ–æRÖfÆW‚—FV×2Ö6VçFW"vÓ"FW‡B×‡2föçBÖW‡G&&öÆB#àĞ “Å6WGF–æw3"6Æ74æÖSÒ&‚ÓBrÓBFW‡B×&–Ö'’"óàĞ Ë
Ø«‚ÊxÙÂÈJØ9Ò+rËiN«şÙ[NÊ	ÀĞ “Â÷7ãàĞ —·6WGF–æw4÷VâòÄ6†Wg&öåW6Æ74æÖSÒ&‚ÓBrÓB"óâ¢Ä6†Wg&öäF÷vâ6Æ74æÖSÒ&‚ÓBrÓB"óçĞĞ “Âö'WGFöãàĞ Ğ —·6WGF–æw4÷Vâbb€Ğ “ÆF—b6Æ74æÖSÒ&×BÓ"76R×’Ó2&÷VæFVBÓ'†Â&÷&FW"&÷&FW"Ö6&BÖ&÷&FW"&rÖ&6¶w&÷VæBÓ2#àĞ —²…².Ë
Ø«ÈJ"Â.ÈºÙ‹‚"Â.»;NÊÊxÙÂ%Ò26öç7B’æÖ‚†w&÷W’Óâ€Ğ “ÆF—b¶W“×¶w&÷WÓàĞ “Ç6Æ74æÖSÒ&Ö"Ó"FW‡BÕ³…ÒföçBÖ&Æ6²FW‡BÖ×WFVBÖf÷&Vw&÷VæB#ç¶w&÷WÓÂ÷àĞ “ÆF—b6Æ74æÖSÒ&fÆW‚fÆW‚×w&vÓ"#àĞ —´õdU$Ä•2æf–ÇFW"‚†—FVÒ’Óâ—FVÒæw&÷WÓÓÒw&÷W’æÖ‚†—FVÒ’Óâ€Ğ “Æ'WGFöàĞ –¶W“×¶—FVÒæ¶W—ĞĞ —G—SÒ&'WGFöâ Ğ –öä6Æ–6³×²‚’ÓâFövvÆT÷fW&Æ’†—FVÒæ¶W’—ĞĞ –6Æ74æÖS×¶6â€Ğ ’'&÷VæFVBÖgVÆÂ&÷&FW"‚Ó2’ÓãRFW‡BÕ³…ÒföçBÖW‡G&&öÆB"ÀĞ –÷fW&Æ—5¶—FVÒæ¶W•ĞĞ “ò&&÷&FW"×&–Ö'’&r×&–Ö'’óFW‡B×&–Ö'’ Ğ “¢&&÷&FW"Ö6&BÖ&÷&FW"&rÖ6&BFW‡BÖ×WFVBÖf÷&Vw&÷VæB"ÀĞ ’—ĞĞ “àĞ —¶÷fW&Æ—5¶—FVÒæ¶W•Òò.)É2"¢"²'×¶—FVÒæÆ&VÇĞĞ “Âö'WGFöãàĞ ’’—ĞĞ “ÂöF—càĞ “ÂöF—càĞ ’’—ĞĞ “ÂöF—càĞ ’—ĞĞ “ÂöF—càĞ Ğ “ÆF—b6Æ74æÖSÒ&Ö–âÖ‚Õ³3“…Ò&rÖ&6¶w&÷VæBó3#àĞ —¶6†'Bæ—4ÆöF–ærò€Ğ “ÆF—b6Æ74æÖSÒ&fÆW‚‚Õ³3“…Ò—FV×2Ö6VçFW"§W7F–g’Ö6VçFW"vÓ"FW‡B×6ÒföçBÖ&öÆBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#àĞ “ÄÆöFW#"6Æ74æÖSÒ&‚ÓRrÓRæ–ÖFR×7–â"óâË
Ø«‚»h¹úÎÉŠN¸©BÊIââàĞ “ÂöF—càĞ ’’¢6†'Bæ—4W'&÷"ò€Ğ “ÆF—b6Æ74æÖSÒ&fÆW‚‚Õ³3“…ÒfÆW‚Ö6öÂ—FV×2Ö6VçFW"§W7F–g’Ö6VçFW"‚ÓbFW‡BÖ6VçFW"#àĞ “Å6†–VÆDÆW'B6Æ74æÖSÒ&‚Ó‚rÓ‚FW‡B×v&æ–ær"óàĞ “Ç6Æ74æÖSÒ&×BÓ2FW‡B×6ÒföçBÖW‡G&&öÆB#îË
Ø«‚¸ÛÉÛNØKº[Â»h¹úÎÉŠNÊxº«¾ÙhÈ«^¸¸¸ºBãÂ÷àĞ “Ç6Æ74æÖSÒ&×BÓ'&V²Ö¶VWFW‡B×‡2ÆVF–ær×&VÆ†VBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#ç¶6†'BæW'&÷"–ç7Fæ6VöbW'&÷"ò6†'BæW'&÷"æÖW76vR¢.Ù[N¸»’È¹Î«N»H’¸ÛÉÛNØKÊ	Î«;RÉzÎ»hº[ÂÙ™^ÉÛÙYÈKÉ©Bâ'ÓÂ÷àĞ “Æ'WGFöâG—SÒ&'WGFöâ"öä6Æ–6³×²‚’Óâfö–B6†'Bç&VfWF6‚‚—Ò6Æ74æÖSÒ&×BÓB&÷VæFVBÖgVÆÂ&r×&–Ö'’‚ÓB’Ó"FW‡B×‡2föçBÖW‡G&&öÆBFW‡B×&–Ö'’Öf÷&Vw&÷VæB#î¸ºNÈ¹ÂÈ¹Î¸øCÂö'WGFöãàĞ “ÂöF—càĞ ’’¢6æFÆW2æÆVæwF‚Â"ÇÂ6æ6†÷BÇÂ÷–æ–öâò€Ğ “ÆF—b6Æ74æÖSÒ&fÆW‚‚Õ³3“…ÒfÆW‚Ö6öÂ—FV×2Ö6VçFW"§W7F–g’Ö6VçFW"‚ÓbFW‡BÖ6VçFW"#àĞ “Ä&$6†'C26Æ74æÖSÒ&‚Ó‚rÓ‚FW‡BÖ×WFVBÖf÷&Vw&÷VæB"óàĞ “Ç6Æ74æÖSÒ&×BÓ2FW‡B×6ÒföçBÖW‡G&&öÆB#îÙÎÈ¹ÎÙZÈºNÊ	Â»H’¸ÛÉÛNØK«ÉxnÈ«^¸¸¸ºBãÂ÷àĞ “Ç6Æ74æÖSÒ&×BÓ'&V²Ö¶VWFW‡B×‡2ÆVF–ær×&VÆ†VBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#î¸ºNº[‚È¹Î«N»HÉØBÈJØ9ŞÙY«¸)‚Ê	Î«;^Ë)‚É{«+È8Ø9Îº[ÂÙ™^ÉÛÙYÈKÉ©BâÉèNÈ¹Â««*ÉØºxÎ¹:NÊxÉX®È«^¸¸¸ºBãÂ÷àĞ “ÂöF—càĞ ’’¢€Ğ “Ä6†'D6çf26æFÆW3×¶6æFÆW7ÒF–ÖVg&ÖS×·F–ÖVg&ÖWÒ÷fW&Æ—3×¶÷fW&Æ—7Ò6æ6†÷C×·6æ6†÷GÒ÷–æ–öã×¶÷–æ–öçÒ&W6WD¶W“×¶G·6VÆV7FVE7Fö6²çF–6¶W'Ó¢G·F–ÖVg&ÖWÖÒfö7W5F–ÖS×¶fö7W5F–ÖWÒóà ’—ĞĞ “ÂöF—càĞ “Â÷6V7F–öãàĞ Ğ —·6æ6†÷Bbb÷–æ–öâbb€Ğ “ÃàĞ “Ç6V7F–öâ6Æ74æÖSÒ&÷fW&fÆ÷rÖ†–FFVâ&÷VæFVBÓ7†Â&÷&FW"&÷&FW"Ö6&BÖ&÷&FW"&rÖ6&B6†F÷r×6Ò#àĞ “ÆF—b6Æ74æÖSÒ&fÆW‚—FV×2Ö6VçFW"§W7F–g’Ö&WGvVVâ&÷&FW"Ö"&÷&FW"Ö6&BÖ&÷&FW"‚ÓB’Ó2#àĞ “ÆF—b6Æ74æÖSÒ&fÆW‚—FV×2Ö6VçFW"vÓ"#àĞ “Ç7â6Æ74æÖS×¶6â‚&‚Ó"ãRrÓ"ãR&÷VæFVBÖgVÆÂ"ÂÆ—fRò&æ–ÖFR×VÇ6R&rÖFW7G'V7F—fR"¢&&rÖ×WFVBÖf÷&Vw&÷VæB"—ÒóàĞ “Æƒ"6Æ74æÖSÒ'FW‡B×6ÒföçBÖ&Æ6²#ä’Ë
Ø«‚»hNÈIÒØ8ÉèN¹ÛÎÉÛƒÂöƒ#à “ÂöF—càĞ “Ç7â6Æ74æÖSÒ'FW‡BÕ³…ÒföçBÖW‡G&&öÆBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#çµD”ÔTe$ÔU2æf–æB‚†—FVÒ’Óâ—FVÒæ¶W’ÓÓÒF–ÖVg&ÖR“òæÆ&VÇŞ»H“Â÷7ãàĞ “ÂöF—càĞ “ÆF—b6Æ74æÖSÒ&Ö‚Ö‚Ós"÷fW&fÆ÷r×’ÖWFòÓ2#àĞ —¶fVVBæÆVæwF‚ò€Ğ “ÆF—b6Æ74æÖSÒ'76R×’Ó"#àĞ —¶fVVBæÖ‚†—FVÒ’Óâ€Ğ “Æ'WGFöâG—SÒ&'WGFöâ"¶W“×¶—FVÒæ–GÒöä6Æ–6³×²‚’Óâ6WDfö7W5F–ÖR†—FVÒææÇ—6—2çö–çG5³ÓòçF–ÖR—Ò6Æ74æÖSÒ&w&–BrÖgVÆÂw&–BÖ6öÇ2Õ³s…öÖ–æÖ‚ƒÃg"•ÒvÓ"&÷VæFVBÓ'†Â&rÖ&6¶w&÷VæB‚Ó2’Ó2FW‡BÖÆVgBfö7W2×f—6–&ÆS¦÷WFÆ–æRÖæöæRfö7W2×f—6–&ÆS§&–ærÓ"fö7W2×f—6–&ÆS§&–ær×&–Ö'’#à “ÇF–ÖR6Æ74æÖSÒ'FW‡BÕ³…ÒföçBÖ&öÆBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#ç¶—FVÒæBçFôÆö6ÆUF–ÖU7G&–ær‚&¶òÔµ""Â²†÷W#¢#"ÖF–v—B"ÂÖ–çWFS¢#"ÖF–v—B"Â6V6öæC¢#"ÖF–v—B"Ò—ÓÂ÷F–ÖSàĞ “ÆF—càĞ “Ç7â6Æ74æÖS×¶6â‚&–æÆ–æRÖfÆW‚&÷VæFVBÖgVÆÂ&÷&FW"‚Ó"’ÓãRFW‡BÕ³—…ÒföçBÖ&Æ6²"Â6–væÄ6Æ72†—FVÒç6–væÂ’—Óç¶—FVÒç7FGW7Ò+r·6–væÄÆ&VÂ†—FVÒç6–væÂ—ÓÂ÷7ãà “Ç6Æ74æÖSÒ&×BÓãR'&V²Ö¶VWFW‡BÕ³…ÒföçBÖ&öÆBÆVF–ærÓRFW‡BÖf÷&Vw&÷VæB#ç¶—FVÒçFW‡GÓÂ÷àĞ “ÂöF—càĞ “Âö'WGFöãà ’’—ĞĞ “ÂöF—càĞ ’’¢€Ğ “Ç6Æ74æÖSÒ'&÷VæFVBÓ'†Â&rÖ&6¶w&÷VæB‚Ó2’ÓRFW‡BÖ6VçFW"FW‡B×‡2föçBÖ&öÆBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#îÈ8‚»H«;Â»hNÈIÒÈºÙ‹º[Â«‹¸ºNºjÎ¸©BÊIÉè^¸¸¸ºBãÂ÷àĞ ’—ĞĞ “ÂöF—càĞ “Â÷6V7F–öãàĞ Ğ “Ç6V7F–öâ6Æ74æÖSÒ'&÷VæFVBÓ7†Â&÷&FW"&÷&FW"Ö6&BÖ&÷&FW"&rÖ6&BÓB6†F÷r×6Ò#àĞ “ÆF—b6Æ74æÖSÒ&fÆW‚—FV×2×7F'B§W7F–g’Ö&WGvVVâvÓ2#àĞ “ÆF—b6Æ74æÖSÒ&Ö–â×rÓ#àĞ “Ç6Æ74æÖSÒ'FW‡BÕ³…ÒföçBÖW‡G&&öÆBFW‡B×&–Ö'’#ä’Ë
Ø«‚»hNÈIŞ«‹Â÷à “Æƒ"6Æ74æÖSÒ&×BÓFW‡BÖÆrföçBÖ&Æ6²#ç¶÷–æ–öâçF—FÆWÓÂöƒ#àĞ “ÂöF—càĞ “ÆF—b6Æ74æÖS×¶6â‚'6‡&–æ²Ó&÷VæFVBÖgVÆÂ&÷&FW"‚Ó2’ÓãRFW‡B×‡2föçBÖ&Æ6²"Â6–væÄ6Æ72†÷–æ–öâç6–væÂ’—Óç·6–væÄÆ&VÂ†÷–æ–öâç6–væÂ—ÓÂöF—càĞ “ÂöF—càĞ Ğ “Ç6Æ74æÖSÒ&×BÓ2'&V²Ö¶VW&÷VæFVBÓ'†Â&r×6V6öæF'’ós‚Ó2’Ó2FW‡B×‡2föçBÖ&öÆBÆVF–ærÓbFW‡BÖf÷&Vw&÷VæB#ç¶÷–æ–öâç7VÖÖ'—ÓÂ÷àĞ Ğ “ÆF—b6Æ74æÖSÒ&×BÓ2w&–Bw&–BÖ6öÇ2Ó"vÓ"#àĞ “ÄÖWG&–46&B–6öã×³Ä7F—f—G’6Æ74æÖSÒ&‚ÓBrÓB"óçÒÆ&VÃÒ.ÙˆNÉêÂËiNÈK‚"fÇVS×·6æ6†÷BçG&VæGÒóàĞ “ÄÖWG&–46&B–6öã×³ÄvVvR6Æ74æÖSÒ&‚ÓBrÓB"óçÒÆ&VÃÒ.Èºº+¸øB"fÇVS×¶G¶÷–æ–öâæ6öæf–FVæ6WÒóÒóàĞ “ÄÖWG&–46&B–6öã×³ÅG&VæF–æuW6Æ74æÖSÒ&‚ÓBrÓB"óçÒÆ&VÃÒ.ÙˆNÉêÎ«"fÇVS×¶f÷&ÖE&–6R‡6æ6†÷Bæ7W'&VçE&–6RÂÖ&¶WB—ÒóàĞ “ÄÖWG&–46&B–6öã×³ÄvVvR6Æ74æÖSÒ&‚ÓBrÓB"óçÒÆ&VÃ×·6æ6†÷BæÖ&¶WDÆ&VÇÒfÇVS×·6æ6†÷BæÖ&¶WD6†ævUW&6VçBÓÒçVÆÂò'Væf–Æ&ÆR"¢G·6æ6†÷BæÖ&¶WD6†ævUW&6VçBãÒò"²"¢"'ÒG·6æ6†÷BæÖ&¶WD6†ævUW&6VçBçFôf—†VBƒ"—ÒVÒóà “ÄÖWG&–46&B–6öã×³Ä&$6†'C26Æ74æÖSÒ&‚ÓBrÓB"óçÒÆ&VÃÒ.«¹é¹ø’"fÇVS×¶G·6æ6†÷BçföÇVÖU&F–òçFôf—†VBƒ"—Ş»ÒóàĞ “ÂöF—càĞ Ğ “ÆF—b6Æ74æÖSÒ&×BÓ2w&–Bw&–BÖ6öÇ2Ó2vÓ"#àĞ “ÅÆä6&BFöæSÒ&VçG'’"Æ&VÃÒ.ÊxNÉèR«‹ÊH"fÇVS×¶f÷&ÖE&–6R†÷–æ–öâæVçG'•&–6RÂÖ&¶WB—ÒóàĞ “ÅÆä6&BFöæSÒ'F&vWB"Æ&VÃÒ.ºªÙÎ«"fÇVS×¶f÷&ÖE&–6R†÷–æ–öâçF&vWE&–6RÂÖ&¶WB—ÒóàĞ “ÅÆä6&BFöæSÒ'7F÷"Æ&VÃÒ.ÈiÊ‚«‹ÊH"fÇVS×¶f÷&ÖE&–6R†÷–æ–öâç7F÷&–6RÂÖ&¶WB—ÒóàĞ “ÂöF—càĞ Ğ “ÆF—b6Æ74æÖSÒ&×BÓ2w&–Bw&–BÖ6öÇ2Ó"vÓ"#àĞ “ÄÆWfVÄ6&BÆ&VÃÒ#Ë
‚ÊÙZÒ"fÇVS×¶f÷&ÖE&–6R‡6æ6†÷BæÆWfVÇ2ç&W6—7Fæ6SÂÖ&¶WB—ÒFöæSÒ'&W6—7Fæ6R"óàĞ “ÄÆWfVÄ6&BÆ&VÃÒ#.Ë
‚ÊÙZÒ"fÇVS×¶f÷&ÖE&–6R‡6æ6†÷BæÆWfVÇ2ç&W6—7Fæ6S"ÂÖ&¶WB—ÒFöæSÒ'&W6—7Fæ6R"óàĞ “ÄÆWfVÄ6&BÆ&VÃÒ#Ë
‚ÊxÊx"fÇVS×¶f÷&ÖE&–6R‡6æ6†÷BæÆWfVÇ2ç7W÷'CÂÖ&¶WB—ÒFöæSÒ'7W÷'B"óàĞ “ÄÆWfVÄ6&BÆ&VÃÒ#.Ë
‚ÊxÊx"fÇVS×¶f÷&ÖE&–6R‡6æ6†÷BæÆWfVÇ2ç7W÷'C"ÂÖ&¶WB—ÒFöæSÒ'7W÷'B"óàĞ “ÂöF—càĞ Ğ “ÆF—b6Æ74æÖSÒ&×BÓ2w&–Bw&–BÖ6öÇ2Ó2vÓ"#àĞ —¶÷fW&Æ—2ç'6’bbÅ6ÖÆÄ–æF–6F÷"Æ&VÃÒ%%4’"fÇVS×·6æ6†÷Bç'6’ÓÒçVÆÂò"Ò"¢6æ6†÷Bç'6’çFôf—†VBƒ—ÒóçĞĞ —¶÷fW&Æ—2æÖ6BbbÅ6ÖÆÄ–æF–6F÷"Æ&VÃÒ$Ô4B"fÇVS×·6æ6†÷BæÖ6BÓÒçVÆÂò"Ò"¢6æ6†÷BæÖ6BçFôf—†VBƒ2—ÒóçĞĞ —¶÷fW&Æ—2æG"bbÅ6ÖÆÄ–æF–6F÷"Æ&VÃÒ$E""fÇVS×¶f÷&ÖE&–6R‡6æ6†÷BæG"ÂÖ&¶WB—ÒóçĞĞ —·6æ6†÷BçGFW&ç2æÖ‚‡GFW&â’ÓâÅ6ÖÆÄ–æF–6F÷"¶W“×·GFW&çÒÆ&VÃÒ.Ë
Ø«ØÊØKB"fÇVS×·GFW&çÒóâ—ĞĞ “ÂöF—càĞ “Â÷6V7F–öãàĞ “ÂóàĞ ’—ĞĞ Ğ “Ç6Æ74æÖSÒ'‚ÓFW‡BÕ³…ÒföçB×6VÖ–&öÆBÆVF–ærÓBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#àĞ ”’Ë
Ø«‚»hNÈIŞ«‹¸©BÈºNÊ	ÂÈ¹ÎÈKŒ+~»H’¸ÛÉÛNØKº[Â$U5B«ÈºÉËÎºÂ»hNÈIŞÙY¸©B»;NÊ«‹¸ª^Éè^¸¸¸ºBâ«;^«ˆÉé«Ë©N¹:BÉ˜Nº8ÂÉzÎ»hº[ÂÊ	Î«;^ÙYÊxÉX®ÉËÎº›Bf÷&Ö–æ~ÉËÎºÂÙÎÈ¹ÎÙZ¸¸¸ºBâ»hNÈIÒºË«ZÎ¸©BÊ;ÎºË‚ÈºNÙhÉÛBÉXN¸¸º›Éé¸ùºzNºzBÊ;ÎºË‚«‹¸ª^«;Â»hNºjÎ¹	ÉkBÉèÈ«^¸¸¸ºBà “Â÷àĞ “ÂöF—càĞ ’“°Ğ§ĞĞ Ğ¦gVæ7F–öâÖWG&–46&B‡²–6öâÂÆ&VÂÂfÇVRÓ¢²–6öã¢&V7DæöFS²Æ&VÃ¢7G&–æs²fÇVS¢7G&–ærÒ’°Ğ —&WGW&â€Ğ “ÆF—b6Æ74æÖSÒ'&÷VæFVBÓ'†Â&÷&FW"&÷&FW"Ö6&BÖ&÷&FW"&rÖ&6¶w&÷VæBÓ2#àĞ “ÆF—b6Æ74æÖSÒ&fÆW‚—FV×2Ö6VçFW"vÓãRFW‡B×&–Ö'’#ç¶–6öçÓÇ7â6Æ74æÖSÒ'FW‡BÕ³…ÒföçBÖW‡G&&öÆBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#ç¶Æ&VÇÓÂ÷7ããÂöF—càĞ “Ç6Æ74æÖSÒ&×BÓ"FW‡B×6ÒföçBÖ&Æ6²#ç·fÇVWÓÂ÷àĞ “ÂöF—càĞ ’“°Ğ§ĞĞ Ğ¦gVæ7F–öâÆä6&B‡²FöæRÂÆ&VÂÂfÇVRÓ¢²FöæS¢&VçG'’"Â'F&vWB"Â'7F÷#²Æ&VÃ¢7G&–æs²fÇVS¢7G&–ærÒ’°Ğ –6öç7B–6öâÒFöæRÓÓÒ&VçG'’"òG&VæF–æuW¢FöæRÓÓÒ'F&vWB"òF&vWB¢G&VæF–ætF÷vã°Ğ —&WGW&â€Ğ “ÆF—b6Æ74æÖS×¶6â‚'&÷VæFVBÓ'†Â&÷&FW"Ó2"ÂFöæRÓÓÒ&VçG'’"ò&&÷&FW"ÖFW7G'V7F—fRó#&rÖFW7G'V7F—fRóR"¢FöæRÓÓÒ'F&vWB"ò&&÷&FW"×v&æ–æró#&r×v&æ–æróR"¢&&÷&FW"Ö&ÇVRÓSó#&rÖ&ÇVRÓSóR"—ÓàĞ “Ä–6öâ6Æ74æÖS×¶6â‚&‚ÓBrÓB"ÂFöæRÓÓÒ&VçG'’"ò'FW‡BÖFW7G'V7F—fR"¢FöæRÓÓÒ'F&vWB"ò'FW‡B×v&æ–ær"¢'FW‡BÖ&ÇVRÓS"—ÒóàĞ “Ç6Æ74æÖSÒ&×BÓ"FW‡BÕ³…ÒföçBÖW‡G&&öÆBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#ç¶Æ&VÇÓÂ÷àĞ “Ç6Æ74æÖSÒ&×BÓ'&V²Ö¶VWFW‡B×‡2föçBÖ&Æ6²#ç·fÇVWÓÂ÷àĞ “ÂöF—càĞ ’“°Ğ§ĞĞ Ğ¦gVæ7F–öâÆWfVÄ6&B‡²Æ&VÂÂfÇVRÂFöæRÓ¢²Æ&VÃ¢7G&–æs²fÇVS¢7G&–æs²FöæS¢'7W÷'B"Â'&W6—7Fæ6R"Ò’°Ğ —&WGW&â€Ğ “ÆF—b6Æ74æÖSÒ&fÆW‚—FV×2Ö6VçFW"§W7F–g’Ö&WGvVVâvÓ"&÷VæFVBÓ'†Â&÷&FW"&÷&FW"Ö6&BÖ&÷&FW"&rÖ&6¶w&÷VæB‚Ó2’Ó"ãR#àĞ “Ç7â6Æ74æÖS×¶6â‚'FW‡BÕ³…ÒföçBÖW‡G&&öÆB"ÂFöæRÓÓÒ'7W÷'B"ò'FW‡BÖ&ÇVRÓS"¢'FW‡BÖFW7G'V7F—fR"—Óç¶Æ&VÇÓÂ÷7ãàĞ “Ç7G&öær6Æ74æÖSÒ'FW‡B×‡2#ç·fÇVWÓÂ÷7G&öæsàĞ “ÂöF—càĞ ’“°Ğ§ĞĞ Ğ¦gVæ7F–öâ6ÖÆÄ–æF–6F÷"‡²Æ&VÂÂfÇVRÓ¢²Æ&VÃ¢7G&–æs²fÇVS¢7G&–ærÒ’°Ğ —&WGW&â€Ğ “ÆF—b6Æ74æÖSÒ'&÷VæFVBÓ'†Â&r×6V6öæF'’ós‚Ó2’Ó"ãRFW‡BÖ6VçFW"#àĞ “Ç6Æ74æÖSÒ'FW‡BÕ³…ÒföçBÖW‡G&&öÆBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#ç¶Æ&VÇÓÂ÷àĞ “Ç6Æ74æÖSÒ&×BÓFW‡B×‡2föçBÖ&Æ6²#ç·fÇVWÓÂ÷àĞ “ÂöF—càĞ ’“°Ğ§Ğ 