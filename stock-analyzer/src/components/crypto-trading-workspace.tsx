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
import { useAuth } from '@/lib/auth';
import { FavoriteButton } from '@/components/favorite-button';
import { InstrumentAlertButton } from '@/components/instrument-alert-modal';
import { displayCoinName } from '@/lib/stock-display';
import { loadVisibleChartTimeframes, saveVisibleChartTimeframes } from '@/lib/chart-preferences';

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
type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1H" | "4H" | "8H" | "12H" | "1D" | "3D" | "5D" | "15D" | "1M" | "3M" | "6M" | "1Y";
type OverlayKey = "ma5" | "ma20" | "ma60" | "bollinger" | "vwap" | "volume" | "levels" | "arrows";
type ScannerCategory = "strongBuy" | "strongSell" | "pattern" | "volumeSignal";
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
  koreanName: string | undefined;
  englishName: string | undefined;
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
  confidence: "높음" | "보통" | "낮음";
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
  spotTotalAmountKRW: number;
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
  { key: "1m", label: "1분" },
  { key: "3m", label: "3분" },
  { key: "5m", label: "5분" },
  { key: "15m", label: "15분" },
  { key: "30m", label: "30분" },
  { key: "1H", label: "1시간" },
  { key: "4H", label: "4시간" },
  { key: "8H", label: "8시간" },
  { key: "12H", label: "12시간" },
  { key: "1D", label: "1일" },
  { key: "3D", label: "3일" },
  { key: "5D", label: "5일" },
  { key: "15D", label: "15일" },
  { key: "1M", label: "1달" },
  { key: "3M", label: "3달" },
  { key: "6M", label: "6달" },
  { key: "1Y", label: "1년" },
];

const OVERLAYS: Array<{ key: OverlayKey; label: string }> = [
  { key: "ma5", label: "MA5" },
  { key: "ma20", label: "MA20" },
  { key: "ma60", label: "MA60" },
  { key: "bollinger", label: "볼린저" },
  { key: "vwap", label: "VWAP" },
  { key: "volume", label: "거래량" },
  { key: "levels", label: "지지·저항" },
  { key: "arrows", label: "롱·숏 화살표" },
];

const OVERLAY_DESCRIPTIONS: Record<OverlayKey, string> = {
  ma5: "MA5는 최근 5개 봉의 평균 가격입니다. 가격이 선 위에서 지지받으면 단기 상승 힘, 선 아래에서 저항받으면 단기 하락 힘을 확인합니다.",
  ma20: "MA20은 최근 20개 봉의 평균 가격으로 단기 추세 기준입니다. 돌파만 보지 말고 종가 유지와 거래량을 함께 확인합니다.",
  ma60: "MA60은 최근 60개 봉의 평균 가격으로 중기 추세 기준입니다. 기울기와 가격의 선 위·아래 위치를 같이 봅니다.",
  bollinger: "볼린저밴드는 20개 봉 평균과 변동 범위를 표시합니다. 밴드 수축 뒤 거래량 동반 이탈은 변동성 확대 신호지만 상·하단 접촉만으로 매매하지 않습니다.",
  vwap: "VWAP은 거래량을 반영한 평균 체결 가격입니다. 가격이 VWAP 위를 유지하면 매수 우위, 아래에서 막히면 매도 우위를 확인합니다.",
  volume: "거래량은 신호의 참여 강도를 보여줍니다. 돌파·이탈 때 최근 평균보다 증가해야 신뢰도가 높아집니다.",
  levels: "지지·저항은 최근 실제 고점과 저점에서 계산한 가격대입니다. 돌파된 저항은 약한 지지로, 이탈한 지지는 약한 저항으로 바뀔 수 있습니다.",
  arrows: "화살표는 실제 봉·지표·패턴 조건이 동시에 충족된 지점을 표시합니다. 단독 매수·매도 지시가 아니며 해당 봉의 근거를 함께 확인해야 합니다.",
};

const SCANNER_CATEGORIES: Array<{ key: ScannerCategory; label: string }> = [
  { key: "strongBuy", label: "강한 매수" },
  { key: "strongSell", label: "강한 매도" },
  { key: "pattern", label: "패턴 감지" },
  { key: "volumeSignal", label: "거래량 신호" },
];

const INDICATOR_PROFILE_TABS: Array<{ key: IndicatorProfileKey; label: string }> = [
  { key: "minute", label: "분봉" },
  { key: "hour", label: "시간봉" },
  { key: "day", label: "일·주봉" },
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
  spotTotalAmountKRW: 100000,
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
    patterns.push({ key: "breakout", label: "거래량 동반 상단 돌파", direction: "LONG", weight: 14 });
  }
  if (last.close < recentLow && last.volume > (average(recent.map((row) => row.volume)) ?? 0) * 1.3) {
    patterns.push({ key: "breakdown", label: "거래량 동반 하단 이탈", direction: "SHORT", weight: 14 });
  }
  if (previous.close < previous.open && last.close > last.open && last.open <= previous.close && last.close >= previous.open) {
    patterns.push({ key: "bullish-engulf", label: "상승 장악형", direction: "LONG", weight: 8 });
  }
  if (previous.close > previous.open && last.close < last.open && last.open >= previous.close && last.close <= previous.open) {
    patterns.push({ key: "bearish-engulf", label: "하락 장악형", direction: "SHORT", weight: 8 });
  }
  if (lowerWick > body * 2 && lowerWick > upperWick * 1.5 && last.close > last.open) {
    patterns.push({ key: "hammer", label: "망치형 반등", direction: "LONG", weight: 7 });
  }
  if (upperWick > body * 2 && upperWick > lowerWick * 1.5 && last.close < last.open) {
    patterns.push({ key: "shooting-star", label: "유성형 반락", direction: "SHORT", weight: 7 });
  }
  if (body / range < 0.12) {
    patterns.push({ key: "doji", label: "도지·방향 대기", direction: "NEUTRAL", weight: 0 });
  }

  const closes = candles.slice(-35).map((row) => row.close);
  const localLows = closes
    .map((value, index) => ({ value, index }))
    .filter((row) => row.index > 0 && row.index < closes.length - 1 && row.value <= closes[row.index - 1] && row.value <= closes[row.index + 1]);
  const localHighs = closes
    .map((value, index) => ({ value, index }))
    .filter((row) => row.index > 0 && row.index < closes.length - 1 && row.value >= closes[row.index - 1] && row.value >= closes[row.index + 1]);
  if (localLows.length >= 2) {
    const [left, right] = localLows.slice(-2);
    if (right.index - left.index >= 4 && Math.abs(right.value - left.value) / Math.max(left.value, 1) < 0.012 && last.close > support) {
      patterns.push({ key: "double-bottom", label: "쌍바닥 후보", direction: "LONG", weight: 9 });
    }
  }
  if (localHighs.length >= 2) {
    const [left, right] = localHighs.slice(-2);
    if (right.index - left.index >= 4 && Math.abs(right.value - left.value) / Math.max(left.value, 1) < 0.012 && last.close < resistance) {
      patterns.push({ key: "double-top", label: "쌍봉 후보", direction: "SHORT", weight: 9 });
    }
  }
  return patterns.slice(0, 6);
}

function analyze(
  symbol: string,
  candles: Candle[],
  ticker: Ticker | null,
  marketBias: number,
  minScore: number,
): Analysis | null {
  if (candles.length < 25) return null;
  const closes = candles.map((row) => row.close);
  const last = candles.at(-1)!;
  const previous = candles.at(-2)!;
  const currentPrice = ticker?.markPrice || last.close;
  const previousClose = previous.close;
  const changePercent = previousClose ? ((currentPrice - previousClose) / previousClose) * 100 : 0;
  const sma5 = sma(closes, 5);
  const sma20 = sma(closes, 20);
  const sma60 = sma(closes, 60);
  const currentRsi = rsi(closes);
  const macd = macdSnapshot(closes);
  const currentAtr = atr(candles);
  const atrPercent = currentPrice ? currentAtr / currentPrice * 100 : 0;
  const recentVolumes = candles.slice(-21, -1).map((row) => row.volume).filter((value) => value > 0);
  const averageVolume = average(recentVolumes) ?? 0;
  const volumeRatio = averageVolume > 0 ? last.volume / averageVolume : 1;
  const vwapRows = rollingVwap(candles);
  const currentVwap = vwapRows.at(-1)?.value ?? null;
  const levelRows = candles.slice(-50, -1);
  const support1 = Math.min(...levelRows.slice(-20).map((row) => row.low));
  const support2 = Math.min(...levelRows.map((row) => row.low));
  const resistance1 = Math.max(...levelRows.slice(-20).map((row) => row.high));
  const resistance2 = Math.max(...levelRows.map((row) => row.high));
  const patterns = detectPatterns(candles, support1, resistance1);

  let longScore = 35;
  let shortScore = 35;
  const longReasons: string[] = [];
  const shortReasons: string[] = [];

  if (sma5 != null && sma20 != null) {
    if (sma5 > sma20) {
      longScore += 10;
      shortScore -= 4;
      longReasons.push("MA5가 MA20 위");
    } else {
      shortScore += 10;
      longScore -= 4;
      shortReasons.push("MA5가 MA20 아래");
    }
  }
  if (sma20 != null && sma60 != null) {
    if (sma20 > sma60) {
      longScore += 8;
      longReasons.push("중기 상승 배열");
    } else {
      shortScore += 8;
      shortReasons.push("중기 하락 배열");
    }
  }
  if (currentVwap != null) {
    if (currentPrice > currentVwap) {
      longScore += 6;
      longReasons.push("VWAP 상단 유지");
    } else {
      shortScore += 6;
      shortReasons.push("VWAP 하단 체류");
    }
  }
  if (currentRsi != null) {
    if (currentRsi >= 55 && currentRsi <= 72) {
      longScore += 8;
      longReasons.push(`RSI ${currentRsi.toFixed(0)} 상승 모멘텀`);
    }
    if (currentRsi <= 45 && currentRsi >= 28) {
      shortScore += 8;
      shortReasons.push(`RSI ${currentRsi.toFixed(0)} 하락 모멘텀`);
    }
    if (currentRsi > 76) {
      shortScore += 9;
      longScore -= 5;
      shortReasons.push("RSI 과매수 주의");
    }
    if (currentRsi < 24) {
      longScore += 9;
      shortScore -= 5;
      longReasons.push("RSI 과매도 반등 후보");
    }
  }
  if (macd.macd != null && macd.signal != null) {
    if (macd.macd > macd.signal) {
      longScore += 9;
      longReasons.push("MACD 상향 우세");
    } else {
      shortScore += 9;
      shortReasons.push("MACD 하향 우세");
    }
  }
  if (volumeRatio >= 1.5) {
    if (last.close >= last.open) {
      longScore += 8;
      longReasons.push(`거래량 ${volumeRatio.toFixed(1)}배 양봉`);
    } else {
      shortScore += 8;
      shortReasons.push(`거래량 ${volumeRatio.toFixed(1)}배 음봉`);
    }
  }
  if (currentPrice > resistance1) {
    longScore += 10;
    longReasons.push("단기 저항 돌파");
  }
  if (currentPrice < support1) {
    shortScore += 10;
    shortReasons.push("단기 지지 이탈");
  }
  for (const pattern of patterns) {
    if (pattern.direction === "LONG") {
      longScore += pattern.weight;
      longReasons.push(pattern.label);
    } else if (pattern.direction === "SHORT") {
      shortScore += pattern.weight;
      shortReasons.push(pattern.label);
    }
  }

  if (marketBias > 0) {
    longScore += Math.min(8, marketBias);
    if (marketBias >= 4) longReasons.push("비트코인·시장 방향 상승");
  } else if (marketBias < 0) {
    shortScore += Math.min(8, Math.abs(marketBias));
    if (marketBias <= -4) shortReasons.push("비트코인·시장 방향 하락");
  }

  const fundingRate = ticker?.fundingRate ?? 0;
  if (fundingRate > 0.0006) {
    shortScore += 4;
    shortReasons.push("양(+) 펀딩 과열");
  } else if (fundingRate < -0.0006) {
    longScore += 4;
    longReasons.push("음(-) 펀딩 과열");
  }

  if (atrPercent > 4) {
    longScore -= 5;
    shortScore -= 5;
  }

  longScore = Math.round(clamp(longScore, 0, 100));
  shortScore = Math.round(clamp(shortScore, 0, 100));
  const difference = longScore - shortScore;
  const direction: Direction =
    longScore >= minScore && difference >= 10
      ? "LONG"
      : shortScore >= minScore && difference <= -10
        ? "SHORT"
        : "WAIT";
  const strongest = Math.max(longScore, shortScore);
  const confidence = strongest >= 85 && Math.abs(difference) >= 20
    ? "높음"
    : strongest >= 70 && Math.abs(difference) >= 10
      ? "보통"
      : "낮음";
  const riskDistance = Math.max(currentAtr * 1.5, currentPrice * 0.008);
  const rewardDistance = riskDistance * 2;

  return {
    symbol,
    currentPrice,
    previousClose,
    changePercent,
    sma5,
    sma20,
    sma60,
    rsi: currentRsi,
      macd: macd.macd,
      macdSignal: macd.signal,
      atr: currentAtr,
      atrPercent,
      volumeRatio,
      vwap: currentVwap,
      support1,
      support2,
      resistance1,
      resistance2,
      longScore,
      shortScore,
      direction,
      confidence,
      longReasons: [...new Set(longReasons)].slice(0, 6),
      shortReasons: [...new Set(shortReasons)].slice(0, 6),
      patterns,
      targetLong: currentPrice + rewardDistance,
      stopLong: currentPrice - riskDistance,
      targetShort: currentPrice - rewardDistance,
      stopShort: currentPrice + riskDistance,
      marketBias,
      generatedAt: new Date().toISOString(),
    };
    }

    function loadSettings() {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    try {
      const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<AutoSettings>;
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      return DEFAULT_SETTINGS;
    }
    }

    function saveSettings(settings: AutoSettings) {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }
    return settings;
    }

    function indicatorProfileForTimeframe(timeframe: Timeframe): IndicatorProfileKey {
    if (["1D", "3D", "5D", "15D", "1M", "3M", "6M", "1Y"].includes(timeframe)) return "day";
    if (["1H", "4H", "8H", "12H"].includes(timeframe)) return "hour";
    return "minute";
    }

    function loadIndicatorProfiles(): IndicatorProfiles {
    if (typeof window === "undefined") return DEFAULT_INDICATOR_PROFILES;
    try {
      const parsed = JSON.parse(
        window.localStorage.getItem(INDICATOR_SETTINGS_KEY) ?? "{}",
      ) as Partial<IndicatorProfiles>;
      return {
        minute: { ...DEFAULT_INDICATOR_PROFILES.minute, ...(parsed.minute ?? {}) },
        hour: { ...DEFAULT_INDICATOR_PROFILES.hour, ...(parsed.hour ?? {}) },
        day: { ...DEFAULT_INDICATOR_PROFILES.day, ...(parsed.day ?? {}) },
      };
    } catch {
      return DEFAULT_INDICATOR_PROFILES;
    }
    }

    function saveIndicatorProfiles(profiles: IndicatorProfiles) {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(INDICATOR_SETTINGS_KEY, JSON.stringify(profiles));
    }
    return profiles;
    }

    async function getProtected<T>(url: string): Promise<T> {
    const response = await authorizedFetch(url, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message ?? payload.error ?? `HTTP_${response.status}`);
    return payload as T;
    }

    async function postProtected<T>(url: string, body: AnyObj, executionKey: string): Promise<T> {
    const normalizedKey = normalizeExecutionKey(executionKey);
    const response = await authorizedFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Crypto-Auto-Trade-Key": normalizedKey,
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message ?? payload.error ?? `HTTP_${response.status}`);
    return payload as T;
    }

    async function fetchCandles(symbol: string, timeframe: Timeframe, limit = 240, market: "spot" | "futures" = "futures") {
    const url = market === "spot"
      ? `/crypto/spot/candles?symbol=${encodeURIComponent(symbol)}&tf=${timeframe}&count=${Math.min(200, limit)}`
      : `/crypto/futures/candles?symbol=${encodeURIComponent(symbol)}&granularity=${encodeURIComponent(timeframe)}&limit=${limit}`;
    const payload = await apiGet<AnyObj>(url);
    return normalizeCandles(Array.isArray(payload.candles) ? payload.candles : []);
    }

    function normalizeTickers(payload: AnyObj | undefined) {
    return ((payload?.tickers ?? []) as AnyObj[])
      .map((row) => ({
        symbol: String(row.symbol ?? "").toUpperCase(),
        koreanName: String(row.koreanName ?? "") || undefined,
        englishName: String(row.englishName ?? row.baseCoin ?? "") || undefined,
        price: numberOf(row.price),
        markPrice: numberOf(row.markPrice ?? row.price),
        indexPrice: numberOf(row.indexPrice ?? row.markPrice ?? row.price),
        changePercent24h: numberOf(row.changePercent24h ?? row.changePercent),
        high24h: numberOf(row.high24h),
        low24h: numberOf(row.low24h),
        volume24h: numberOf(row.volume24h),
        tradingValue24h: numberOf(row.tradingValue24h),
        fundingRate: numberOf(row.fundingRate),
        openInterest: numberOf(row.openInterest),
        bidPrice: numberOf(row.bidPrice),
        askPrice: numberOf(row.askPrice),
      } satisfies Ticker))
      .filter((row) => row.symbol && row.markPrice > 0);
    }

    function formatPrice(value: number | null | undefined) {
    if (value == null || !Number.isFinite(value)) return "-";
    if (Math.abs(value) >= 1000) return value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
    if (Math.abs(value) >= 1) return value.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
    return value.toLocaleString("ko-KR", { maximumFractionDigits: 8 });
    }

    function formatPercent(value: number | null | undefined, digits = 2) {
    if (value == null || !Number.isFinite(value)) return "-";
    return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
    }

    type ScannerTradePlan = {
    entry: number;
    entries: [number, number, number];
    exits: [number, number, number];
    target: number;
    stop: number;
    invalidation: string;
    rewardRisk: number | null;
    };

    function buildScannerTradePlan(analysis: Analysis, direction: ScannerDirection): ScannerTradePlan {
    const price = analysis.currentPrice;
    const atr = Math.max(analysis.atr, price * 0.003);
    const isLong = direction === "LONG";

    const entries: [number, number, number] = isLong
      ? [price, Math.min(price - atr * 0.55, analysis.support1), Math.min(price - atr * 1.1, analysis.support2)]
      : [price, Math.max(price + atr * 0.55, analysis.resistance1), Math.max(price + atr * 1.1, analysis.resistance2)];
    const target = isLong ? Math.max(analysis.targetLong, analysis.resistance2) : Math.min(analysis.targetShort, analysis.support2);
    const stop = isLong ? Math.min(analysis.stopLong, analysis.support2 - atr * 0.2) : Math.max(analysis.stopShort, analysis.resistance2 + atr * 0.2);
    const exits: [number, number, number] = isLong
      ? [Math.max(price + atr, analysis.resistance1), Math.max(price + atr * 1.7, analysis.resistance2), target]
      : [Math.min(price - atr, analysis.support1), Math.min(price - atr * 1.7, analysis.support2), target];
    const risk = Math.abs(entries[0] - stop);
    const reward = Math.abs(target - entries[0]);

    return {
      entry: entries[0],
      entries,
      exits,
      target,
      stop,
      invalidation: `${formatPrice(stop)} ${isLong ? "종가 이탈" : "종가 돌파"}`,
      rewardRisk: risk > 0 ? reward / risk : null,
    };
    }

    function toneClass(direction: Direction) {
    if (direction === "LONG") return "border-positive/30 bg-positive/10 text-positive";
    if (direction === "SHORT") return "border-destructive/30 bg-destructive/10 text-destructive";
    return "border-card-border bg-secondary text-muted-foreground";
    }

    function directionLabel(direction: Direction) {
    return direction === "LONG" ? "롱" : direction === "SHORT" ? "숏" : "관망";
    }

    function normalizeExecutionKey(value: unknown) {
    let normalized = String(value ?? "")
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .trim();

    const first = normalized.at(0);
    const last = normalized.at(-1);
    const quoted =
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "`" && last === "`");

    if (quoted && normalized.length >= 2) {
      normalized = normalized.slice(1, -1).trim();
    }

    return normalized;
    }

    function loadExecutionKey() {
    if (typeof window === "undefined") return "";
    return normalizeExecutionKey(
      window.sessionStorage.getItem(EXECUTION_KEY_SESSION_KEY) ?? "",
    );
    }

    function saveExecutionKeyToSession(value: string) {
    if (typeof window === "undefined") return;
    const normalized = normalizeExecutionKey(value);
    if (normalized) {
      window.sessionStorage.setItem(EXECUTION_KEY_SESSION_KEY, normalized);
    } else {
      window.sessionStorage.removeItem(EXECUTION_KEY_SESSION_KEY);
    }
    }

    function buildAiTradeView(analysis: Analysis, timeframe: Timeframe) {
    const frameLabel = TIMEFRAMES.find((item) => item.key === timeframe)?.label ?? timeframe;
    const scoreGap = Math.abs(analysis.longScore - analysis.shortScore);
    if (analysis.direction === "LONG") {
      return {
        title: "매수 우위 · 눌림 또는 돌파 확인",
        summary: `${frameLabel} 기준 롱 ${analysis.longScore}점으로 숏보다 ${scoreGap}점 높습니다. ${formatPrice(analysis.support1)} 지지를 유지하면 매수 관점이며, ${formatPrice(analysis.resistance1)} 돌파 시 추세 강화를 확인합니다. 손절은 설정값과 지지 이탈을 함께 보세요.`,
      };
    }
    if (analysis.direction === "SHORT") {
      return {
        title: "매도 우위 · 반등 실패 또는 지지 이탈 확인",
        summary: `${frameLabel} 기준 숏 ${analysis.shortScore}점으로 롱보다 ${scoreGap}점 높습니다. ${formatPrice(analysis.resistance1)} 아래에서는 매도 관점이며, ${formatPrice(analysis.support1)} 이탈 시 하락 추세 강화를 확인합니다. 손절은 저항 회복과 설정값을 함께 보세요.`,
      };
    }
    return {
      title: "매수·매도 힘이 비슷해 관망",
      summary: `${frameLabel} 기준 롱 ${analysis.longScore}점, 숏 ${analysis.shortScore}점으로 방향 차이가 작습니다. ${formatPrice(analysis.resistance1)} 위 돌파는 롱 준비, ${formatPrice(analysis.support1)} 아래 이탈은 숏 준비 조건으로 보고 그 전에는 신규 진입을 보류합니다.`,
    };
    }

    function addLine(
    chart: IChartApi,
    rows: Array<{ time: Time; value: number }>,
    options: AnyObj,
    ) {
    const series = chart.addLineSeries({
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      ...options,
    });
    series.setData(rows);
    return series;
    }

    function chartMarkers(candles: Candle[], analysis: Analysis) {
    const last = candles.at(-1);
    if (!last || analysis.direction === "WAIT") return [];
    return [
      {
        time: last.time,
        position: analysis.direction === "LONG" ? "belowBar" : "aboveBar",
        color: analysis.direction === "LONG" ? "#16a34a" : "#dc2626",
        shape: analysis.direction === "LONG" ? "arrowUp" : "arrowDown",
        text: `${directionLabel(analysis.direction)} ${Math.max(analysis.longScore, analysis.shortScore)}점`,
      },
    ];
    }

    function FuturesChart({
    candles,
    analysis,
    timeframe,
    overlays,
    }: {
    candles: Candle[];
    analysis: Analysis;
    timeframe: Timeframe;
    overlays: Record<OverlayKey, boolean>;
    }) {
    const containerRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      const container = containerRef.current;
      if (!container || !candles.length) return;
      const dark = document.documentElement.classList.contains("dark");
      const chart = createChart(container, {
        width: container.clientWidth,
        height: 390,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: dark ? "#cbd5e1" : "#475569",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: dark ? "rgba(148,163,184,0.08)" : "rgba(100,116,139,0.10)" },
          horzLines: { color: dark ? "rgba(148,163,184,0.08)" : "rgba(100,116,139,0.10)" },
        },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: {
          borderVisible: false,
          scaleMargins: { top: 0.08, bottom: overlays.volume ? 0.22 : 0.08 },
        },
        timeScale: {
          borderVisible: false,
          timeVisible: /m|H/.test(timeframe),
          secondsVisible: false,
          rightOffset: 5,
          barSpacing: timeframe.includes("m") ? 8 : 7,
        },
        handleScroll: true,
        handleScale: true,
      });

      const candleSeries = chart.addCandlestickSeries({
        upColor: "#16a34a",
        downColor: "#dc2626",
        wickUpColor: "#16a34a",
        wickDownColor: "#dc2626",
        borderUpColor: "#16a34a",
        borderDownColor: "#dc2626",
        priceLineVisible: true,
        lastValueVisible: true,
      });
      candleSeries.setData(candles.map((row) => ({
        time: row.time,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
      })));

      if (overlays.ma5) addLine(chart, rollingSma(candles, 5), { color: "#f59e0b", lineWidth: 1, title: "MA5" });
      if (overlays.ma20) addLine(chart, rollingSma(candles, 20), { color: "#8b5cf6", lineWidth: 2, title: "MA20" });
      if (overlays.ma60) addLine(chart, rollingSma(candles, 60), { color: "#10b981", lineWidth: 1, title: "MA60" });
      if (overlays.bollinger) {
        const band = rollingBollinger(candles);
        addLine(chart, band.upper, { color: "rgba(14,165,233,0.75)", lineWidth: 1, title: "BB 상단" });
        addLine(chart, band.middle, { color: "rgba(14,165,233,0.35)", lineWidth: 1, lineStyle: LineStyle.Dashed, title: "BB 중심" });
        addLine(chart, band.lower, { color: "rgba(14,165,233,0.75)", lineWidth: 1, title: "BB 하단" });
      }
      if (overlays.vwap) {
        addLine(chart, rollingVwap(candles), { color: "#06b6d4", lineWidth: 2, lineStyle: LineStyle.Dashed, title: "VWAP" });
      }
      if (overlays.volume) {
        const volumeSeries = chart.addHistogramSeries({
          priceFormat: { type: "volume" },
          priceScaleId: "volume",
          lastValueVisible: false,
          priceLineVisible: false,
        });
        volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
        volumeSeries.setData(candles.map((row) => ({
          time: row.time,
          value: row.volume,
          color: row.close >= row.open ? "rgba(22,163,74,0.40)" : "rgba(220,38,38,0.40)",
        })));
      }
      if (overlays.levels) {
        const lines = [
          { price: analysis.resistance2, color: "#f97316", title: "2차 저항", style: LineStyle.Dotted },
          { price: analysis.resistance1, color: "#dc2626", title: "1차 저항", style: LineStyle.Dashed },
          { price: analysis.support1, color: "#2563eb", title: "1차 지지", style: LineStyle.Dashed },
          { price: analysis.support2, color: "#06b6d4", title: "2차 지지", style: LineStyle.Dotted },
        ];
        for (const line of lines) {
          if (!(line.price > 0)) continue;
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
      if (overlays.arrows) candleSeries.setMarkers(chartMarkers(candles, analysis) as any);

      chart.timeScale().fitContent();
      const observer = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width;
        if (width) chart.applyOptions({ width: Math.max(1, width) });
      });
      observer.observe(container);
      return () => {
        observer.disconnect();
        chart.remove();
      };
    }, [analysis, candles, overlays, timeframe]);

    return <div ref={containerRef} className="h-[390px] w-full" />;
    }

    export function CryptoTradingWorkspace({
    viewMode,
    onViewModeChange,
    onBackToStock,
    }: Props) {
    const assetMode = useAssetMode();
    const [, navigate] = useLocation();
    const auth = useAuth();
    const chartSectionRef = useRef<HTMLElement | null>(null);
    const scannerSectionRef = useRef<HTMLDivElement | null>(null);
    const autoSectionRef = useRef<HTMLElement | null>(null);
    const searchBoxRef = useRef<HTMLDivElement | null>(null);
    const [symbol, setSymbol] = useState(() => {
      if (typeof window === "undefined") return "BTCUSDT";
      return window.localStorage.getItem(SYMBOL_KEY) || "BTCUSDT";
    });
    const [query, setQuery] = useState("");
    const [timeframe, setTimeframe] = useState<Timeframe>("15m");
    const [visibleTimeframes, setVisibleTimeframes] = useState<Timeframe[]>(() => loadVisibleChartTimeframes());
    const [settings, setSettings] = useState<AutoSettings>(() => loadSettings());
    const [executionKey, setExecutionKey] = useState(() => loadExecutionKey());
    const [showExecutionKey, setShowExecutionKey] = useState(false);
    const [executionKeySaved, setExecutionKeySaved] = useState(
      () => Boolean(loadExecutionKey().trim()),
    );
    const [keyVerifying, setKeyVerifying] = useState(false);
    const [pendingPlan, setPendingPlan] = useState<PlanResponse | null>(null);
    const [watchPlan, setWatchPlan] = useState<WatchPlan | null>(null);
    const [planMenuOpen, setPlanMenuOpen] = useState(false);
    const [planViewerOpen, setPlanViewerOpen] = useState(false);
    const [pendingAction, setPendingAction] = useState<"open" | "close" | "configure" | null>(null);
    const [message, setMessage] = useState("");
    const [feed, setFeed] = useState<FeedLine[]>([]);
    const [searchOpen, setSearchOpen] = useState(false);
    const [scannerCategory, setScannerCategory] = useState<ScannerCategory>("strongBuy");
    const [scannerDirection, setScannerDirection] = useState<ScannerDirection>("LONG");
    const [indicatorSettingsOpen, setIndicatorSettingsOpen] = useState(false);
    const [indicatorProfileTab, setIndicatorProfileTab] = useState<IndicatorProfileKey>("minute");
    const [indicatorProfiles, setIndicatorProfiles] = useState<IndicatorProfiles>(() => loadIndicatorProfiles());
    const [selectedScannerRow, setSelectedScannerRow] = useState<ScannerRow | null>(null);
    const [selectedChartExplanation, setSelectedChartExplanation] = useState<{ title: string; body: string } | null>(null);
    const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>(
      () => loadIndicatorProfiles().minute,
    );

    useEffect(() => {
      assetMode.setAsset("coin");
    }, []);

    useEffect(() => {
      const nextSymbol = assetMode.coinMarket === "spot" ? "BTC" : "BTCUSDT";
      setSymbol(nextSymbol);
      setQuery("");
      setPendingPlan(null);
      setWatchPlan(null);
      setSelectedScannerRow(null);
    }, [assetMode.coinMarket]);

    useEffect(() => {
      if (!visibleTimeframes.includes(timeframe)) setTimeframe(visibleTimeframes[0] ?? "1m");
    }, [timeframe, visibleTimeframes]);


    useEffect(() => {
      const closeSearch = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (target && !searchBoxRef.current?.contains(target)) {
          setSearchOpen(false);
        }
      };
      const closeWithEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          setSearchOpen(false);
          setSelectedScannerRow(null);
          setSelectedChartExplanation(null);
        }
      };
      document.addEventListener("pointerdown", closeSearch);
      document.addEventListener("keydown", closeWithEscape);
      return () => {
        document.removeEventListener("pointerdown", closeSearch);
        document.removeEventListener("keydown", closeWithEscape);
      };
    }, []);

    useEffect(() => {
      const profileKey = indicatorProfileForTimeframe(timeframe);
      setIndicatorProfileTab(profileKey);
      setOverlays(indicatorProfiles[profileKey]);
    }, [timeframe, indicatorProfiles]);

    const status = useQuery({
      queryKey: ["crypto-status"],
      queryFn: () => apiGet<AnyObj>("/crypto/status"),
      refetchInterval: 30_000,
    });
    const tickersQuery = useQuery({
      queryKey: ["crypto-tickers-live", assetMode.coinMarket],
      queryFn: () => apiGet<AnyObj>(assetMode.coinMarket === "spot" ? "/crypto/spot/tickers" : "/crypto/futures/tickers"),
      refetchInterval: 8_000,
      refetchIntervalInBackground: true,
    });
    const tickers = useMemo(() => normalizeTickers(tickersQuery.data), [tickersQuery.data]);
    const tickerMap = useMemo(() => new Map(tickers.map((row) => [row.symbol, row])), [tickers]);
    const selectedTicker = tickerMap.get(symbol) ?? null;
    const bitcoinTicker = tickerMap.get("BTCUSDT") ?? null;
    const positiveMarketRatio = tickers.length
      ? tickers.filter((row) => row.changePercent24h > 0).length / tickers.length
      : 0.5;
    const marketBias = clamp(
      (bitcoinTicker?.changePercent24h ?? 0) * 0.8 + (positiveMarketRatio - 0.5) * 12,
      -8,
      8,
    );

    const candlesQuery = useQuery({
      queryKey: ["crypto-candles-live", assetMode.coinMarket, symbol, timeframe],
      queryFn: () => fetchCandles(symbol, timeframe, 300, assetMode.coinMarket),
      enabled: Boolean(symbol),
      refetchInterval: 10_000,
      refetchIntervalInBackground: true,
    });
    const candles = candlesQuery.data ?? [];
    const currentAnalysis = useMemo(
      () => analyze(symbol, candles, selectedTicker, marketBias, settings.minScore),
      [candles, marketBias, selectedTicker, settings.minScore, symbol],
    );

    const scannerSymbols = useMemo(() => {
      // 기술 신호는 캔들 분석 뒤 판정하므로, 먼저 유동성이 높은 종목을 넓게 분석합니다.
      return [...tickers]
        .sort((a, b) => b.tradingValue24h - a.tradingValue24h || b.volume24h - a.volume24h)
        .slice(0, 30)
        .map((row) => row.symbol);
    }, [tickers]);
    const scannerKey = scannerSymbols.join("|");
    const scannerQuery = useQuery({
      queryKey: ["crypto-signal-scanner", assetMode.coinMarket, scannerCategory, timeframe, scannerKey, settings.minScore],
      queryFn: async () => {
        const rows = await Promise.allSettled(
          scannerSymbols.map(async (item) => {
            const rowCandles = item === symbol && candles.length
              ? candles
              : await fetchCandles(item, timeframe, 180, assetMode.coinMarket);
            const ticker = tickerMap.get(item) ?? null;
            const rowAnalysis = analyze(item, rowCandles, ticker, marketBias, settings.minScore);
            return rowAnalysis && ticker ? { ticker, analysis: rowAnalysis } : null;
          }),
        );
        return rows
          .map((row) => row.status === "fulfilled" ? row.value : null)
          .filter((row): row is { ticker: Ticker; analysis: Analysis } => row != null)
          .sort((a, b) => {
            const aScore = Math.max(a.analysis.longScore, a.analysis.shortScore);
            const bScore = Math.max(b.analysis.longScore, b.analysis.shortScore);
            return bScore - aScore || b.ticker.tradingValue24h - a.ticker.tradingValue24h;
          })
          .map((row, index) => ({ ...row, rank: index + 1 } satisfies ScannerRow));
      },
      enabled: scannerSymbols.length > 0,
      refetchInterval: 30_000,
      refetchIntervalInBackground: true,
    });
    const scannerRows = scannerQuery.data ?? [];
    const visibleScannerRows = useMemo(() => {
      const filtered = scannerRows.filter((row) => {
        if (scannerCategory === "pattern") return row.analysis.patterns.length > 0;
        if (scannerCategory === "volumeSignal") return row.analysis.volumeRatio >= 1.5;
        if (scannerCategory === "strongBuy") return row.analysis.longScore >= settings.minScore;
        return row.analysis.shortScore >= settings.minScore;
      });

      const effectiveDirection: ScannerDirection = scannerCategory === "strongSell" ? "SHORT" : scannerCategory === "strongBuy" ? "LONG" : scannerDirection;
      return filtered
        .sort((a, b) => {
          const aScore = effectiveDirection === "LONG" ? a.analysis.longScore : a.analysis.shortScore;
          const bScore = effectiveDirection === "LONG" ? b.analysis.longScore : b.analysis.shortScore;
          const categoryBoostA = scannerCategory === "volumeSignal" ? a.analysis.volumeRatio : a.analysis.patterns.length;
          const categoryBoostB = scannerCategory === "volumeSignal" ? b.analysis.volumeRatio : b.analysis.patterns.length;
          return categoryBoostB - categoryBoostA || bScore - aScore || b.ticker.tradingValue24h - a.ticker.tradingValue24h;
        })
        .slice(0, 10)
        .map((row, index) => ({ ...row, rank: index + 1 }));
    }, [scannerCategory, scannerDirection, scannerRows, settings.minScore]);

    const autoStatus = useQuery({
    queryKey: ["crypto-auto-status", assetMode.coinMarket],
    queryFn: () => getProtected<AnyObj>(assetMode.coinMarket === "spot" ? "/api/crypto/spot/auto/status" : "/api/crypto/futures/auto/status"),
    refetchInterval: 30_000,
    enabled: auth.isAdmin,
    });
    const account = useQuery({
    queryKey: ["crypto-private-account", assetMode.coinMarket],
    queryFn: () => getProtected<AnyObj>(assetMode.coinMarket === "spot" ? "/api/crypto/spot/accounts" : "/api/crypto/futures/account"),
      refetchInterval: 10_000,
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: 1,
    enabled: auth.isAdmin,
    });
    const positionsQuery = useQuery({
      queryKey: ["crypto-futures-positions"],
      queryFn: () => getProtected<AnyObj>("/api/crypto/futures/positions"),
      refetchInterval: 15_000,
      enabled: auth.isAdmin && assetMode.coinMarket === "futures",
    });
    const positions = ((positionsQuery.data?.positions ?? []) as AnyObj[]).map((row) => ({
      symbol: String(row.symbol ?? ""),
      holdSide: String(row.holdSide ?? ""),
      total: numberOf(row.total),
      available: numberOf(row.available),
      openPriceAvg: numberOf(row.openPriceAvg),
      markPrice: numberOf(row.markPrice),
      unrealizedPL: numberOf(row.unrealizedPL),
      liquidationPrice: numberOf(row.liquidationPrice),
      leverage: numberOf(row.leverage),
      marginMode: String(row.marginMode ?? ""),
      marginSize: numberOf(row.marginSize),
      breakEvenPrice: numberOf(row.breakEvenPrice),
    } satisfies Position));

    const filteredTickers = useMemo(() => {
      const needle = query.trim().toLowerCase();
      return [...tickers]
        .filter((row) => !needle || [row.symbol, row.koreanName, row.englishName].some((value) => String(value ?? "").toLowerCase().includes(needle)))
        .sort((a, b) => b.tradingValue24h - a.tradingValue24h)
        .slice(0, 50);
    }, [query, tickers]);

    useEffect(() => {
      if (!currentAnalysis || !settings.monitorEnabled) return;
      const generated = new Date();
      const strongestReasons = currentAnalysis.direction === "LONG"
        ? currentAnalysis.longReasons
        : currentAnalysis.direction === "SHORT"
          ? currentAnalysis.shortReasons
          : [
              `롱 ${currentAnalysis.longScore}점 · 숏 ${currentAnalysis.shortScore}점`,
              "점수 차이가 진입 기준보다 작아 관망",
            ];
      const newLines: FeedLine[] = [
        {
          id: `${currentAnalysis.generatedAt}:signal`,
          at: generated,
          tone: currentAnalysis.direction,
          text: `${symbol} ${directionLabel(currentAnalysis.direction)} 신호 · 롱 ${currentAnalysis.longScore}점 / 숏 ${currentAnalysis.shortScore}점 · 신뢰도 ${currentAnalysis.confidence}`,
        },
        ...strongestReasons.slice(0, 3).map((reason, index) => ({
          id: `${currentAnalysis.generatedAt}:reason:${index}`,
          at: generated,
          tone: currentAnalysis.direction === "WAIT" ? "INFO" as const : currentAnalysis.direction,
          text: reason,
        })),
        {
          id: `${currentAnalysis.generatedAt}:level`,
          at: generated,
          tone: "INFO",
          text: `현재 ${formatPrice(currentAnalysis.currentPrice)} · 지지 ${formatPrice(currentAnalysis.support1)} · 저항 ${formatPrice(currentAnalysis.resistance1)} · 거래량 ${currentAnalysis.volumeRatio.toFixed(1)}배`,
        },
      ];
      setFeed((current) => {
        const existing = new Set(current.map((item) => item.id));
        return [...newLines.filter((item) => !existing.has(item.id)), ...current].slice(0, 60);
      });
    }, [currentAnalysis?.generatedAt, settings.monitorEnabled, symbol]);

    const updateSettings = (patch: Partial<AutoSettings>) => {
      setSettings((current) => saveSettings({ ...current, ...patch }));
      setPendingPlan(null);
    };


    const chooseTimeframe = (next: Timeframe) => {
      setTimeframe(next);
      setPendingPlan(null);
      const profileKey = indicatorProfileForTimeframe(next);
      setIndicatorProfileTab(profileKey);
      setOverlays(indicatorProfiles[profileKey]);
    };

    const toggleVisibleTimeframe = (frame: Timeframe) => {
      setVisibleTimeframes((current) => {
        const next = current.includes(frame) ? current.filter((item) => item !== frame) : [...current, frame];
        const ordered = TIMEFRAMES.filter((item) => next.includes(item.key)).map((item) => item.key);
        const safe = ordered.length ? ordered : [frame];
        saveVisibleChartTimeframes(safe);
        return safe;
      });
    };

    const toggleProfileOverlay = (profileKey: IndicatorProfileKey, key: OverlayKey) => {
      setIndicatorProfiles((current) => {
        const next = saveIndicatorProfiles({
          ...current,
          [profileKey]: {
            ...current[profileKey],
            [key]: !current[profileKey][key],
            },
                });
                if (indicatorProfileForTimeframe(timeframe) === profileKey) {
                  setOverlays(next[profileKey]);
                }
                return next;
              });
            };

            const selectSymbol = (next: string) => {
              const normalized = next.toUpperCase();
              setSymbol(normalized);
              setQuery("");
              setSearchOpen(false);
              setPendingPlan(null);
              if (typeof window !== "undefined") window.localStorage.setItem(SYMBOL_KEY, normalized);
              chartSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
            };

            const changeView = (next: CryptoWorkspaceViewMode) => {
              onViewModeChange(next);
              const target = next === "condition" ? scannerSectionRef.current : next === "chart" ? chartSectionRef.current : autoSectionRef.current;
              window.setTimeout(() => target?.scrollIntoView({ behavior: "smooth", block: "start" }), 10);
            };

            const refreshAll = async () => {
              await Promise.allSettled([
                status.refetch(),
                tickersQuery.refetch(),
                candlesQuery.refetch(),
                scannerQuery.refetch(),
                autoStatus.refetch(),
                account.refetch(),
                positionsQuery.refetch(),
              ]);
            };

            const registerExecutionKey = async () => {
              if (keyVerifying) return;

              const normalized = normalizeExecutionKey(executionKey);
              if (!normalized) {
                setExecutionKeySaved(false);
                saveExecutionKeyToSession("");
                setMessage(
                  "화면 맨 아래에서 자동매매 실행키를 입력하고 Enter를 눌러 확인하세요.",
                );
                return;
              }

              setKeyVerifying(true);
              setExecutionKey(normalized);
              setExecutionKeySaved(false);
              setPendingPlan(null);
              setMessage("서버에 설정된 자동매매 실행키와 일치하는지 확인 중입니다.");

              try {
                await postProtected<AnyObj>(
              assetMode.coinMarket === "spot" ? "/api/crypto/spot/auto/verify-key" : "/api/crypto/futures/auto/verify-key",
                  {},
                  normalized,
                );
                saveExecutionKeyToSession(normalized);
                setExecutionKeySaved(true);
                setMessage(
                  "실행키 확인이 완료됐습니다. 이제 거래소 설정계획과 주문계획에 자동 사용됩니다.",
                );
                await Promise.allSettled([
                  autoStatus.refetch(),
                  account.refetch(),
                  positionsQuery.refetch(),
                ]);
              } catch (error) {
                saveExecutionKeyToSession("");
                setExecutionKeySaved(false);
                setMessage(
                  error instanceof Error
                ? `${error.message} 선택한 거래소의 자동매매 보호키 설정을 확인해 주세요.`
                    : "자동매매 실행키 확인에 실패했습니다.",
                );
              } finally {
                setKeyVerifying(false);
              }
            };

            const createWatchPlan = () => {
              if (!currentAnalysis) {
                setMessage("차트 분석이 완료된 뒤 관망 준비계획서를 만들 수 있습니다.");
                return;
              }
              const plan: WatchPlan = {
                kind: "WATCH",
                symbol,
                timeframe,
                direction: "WAIT",
                longScore: currentAnalysis.longScore,
                shortScore: currentAnalysis.shortScore,
                minimumScore: settings.minScore,
                supportTrigger: currentAnalysis.support1,
                resistanceTrigger: currentAnalysis.resistance1,
                marginAmountUSDT: settings.marginAmountUSDT,
                leverage: settings.leverage,
                stopLossPercent: settings.stopLossPercent,
                targetProfitPercent: settings.targetProfitPercent,
                availableUSDT: accountRow ? numberOf(accountRow.available) : null,
                accountEquityUSDT: accountRow ? numberOf(accountRow.accountEquity) : null,
                reasons: [
                  ...currentAnalysis.longReasons.slice(0, 2),
                  ...currentAnalysis.shortReasons.slice(0, 2),
                ],
                createdAt: new Date().toISOString(),
              };
              setWatchPlan(plan);
              setPendingPlan(null);
              setPlanMenuOpen(false);
              setPlanViewerOpen(true);
              setMessage("관망 준비계획서를 만들었습니다. 실제 주문은 전송되지 않습니다.");
            };

            const openPlanViewer = () => {
              if (!pendingPlan && !watchPlan) {
                setMessage("먼저 계획서를 만들어 주세요.");
                return;
              }
              setPlanMenuOpen(false);
              setPlanViewerOpen(true);
            };

            const buildOpenPlan = async () => {
              if (!currentAnalysis) {
                setMessage("차트 분석이 완료된 뒤 주문계획을 만들 수 있습니다.");
                return null;
              }
              if (currentAnalysis.direction === "WAIT") {
                createWatchPlan();
                return null;
              }
              if (!executionKeySaved || !normalizeExecutionKey(executionKey)) {
                setMessage("화면 맨 아래에서 실행키를 입력하고 Enter를 눌러 서버 확인을 완료하세요.");
                return null;
              }
              setPendingAction("open");
              setMessage("주문 직전 가격·계약규격·보유 포지션을 검사하는 중입니다.");
              try {
                const direction = currentAnalysis.direction;
                const result = await postProtected<PlanResponse>(
              assetMode.coinMarket === "spot" ? "/api/crypto/spot/auto/plan" : "/api/crypto/futures/auto/plan",
              assetMode.coinMarket === "spot"
                ? {
                  symbol,
                  side: direction === "LONG" ? "BUY" : "SELL",
                  totalAmountKRW: settings.spotTotalAmountKRW,
                  stage: 1,
                  score: direction === "LONG" ? currentAnalysis.longScore : currentAnalysis.shortScore,
                  oppositeScore: direction === "LONG" ? currentAnalysis.shortScore : currentAnalysis.longScore,
                }
                : {
                  symbol,
                  direction,
                  positionMode: settings.positionMode,
                  marginMode: settings.marginMode,
                  leverage: settings.leverage,
                  totalMarginAmountUSDT: settings.marginAmountUSDT,
                  stage: 1,
                  score: direction === "LONG" ? currentAnalysis.longScore : currentAnalysis.shortScore,
                  oppositeScore: direction === "LONG" ? currentAnalysis.shortScore : currentAnalysis.longScore,
                  minScore: settings.minScore,
                  stopLossPercent: settings.stopLossPercent,
                  targetProfitPercent: settings.targetProfitPercent,
                  maxOpenPositions: settings.maxOpenPositions,
                  maxDailyOrders: settings.maxDailyOrders,
                  reasons: direction === "LONG" ? currentAnalysis.longReasons : currentAnalysis.shortReasons,
                },
                  executionKey,
                );
                setPendingPlan(result);
                setWatchPlan(null);
                setPlanMenuOpen(false);
                setPlanViewerOpen(true);
                setMessage("주문계획이 생성됐습니다. 작은 계획서 창에서 수량·손절·익절을 확인한 뒤 최종 승인하세요.");
                return result;
              } catch (error) {
                setMessage(error instanceof Error ? error.message : "주문계획 생성 실패");
                return null;
              } finally {
                setPendingAction(null);
              }
            };

            const approveOpen = async () => {
              if (!pendingPlan?.approvalToken) return;
              const confirmed = window.confirm(
              `${String(pendingPlan.plan?.symbol ?? symbol)} ${String(pendingPlan.plan?.direction ?? pendingPlan.plan?.side ?? "")} 주문을 실제 ${assetMode.coinMarket === "spot" ? "업비트" : "비트겟"} 계정으로 전송합니다. 계속하시겠습니까?`,
              );
              if (!confirmed) return;
              setPendingAction("open");
              try {
                const result = await postProtected<AnyObj>(
              assetMode.coinMarket === "spot" ? "/api/crypto/spot/auto/execute" : "/api/crypto/futures/auto/execute",
                  { approvalToken: pendingPlan.approvalToken },
                  executionKey,
                );
                setMessage(String(result.journal?.message ?? "주문이 전송됐습니다."));
                setPlanViewerOpen(false);
                setPendingPlan(null);
                await Promise.allSettled([positionsQuery.refetch(), autoStatus.refetch(), account.refetch()]);
              } catch (error) {
                setMessage(error instanceof Error ? error.message : "주문 전송 실패");
                setPendingPlan(null);
              } finally {
                setPendingAction(null);
              }
            };

            const buildConfigurePlan = async () => {
              if (!executionKeySaved || !normalizeExecutionKey(executionKey)) {
                setMessage("화면 맨 아래에서 실행키를 입력하고 Enter를 눌러 서버 확인을 완료하세요.");
                return;
              }
              setPendingAction("configure");
              try {
                const result = await postProtected<PlanResponse>(
                  "/api/crypto/futures/auto/configure-plan",
                  {
                    symbol,
                    positionMode: settings.positionMode,
                    marginMode: settings.marginMode,
                    leverage: settings.leverage,
                  },
                  executionKey,
                );
                setPendingPlan(result);
                setWatchPlan(null);
                setPlanViewerOpen(true);
                setMessage("거래소 설정계획을 만들었습니다. 작은 창에서 내용을 확인한 뒤 승인하세요.");
              } catch (error) {
                setMessage(error instanceof Error ? error.message : "설정계획 생성 실패");
              } finally {
                setPendingAction(null);
              }
            };

            const approveConfigure = async () => {
              if (!pendingPlan?.approvalToken || pendingPlan.plan?.kind !== "CONFIGURE") return;
              const confirmed = window.confirm("비트겟 포지션 모드·마진 모드·레버리지 설정을 실제 계정에 적용합니다. 계속하시겠습니까?");
              if (!confirmed) return;
              setPendingAction("configure");
              try {
                const result = await postProtected<AnyObj>(
                  "/api/crypto/futures/auto/configure",
                  { approvalToken: pendingPlan.approvalToken },
                  executionKey,
                );
                setMessage(String(result.journal?.message ?? "거래소 설정을 적용했습니다."));
                setPlanViewerOpen(false);
                setPendingPlan(null);
                await Promise.allSettled([autoStatus.refetch(), account.refetch()]);
              } catch (error) {
                setMessage(error instanceof Error ? error.message : "거래소 설정 실패");
                setPendingPlan(null);
              } finally {
                setPendingAction(null);
              }
            };

            const buildClosePlan = async (position: Position) => {
              if (!executionKeySaved || !normalizeExecutionKey(executionKey)) {
                setMessage("화면 맨 아래에서 실행키를 입력하고 Enter를 눌러 서버 확인을 완료하세요.");
                return;
              }
              setPendingAction("close");
              try {
                const result = await postProtected<PlanResponse>(
                  "/api/crypto/futures/auto/close-plan",
                  {
                    symbol: position.symbol,
                    holdSide: position.holdSide,
                    positionMode: settings.positionMode,
                    reason: "사용자 수동 종료 승인",
                  },
                  executionKey,
                );
                setPendingPlan(result);
                setWatchPlan(null);
                setPlanViewerOpen(true);
                setMessage("포지션 종료계획이 생성됐습니다. 작은 창에서 방향과 수량을 확인한 뒤 최종 승인하세요.");
              } catch (error) {
                setMessage(error instanceof Error ? error.message : "종료계획 생성 실패");
              } finally {
                setPendingAction(null);
              }
            };

            const approveClose = async () => {
              if (!pendingPlan?.approvalToken || pendingPlan.plan?.kind !== "CLOSE") return;
              const confirmed = window.confirm(`${String(pendingPlan.plan?.symbol ?? "")} 포지션을 시장가로 종료합니다. 계속하시겠습니까?`);
              if (!confirmed) return;
              setPendingAction("close");
              try {
                const result = await postProtected<AnyObj>(
                  "/api/crypto/futures/auto/close",
                  { approvalToken: pendingPlan.approvalToken },
                  executionKey,
                );
                setMessage(String(result.journal?.message ?? "포지션 종료 요청을 전송했습니다."));
                setPlanViewerOpen(false);
                setPendingPlan(null);
                await Promise.allSettled([positionsQuery.refetch(), autoStatus.refetch(), account.refetch()]);
              } catch (error) {
                setMessage(error instanceof Error ? error.message : "포지션 종료 실패");
                setPendingPlan(null);
              } finally {
                setPendingAction(null);
              }
            };

            const serverConnected = Boolean(assetMode.coinMarket === "spot" ? status.data?.upbit?.ok : status.data?.bitget?.ok);
            const privateConfigured = Boolean(assetMode.coinMarket === "spot" ? status.data?.upbit?.privateKeyConfigured : status.data?.bitget?.privateKeyConfigured);
            const accountRow = ((account.data?.accounts ?? []) as AnyObj[]).find((row) => String(row.marginCoin ?? "").toUpperCase() === "USDT") ?? null;
            const spotKrwAccount = ((account.data?.accounts ?? []) as AnyObj[]).find((row) => String(row.currency ?? "").toUpperCase() === "KRW") ?? null;
            const spotCoinAccount = ((account.data?.accounts ?? []) as AnyObj[]).find((row) => String(row.currency ?? "").toUpperCase() === symbol) ?? null;
            const availableKRW = spotKrwAccount ? numberOf(spotKrwAccount.balance) : null;
            const availableSpotCoin = spotCoinAccount ? numberOf(spotCoinAccount.balance) : null;
            const availableUSDT = accountRow ? numberOf(accountRow.available) : null;
            const accountEquityUSDT = accountRow ? numberOf(accountRow.accountEquity) : null;
            const unrealizedPLUSDT = accountRow ? numberOf(accountRow.unrealizedPL) : null;
            const isolatedAvailableUSDT = accountRow ? numberOf(accountRow.isolatedMaxAvailable) : null;
            const crossedAvailableUSDT = accountRow ? numberOf(accountRow.crossedMaxAvailable) : null;
            const accountUpdatedAt = String(account.data?.updatedAt ?? "");
            const aiTradeView = currentAnalysis ? buildAiTradeView(currentAnalysis, timeframe) : null;
            const selectedScannerPlan = selectedScannerRow ? buildScannerTradePlan(selectedScannerRow.analysis, scannerDirection) : null;
            const planKind = String(pendingPlan?.plan?.kind ?? watchPlan?.kind ?? "");

            return (
              <div className="h-full overflow-y-auto overscroll-contain bg-background">
                <header className="sticky top-0 z-30 border-b border-card-border bg-background/95 px-4 pb-3 pt-4 backdrop-blur">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h1 className="text-xl font-black">차트 · 신호검색 · 자동매매</h1>
                      <p className="mt-1 text-[10px] font-bold text-muted-foreground">{assetMode.coinMarket === "spot" ? "Upbit 원화 현물 · 매수/매도 신호" : "Bitget USDT 선물 · 롱/숏 통합 도구"}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void refreshAll()}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-card"
                    >
                      <RefreshCw className={cn("h-4 w-4", (tickersQuery.isFetching || candlesQuery.isFetching) && "animate-spin")} />
                    </button>
                  </div>

                  <div className={cn('mt-3 grid gap-2', auth.isAdmin ? 'grid-cols-3' : 'grid-cols-2')}>
                    <TopTab active={viewMode === "condition"} onClick={() => changeView("condition")}>신호검색</TopTab>
                    <TopTab active={viewMode === "chart"} onClick={() => changeView("chart")}>차트중계</TopTab>
                    {auth.isAdmin && <TopTab active={viewMode === "auto"} onClick={() => changeView("auto")}>자동매매</TopTab>}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <TopTab active={false} onClick={() => { onBackToStock(); }}>주식</TopTab>
                    <TopTab active onClick={() => undefined}>코인</TopTab>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <TopTab active={assetMode.coinMarket === "spot"} onClick={() => { onViewModeChange("condition"); assetMode.setCoinMarket("spot"); }}>현물 · Upbit</TopTab>
                    <TopTab active={assetMode.coinMarket === "futures"} onClick={() => { onViewModeChange("condition"); assetMode.setCoinMarket("futures"); }}>선물 · Bitget</TopTab>
                  </div>
                </header>

                <main className="space-y-4 px-4 pb-28 pt-4">
                <div ref={scannerSectionRef} className="scroll-mt-4 rounded-3xl border border-card-border bg-card p-4 shadow-sm">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-black text-primary">신호검색기</p>
                        <h2 className="mt-1 text-sm font-black">{assetMode.coinMarket === "spot" ? "매수·매도 상위 후보 10개" : "롱·숏 상위 후보 10개"}</h2>
                        <p className="mt-1 text-[10px] font-bold text-muted-foreground">
                          같은 {TIMEFRAMES.find((item) => item.key === timeframe)?.label} 기준 봉·거래량·보조지표·패턴 종합
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void scannerQuery.refetch()}
                        className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-background"
                      >
                        <RefreshCw className={cn("h-4 w-4", scannerQuery.isFetching && "animate-spin")} />
                      </button>
                    </div>

                    <div className="mt-3 grid grid-cols-4 gap-1.5">
                      {SCANNER_CATEGORIES.map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => { setScannerCategory(item.key); if (item.key === "strongBuy") setScannerDirection("LONG"); if (item.key === "strongSell") setScannerDirection("SHORT"); }}
                          className={cn(
                            "rounded-xl border px-1.5 py-2 text-[10px] font-black",
                            scannerCategory === item.key
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-card-border bg-background text-muted-foreground",
                          )}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>

                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setScannerDirection("LONG")}
                        className={cn(
                          "rounded-xl border px-3 py-2 text-xs font-black",
                          scannerDirection === "LONG"
                            ? "border-positive/30 bg-positive/10 text-positive"
                            : "border-card-border bg-background text-muted-foreground",
                        )}
                      >
                        {assetMode.coinMarket === "spot" ? "매수 후보 10개" : "롱 후보 10개"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setScannerDirection("SHORT")}
                        className={cn(
                          "rounded-xl border px-3 py-2 text-xs font-black",
                          scannerDirection === "SHORT"
                            ? "border-destructive/30 bg-destructive/10 text-destructive"
                            : "border-card-border bg-background text-muted-foreground",
                        )}
                      >
                        {assetMode.coinMarket === "spot" ? "매도 후보 10개" : "숏 후보 10개"}
                      </button>
                    </div>

                    {scannerQuery.isLoading && <LoadingBox text="선택한 순위 코인의 봉을 분석하는 중입니다." />}
                    {scannerQuery.isError && <ErrorBox text={scannerQuery.error instanceof Error ? scannerQuery.error.message : "신호검색 실패"} />}
                    <div className="mt-3 space-y-2">
                      {visibleScannerRows.map((row) => {
                        const score = scannerDirection === "LONG" ? row.analysis.longScore : row.analysis.shortScore;
                        const reasons = scannerDirection === "LONG" ? row.analysis.longReasons : row.analysis.shortReasons;
                        return (
                          <div
                            key={`${scannerDirection}:${row.ticker.symbol}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => setSelectedScannerRow(row)}
                            onKeyDown={(event) => { if (event.key === "Enter") setSelectedScannerRow(row); }}
                            className="flex w-full items-center gap-2 rounded-2xl border border-card-border bg-background p-3 text-center"
                          >
                            <span className="w-7 shrink-0 text-center text-sm font-black text-primary">{row.rank}</span>
                            <div className="flex min-w-0 flex-1 items-center gap-1">
                              <FavoriteButton item={{ ticker: row.ticker.symbol, name: displayCoinName(row.ticker.symbol, row.ticker.koreanName, row.ticker.englishName), market: assetMode.coinMarket === "spot" ? "UPBIT" : "BITGET", currency: assetMode.coinMarket === "spot" ? "KRW" : "USDT" }} />
                              <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-center gap-2">
                                <p className="truncate text-sm font-black">{displayCoinName(row.ticker.symbol, row.ticker.koreanName, row.ticker.englishName)}</p>
                                <span className={cn(
                                  "rounded-full border px-2 py-0.5 text-[9px] font-black",
                                  scannerDirection === "LONG"
                                    ? "border-positive/30 bg-positive/10 text-positive"
                                    : "border-destructive/30 bg-destructive/10 text-destructive",
                                )}>
                                  {scannerDirection === "LONG" ? (assetMode.coinMarket === "spot" ? "매수" : "롱") : (assetMode.coinMarket === "spot" ? "매도" : "숏")}
                                </span>
                              </div>
                              <p className="mt-1 truncate text-[10px] font-bold text-muted-foreground">
                                {row.ticker.symbol} · {reasons[0] ?? "조건 확인 중"}
                              </p>
                            </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1 text-center">
                              <div>
                              <p className={cn(
                                "text-sm font-black",
                                scannerDirection === "LONG" ? "text-positive" : "text-destructive",
                              )}>
                                {score}점
                              </p>
                              <p className="text-[9px] font-bold text-muted-foreground">
                                24시간 {formatPercent(row.ticker.changePercent24h)}
                              </p>
                            </div>
                              <InstrumentAlertButton instrument={{ ticker: row.ticker.symbol, name: displayCoinName(row.ticker.symbol, row.ticker.koreanName, row.ticker.englishName), market: assetMode.coinMarket === "spot" ? "UPBIT" : "BITGET", assetType: assetMode.coinMarket === "spot" ? "coin_spot" : "coin_futures" }} />
                            </div>
                          </div>
                        );
                      })}
                      {!scannerQuery.isLoading && !visibleScannerRows.length && (
                        <p className="rounded-2xl bg-secondary p-4 text-center text-xs font-bold text-muted-foreground">
                          표시할 {scannerDirection === "LONG" ? (assetMode.coinMarket === "spot" ? "매수" : "롱") : (assetMode.coinMarket === "spot" ? "매도" : "숏")} 후보가 없습니다.
                        </p>
                      )}
                    </div>
                  </div>


                  <section ref={chartSectionRef} className="scroll-mt-4 rounded-3xl border border-card-border bg-card p-4 shadow-sm">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-black text-primary">실시간 차트 생중계</p>
                        <h2 className="mt-1 text-lg font-black">{symbol}</h2>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-black">{formatPrice(selectedTicker?.markPrice ?? currentAnalysis?.currentPrice)}</p>
                        <p className={cn("text-xs font-black", (selectedTicker?.changePercent24h ?? 0) >= 0 ? "text-positive" : "text-destructive")}>{formatPercent(selectedTicker?.changePercent24h)}</p>
                      </div>
                </div>
                <button type="button" onClick={() => setSelectedChartExplanation({ title: '실시간 차트', body: `${TIMEFRAMES.find((item) => item.key === timeframe)?.label} 실제 OHLCV 봉을 시간 오름차순으로 표시합니다. 오른쪽이 최신 봉이며 확대·축소와 좌우 이동으로 구간을 확인할 수 있습니다. 지지·저항, 목표·손절, 마커는 값이 산출된 경우에만 표시됩니다.` })} className="mt-2 rounded-full border border-card-border bg-background px-3 py-1.5 text-[10px] font-black text-primary">? 차트 설명</button>

                    <div ref={searchBoxRef} className="relative mt-3">
                      <label className="flex h-11 items-center gap-2 rounded-2xl border border-card-border bg-background px-3">
                        <Search className="h-4 w-4 text-muted-foreground" />
                        <input
                          value={query}
                          onFocus={() => setSearchOpen(true)}
                          onChange={(event) => { setQuery(event.target.value); setSearchOpen(true); }}
                          placeholder="BTCUSDT 등 코인 검색"
                          className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none"
                        />
                        {query && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setQuery("");
                            }}
                            aria-label="검색어 지우기"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            setSearchOpen((current) => !current);
                          }}
                          aria-label={searchOpen ? "코인 검색목록 접기" : "코인 검색목록 펼치기"}
                          className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground"
                        >
                          <ChevronDown className={cn("h-4 w-4 transition-transform", searchOpen && "rotate-180")} />
                        </button>
                      </label>
                      {searchOpen && (
                        <div className="absolute left-0 right-0 top-12 z-30 max-h-72 overflow-y-auto rounded-2xl border border-card-border bg-card p-2 shadow-xl">
                          {filteredTickers.map((row) => (
                            <button
                              key={row.symbol}
                              type="button"
                              onClick={() => selectSymbol(row.symbol)}
                              className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left hover:bg-secondary"
                            >
                              <span className="text-sm font-black">{row.symbol}</span>
                              <span className={cn("text-xs font-black", row.changePercent24h >= 0 ? "text-positive" : "text-destructive")}>{formatPercent(row.changePercent24h)}</span>
                            </button>
                          ))}
                          {!filteredTickers.length && <p className="p-4 text-center text-xs font-bold text-muted-foreground">검색 결과가 없습니다.</p>}
                          <button type="button" onClick={() => setSearchOpen(false)} className="mt-1 w-full rounded-xl bg-secondary px-3 py-2 text-xs font-black">닫기</button>
                        </div>
                      )}
                    </div>

                    <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                      {TIMEFRAMES.filter((item) => visibleTimeframes.includes(item.key)).map((item) => (
                        <button key={`visible-frame:${item.key}`} type="button" onClick={() => chooseTimeframe(item.key)} className={cn("shrink-0 rounded-xl border px-3 py-2 text-xs font-black", timeframe === item.key ? "border-primary bg-primary text-primary-foreground" : "border-card-border bg-background text-muted-foreground")}>{item.label}</button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => setIndicatorSettingsOpen((current) => !current)}
                      className="mt-3 flex w-full items-center justify-between rounded-2xl border border-card-border bg-background px-3 py-2.5 text-left"
                    >
                      <span className="inline-flex items-center gap-2 text-xs font-black">
                        <Settings2 className="h-4 w-4 text-primary" />
                        보조지표·시간봉 환경설정 · {TIMEFRAMES.find((item) => item.key === timeframe)?.label}
                      </span>
                      {indicatorSettingsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>

                    {indicatorSettingsOpen && (
                      <div className="mt-2 rounded-2xl border border-card-border bg-background p-3">
                        <div className="grid grid-cols-3 gap-2">
                          {INDICATOR_PROFILE_TABS.map((item) => (
                            <button
                              key={item.key}
                              type="button"
                              onClick={() => setIndicatorProfileTab(item.key)}
                              className={cn(
                                "rounded-xl border px-2 py-2 text-xs font-black",
                                indicatorProfileTab === item.key
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-card-border bg-card text-muted-foreground",
                              )}
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                        <p className="mt-3 text-[10px] font-bold leading-relaxed text-muted-foreground">
                          분봉·시간봉·일·주봉 선택과 보조지표를 이 환경설정 안에서 각각 저장합니다.
                        </p>
                        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                          {TIMEFRAMES.filter((item) => indicatorProfileForTimeframe(item.key) === indicatorProfileTab).map((item) => (
                            <button
                              key={`frame:${item.key}`}
                              type="button"
                              onClick={() => toggleVisibleTimeframe(item.key)}
                              className={cn(
                                "shrink-0 rounded-xl border px-3 py-2 text-xs font-black",
                                visibleTimeframes.includes(item.key)
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-card-border bg-card text-muted-foreground",
                              )}
                            >
                              {visibleTimeframes.includes(item.key) ? "✓ " : "+ "}{item.label}
                            </button>
                          ))}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {OVERLAYS.map((item) => {
                            const active = indicatorProfiles[indicatorProfileTab][item.key];
                            return (
                    <div key={`${indicatorProfileTab}:${item.key}`} className="flex overflow-hidden rounded-full border border-card-border bg-card">
                    <button
                      type="button"
                      onClick={() => toggleProfileOverlay(indicatorProfileTab, item.key)}
                      className={cn(
                      "px-3 py-1.5 text-[10px] font-black",
                      active
                        ? "bg-primary/10 text-primary"
                        : "bg-card text-muted-foreground",
                      )}
                    >
                      {active ? "✓ " : "+ "}{item.label}
                    </button>
                    <button type="button" onClick={() => setSelectedChartExplanation({ title: item.label, body: OVERLAY_DESCRIPTIONS[item.key] })} className="border-l border-card-border px-2 text-[10px] font-black text-primary" aria-label={`${item.label} 설명`}>?</button>
                    </div>
                            );
                          })}
                        </div>
                        <div className="mt-3 border-t border-card-border pt-3">
                          <p className="text-[10px] font-black text-muted-foreground">현재 {TIMEFRAMES.find((item) => item.key === timeframe)?.label} 패턴 감지</p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {currentAnalysis?.patterns.length ? currentAnalysis.patterns.map((pattern) => (
                              <span
                                key={`setting-pattern:${pattern.key}`}
                                className={cn(
                                  "rounded-full px-2.5 py-1.5 text-[10px] font-black",
                                  pattern.direction === "LONG"
                                    ? "bg-positive/10 text-positive"
                                    : pattern.direction === "SHORT"
                                      ? "bg-destructive/10 text-destructive"
                                      : "bg-secondary text-muted-foreground",
                                )}
                              >
                                {pattern.label}
                              </span>
                            )) : (
                              <span className="rounded-full bg-secondary px-2.5 py-1.5 text-[10px] font-bold text-muted-foreground">감지된 패턴 없음</span>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="mt-3 overflow-hidden rounded-2xl border border-card-border bg-background">
                      {candlesQuery.isLoading && <LoadingBox text="비트겟 봉 데이터를 불러오는 중입니다." />}
                      {candlesQuery.isError && <ErrorBox text={candlesQuery.error instanceof Error ? candlesQuery.error.message : "봉 데이터 조회 실패"} />}
                      {currentAnalysis && candles.length > 0 && (
                        <FuturesChart candles={candles} analysis={currentAnalysis} timeframe={timeframe} overlays={overlays} />
                      )}
                    </div>

                    {currentAnalysis && (
                      <>
                        <div className="mt-3 grid grid-cols-3 gap-1.5">
                          <ScoreCard label="롱" score={currentAnalysis.longScore} active={currentAnalysis.direction === "LONG"} tone="long" />
                          <ScoreCard label="숏" score={currentAnalysis.shortScore} active={currentAnalysis.direction === "SHORT"} tone="short" />
                          <div className={cn("rounded-xl border p-2 text-center", toneClass(currentAnalysis.direction))}>
                            <p className="text-[9px] font-black">종합 신호</p>
                            <p className="mt-0.5 text-base font-black">{directionLabel(currentAnalysis.direction)}</p>
                            <p className="text-[8px] font-bold">{currentAnalysis.confidence}</p>
                          </div>
                        </div>
                        {aiTradeView && (
                          <div className={cn("mt-2 rounded-2xl border p-3", toneClass(currentAnalysis.direction))}>
                            <p className="text-[10px] font-black">{assetMode.coinMarket === "spot" ? "AI 매수·매도 관점" : "AI 롱·숏 관점"}</p>
                            <p className="mt-1 text-sm font-black">{aiTradeView.title}</p>
                            <p className="mt-1 break-keep text-[11px] font-bold leading-5">{aiTradeView.summary}</p>
                          </div>
                        )}
                        <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-bold">
                          <Metric label="RSI" value={currentAnalysis.rsi == null ? "-" : currentAnalysis.rsi.toFixed(1)} />
                          <Metric label="거래량" value={`${currentAnalysis.volumeRatio.toFixed(1)}배`} />
                          <Metric label="ATR 변동성" value={`${currentAnalysis.atrPercent.toFixed(2)}%`} />
                          <Metric label="펀딩비" value={`${((selectedTicker?.fundingRate ?? 0) * 100).toFixed(4)}%`} />
                          <Metric label="1차 지지" value={formatPrice(currentAnalysis.support1)} />
                          <Metric label="1차 저항" value={formatPrice(currentAnalysis.resistance1)} />
                        </div>
                        </>
                          )}

                        </section>

                        <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-[10px] font-black text-primary">AI 차트 실시간 생중계</p>
                              <h2 className="mt-1 text-sm font-black">봉·거래량·지표·패턴 변화</h2>
                            </div>
                            <button
                              type="button"
                              onClick={() => updateSettings({ monitorEnabled: !settings.monitorEnabled })}
                              className={cn("flex items-center gap-1 rounded-xl px-3 py-2 text-xs font-black", settings.monitorEnabled ? "bg-positive/10 text-positive" : "bg-secondary text-muted-foreground")}
                            >
                              {settings.monitorEnabled ? <CirclePlay className="h-4 w-4" /> : <CirclePause className="h-4 w-4" />}
                              {settings.monitorEnabled ? "생중계 중" : "일시정지"}
                            </button>
                          </div>
                          <div className="mt-3 max-h-72 space-y-2 overflow-y-auto rounded-2xl bg-background p-3">
                            {feed.map((item) => (
                              <div key={item.id} className="flex gap-2 text-[11px] font-bold leading-relaxed">
                                <span className="shrink-0 text-muted-foreground">{item.at.toLocaleTimeString("ko-KR", { hour12: false })}</span>
                                <span className={cn(item.tone === "LONG" && "text-positive", item.tone === "SHORT" && "text-destructive", (item.tone === "WAIT" || item.tone === "INFO") && "text-foreground")}>{item.text}</span>
                              </div>
                            ))}
                            {!feed.length && <p className="p-4 text-center text-xs font-bold text-muted-foreground">봉 데이터를 받은 뒤 분석 생중계가 시작됩니다.</p>}
                          </div>
                        </section>

                        {auth.isAdmin && <><section ref={autoSectionRef} className="scroll-mt-4 rounded-3xl border border-card-border bg-card p-4 shadow-sm">
                          <div className="flex items-center gap-2">
                            <ShieldAlert className="h-5 w-5 text-warning" />
                            <div>
                        <p className="text-[10px] font-black text-primary">{assetMode.coinMarket === "spot" ? "업비트 현물 자동매매" : "비트겟 선물 자동매매"}</p>
                        <h2 className="mt-1 text-sm font-black">{assetMode.coinMarket === "spot" ? "매수·매도 주문 안전설정" : "롱·숏 주문 안전설정"}</h2>
                            </div>
                          </div>

                          <div className="mt-3 grid grid-cols-2 gap-2">
                        {assetMode.coinMarket === "spot" ? (
                        <NumberField label="총 거래금액" value={settings.spotTotalAmountKRW} min={5000} max={100000000} step={10000} suffix="원" onChange={(value) => updateSettings({ spotTotalAmountKRW: clamp(Math.round(value), 5000, 100000000) })} />
                        ) : (
                        <>
                        <SelectField label="포지션 모드" value={settings.positionMode} onChange={(value) => updateSettings({ positionMode: value as PositionMode })} options={[{ value: "one_way_mode", label: "단방향" }, { value: "hedge_mode", label: "헤지" }]} />
                        <SelectField label="마진 모드" value={settings.marginMode} onChange={(value) => updateSettings({ marginMode: value as MarginMode })} options={[{ value: "isolated", label: "격리" }, { value: "crossed", label: "교차" }]} />
                        <NumberField label="레버리지" value={settings.leverage} min={1} max={20} step={1} suffix="배" onChange={(value) => updateSettings({ leverage: clamp(Math.round(value), 1, 20) })} />
                        <NumberField label="총 진입금액" value={settings.marginAmountUSDT} min={5} max={500} step={1} suffix="USDT" onChange={(value) => updateSettings({ marginAmountUSDT: clamp(value, 5, 500) })} />
                        </>
                        )}
                            <NumberField label="최소 신호점수" value={settings.minScore} min={50} max={95} step={1} suffix="점" onChange={(value) => updateSettings({ minScore: clamp(Math.round(value), 50, 95) })} />
                            <NumberField label="손절률" value={settings.stopLossPercent} min={0.2} max={15} step={0.1} suffix="%" onChange={(value) => updateSettings({ stopLossPercent: clamp(value, 0.2, 15) })} />
                            <NumberField label="목표 수익률" value={settings.targetProfitPercent} min={0.2} max={50} step={0.1} suffix="%" onChange={(value) => updateSettings({ targetProfitPercent: clamp(value, 0.2, 50) })} />
                        {assetMode.coinMarket === "futures" && <NumberField label="최대 동시보유" value={settings.maxOpenPositions} min={1} max={20} step={1} suffix="개" onChange={(value) => updateSettings({ maxOpenPositions: clamp(Math.round(value), 1, 20) })} />}
                        {assetMode.coinMarket === "futures" && <NumberField label="하루 신규주문" value={settings.maxDailyOrders} min={1} max={100} step={1} suffix="회" onChange={(value) => updateSettings({ maxDailyOrders: clamp(Math.round(value), 1, 100) })} />}
                          </div>

                          <p className="mt-3 rounded-2xl bg-secondary/70 px-3 py-2 text-[10px] font-bold leading-relaxed text-muted-foreground">
                            실행키는 화면 맨 아래의 보호키 입력칸에서 한 번 입력하고 Enter를 누르면 이 브라우저 탭에서 자동 사용됩니다.
                          </p>

                          <div className="mt-3 grid grid-cols-2 gap-2">
                        {assetMode.coinMarket === "futures" && <button
                        type="button"
                              onClick={() => void buildConfigurePlan()}
                              disabled={pendingAction != null}
                              className="rounded-2xl border border-card-border bg-background px-3 py-3 text-xs font-black disabled:opacity-50"
                        >
                        거래소 설정계획
                        </button>}
                        <button
                              type="button"
                              onClick={() => setPlanMenuOpen((current) => !current)}
                              disabled={pendingAction != null || !currentAnalysis}
                        className={cn("rounded-2xl bg-primary px-3 py-3 text-xs font-black text-primary-foreground disabled:opacity-50", assetMode.coinMarket === "spot" && "col-span-2")}
                            >
                              {currentAnalysis?.direction === "WAIT"
                                ? "관망 준비계획서"
                                : `${directionLabel(currentAnalysis?.direction ?? "WAIT")} 주문계획`}
                            </button>
                          </div>

                          {planMenuOpen && (
                            <div className="mt-2 grid grid-cols-2 gap-2 rounded-2xl border border-primary/20 bg-primary/5 p-2">
                              <button
                                type="button"
                                onClick={() => void (currentAnalysis?.direction === "WAIT" ? createWatchPlan() : buildOpenPlan())}
                                disabled={pendingAction != null}
                                className="inline-flex items-center justify-center gap-1 rounded-xl bg-primary px-3 py-2.5 text-xs font-black text-primary-foreground disabled:opacity-50"
                              >
                                <CirclePlay className="h-4 w-4" />
                                {pendingAction === "open" ? "만드는 중" : "만들기"}
                              </button>
                              <button
                                type="button"
                                onClick={openPlanViewer}
                                className="inline-flex items-center justify-center gap-1 rounded-xl border border-card-border bg-background px-3 py-2.5 text-xs font-black"
                              >
                                <FileText className="h-4 w-4" /> 보기
                              </button>
                            </div>
                          )}

                          <div className="mt-2 space-y-1 rounded-2xl bg-background p-3 text-[10px] font-bold leading-relaxed text-muted-foreground">
                            <p><strong className="text-foreground">거래소 설정계획</strong> · 비트겟의 포지션 모드, 격리·교차 마진, 레버리지를 실제 계정에 적용하기 전에 확인하는 계획입니다. 매수·매도 주문은 아닙니다.</p>
                            <p><strong className="text-foreground">관망 준비계획서</strong> · 현재 방향이 관망일 때 롱 돌파선, 숏 이탈선, 손절·목표·증거금 기준만 정리합니다. 실제 주문은 전송하지 않습니다.</p>
                          </div>

                          {message && <p className="mt-3 break-keep rounded-2xl bg-secondary px-3 py-2 text-[11px] font-bold leading-relaxed text-muted-foreground">{message}</p>}

                          <div className="mt-3 flex items-center justify-between gap-2">
                        <p className="text-[10px] font-black text-primary">{assetMode.coinMarket === "spot" ? "업비트 실제 계좌 실시간 반영" : "비트겟 실제 계좌 실시간 반영"}</p>
                            <button
                              type="button"
                              onClick={() => void account.refetch()}
                              className="inline-flex items-center gap-1 rounded-full border border-card-border bg-background px-2.5 py-1.5 text-[9px] font-black"
                            >
                              <RefreshCw className={cn("h-3 w-3", account.isFetching && "animate-spin")} /> 계좌갱신
                            </button>
                          </div>
                          {account.isError && (
                            <p className="mt-2 rounded-2xl bg-destructive/10 p-3 text-[10px] font-bold text-destructive">
                              {account.error instanceof Error ? account.error.message : "실제 비트겟 계좌 조회에 실패했습니다."}
                            </p>
                          )}
                          <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] font-bold">
                        {assetMode.coinMarket === "spot" ? (
                        <>
                        <Metric label="주문가능 원화" value={availableKRW == null ? (account.isFetching ? "조회 중" : "조회 필요") : `${formatPrice(availableKRW)} 원`} />
                        <Metric label={`${symbol} 주문가능`} value={availableSpotCoin == null ? "보유 없음" : formatPrice(availableSpotCoin)} />
                        <Metric label="총 거래금액" value={`${formatPrice(settings.spotTotalAmountKRW)} 원`} />
                        <Metric label="최근 기록" value={`${((autoStatus.data?.latestJournal ?? []) as AnyObj[]).length}건`} />
                        </>
                        ) : (
                        <>
                        <Metric label="실제 USDT 사용가능" value={availableUSDT == null ? (account.isFetching ? "조회 중" : "조회 필요") : `${formatPrice(availableUSDT)} USDT`} />
                        <Metric label="실제 계좌 평가" value={accountEquityUSDT == null ? (account.isFetching ? "조회 중" : "조회 필요") : `${formatPrice(accountEquityUSDT)} USDT`} />
                        <Metric label="미실현 손익" value={unrealizedPLUSDT == null ? "조회 필요" : `${formatPrice(unrealizedPLUSDT)} USDT`} />
                        <Metric label={settings.marginMode === "isolated" ? "격리 사용가능" : "교차 사용가능"} value={`${formatPrice(settings.marginMode === "isolated" ? isolatedAvailableUSDT : crossedAvailableUSDT)} USDT`} />
                        <Metric label="현재 보유" value={`${positions.length}/${settings.maxOpenPositions}개`} />
                        <Metric label="오늘 주문" value={`${numberOf(autoStatus.data?.todayOrders)}/${settings.maxDailyOrders}회`} />
                        </>
                        )}
                          </div>
                          {accountUpdatedAt && (
                            <p className="mt-2 text-right text-[9px] font-bold text-muted-foreground">계좌 기준시각 · {new Date(accountUpdatedAt).toLocaleTimeString("ko-KR")}</p>
                          )}
                        </section>

                        {assetMode.coinMarket === "futures" && <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-[10px] font-black text-primary">실제 포지션</p>
                              <h2 className="mt-1 text-sm font-black">비트겟 보유 롱·숏</h2>
                            </div>
                            <span className="text-xs font-black text-primary">{positions.length}개</span>
                          </div>
                          {positionsQuery.isLoading && <LoadingBox text="보유 포지션을 조회하는 중입니다." />}
                          {positionsQuery.isError && <ErrorBox text={positionsQuery.error instanceof Error ? positionsQuery.error.message : "포지션 조회 실패"} />}
                          <div className="mt-3 space-y-2">
                            {positions.map((position) => {
                              const long = position.holdSide === "long" || (position.holdSide !== "short" && position.total > 0);
                              return (
                                <div key={`${position.symbol}:${position.holdSide}`} className="rounded-2xl border border-card-border bg-background p-3">
                                  <div className="flex items-center justify-between gap-3">
                                    <div>
                                      <div className="flex items-center gap-2">
                                        <p className="text-sm font-black">{position.symbol}</p>
                                        <span className={cn("rounded-full px-2 py-0.5 text-[9px] font-black", long ? "bg-positive/10 text-positive" : "bg-destructive/10 text-destructive")}>{long ? "롱" : "숏"}</span>
                                      </div>
                                      <p className="mt-1 text-[10px] font-bold text-muted-foreground">수량 {formatPrice(Math.abs(position.total))} · 진입 {formatPrice(position.openPriceAvg)} · {position.leverage}배</p>
                                    </div>
                                    <div className="text-right">
                                      <p className={cn("text-sm font-black", position.unrealizedPL >= 0 ? "text-positive" : "text-destructive")}>{formatPrice(position.unrealizedPL)} USDT</p>
                                      <button
                                        type="button"
                                        onClick={() => void buildClosePlan(position)}
                                        disabled={pendingAction != null}
                                        className="mt-1 rounded-xl border border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] font-black text-destructive disabled:opacity-50"
                                      >
                                        종료계획
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                            {!positionsQuery.isLoading && !positions.length && <p className="rounded-2xl bg-secondary p-4 text-center text-xs font-bold text-muted-foreground">현재 보유 중인 비트겟 선물 포지션이 없습니다.</p>}
                          </div>
                        </section>}

                        <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="h-4 w-4 text-positive" />
                            <h2 className="text-sm font-black">최근 자동매매 기록</h2>
                          </div>
                          <div className="mt-3 space-y-2">
                            {((autoStatus.data?.latestJournal ?? []) as AnyObj[]).map((entry) => (
                              <div key={String(entry.id)} className="rounded-2xl bg-background p-3 text-[10px] font-bold">
                                <div className="flex items-center justify-between gap-2">
                          <span>{String(entry.symbol)} · {String(entry.action ?? entry.side)}{entry.stage ? ` · ${String(entry.stage)}차` : ''}</span>
                                  <span className={entry.status === "SUCCESS" ? "text-positive" : "text-destructive"}>{String(entry.status)}</span>
                                </div>
                                <p className="mt-1 text-muted-foreground">{String(entry.message)}</p>
                                <p className="mt-1 text-[9px] text-muted-foreground">{new Date(String(entry.createdAt)).toLocaleString("ko-KR")}</p>
                              </div>
                            ))}
                            {!((autoStatus.data?.latestJournal ?? []) as AnyObj[]).length && <p className="rounded-2xl bg-secondary p-4 text-center text-xs font-bold text-muted-foreground">아직 자동매매 기록이 없습니다.</p>}
                          </div>
                        </section>


                        <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
                          <div>
                            <p className="text-[10px] font-black text-primary">매매기록 하단 환경</p>
                        <h2 className="mt-1 text-sm font-black">{assetMode.coinMarket === "spot" ? "업비트" : "비트겟"} 연결·주문 상태</h2>
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2 text-center text-[11px] font-black">
                        <StatusPill ok={serverConnected} label={`${assetMode.coinMarket === "spot" ? "UPBIT" : "BITGET"} 시세 · ${serverConnected ? "정상" : "오류"}`} />
                            <StatusPill ok={privateConfigured} label={`개인 API · ${privateConfigured ? "설정" : "미설정"}`} />
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2 text-center text-[11px] font-black">
                        <StatusPill ok={Boolean(autoStatus.data?.serverTradingEnabled ?? autoStatus.data?.enabled)} label={`서버 실주문 · ${(autoStatus.data?.serverTradingEnabled ?? autoStatus.data?.enabled) ? "켜짐" : "꺼짐"}`} />
                            <StatusPill ok={Boolean(autoStatus.data?.executionKeyConfigured)} label={`보호키 · ${autoStatus.data?.executionKeyConfigured ? "설정" : "미설정"}`} />
                          </div>
                          <div className="mt-3 rounded-2xl border border-card-border bg-background p-3">
                            <div className="flex items-center gap-2">
                              <KeyRound className="h-4 w-4 text-primary" />
                              <div>
                                <p className="text-[10px] font-black">자동매매 실행키 등록</p>
                                <p className="mt-0.5 text-[9px] font-bold text-muted-foreground">입력 후 Enter를 누르면 서버 키와 일치 여부를 확인하고 이 탭에 저장합니다.</p>
                              </div>
                            </div>
                            <div className="relative mt-2">
                              <input
                                type={showExecutionKey ? "text" : "password"}
                                value={executionKey}
                                onChange={(event) => {
                                  setExecutionKey(event.target.value);
                                  setExecutionKeySaved(false);
                                  setPendingPlan(null);
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    void registerExecutionKey();
                                  }
                                }}
                                placeholder="CRYPTO_AUTO_TRADE_KEY 입력 후 Enter"
                                autoComplete="off"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                                enterKeyHint="done"
                                className="h-11 w-full rounded-xl border border-card-border bg-card px-3 pr-12 text-sm font-bold outline-none focus:border-primary"
                              />
                              <button
                                type="button"
                                onClick={() => setShowExecutionKey((current) => !current)}
                                aria-label={showExecutionKey ? "실행키 숨기기" : "실행키 보기"}
                                className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground"
                              >
                                {showExecutionKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                              </button>
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-2">
                              <span className={cn("text-[10px] font-black", executionKeySaved ? "text-positive" : "text-muted-foreground")}>
                                {keyVerifying
                                  ? "서버 확인 중..."
                                  : executionKeySaved
                                    ? "✓ 서버 확인 완료"
                                    : "Enter를 눌러 확인"}
                              </span>
                              <button
                                type="button"
                                onClick={() => void registerExecutionKey()}
                                disabled={keyVerifying}
                                className="rounded-full bg-primary px-3 py-1.5 text-[10px] font-black text-primary-foreground disabled:opacity-50"
                              >
                                {keyVerifying ? "확인 중" : "확인"}
                              </button>
                            </div>
                          </div>
                          <p className="mt-3 rounded-2xl bg-warning/10 p-3 text-[11px] font-bold leading-relaxed text-warning">
                            차트와 신호는 자동 갱신되지만 실제 주문은 주문계획 생성 → 수량·손절·익절 확인 → 10분 승인 토큰의 2단계 승인으로만 전송됩니다.
                          </p>
                        </section></>}
                        </main>

                        {selectedChartExplanation && (
                        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-5 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`${selectedChartExplanation.title} 설명`} onMouseDown={(event) => { if (event.currentTarget === event.target) setSelectedChartExplanation(null); }}>
                        <section className="w-full max-w-sm rounded-3xl border border-card-border bg-card p-4 shadow-2xl">
                        <div className="flex items-center justify-between gap-3">
                        <h2 className="text-left text-base font-black">{selectedChartExplanation.title}</h2>
                        <button type="button" onClick={() => setSelectedChartExplanation(null)} className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary" aria-label="설명 닫기"><X className="h-4 w-4" /></button>
                        </div>
                        <p className="mt-3 break-keep text-left text-sm font-bold leading-relaxed text-muted-foreground">{selectedChartExplanation.body}</p>
                        </section>
                        </div>
                        )}

                        {selectedScannerRow && (
                        <div
                          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-5 backdrop-blur-sm"
                          role="dialog"
                          aria-modal="true"
                          aria-labelledby="crypto-signal-detail-title"
                          onMouseDown={(event) => {
                            if (event.currentTarget === event.target) setSelectedScannerRow(null);
                          }}
                        >
                          <div className="max-h-[82vh] w-full max-w-sm overflow-y-auto rounded-3xl border border-card-border bg-card p-4 text-center shadow-2xl">
                            <div className="flex items-start justify-between gap-3 text-left">
                              <div className="min-w-0">
                                <p className="text-[10px] font-black text-primary">{assetMode.coinMarket === "spot" ? "Upbit 현물" : "Bitget 선물"} · {TIMEFRAMES.find((item) => item.key === timeframe)?.label}</p>
                                <h2 id="crypto-signal-detail-title" className="mt-1 truncate text-base font-black">
                                  {displayCoinName(selectedScannerRow.ticker.symbol, selectedScannerRow.ticker.koreanName, selectedScannerRow.ticker.englishName)} · {scannerDirection === "LONG" ? (assetMode.coinMarket === "spot" ? "매수" : "롱") : (assetMode.coinMarket === "spot" ? "매도" : "숏")} {scannerDirection === "LONG" ? selectedScannerRow.analysis.longScore : selectedScannerRow.analysis.shortScore}점
                                </h2>
                              </div>
                              <button type="button" aria-label="신호 설명 닫기" onClick={() => setSelectedScannerRow(null)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary"><X className="h-4 w-4" /></button>
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-2">
                              <Metric label="신뢰도" value={selectedScannerRow.analysis.confidence} />
                              <Metric label="거래량" value={`${selectedScannerRow.analysis.volumeRatio.toFixed(2)}배`} />
                              <Metric label="RSI" value={selectedScannerRow.analysis.rsi == null ? "산출 불가" : selectedScannerRow.analysis.rsi.toFixed(1)} />
                              <Metric label="변동성(ATR)" value={`${selectedScannerRow.analysis.atrPercent.toFixed(2)}%`} />
                            </div>
                            <section className="mt-3 rounded-2xl bg-secondary/70 p-3 text-left">
                              <h3 className="text-xs font-black">판단 근거</h3>
                              <div className="mt-2 space-y-1">
                                {(scannerDirection === "LONG" ? selectedScannerRow.analysis.longReasons : selectedScannerRow.analysis.shortReasons).map((reason, index) => (
                                  <p key={`${reason}:${index}`} className="break-keep text-[11px] font-bold leading-relaxed text-muted-foreground">· {reason}</p>
                                ))}
                              </div>
                            </section>
                            <section className="mt-2 rounded-2xl bg-secondary/70 p-3 text-left">
                              <h3 className="text-xs font-black">패턴·위험</h3>
                              <p className="mt-1 break-keep text-[11px] font-bold leading-relaxed text-muted-foreground">
                                {selectedScannerRow.analysis.patterns.length
                                  ? selectedScannerRow.analysis.patterns.map((pattern) => pattern.label).join(" · ")
                                  : "현재 선택 구간에서 신뢰 기준을 충족한 패턴이 없습니다."}
                              </p>
                              <p className="mt-1 break-keep text-[11px] font-bold leading-relaxed text-destructive">
                                지지 {formatPrice(selectedScannerRow.analysis.support1)} 이탈 또는 저항 {formatPrice(selectedScannerRow.analysis.resistance1)} 부근 반전 가능성을 함께 확인하세요.
                              </p>
                            </section>
                            {selectedScannerPlan && (
                              <>
                                <section className="mt-2 rounded-2xl border border-card-border bg-background p-3 text-left">
                                  <div className="flex items-center justify-between gap-2">
                                    <h3 className="text-xs font-black">진입·목표 계획</h3>
                                    <span className="rounded-full bg-secondary px-2 py-1 text-[9px] font-black text-muted-foreground">
                                      손익비 {selectedScannerPlan.rewardRisk == null ? "산출 불가" : `1:${selectedScannerPlan.rewardRisk.toFixed(2)}`}
                                    </span>
                                  </div>
                                  <div className="mt-2 grid grid-cols-2 gap-2">
                                    <Metric label={assetMode.coinMarket === "spot" ? "진입 기준가" : `${scannerDirection === "LONG" ? "롱" : "숏"} 진입 기준가`} value={formatPrice(selectedScannerPlan.entry)} />
                                    <Metric label="최종 목표가" value={formatPrice(selectedScannerPlan.target)} />
                                    <Metric label="손절가" value={formatPrice(selectedScannerPlan.stop)} />
                                    <Metric label="신호 무효화" value={selectedScannerPlan.invalidation} />
                                  </div>
                                </section>

                                <section className="mt-2 grid grid-cols-2 gap-2 text-left">
                                  <div className="rounded-2xl bg-positive/10 p-3">
                                    <h3 className="text-xs font-black text-positive">{assetMode.coinMarket === "spot" ? (scannerDirection === "LONG" ? "분할매수" : "분할매도 진입") : "분할진입"}</h3>
                                    {selectedScannerPlan.entries.map((price, index) => (
                                      <p key={`entry:${index}`} className="mt-2 flex items-center justify-between text-[11px] font-bold"><span>{index + 1}차</span><strong>{formatPrice(price)}</strong></p>
                                    ))}
                                  </div>
                                  <div className="rounded-2xl bg-primary/10 p-3">
                                    <h3 className="text-xs font-black text-primary">{assetMode.coinMarket === "spot" ? (scannerDirection === "LONG" ? "분할매도" : "분할청산") : "분할청산"}</h3>
                                    {selectedScannerPlan.exits.map((price, index) => (
                                      <p key={`exit:${index}`} className="mt-2 flex items-center justify-between text-[11px] font-bold"><span>{index + 1}차</span><strong>{formatPrice(price)}</strong></p>
                                    ))}
                                  </div>
                                </section>
                              </>
                            )}

                            <div className="mt-3 grid grid-cols-2 gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  const params = new URLSearchParams({
                                    asset: "coin",
                                    coinMarket: assetMode.coinMarket,
                                    symbol: selectedScannerRow.ticker.symbol,
                                  });
                                  setSelectedScannerRow(null);
                                  navigate(`/stock-info?${params.toString()}`);
                                }}
                                className="rounded-2xl border border-card-border bg-background px-3 py-3 text-xs font-black"
                              >
                                종목 보기
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  selectSymbol(selectedScannerRow.ticker.symbol);
                                  setSelectedScannerRow(null);
                                  changeView("chart");
                                }}
                                className="rounded-2xl bg-primary px-3 py-3 text-xs font-black text-primary-foreground"
                              >
                                차트 보기
                              </button>
                            </div>
                          </div>
                        </div>
                        )}

                        {planViewerOpen && (pendingPlan || watchPlan) && (
                        <div
                          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-5 backdrop-blur-sm"
                          role="dialog"
                          aria-modal="true"
                          aria-label="자동매매 계획서 보기"
                          onMouseDown={(event) => {
                            if (event.currentTarget === event.target) setPlanViewerOpen(false);
                          }}
                        >
                          <div className="max-h-[78vh] w-full max-w-sm overflow-y-auto rounded-3xl border border-card-border bg-card p-4 shadow-2xl">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="text-[10px] font-black text-primary">계획서 보기</p>
                                <h2 className="mt-1 text-base font-black">
                                  {planKind === "WATCH" ? "관망 준비계획서" : planKind === "CONFIGURE" ? "거래소 설정계획" : planKind === "CLOSE" ? "포지션 종료계획" : "롱·숏 주문계획"}
                                </h2>
                              </div>
                              <button
                                type="button"
                                onClick={() => setPlanViewerOpen(false)}
                                className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary"
                                aria-label="계획서 닫기"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>

                            {planKind === "WATCH" && watchPlan && (
                              <div className="mt-3 space-y-3">
                                <div className="grid grid-cols-2 gap-2 text-[10px] font-bold">
                                  <Metric label="종목·기준봉" value={`${watchPlan.symbol} · ${TIMEFRAMES.find((item) => item.key === watchPlan.timeframe)?.label}`} />
                                  <Metric label="롱·숏 점수" value={`${watchPlan.longScore} / ${watchPlan.shortScore}`} />
                                  <Metric label="롱 준비선" value={`저항 ${formatPrice(watchPlan.resistanceTrigger)} 돌파`} />
                                  <Metric label="숏 준비선" value={`지지 ${formatPrice(watchPlan.supportTrigger)} 이탈`} />
                                  <Metric label="증거금·레버리지" value={`${formatPrice(watchPlan.marginAmountUSDT)} USDT · ${watchPlan.leverage}배`} />
                                  <Metric label="손절·목표" value={`${watchPlan.stopLossPercent}% / ${watchPlan.targetProfitPercent}%`} />
                                  <Metric label="실제 사용가능" value={watchPlan.availableUSDT == null ? "조회 필요" : `${formatPrice(watchPlan.availableUSDT)} USDT`} />
                                  <Metric label="실제 계좌평가" value={watchPlan.accountEquityUSDT == null ? "조회 필요" : `${formatPrice(watchPlan.accountEquityUSDT)} USDT`} />
                                </div>
                                <div className="rounded-2xl bg-secondary/70 p-3">
                                  <p className="text-[10px] font-black">관망 이유와 준비조건</p>
                                  <div className="mt-2 space-y-1">
                                    {watchPlan.reasons.map((reason, index) => (
                                      <p key={`watch-reason:${index}`} className="text-[10px] font-bold leading-relaxed text-muted-foreground">· {reason}</p>
                                    ))}
                                  </div>
                                </div>
                                <p className="rounded-2xl bg-warning/10 p-3 text-[10px] font-bold leading-relaxed text-warning">
                                  관망 준비계획서는 주문이 아닙니다. 롱 돌파 또는 숏 이탈 조건이 실제로 발생한 뒤 새 주문계획을 만들어야 합니다.
                                </p>
                              </div>
                            )}

                            {planKind === "OPEN" && pendingPlan && (
                              <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-bold">
                        <Metric label="종목·방향" value={`${String(pendingPlan.plan.symbol)} · ${String(pendingPlan.plan.direction ?? pendingPlan.plan.side)}`} />
                        <Metric label="마크가격" value={formatPrice(numberOf(pendingPlan.plan.currentPrice))} />
                        {assetMode.coinMarket === "spot"
                          ? <Metric label="단계 거래금액" value={`${formatPrice(numberOf(pendingPlan.plan.stageAmountKRW))} 원`} />
                          : <Metric label="증거금·레버리지" value={`${formatPrice(numberOf(pendingPlan.plan.marginAmountUSDT))} USDT · ${numberOf(pendingPlan.plan.leverage)}배`} />}
                                <Metric label="분할 단계" value={`${numberOf(pendingPlan.plan.stage)}차 · 총액의 ${numberOf(pendingPlan.plan.stageRatio)}%`} />
                                <Metric label="진입 비율" value={Array.isArray(pendingPlan.plan.allocation?.entryRatios) ? `${pendingPlan.plan.allocation.entryRatios.join(' / ')}%` : '산출 불가'} />
                                <Metric label="청산 비율" value={Array.isArray(pendingPlan.plan.allocation?.exitRatios) ? `${pendingPlan.plan.allocation.exitRatios.join(' / ')}%` : '산출 불가'} />
                                <Metric label="조정 위험도" value={pendingPlan.plan.allocation?.adjustedRiskScore == null ? '산출 불가' : `${numberOf(pendingPlan.plan.allocation.adjustedRiskScore)}점 · ${String(pendingPlan.plan.allocation.riskBand)}`} />
                        <Metric label="주문 수량" value={String(pendingPlan.plan.sizeText ?? pendingPlan.plan.size ?? pendingPlan.plan.orderVolume ?? (pendingPlan.plan.side === 'BUY' ? '금액주문' : '산출 불가'))} />
                        {assetMode.coinMarket === "futures" && <Metric label="손절가" value={formatPrice(numberOf(pendingPlan.plan.stopPrice))} />}
                        {assetMode.coinMarket === "futures" && <Metric label="익절가" value={formatPrice(numberOf(pendingPlan.plan.targetPrice))} />}
                              </div>
                            )}

                            {planKind === "CLOSE" && pendingPlan && (
                              <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-bold">
                                <Metric label="종목" value={String(pendingPlan.plan.symbol)} />
                                <Metric label="방향" value={String(pendingPlan.plan.holdSide ?? "단방향 전체")} />
                                <Metric label="수량" value={formatPrice(numberOf(pendingPlan.plan.positionSize))} />
                                <Metric label="미실현손익" value={`${formatPrice(numberOf(pendingPlan.plan.unrealizedPL))} USDT`} />
                              </div>
                            )}

                            {planKind === "CONFIGURE" && pendingPlan && (
                              <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-bold">
                                <Metric label="포지션 모드" value={String(pendingPlan.plan.positionMode)} />
                                <Metric label="마진 모드" value={String(pendingPlan.plan.marginMode)} />
                                <Metric label="심볼" value={String(pendingPlan.plan.symbol)} />
                                <Metric label="레버리지" value={`${numberOf(pendingPlan.plan.leverage)}배`} />
                              </div>
                            )}

                            {pendingPlan?.warning && (
                              <p className="mt-3 rounded-2xl bg-warning/10 p-3 text-[10px] font-bold leading-relaxed text-warning">{pendingPlan.warning}</p>
                            )}

                            {planKind !== "WATCH" && pendingPlan && (
                              <button
                                type="button"
                                onClick={() => void (planKind === "OPEN" ? approveOpen() : planKind === "CLOSE" ? approveClose() : approveConfigure())}
                                disabled={pendingAction != null}
                                className="mt-3 w-full rounded-2xl bg-destructive px-3 py-3 text-xs font-black text-destructive-foreground disabled:opacity-50"
                              >
                                {pendingAction
                                  ? "처리 중..."
                                  : planKind === "OPEN"
                                    ? "실제 롱·숏 주문 최종 승인"
                                    : planKind === "CLOSE"
                                      ? "포지션 시장가 종료 최종 승인"
                                      : "거래소 설정 최종 승인"}
                              </button>
                            )}
                          </div>
                        </div>
                        )}

                        <BottomNav />
                        </div>
                        );
                        }

                        function TopTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
                        return (
                        <button
                        type="button"
                        onClick={onClick}
                        className={cn(
                        "inline-flex items-center justify-center rounded-xl border px-2 py-2 text-center text-sm font-black leading-tight",
                        active ? "border-primary bg-primary text-primary-foreground" : "border-card-border bg-card text-muted-foreground",
                        )}
                        >
                        {children}
                        </button>
                        );
                        }

                        function StatusPill({ ok, label }: { ok: boolean; label: string }) {
                        return <div className={cn("rounded-2xl p-3", ok ? "bg-positive/10 text-positive" : "bg-destructive/10 text-destructive")}>{label}</div>;
                        }

                        function ScoreCard({ label, score, active, tone }: { label: string; score: number; active: boolean; tone: "long" | "short" }) {
                        return (
                        <div className={cn(
                        "rounded-xl border p-2 text-center",
                        active
                        ? tone === "long" ? "border-positive/30 bg-positive/10 text-positive" : "border-destructive/30 bg-destructive/10 text-destructive"
                        : "border-card-border bg-background text-muted-foreground",
                        )}>
                        <p className="text-[9px] font-black">{label} 점수</p>
                        <p className="mt-0.5 text-base font-black">{score}</p>
                        </div>
                        );
                        }

                        function Metric({ label, value }: { label: string; value: string }) {
                        return (
                        <div className="rounded-xl bg-secondary/70 p-2">
                        <p className="text-[9px] font-black text-muted-foreground">{label}</p>
                        <p className="mt-1 break-words text-[11px] font-black text-foreground">{value}</p>
                        </div>
                        );
                        }

                        function LoadingBox({ text }: { text: string }) {
                        return (
                        <div className="mt-3 flex items-center justify-center gap-2 rounded-2xl bg-secondary p-5 text-xs font-bold text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> {text}
                        </div>
                        );
                        }

                        function ErrorBox({ text }: { text: string }) {
                        return <p className="mt-3 rounded-2xl bg-destructive/10 p-4 text-center text-xs font-bold text-destructive">{text}</p>;
                        }

                        function SelectField({
                        label,
                        value,
                        onChange,
                        options,
                        }: {
                        label: string;
                        value: string;
                        onChange: (value: string) => void;
                        options: Array<{ value: string; label: string }>;
                        }) {
                        return (
                        <label className="rounded-2xl border border-card-border bg-background p-3">
                        <span className="block text-[10px] font-black text-muted-foreground">{label}</span>
                        <select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full bg-transparent text-sm font-black outline-none">
                        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                        </label>
                        );
                        }

                        function NumberField({
                        label,
                        value,
                        min,
                        max,
                        step,
                        suffix,
                        onChange,
                        }: {
                        label: string;
                        value: number;
                        min: number;
                        max: number;
                        step: number;
                        suffix: string;
                        onChange: (value: number) => void;
                        }) {
                        const [draft, setDraft] = useState(() => String(value));
                        const focusedRef = useRef(false);

                        useEffect(() => {
                        if (!focusedRef.current) {
                        setDraft(String(value));
                        }
                        }, [value]);

                        const commit = () => {
                        const cleaned = draft.replace(/,/g, "").trim();
                        if (!cleaned) {
                        setDraft(String(value));
                        return;
                        }

                        const parsed = Number(cleaned);
                        if (!Number.isFinite(parsed)) {
                        setDraft(String(value));
                        return;
                        }

                        const normalized = clamp(parsed, min, max);
                        onChange(normalized);
                        setDraft(String(normalized));
                        };

                        return (
                        <label className="rounded-2xl border border-card-border bg-background p-3">
                        <span className="block text-[10px] font-black text-muted-foreground">
                        {label}
                        </span>
                        <div className="mt-1 flex items-center gap-1">
                        <input
                          type="text"
                          inputMode={Number.isInteger(step) ? "numeric" : "decimal"}
                          value={draft}
                          onFocus={(event) => {
                            focusedRef.current = true;
                            window.requestAnimationFrame(() => event.currentTarget.select());
                          }}
                          onChange={(event) => {
                            const next = event.target.value;
                            if (/^-?\d*(?:[.]\d*)?$/.test(next.replace(/,/g, ""))) {
                              setDraft(next);
                            }
                          }}
                          onBlur={() => {
                            focusedRef.current = false;
                            commit();
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commit();
                              event.currentTarget.blur();
                            }
                            if (event.key === "Escape") {
                              setDraft(String(value));
                              event.currentTarget.blur();
                            }
                          }}
                          placeholder={`${min} ~ ${max}`}
                          className="min-w-0 flex-1 bg-transparent text-sm font-black outline-none"
                        />
                        <span className="text-[10px] font-black text-muted-foreground">
                          {suffix}
                        </span>
                        </div>
                        </label>
                        );
                        }