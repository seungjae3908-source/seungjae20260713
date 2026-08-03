import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CirclePause,
  CirclePlay,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  X,
} from "lucide-react";
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { authorizedFetch } from "@/lib/auth-fetch";
import { apiGet } from "@/lib/api";
import { BottomNav } from "@/components/bottom-nav";
import { useAssetMode } from "@/lib/asset-mode";
import { cn } from "@/lib/utils";
import { FuturesMarketStatusPanel } from "@/components/futures-market-status-panel";

export type CryptoWorkspaceViewMode = "condition" | "chart" | "auto";

type Props = {
  viewMode: CryptoWorkspaceViewMode;
  onViewModeChange: (mode: CryptoWorkspaceViewMode) => void;
  onBackToStock: () => void;
};

type AnyObj = Record<string, any>;
type Direction = "LONG" | "SHORT" | "WAIT";
type PositionMode = "one_way_mode" | "hedge_mode";
type MarginMode = "isolated" | "crossed";
type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1H" | "4H" | "1D" | "1W";
type OverlayKey = "ma5" | "ma20" | "ma60" | "bollinger" | "vwap" | "volume" | "levels" | "arrows";
type ScannerCategory = "tradingValue" | "volume" | "gainers" | "losers";
type ScannerDirection = "LONG" | "SHORT";
type IndicatorProfileKey = "minute" | "hour" | "day";
type IndicatorProfiles = Record<IndicatorProfileKey, Record<OverlayKey, boolean>>;

type Candle = {
  time: UTCTimestamp;
  sourceTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
};

type Ticker = {
  symbol: string;
  price: number;
  markPrice: number;
  indexPrice: number;
  changePercent24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  tradingValue24h: number;
  fundingRate: number;
  openInterest: number;
  bidPrice: number;
  askPrice: number;
};

type PatternSignal = {
  key: string;
  label: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  weight: number;
};

type Analysis = {
  symbol: string;
  currentPrice: number;
  previousClose: number;
  changePercent: number;
  sma5: number | null;
  sma20: number | null;
  sma60: number | null;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  atr: number;
  atrPercent: number;
  volumeRatio: number;
  vwap: number | null;
  support1: number;
  support2: number;
  resistance1: number;
  resistance2: number;
  longScore: number;
  shortScore: number;
  direction: Direction;
  confidence: "ë†’ìŒ" | "ë³´í†µ" | "ë‚®ìŒ";
  longReasons: string[];
  shortReasons: string[];
  patterns: PatternSignal[];
  targetLong: number;
  stopLong: number;
  targetShort: number;
  stopShort: number;
  marketBias: number;
  generatedAt: string;
};

type ScannerRow = {
  ticker: Ticker;
  analysis: Analysis;
  rank: number;
};

type Position = {
  symbol: string;
  holdSide: string;
  total: number;
  available: number;
  openPriceAvg: number;
  markPrice: number;
  unrealizedPL: number;
  liquidationPrice: number;
  leverage: number;
  marginMode: string;
  marginSize: number;
  breakEvenPrice: number;
};

type AutoSettings = {
  monitorEnabled: boolean;
  positionMode: PositionMode;
  marginMode: MarginMode;
  leverage: number;
  marginAmountUSDT: number;
  minScore: number;
  stopLossPercent: number;
  targetProfitPercent: number;
  maxOpenPositions: number;
  maxDailyOrders: number;
};

type PlanResponse = {
  ok: boolean;
  approvalRequired: boolean;
  approvalToken: string;
  approvalExpiresAt: string;
  plan: AnyObj;
  warning?: string;
};

type WatchPlan = {
  kind: "WATCH";
  symbol: string;
  timeframe: Timeframe;
  direction: "WAIT";
  longScore: number;
  shortScore: number;
  minimumScore: number;
  supportTrigger: number;
  resistanceTrigger: number;
  marginAmountUSDT: number;
  leverage: number;
  stopLossPercent: number;
  targetProfitPercent: number;
  availableUSDT: number | null;
  accountEquityUSDT: number | null;
  reasons: string[];
  createdAt: string;
};

type FeedLine = {
  id: string;
  at: Date;
  tone: "LONG" | "SHORT" | "WAIT" | "INFO";
  text: string;
};

const TIMEFRAMES: Array<{ key: Timeframe; label: string }> = [
  { key: "1m", label: "1ë¶„" },
  { key: "3m", label: "3ë¶„" },
  { key: "5m", label: "5ë¶„" },
  { key: "15m", label: "15ë¶„" },
  { key: "30m", label: "30ë¶„" },
  { key: "1H", label: "1ì‹œê°„" },
  { key: "4H", label: "4ì‹œê°„" },
  { key: "1D", label: "ì¼ë´‰" },
  { key: "1W", label: "ì£¼ë´‰" },
];

const OVERLAYS: Array<{ key: OverlayKey; label: string }> = [
  { key: "ma5", label: "MA5" },
  { key: "ma20", label: "MA20" },
  { key: "ma60", label: "MA60" },
  { key: "bollinger", label: "ë³¼ë¦°ì €" },
  { key: "vwap", label: "VWAP" },
  { key: "volume", label: "ê±°ë˜ëŸ‰" },
  { key: "levels", label: "ì§€ì§€Â·ì €í•­" },
  { key: "arrows", label: "ë¡±Â·ìˆ í™”ì‚´í‘œ" },
];

const SCANNER_CATEGORIES: Array<{ key: ScannerCategory; label: string }> = [
  { key: "tradingValue", label: "ê±°ë˜ëŒ€ê¸ˆ" },
  { key: "volume", label: "ê±°ë˜ëŸ‰" },
  { key: "gainers", label: "ê¸‰ìƒìŠ¹" },
  { key: "losers", label: "ê¸‰í•˜ë½" },
];

const INDICATOR_PROFILE_TABS: Array<{ key: IndicatorProfileKey; label: string }> = [
  { key: "minute", label: "ë¶„ë´‰" },
  { key: "hour", label: "ì‹œê°„ë´‰" },
  { key: "day", label: "ì¼Â·ì£¼ë´‰" },
];

const DEFAULT_INDICATOR_PROFILES: IndicatorProfiles = {
  minute: {
    ma5: true,
    ma20: true,
    ma60: false,
    bollinger: false,
    vwap: true,
    volume: true,
    levels: true,
    arrows: true,
  },
  hour: {
    ma5: true,
    ma20: true,
    ma60: true,
    bollinger: true,
    vwap: true,
    volume: true,
    levels: true,
    arrows: true,
  },
  day: {
    ma5: false,
    ma20: true,
    ma60: true,
    bollinger: true,
    vwap: false,
    volume: true,
    levels: true,
    arrows: true,
  },
};

const DEFAULT_SETTINGS: AutoSettings = {
  monitorEnabled: true,
  positionMode: "one_way_mode",
  marginMode: "isolated",
  leverage: 2,
  marginAmountUSDT: 20,
  minScore: 75,
  stopLossPercent: 1.5,
  targetProfitPercent: 3,
  maxOpenPositions: 3,
  maxDailyOrders: 5,
};

const SETTINGS_KEY = "crypto-long-short-settings.v1";
const SYMBOL_KEY = "crypto-long-short-symbol.v1";
const INDICATOR_SETTINGS_KEY = "crypto-long-short-indicators.v2";
const EXECUTION_KEY_SESSION_KEY = "crypto-auto-execution-key.session.v1";

function numberOf(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function average(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sma(values: number[], period: number) {
  if (values.length < period) return null;
  return average(values.slice(-period));
}

function emaSeries(values: number[], period: number) {
  if (!values.length) return [] as number[];
  const multiplier = 2 / (period + 1);
  const result: number[] = [];
  let current = values[0];
  for (let index = 0; index < values.length; index += 1) {
    current = index === 0 ? values[index] : (values[index] - current) * multiplier + current;
    result.push(current);
  }
  return result;
}

function rsi(values: number[], period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const difference = values[index] - values[index - 1];
    if (difference >= 0) gains += difference;
    else losses += Math.abs(difference);
  }
  if (losses === 0) return 100;
  const relativeStrength = gains / period / (losses / period);
  return 100 - 100 / (1 + relativeStrength);
}

function macdSnapshot(values: number[]) {
  if (values.length < 35) return { macd: null, signal: null };
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  const macdRows = values.map((_, index) => (fast[index] ?? 0) - (slow[index] ?? 0));
  const signalRows = emaSeries(macdRows, 9);
  return {
    macd: macdRows.at(-1) ?? null,
    signal: signalRows.at(-1) ?? null,
  };
}

function atr(candles: Candle[], period = 14) {
  if (candles.length < 2) return 0;
  const rows = candles.slice(-Math.min(period + 1, candles.length));
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

function standardDeviation(values: number[]) {
  const mean = average(values);
  if (mean == null || !values.length) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function rollingSma(candles: Candle[], period: number) {
  const rows: Array<{ time: Time; value: number }> = [];
  for (let index = period - 1; index < candles.length; index += 1) {
    const values = candles.slice(index - period + 1, index + 1).map((row) => row.close);
    const value = average(values);
    if (value != null) rows.push({ time: candles[index].time, value });
  }
  return rows;
}

function rollingBollinger(candles: Candle[], period = 20) {
  const upper: Array<{ time: Time; value: number }> = [];
  const middle: Array<{ time: Time; value: number }> = [];
  const lower: Array<{ time: Time; value: number }> = [];
  for (let index = period - 1; index < candles.length; index += 1) {
    const values = candles.slice(index - period + 1, index + 1).map((row) => row.close);
    const mean = average(values);
    const deviation = standardDeviation(values);
    if (mean == null || deviation == null) continue;
    const time = candles[index].time;
    upper.push({ time, value: mean + deviation * 2 });
    middle.push({ time, value: mean });
    lower.push({ time, value: mean - deviation * 2 });
  }
  return { upper, middle, lower };
}

function rollingVwap(candles: Candle[]) {
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  return candles.map((row) => {
    const typical = (row.high + row.low + row.close) / 3;
    cumulativePriceVolume += typical * row.volume;
    cumulativeVolume += row.volume;
    return {
      time: row.time as Time,
      value: cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : row.close,
    };
  });
}

function normalizeCandles(rows: AnyObj[]) {
  return rows
    .map((row, index) => {
      const open = numberOf(row.open, Number.NaN);
      const high = numberOf(row.high, Number.NaN);
      const low = numberOf(row.low, Number.NaN);
      const close = numberOf(row.close, Number.NaN);
      if (![open, high, low, close].every(Number.isFinite)) return null;
      const rawTime = row.time;
      const milliseconds = numberOf(rawTime, Number.NaN);
      const parsed = Number.isFinite(milliseconds) && milliseconds > 1_000_000_000
        ? milliseconds
        : Date.parse(String(rawTime ?? ""));
      const fallback = Date.now() - (rows.length - index) * 60_000;
      const unix = Math.floor((Number.isFinite(parsed) ? parsed : fallback) / 1000) as UTCTimestamp;
      return {
        time: unix,
        sourceTime: String(rawTime ?? ""),
        open,
        high: Math.max(high, open, close),
        low: Math.min(low, open, close),
        close,
        volume: Math.max(0, numberOf(row.volume, 0)),
        quoteVolume: Math.max(0, numberOf(row.quoteVolume, 0)),
      } satisfies Candle;
    })
    .filter((row): row is Candle => row != null)
    .sort((a, b) => Number(a.time) - Number(b.time))
    .filter((row, index, source) => index === 0 || row.time !== source[index - 1].time);
}

function detectPatterns(candles: Candle[], support: number, resistance: number) {
  const patterns: PatternSignal[] = [];
  if (candles.length < 8) return patterns;
  const last = candles.at(-1)!;
  const previous = candles.at(-2)!;
  const recent = candles.slice(-20, -1);
  const recentHigh = Math.max(...recent.map((row) => row.high));
  const recentLow = Math.min(...recent.map((row) => row.low));
  const body = Math.abs(last.close - last.open);
  const range = Math.max(last.high - last.low, Number.EPSILON);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);

  if (last.close > recentHigh && last.volume > (average(recent.map((row) => row.volume)) ?? 0) * 1.3) {
    patterns.push({ key: "breakout", label: "ê±°ë˜ëŸ‰ ë™ë°˜ ìƒë‹¨ ëŒíŒŒ", direction: "LONG", weight: 14 });
  }
  if (last.close < recentLow && last.volume > (average(recent.map((row) => row.volume)) ?? 0) * 1.3) {
    patterns.push({ key: "breakdown", label: "ê±°ë˜ëŸ‰ ë™ë°˜ í•˜ë‹¨ ì´íƒˆ", direction: "SHORT", weight: 14 });
  }
  if (previous.close < previous.open && last.close > last.open && last.open <= previous.close && last.close >= previous.open) {
    patterns.push({ key: "bullish-engulf", label: "ìƒìŠ¹ ì¥ì•…í˜•", direction: "LONG", weight: 8 });
  }
  if (previous.close > previous.open && last.close < last.open && last.open >= previous.close && last.close <= previous.open) {
    patterns.push({ key: "bearish-engulf", label: "í•˜ë½ ì¥ì•…í˜•", direction: "SHORT", weight: 8 });
  }
  if (lowerWick > body * 2 && lowerWick > upperWick * 1.5 && last.close > last.open) {
    patterns.push({ key: "hammer", label: "ë§ì¹˜í˜• ë°˜ë“±", direction: "LONG", weight: 7 });
  }
  if (upperWick > body * 2 && upperWick > lowerWick * 1.5 && last.close < last.open) {
    patterns.push({ key: "shooting-star", label: "ìœ ì„±í˜• ë°˜ë½", direction: "SHORT", weight: 7 });
  }
  if (body / range < 0.12) {
    patterns.push({ key: "doji", label: "ë„ì§€Â·ë°©í–¥ ëŒ€ê¸°", direction: "NEUTRAL", weight: 0 });
  }

  const closes = candles.slice(-35).map((row) => row.close);
  const localLows = closes
    .map((value, index) => ({ value, index }))
    .filter((row) => row.index > 0 && row.index < closes.length - 1 && row.value <= closes[row.index - 1] && row.value <= closes[row.index + 1]);
  const localHighs = closes
    .map((value, index) => ({ value, index }))
    .filter((rÛ­9ŞÚ$z{-®éÜj×hØ*B¹;ºÓÂ÷àĞ¢Ç6Æ74æÖSÒ&×BÓãRFW‡BÕ³—…ÒföçBÖ&öÆBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#îÉè^º
RÙ¸BVçFW.º[Â¸ˆNº[Nº›BÈIÎ»(BØ*NÉ˜ÉÛÎË™‚ÉzÎ»hº[ÂÙ™^ÉÛÙY«:ÉÛBØ:ŞÉyÊÉê^ÙZ¸¸¸ºBãÂ÷àĞ¢ÂöF—càĞ¢ÂöF—càĞ¢ÆF—b6Æ74æÖSÒ'&VÆF—fR×BÓ"#àĞ¢Æ–çW@Ğ¢G—S×·6†÷tW†V7WF–öä¶W’ò'FW‡B"¢'77v÷&B'ĞĞ¢fÇVS×¶W†V7WF–öä¶W—ĞĞ¢öä6†ævS×²†WfVçB’Óâ°Ğ¢6WDW†V7WF–öä¶W’†WfVçBçF&vWBçfÇVR“°Ğ¢6WDW†V7WF–öä¶W•6fVB†fÇ6R“°Ğ¢6WEVæF–æuÆâ†çVÆÂ“°Ğ¢×ĞĞ¢öä¶W”F÷vã×²†WfVçB’Óâ°Ğ¢–b†WfVçBæ¶W’ÓÓÒ$VçFW""’°Ğ¢WfVçBç&WfVçDFVfVÇB‚“°Ğ¢fö–B&Vv—7FW$W†V7WF–öä¶W’‚“°Ğ¢ĞĞ¢×ĞĞ¢Æ6V†öÆFW#Ò$5%•DõôUDõõE$DUô´U’Éè^º
RÙ¸BVçFW" Ğ¢WFô6ö×ÆWFSÒ&öfb Ğ¢WFô6—FÆ—¦SÒ&æöæR Ğ¢WFô6÷'&V7CÒ&öfb Ğ¢7VÆÄ6†V6³×¶fÇ6WĞĞ¢VçFW$¶W”†–çCÒ&FöæR Ğ¢6Æ74æÖSÒ&‚ÓrÖgVÆÂ&÷VæFVB×†Â&÷&FW"&÷&FW"Ö6&BÖ&÷&FW"&rÖ6&B‚Ó2"Ó"FW‡B×6ÒföçBÖ&öÆB÷WFÆ–æRÖæöæRfö7W3¦&÷&FW"×&–Ö'’ Ğ¢óàĞ¢Æ'WGFöàĞ¢G—SÒ&'WGFöâ Ğ¢öä6Æ–6³×²‚’Óâ6WE6†÷tW†V7WF–öä¶W’‚†7W'&VçB’Óâ7W'&VçB—ĞĞ¢&–ÖÆ&VÃ×·6†÷tW†V7WF–öä¶W’ò.ÈºNÙhØ*BÈŠ«‹«‹"¢.ÈºNÙhØ*B»;N«‹'ĞĞ¢6Æ74æÖSÒ&'6öÇWFR&–v‡BÓ"F÷Óó"fÆW‚‚Ó‚rÓ‚×G&ç6ÆFR×’Óó"—FV×2Ö6VçFW"§W7F–g’Ö6VçFW"&÷VæFVBÖgVÆÂFW‡BÖ×WFVBÖf÷&Vw&÷VæB Ğ¢àĞ¢·6†÷tW†V7WF–öä¶W’òÄW–Töfb6Æ74æÖSÒ&‚ÓBrÓB"óâ¢ÄW–R6Æ74æÖSÒ&‚ÓBrÓB"óçĞĞ¢Âö'WGFöãàĞ¢ÂöF—càĞ¢ÆF—b6Æ74æÖSÒ&×BÓ"fÆW‚—FV×2Ö6VçFW"§W7F–g’Ö&WGvVVâvÓ"#àĞ¢Ç7â6Æ74æÖS×¶6â‚'FW‡BÕ³…ÒföçBÖ&Æ6²"ÂW†V7WF–öä¶W•6fVBò'FW‡B×÷6—F—fR"¢'FW‡BÖ×WFVBÖf÷&Vw&÷VæB"—ÓàĞ¢¶¶W•fW&–g––æpĞ¢ò.ÈIÎ»(BÙ™^ÉÛ‚ÊIâââ Ğ¢¢W†V7WF–öä¶W•6fV@Ğ¢ò.)É2ÈIÎ»(BÙ™^ÉÛ‚É˜Nº8Â Ğ¢¢$VçFW.º[Â¸ˆÎ¹úÂÙ™^ÉÛ‚'ĞĞ¢Â÷7ãàĞ¢Æ'WGFöàĞ¢G—SÒ&'WGFöâ Ğ¢öä6Æ–6³×²‚’Óâfö–B&Vv—7FW$W†V7WF–öä¶W’‚—ĞĞ¢F—6&ÆVC×¶¶W•fW&–g––æwĞĞ¢6Æ74æÖSÒ'&÷VæFVBÖgVÆÂ&r×&–Ö'’‚Ó2’ÓãRFW‡BÕ³…ÒföçBÖ&Æ6²FW‡B×&–Ö'’Öf÷&Vw&÷VæBF—6&ÆVC¦÷6—G’ÓS Ğ¢àĞ¢¶¶W•fW&–g––ærò.Ù™^ÉÛ‚ÊI"¢.Ù™^ÉÛ‚'ĞĞ¢Âö'WGFöãàĞ¢ÂöF—càĞ¢ÂöF—càĞ¢Ç6Æ74æÖSÒ&×BÓ2&÷VæFVBÓ'†Â&r×v&æ–æróÓ2FW‡BÕ³…ÒföçBÖ&öÆBÆVF–ær×&VÆ†VBFW‡B×v&æ–ær#àĞ¢Ë
Ø«É˜ÈºÙ‹¸©BÉé¸ù’«Èº¹	ÊxºxÂÈºNÊ	ÂÊ;ÎºËÉØÊ;ÎºË«8NÙ¨ÒÈ9ŞÈK(i"È‰¹øœ+~ÈiÊŒ+~ÉÛ^Ê‚Ù™^ÉÛ‚(i"»hBÈ«ÉÛ‚ØjØÉÙ‚.¸º«8BÈ«ÉÛÉËÎºÎºxÂÊNÈj¹
¸¸¸ºBàĞ¢Â÷àĞ¢Â÷6V7F–öãàĞ¢ÂöÖ–ãàĞ Ğ¢·Æåf–WvW$÷Vâbb‡VæF–æuÆâÇÂvF6…Æâ’bb€Ğ¢ÆF—`Ğ¢6Æ74æÖSÒ&f—†VB–ç6WBÓ¢ÓSfÆW‚—FV×2Ö6VçFW"§W7F–g’Ö6VçFW"&rÖ&Æ6²ócRÓR&6¶G&÷Ö&ÇW"×6Ò Ğ¢&öÆSÒ&F–Æör Ğ¢&–ÖÖöFÃÒ'G'VR Ğ¢&–ÖÆ&VÃÒ.Éé¸ùºzNºzB«8NÙ¨ŞÈIÂ»;N«‹ Ğ¢öäÖ÷W6TF÷vã×²†WfVçB’Óâ°Ğ¢–b†WfVçBæ7W'&VçEF&vWBÓÓÒWfVçBçF&vWB’6WEÆåf–WvW$÷Vâ†fÇ6R“°Ğ¢×ĞĞ¢àĞ¢ÆF—b6Æ74æÖSÒ&Ö‚Ö‚Õ³s‡f…ÒrÖgVÆÂÖ‚×r×6Ò÷fW&fÆ÷r×’ÖWFò&÷VæFVBÓ7†Â&÷&FW"&÷&FW"Ö6&BÖ&÷&FW"&rÖ6&BÓB6†F÷rÓ'†Â#àĞ¢ÆF—b6Æ74æÖSÒ&fÆW‚—FV×2×7F'B§W7F–g’Ö&WGvVVâvÓ2#àĞ¢ÆF—càĞ¢Ç6Æ74æÖSÒ'FW‡BÕ³…ÒföçBÖ&Æ6²FW‡B×&–Ö'’#î«8NÙ¨ŞÈIÂ»;N«‹Â÷àĞ¢Æƒ"6Æ74æÖSÒ&×BÓFW‡BÖ&6RföçBÖ&Æ6²#àĞ¢·Æä¶–æBÓÓÒ%tD4‚"ò.«HºyÒÊH»˜N«8NÙ¨ŞÈIÂ"¢Æä¶–æBÓÓÒ$4ôäd”uU$R"ò.«¹éÈhÂÈJNÊ	^«8NÙ¨Ò"¢Æä¶–æBÓÓÒ$4Äõ4R"ò.ØúÎÊxÈY‚Ê(^º8Î«8NÙ¨Ò"¢.º+~ÈˆòÊ;ÎºË«8NÙ¨Ò'ĞĞ¢Âöƒ#àĞ¢ÂöF—càĞ¢Æ'WGFöàĞ¢G—SÒ&'WGFöâ Ğ¢öä6Æ–6³×²‚’Óâ6WEÆåf–WvW$÷Vâ†fÇ6R—ĞĞ¢6Æ74æÖSÒ&fÆW‚‚Ó’rÓ’—FV×2Ö6VçFW"§W7F–g’Ö6VçFW"&÷VæFVBÖgVÆÂ&r×6V6öæF'’ Ğ¢&–ÖÆ&VÃÒ.«8NÙ¨ŞÈIÂ¸º¾«‹ Ğ¢àĞ¢Å‚6Æ74æÖSÒ&‚ÓBrÓB"óàĞ¢Âö'WGFöãàĞ¢ÂöF—càĞ Ğ¢·Æä¶–æBÓÓÒ%tD4‚"bbvF6…Æâbb€Ğ¢ÆF—b6Æ74æÖSÒ&×BÓ276R×’Ó2#àĞ¢ÆF—b6Æ74æÖSÒ&w&–Bw&–BÖ6öÇ2Ó"vÓ"FW‡BÕ³…ÒföçBÖ&öÆB#àĞ¢ÄÖWG&–2Æ&VÃÒ.Ê(^ºªœ+~«‹ÊH»H’"fÇVS×¶G·vF6…Æâç7–Ö&öÇÒ+rGµD”ÔTe$ÔU2æf–æB‚†—FVÒ’Óâ—FVÒæ¶W’ÓÓÒvF6…ÆâçF–ÖVg&ÖR“òæÆ&VÇÖÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.º+~ÈˆòÊ	È‰‚"fÇVS×¶G·vF6…ÆâæÆöæu66÷&WÒòG·vF6…Æâç6†÷'E66÷&WÖÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.ºÊH»˜NÈJ"fÇVS×¶ÊÙZÒG¶f÷&ÖE&–6R‡vF6…Æâç&W6—7Fæ6UG&–vvW"—Ò¸øÎØÈÆÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.ÈˆòÊH»˜NÈJ"fÇVS×¶ÊxÊxG¶f÷&ÖE&–6R‡vF6…Æâç7W÷'EG&–vvW"—ÒÉÛNØ8†ÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.ÊiŞ««ˆŒ+~º»(NºjÎÊx"fÇVS×¶G¶f÷&ÖE&–6R‡vF6…ÆâæÖ&v–äÖ÷VçEU4EB—ÒU4EB+rG·vF6…ÆâæÆWfW&vWŞ»ÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.ÈiÊŒ+~ºªÙÂ"fÇVS×¶G·vF6…Æâç7F÷Æ÷75W&6VçGÒRòG·vF6…ÆâçF&vWE&öf—EW&6VçGÒVÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.ÈºNÊ	ÂÈ*ÎÉª«¸ªR"fÇVS×·vF6…Æâæf–Æ&ÆUU4EBÓÒçVÆÂò.ÊÙ¨ÂÙXNÉ©B"¢G¶f÷&ÖE&–6R‡vF6…Æâæf–Æ&ÆUU4EB—ÒU4EFÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.ÈºNÊ	Â«8NÊ(ÎØø«"fÇVS×·vF6…Æâæ66÷VçDWV—G•U4EBÓÒçVÆÂò.ÊÙ¨ÂÙXNÉ©B"¢G¶f÷&ÖE&–6R‡vF6…Æâæ66÷VçDWV—G•U4EB—ÒU4EFÒóàĞ¢ÂöF—càĞ¢ÆF—b6Æ74æÖSÒ'&÷VæFVBÓ'†Â&r×6V6öæF'’ósÓ2#àĞ¢Ç6Æ74æÖSÒ'FW‡BÕ³…ÒföçBÖ&Æ6²#î«HºyÒÉÛNÉÊÉ˜ÊH»˜NÊ«CÂ÷àĞ¢ÆF—b6Æ74æÖSÒ&×BÓ"76R×’Ó#àĞ¢·vF6…Æâç&V6öç2æÖ‚‡&V6öâÂ–æFW‚’Óâ€Ğ¢Ç¶W“×¶vF6‚×&V6öã¢G¶–æFW‡ÖÒ6Æ74æÖSÒ'FW‡BÕ³…ÒföçBÖ&öÆBÆVF–ær×&VÆ†VBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#ì+r·&V6öçÓÂ÷àĞ¢’—ĞĞ¢ÂöF—càĞ¢ÂöF—càĞ¢Ç6Æ74æÖSÒ'&÷VæFVBÓ'†Â&r×v&æ–æróÓ2FW‡BÕ³…ÒföçBÖ&öÆBÆVF–ær×&VÆ†VBFW‡B×v&æ–ær#àĞ¢«HºyÒÊH»˜N«8NÙ¨ŞÈIÎ¸©BÊ;ÎºËÉÛBÉXN¸¹¸¸¸ºBâº¸øÎØÈÂ¹‰¸©BÈˆòÉÛNØ8‚Ê«NÉÛBÈºNÊ	ÎºÂ»	ÎÈ9ŞÙYÂ¹*BÈ8‚Ê;ÎºË«8NÙ¨ŞÉØBºxÎ¹:NÉkNÉ[ÂÙZ¸¸¸ºBàĞ¢Â÷àĞ¢ÂöF—càĞ¢—ĞĞ Ğ¢·Æä¶–æBÓÓÒ$õTâ"bbVæF–æuÆâbb€Ğ¢ÆF—b6Æ74æÖSÒ&×BÓ2w&–Bw&–BÖ6öÇ2Ó"vÓ"FW‡BÕ³…ÒföçBÖ&öÆB#àĞ¢ÄÖWG&–2Æ&VÃÒ.Ê(^ºªœ+~»
ÙjR"fÇVS×¶Gµ7G&–ær‡VæF–æuÆâçÆâç7–Ö&öÂ—Ò+rGµ7G&–ær‡VæF–æuÆâçÆâæF—&V7F–öâ—ÖÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.ºxØÎ««*’"fÇVS×¶f÷&ÖE&–6R†çVÖ&W$öb‡VæF–æuÆâçÆâæ7W'&VçE&–6R’—ÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.ÊiŞ««ˆŒ+~º»(NºjÎÊx"fÇVS×¶G¶f÷&ÖE&–6R†çVÖ&W$öb‡VæF–æuÆâçÆâæÖ&v–äÖ÷VçEU4EB’—ÒU4EB+rG¶çVÖ&W$öb‡VæF–æuÆâçÆâæÆWfW&vR—Ş»ÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.Ê;ÎºË‚È‰¹ø’"fÇVS×µ7G&–ær‡VæF–æuÆâçÆâç6—¦UFW‡BóòVæF–æuÆâçÆâç6—¦R—ÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.ÈiÊ«"fÇVS×¶f÷&ÖE&–6R†çVÖ&W$öb‡VæF–æuÆâçÆâç7F÷&–6R’—ÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.ÉÛ^Ê«"fÇVS×¶f÷&ÖE&–6R†çVÖ&W$öb‡VæF–æuÆâçÆâçF&vWE&–6R’—ÒóàĞ¢ÂöF—càĞ¢—ĞĞ Ğ¢·Æä¶–æBÓÓÒ$4Äõ4R"bbVæF–æuÆâbb€Ğ¢ÆF—b6Æ74æÖSÒ&×BÓ2w&–Bw&–BÖ6öÇ2Ó"vÓ"FW‡BÕ³…ÒföçBÖ&öÆB#àĞ¢ÄÖWG&–2Æ&VÃÒ.Ê(^ºª’"fÇVS×µ7G&–ær‡VæF–æuÆâçÆâç7–Ö&öÂ—ÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.»
ÙjR"fÇVS×µ7G&–ær‡VæF–æuÆâçÆâæ†öÆE6–FRóò.¸º»
ÙjRÊNË+B"—ÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.È‰¹ø’"fÇVS×¶f÷&ÖE&–6R†çVÖ&W$öb‡VæF–æuÆâçÆâç÷6—F–öå6—¦R’—ÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.ºûÈºNÙˆNÈiÉÛR"fÇVS×¶G¶f÷&ÖE&–6R†çVÖ&W$öb‡VæF–æuÆâçÆâçVç&VÆ—¦VEÂ’—ÒU4EFÒóàĞ¢ÂöF—càĞ¢—ĞĞ Ğ¢·Æä¶–æBÓÓÒ$4ôäd”uU$R"bbVæF–æuÆâbb€Ğ¢ÆF—b6Æ74æÖSÒ&×BÓ2w&–Bw&–BÖ6öÇ2Ó"vÓ"FW‡BÕ³…ÒföçBÖ&öÆB#àĞ¢ÄÖWG&–2Æ&VÃÒ.ØúÎÊxÈY‚ºª¹9Â"fÇVS×µ7G&–ær‡VæF–æuÆâçÆâç÷6—F–öäÖöFR—ÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.ºxÊxBºª¹9Â"fÇVS×µ7G&–ær‡VæF–æuÆâçÆâæÖ&v–äÖöFR—ÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.ÈºÎ»;Â"fÇVS×µ7G&–ær‡VæF–æuÆâçÆâç7–Ö&öÂ—ÒóàĞ¢ÄÖWG&–2Æ&VÃÒ.º»(NºjÎÊx"fÇVS×¶G¶çVÖ&W$öb‡VæF–æuÆâçÆâæÆWfW&vR—Ş»ÒóàĞ¢ÂöF—càĞ¢—ĞĞ Ğ¢·VæF–æuÆãòçv&æ–ærbb€Ğ¢Ç6Æ74æÖSÒ&×BÓ2&÷VæFVBÓ'†Â&r×v&æ–æróÓ2FW‡BÕ³…ÒföçBÖ&öÆBÆVF–ær×&VÆ†VBFW‡B×v&æ–ær#ç·VæF–æuÆâçv&æ–æwÓÂ÷àĞ¢—ĞĞ Ğ¢·Æä¶–æBÓÒ%tD4‚"bbVæF–æuÆâbb€Ğ¢Æ'WGFöàĞ¢G—SÒ&'WGFöâ Ğ¢öä6Æ–6³×²‚’Óâfö–B‡Æä¶–æBÓÓÒ$õTâ"ò&÷fT÷Vâ‚’¢Æä¶–æBÓÓÒ$4Äõ4R"ò&÷fT6Æ÷6R‚’¢&÷fT6öæf–wW&R‚’—ĞĞ¢F—6&ÆVC×·VæF–æt7F–öâÒçVÆÇĞĞ¢6Æ74æÖSÒ&×BÓ2rÖgVÆÂ&÷VæFVBÓ'†Â&rÖFW7G'V7F—fR‚Ó2’Ó2FW‡B×‡2föçBÖ&Æ6²FW‡BÖFW7G'V7F—fRÖf÷&Vw&÷VæBF—6&ÆVC¦÷6—G’ÓS Ğ¢àĞ¢·VæF–æt7F–öàĞ¢ò.Ë)ºjÂÊIâââ Ğ¢¢Æä¶–æBÓÓÒ$õTâ Ğ¢ò.ÈºNÊ	Âº+~ÈˆòÊ;ÎºË‚ËYÎÊ(RÈ«ÉÛ‚ Ğ¢¢Æä¶–æBÓÓÒ$4Äõ4R Ğ¢ò.ØúÎÊxÈY‚È¹ÎÉê^«Ê(^º8ÂËYÎÊ(RÈ«ÉÛ‚ Ğ¢¢.«¹éÈhÂÈJNÊ	RËYÎÊ(RÈ«ÉÛ‚'ĞĞ¢Âö'WGFöãàĞ¢—ĞĞ¢ÂöF—càĞ¢ÂöF—càĞ¢—ĞĞ Ğ¢Ä&÷GFöÔæbóàĞ¢ÂöF—càĞ¢“°Ğ§ĞĞ Ğ¦gVæ7F–öâF÷F"‡²7F—fRÂöä6Æ–6²Â6†–ÆG&VâÓ¢²7F—fS¢&ööÆVã²öä6Æ–6³¢‚’Óâfö–C²6†–ÆG&Vã¢&V7DæöFRÒ’°Ğ¢&WGW&â€Ğ¢Æ'WGFöàĞ¢G—SÒ&'WGFöâ Ğ¢öä6Æ–6³×¶öä6Æ–6·ĞĞ¢6Æ74æÖS×¶6â€Ğ¢&–æÆ–æRÖfÆW‚—FV×2Ö6VçFW"§W7F–g’Ö6VçFW"&÷VæFVB×†Â&÷&FW"‚Ó"’Ó"FW‡BÖ6VçFW"FW‡B×6ÒföçBÖ&Æ6²ÆVF–ær×F–v‡B"ÀĞ¢7F—fRò&&÷&FW"×&–Ö'’&r×&–Ö'’FW‡B×&–Ö'’Öf÷&Vw&÷VæB"¢&&÷&FW"Ö6&BÖ&÷&FW"&rÖ6&BFW‡BÖ×WFVBÖf÷&Vw&÷VæB"ÀĞ¢—ĞĞ¢àĞ¢¶6†–ÆG&VçĞĞ¢Âö'WGFöãàĞ¢“°Ğ§ĞĞ Ğ¦gVæ7F–öâ7FGW5–ÆÂ‡²ö²ÂÆ&VÂÓ¢²ö³¢&ööÆVã²Æ&VÃ¢7G&–ærÒ’°Ğ¢&WGW&âÆF—b6Æ74æÖS×¶6â‚'&÷VæFVBÓ'†ÂÓ2"Âö²ò&&r×÷6—F—fRóFW‡B×÷6—F—fR"¢&&rÖFW7G'V7F—fRóFW‡BÖFW7G'V7F—fR"—Óç¶Æ&VÇÓÂöF—cã°Ğ§ĞĞ Ğ¦gVæ7F–öâ66÷&T6&B‡²Æ&VÂÂ66÷&RÂ7F—fRÂFöæRÓ¢²Æ&VÃ¢7G&–æs²66÷&S¢çVÖ&W#²7F—fS¢&ööÆVã²FöæS¢&Æöær"Â'6†÷'B"Ò’°Ğ¢&WGW&â€Ğ¢ÆF—b6Æ74æÖS×¶6â€Ğ¢'&÷VæFVB×†Â&÷&FW"Ó"FW‡BÖ6VçFW""ÀĞ¢7F—fPĞ¢òFöæRÓÓÒ&Æöær"ò&&÷&FW"×÷6—F—fRó3&r×÷6—F—fRóFW‡B×÷6—F—fR"¢&&÷&FW"ÖFW7G'V7F—fRó3&rÖFW7G'V7F—fRóFW‡BÖFW7G'V7F—fR Ğ¢¢&&÷&FW"Ö6&BÖ&÷&FW"&rÖ&6¶w&÷VæBFW‡BÖ×WFVBÖf÷&Vw&÷VæB"ÀĞ¢—ÓàĞ¢Ç6Æ74æÖSÒ'FW‡BÕ³—…ÒföçBÖ&Æ6²#ç¶Æ&VÇÒÊ	È‰ƒÂ÷àĞ¢Ç6Æ74æÖSÒ&×BÓãRFW‡BÖ&6RföçBÖ&Æ6²#ç·66÷&WÓÂ÷àĞ¢ÂöF—càĞ¢“°Ğ§ĞĞ Ğ¦gVæ7F–öâÖWG&–2‡²Æ&VÂÂfÇVRÓ¢²Æ&VÃ¢7G&–æs²fÇVS¢7G&–ærÒ’°Ğ¢&WGW&â€Ğ¢ÆF—b6Æ74æÖSÒ'&÷VæFVB×†Â&r×6V6öæF'’ósÓ"#àĞ¢Ç6Æ74æÖSÒ'FW‡BÕ³—…ÒföçBÖ&Æ6²FW‡BÖ×WFVBÖf÷&Vw&÷VæB#ç¶Æ&VÇÓÂ÷àĞ¢Ç6Æ74æÖSÒ&×BÓ'&V²×v÷&G2FW‡BÕ³…ÒföçBÖ&Æ6²FW‡BÖf÷&Vw&÷VæB#ç·fÇVWÓÂ÷àĞ¢ÂöF—càĞ¢“°Ğ§ĞĞ Ğ¦gVæ7F–öâÆöF–æt&÷‚‡²FW‡BÓ¢²FW‡C¢7G&–ærÒ’°Ğ¢&WGW&â€Ğ¢ÆF—b6Æ74æÖSÒ&×BÓ2fÆW‚—FV×2Ö6VçFW"§W7F–g’Ö6VçFW"vÓ"&÷VæFVBÓ'†Â&r×6V6öæF'’ÓRFW‡B×‡2föçBÖ&öÆBFW‡BÖ×WFVBÖf÷&Vw&÷VæB#àĞ¢ÄÆöFW#"6Æ74æÖSÒ&‚ÓBrÓBæ–ÖFR×7–â"óâ·FW‡GĞĞ¢ÂöF—càĞ¢“°Ğ§ĞĞ Ğ¦gVæ7F–öâW'&÷$&÷‚‡²FW‡BÓ¢²FW‡C¢7G&–ærÒ’°Ğ¢&WGW&âÇ6Æ74æÖSÒ&×BÓ2&÷VæFVBÓ'†Â&rÖFW7G'V7F—fRóÓBFW‡BÖ6VçFW"FW‡B×‡2föçBÖ&öÆBFW‡BÖFW7G'V7F—fR#ç·FW‡GÓÂ÷ã°Ğ§ĞĞ Ğ¦gVæ7F–öâ6VÆV7Df–VÆB‡°Ğ¢Æ&VÂÀĞ¢fÇVRÀĞ¢öä6†ævRÀĞ¢÷F–öç2ÀĞ§Ó¢°Ğ¢Æ&VÃ¢7G&–æs°Ğ¢fÇVS¢7G&–æs°Ğ¢öä6†ævS¢‡fÇVS¢7G&–ær’Óâfö–C°Ğ¢÷F–öç3¢'&“Ç²fÇVS¢7G&–æs²Æ&VÃ¢7G&–ærÓã°Ğ§Ò’°Ğ¢&WGW&â€Ğ¢ÆÆ&VÂ6Æ74æÖSÒ'&÷VæFVBÓ'†Â&÷&FW"&÷&FW"Ö6&BÖ&÷&FW"&rÖ&6¶w&÷VæBÓ2#àĞ¢Ç7â6Æ74æÖSÒ&&Æö6²FW‡BÕ³…ÒföçBÖ&Æ6²FW‡BÖ×WFVBÖf÷&Vw&÷VæB#ç¶Æ&VÇÓÂ÷7ãàĞ¢Ç6VÆV7BfÇVS×·fÇVWÒöä6†ævS×²†WfVçB’Óâöä6†ævR†WfVçBçF&vWBçfÇVR—Ò6Æ74æÖSÒ&×BÓrÖgVÆÂ&r×G&ç7&VçBFW‡B×6ÒföçBÖ&Æ6²÷WFÆ–æRÖæöæR#àĞ¢¶÷F–öç2æÖ‚†÷F–öâ’ÓâÆ÷F–öâ¶W“×¶÷F–öâçfÇVWÒfÇVS×¶÷F–öâçfÇVWÓç¶÷F–öâæÆ&VÇÓÂö÷F–öãâ—ĞĞ¢Â÷6VÆV7CàĞ¢ÂöÆ&VÃàĞ¢“°Ğ§ĞĞ Ğ¦gVæ7F–öâçVÖ&W$f–VÆB‡°Ğ¢Æ&VÂÀĞ¢fÇVRÀĞ¢Ö–âÀĞ¢Ö‚ÀĞ¢7FWÀĞ¢7Vff—‚ÀĞ¢öä6†ævRÀĞ§Ó¢°Ğ¢Æ&VÃ¢7G&–æs°Ğ¢fÇVS¢çVÖ&W#°Ğ¢Ö–ã¢çVÖ&W#°Ğ¢Öƒ¢çVÖ&W#°Ğ¢7FW¢çVÖ&W#°Ğ¢7Vff—ƒ¢7G&–æs°Ğ¢öä6†ævS¢‡fÇVS¢çVÖ&W"’Óâfö–C°Ğ§Ò’°Ğ¢6öç7B¶G&gBÂ6WDG&gEÒÒW6U7FFR‚‚’Óâ7G&–ær‡fÇVR’“°Ğ¢6öç7Bfö7W6VE&VbÒW6U&Vb†fÇ6R“°Ğ Ğ¢W6TVffV7B‚‚’Óâ°Ğ¢–b‚fö7W6VE&Vbæ7W'&VçB’°Ğ¢6WDG&gB…7G&–ær‡fÇVR’“°Ğ¢ĞĞ¢ÒÂ·fÇVUÒ“°Ğ Ğ¢6öç7B6öÖÖ—BÒ‚’Óâ°Ğ¢6öç7B6ÆVæVBÒG&gBç&WÆ6R‚òÂörÂ""’çG&–Ò‚“°Ğ¢–b‚6ÆVæVB’°Ğ¢6WDG&gB…7G&–ær‡fÇVR’“°Ğ¢&WGW&ã°Ğ¢ĞĞ Ğ¢6öç7B'6VBÒçVÖ&W"†6ÆVæVB“°Ğ¢–b‚çVÖ&W"æ—4f–æ—FR‡'6VB’’°Ğ¢6WDG&gB…7G&–ær‡fÇVR’“°Ğ¢&WGW&ã°Ğ¢ĞĞ Ğ¢6öç7Bæ÷&ÖÆ—¦VBÒ6Æ×‡'6VBÂÖ–âÂÖ‚“°Ğ¢öä6†ævR†æ÷&ÖÆ—¦VB“°Ğ¢6WDG&gB…7G&–ær†æ÷&ÖÆ—¦VB’“°Ğ¢Ó°Ğ Ğ¢&WGW&â€Ğ¢ÆÆ&VÂ6Æ74æÖSÒ'&÷VæFVBÓ'†Â&÷&FW"&÷&FW"Ö6&BÖ&÷&FW"&rÖ&6¶w&÷VæBÓ2#àĞ¢Ç7â6Æ74æÖSÒ&&Æö6²FW‡BÕ³…ÒföçBÖ&Æ6²FW‡BÖ×WFVBÖf÷&Vw&÷VæB#àĞ¢¶Æ&VÇĞĞ¢Â÷7ãàĞ¢ÆF—b6Æ74æÖSÒ&×BÓfÆW‚—FV×2Ö6VçFW"vÓ#àĞ¢Æ–çW@Ğ¢G—SÒ'FW‡B Ğ¢–çWDÖöFS×´çVÖ&W"æ—4–çFVvW"‡7FW’ò&çVÖW&–2"¢&FV6–ÖÂ'ĞĞ¢fÇVS×¶G&gGĞĞ¢öäfö7W3×²†WfVçB’Óâ°Ğ¢fö7W6VE&Vbæ7W'&VçBÒG'VS°Ğ¢v–æF÷rç&WVW7Dæ–ÖF–öäg&ÖR‚‚’ÓâWfVçBæ7W'&VçEF&vWBç6VÆV7B‚’“°Ğ¢×ĞĞ¢öä6†ævS×²†WfVçB’Óâ°Ğ¢6öç7BæW‡BÒWfVçBçF&vWBçfÇVS°Ğ¢–b‚õâÓõÆB¢ƒó¥²åÕÆB¢“òBòçFW7B†æW‡Bç&WÆ6R‚òÂörÂ""’’’°Ğ¢6WDG&gB†æW‡B“°Ğ¢ĞĞ¢×ĞĞ¢öä&ÇW#×²‚’Óâ°Ğ¢fö7W6VE&Vbæ7W'&VçBÒfÇ6S°Ğ¢6öÖÖ—B‚“°Ğ¢×ĞĞ¢öä¶W”F÷vã×²†WfVçB’Óâ°Ğ¢–b†WfVçBæ¶W’ÓÓÒ$VçFW""’°Ğ¢WfVçBç&WfVçDFVfVÇB‚“°Ğ¢6öÖÖ—B‚“°Ğ¢WfVçBæ7W'&VçEF&vWBæ&ÇW"‚“°Ğ¢ĞĞ¢–b†WfVçBæ¶W’ÓÓÒ$W66R"’°Ğ¢6WDG&gB…7G&–ær‡fÇVR’“°Ğ¢WfVçBæ7W'&VçEF&vWBæ&ÇW"‚“°Ğ¢ĞĞ¢×ĞĞ¢Æ6V†öÆFW#×¶G¶Ö–çÒâG¶Ö‡ÖĞĞ¢6Æ74æÖSÒ&Ö–â×rÓfÆW‚Ó&r×G&ç7&VçBFW‡B×6ÒföçBÖ&Æ6²÷WFÆ–æRÖæöæR Ğ¢óàĞ¢Ç7â6Æ74æÖSÒ'FW‡BÕ³…ÒföçBÖ&Æ6²FW‡BÖ×WFVBÖf÷&Vw&÷VæB#àĞ¢·7Vff—‡ĞĞ¢Â÷7ãàĞ¢ÂöF—càĞ¢ÂöÆ&VÃàĞ¢“°Ğ§Ğ