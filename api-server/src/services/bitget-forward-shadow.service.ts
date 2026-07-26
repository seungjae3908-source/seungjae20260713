import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MarketDataService } from './market-data.service';
import {
  getLatestBitgetMarketContext,
  type BitgetMarketContextSnapshot,
} from './bitget-market-context.service';

const BITGET_BASE = 'https://api.bitget.com';
const PRODUCT_TYPE = 'USDT-FUTURES';
const MONITOR_INTERVAL_MS = 60_000;
const MAX_EVALUATIONS = 10_000;
const MAX_TRADES = 2_000;

export const FORWARD_SHADOW_POLICY = {
  version: 'stage6-forward-shadow-300k-v1',
  startingCapitalKRW: 300_000,
  leverage: 5,
  maximumPlannedMarginKRW: 30_000,
  entrySplits: [0.3, 0.3, 0.4] as const,
  exitSplits: [0.3, 0.3, 0.4] as const,
  feeBpsPerFill: 12,
  slippageBpsPerFill: 15,
  maximumConcurrentPositions: 1,
  maximumDailyLossKRW: 6_000,
  maximumTotalLossKRW: 15_000,
  maximumHoldHours: 48,
  cooldownHours: 8,
  shortEntriesEnabled: false,
  realOrdersEnabled: false,
} as const;

export type ForwardCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
};

export type ForwardTechnicalEvaluation = {
  eligible: boolean;
  score: number;
  reasons: string[];
  candleTime: number | null;
  close: number | null;
  atr: number | null;
  ema20: number | null;
  ema50: number | null;
  rsi: number | null;
  macdHistogram: number | null;
  volumeRatio: number | null;
  rangeAtr: number | null;
  retestLevel: number | null;
  support: number | null;
  oneHourTrendUp: boolean;
  fourHourTrendUp: boolean;
  healthyForAdd: boolean;
};

type EntryFill = {
  stage: 1 | 2 | 3;
  marginKRW: number;
  notionalKRW: number;
  quantity: number;
  marketPrice: number;
  fillPrice: number;
  fxRate: number;
  feeKRW: number;
  estimatedSlippageKRW: number;
  filledAt: string;
  sampleId: string;
};

type ExitFill = {
  stage: 1 | 2 | 3 | 0;
  reason: string;
  quantity: number;
  marketPrice: number;
  fillPrice: number;
  fxRate: number;
  grossPnlKRW: number;
  feeKRW: number;
  estimatedSlippageKRW: number;
  filledAt: string;
  sampleId: string;
};

export type ForwardShadowPosition = {
  id: string;
  symbol: string;
  direction: 'LONG';
  openedAt: string;
  updatedAt: string;
  initialCandleTime: number;
  lastManagedSampleId: string;
  entryFills: EntryFill[];
  exitFills: ExitFill[];
  remainingQuantity: number;
  remainingMarginKRW: number;
  stopPrice: number;
  targetPrices: [number, number, number];
  targetHits: [boolean, boolean, boolean];
  initialRiskPerUnit: number;
  retestLevel: number;
  latestMarketPrice: number;
  latestFxRate: number;
};

export type ForwardShadowTrade = {
  id: string;
  positionId: string;
  symbol: string;
  direction: 'LONG';
  openedAt: string;
  closedAt: string;
  exitReason: string;
  entryFills: EntryFill[];
  exitFills: ExitFill[];
  averageEntryPrice: number;
  averageExitPrice: number;
  totalMarginKRW: number;
  totalNotionalKRW: number;
  grossPnlKRW: number;
  entryFeesKRW: number;
  exitFeesKRW: number;
  netPnlKRW: number;
  estimatedSlippageKRW: number;
  returnOnMarginPct: number;
};

export type ForwardShadowEvaluation = {
  id: string;
  evaluatedAt: string;
  symbol: string;
  sampleId: string;
  candleTime: number | null;
  contextStatus: BitgetMarketContextSnapshot['policy']['dataStatus'];
  contextAllowed: boolean;
  contextBlockReasons: string[];
  contextWarnings: string[];
  technicalEligible: boolean;
  technicalScore: number;
  technicalReasons: string[];
  action: string;
  actionReason: string;
  marketPrice: number | null;
  markPrice: number | null;
  fxRate: number | null;
  metrics: Omit<ForwardTechnicalEvaluation, 'eligible' | 'score' | 'reasons'>;
};

type ForwardShadowStore = {
  version: 1;
  policyVersion: string;
  startedAt: string;
  updatedAt: string;
  disabled: boolean;
  disabledReason: string | null;
  lastRunAt: string | null;
  lastRunError: string | null;
  lastProcessedSampleBySymbol: Record<string, string>;
  cooldownUntilBySymbol: Record<string, string>;
  positions: ForwardShadowPosition[];
  trades: ForwardShadowTrade[];
  evaluations: ForwardShadowEvaluation[];
};

type Candidate = {
  snapshot: BitgetMarketContextSnapshot;
  technical: ForwardTechnicalEvaluation;
  evaluation: ForwardShadowEvaluation;
};

let loaded = false;
let store: ForwardShadowStore = createStore();
let writeQueue = Promise.resolve();
let monitorTimer: NodeJS.Timeout | null = null;
let monitorRunning = false;
let fxCache: { value: number; expiresAt: number } | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function createStore(): ForwardShadowStore {
  const now = nowIso();
  return {
    version: 1,
    policyVersion: FORWARD_SHADOW_POLICY.version,
    startedAt: now,
    updatedAt: now,
    disabled: false,
    disabledReason: null,
    lastRunAt: null,
    lastRunError: null,
    lastProcessedSampleBySymbol: {},
    cooldownUntilBySymbol: {},
    positions: [],
    trades: [],
    evaluations: [],
  };
}

function storageDirectory(): string {
  const explicit = String(process.env.BITGET_FORWARD_SHADOW_DATA_DIR ?? '').trim();
  if (explicit) return path.resolve(explicit);
  const cwd = process.cwd();
  return path.resolve(cwd, path.basename(cwd) === 'api-server' ? '../data/bitget-forward-shadow' : 'data/bitget-forward-shadow');
}

function storeFile(): string {
  return path.join(storageDirectory(), 'stage6-forward-shadow-300k.json');
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(await readFile(storeFile(), 'utf8')) as Partial<ForwardShadowStore>;
    store = {
      ...createStore(),
      ...parsed,
      version: 1,
      policyVersion: FORWARD_SHADOW_POLICY.version,
      lastProcessedSampleBySymbol: parsed.lastProcessedSampleBySymbol ?? {},
      cooldownUntilBySymbol: parsed.cooldownUntilBySymbol ?? {},
      positions: Array.isArray(parsed.positions) ? parsed.positions : [],
      trades: Array.isArray(parsed.trades) ? parsed.trades : [],
      evaluations: Array.isArray(parsed.evaluations) ? parsed.evaluations : [],
    };
  } catch {
    store = createStore();
  }
}

function saveStore(): Promise<void> {
  store.updatedAt = nowIso();
  writeQueue = writeQueue.then(async () => {
    await mkdir(storageDirectory(), { recursive: true });
    const temporary = `${storeFile()}.tmp`;
    await writeFile(temporary, JSON.stringify(store, null, 2), 'utf8');
    await rename(temporary, storeFile());
  });
  return writeQueue;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bps(value: number, basisPoints: number): number {
  return value * (basisPoints / 10_000);
}

function weightedAverage<T>(rows: T[], quantity: (row: T) => number, price: (row: T) => number): number {
  const totalQuantity = rows.reduce((sum, row) => sum + quantity(row), 0);
  return totalQuantity > 0
    ? rows.reduce((sum, row) => sum + quantity(row) * price(row), 0) / totalQuantity
    : 0;
}

function averageEntry(position: ForwardShadowPosition): number {
  return weightedAverage(position.entryFills, (row) => row.quantity, (row) => row.fillPrice);
}

function totalEntryQuantity(position: ForwardShadowPosition): number {
  return position.entryFills.reduce((sum, row) => sum + row.quantity, 0);
}

function totalEntryMargin(position: ForwardShadowPosition): number {
  return position.entryFills.reduce((sum, row) => sum + row.marginKRW, 0);
}

function positionRealizedNet(position: ForwardShadowPosition): number {
  const gross = position.exitFills.reduce((sum, row) => sum + row.grossPnlKRW, 0);
  const entryFees = position.entryFills.reduce((sum, row) => sum + row.feeKRW, 0);
  const exitFees = position.exitFills.reduce((sum, row) => sum + row.feeKRW, 0);
  return gross - entryFees - exitFees;
}

function closedNetPnl(): number {
  return store.trades.reduce((sum, trade) => sum + trade.netPnlKRW, 0);
}

function dailyNetPnl(): number {
  const day = nowIso().slice(0, 10);
  return store.trades
    .filter((trade) => trade.closedAt.slice(0, 10) === day)
    .reduce((sum, trade) => sum + trade.netPnlKRW, 0);
}

function enforceLossLocks(): void {
  const daily = dailyNetPnl();
  const total = closedNetPnl();
  if (daily <= -FORWARD_SHADOW_POLICY.maximumDailyLossKRW) {
    store.disabled = true;
    store.disabledReason = 'DAILY_SHADOW_LOSS_LIMIT';
  }
  if (total <= -FORWARD_SHADOW_POLICY.maximumTotalLossKRW) {
    store.disabled = true;
    store.disabledReason = 'TOTAL_SHADOW_LOSS_LIMIT';
  }
}

async function usdKrwRate(): Promise<number> {
  if (fxCache && fxCache.expiresAt > Date.now()) return fxCache.value;
  const summary = await MarketDataService.getMarketSummary();
  const row = summary.find((item) => item.key === 'usdkrw');
  if (!row?.ok || !(row.price > 0)) throw new Error('USDKRW_UNAVAILABLE');
  fxCache = { value: row.price, expiresAt: Date.now() + 5 * 60_000 };
  return row.price;
}

async function fetchCandles(symbol: string): Promise<ForwardCandle[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const query = new URLSearchParams({
      symbol,
      productType: PRODUCT_TYPE,
      granularity: '15m',
      limit: '500',
    });
    const response = await fetch(`${BITGET_BASE}/api/v2/mix/market/candles?${query.toString()}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'seungjae-forward-shadow/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`BITGET_CANDLES_HTTP_${response.status}`);
    const payload = (await response.json()) as { code?: string; data?: unknown[] };
    if (String(payload.code ?? '') !== '00000' || !Array.isArray(payload.data)) {
      throw new Error(`BITGET_CANDLES_${String(payload.code ?? 'INVALID')}`);
    }
    return payload.data
      .map((raw) => {
        const row = raw as unknown[];
        return {
          time: Number(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5]),
          quoteVolume: Number(row[6]),
        };
      })
      .filter((row) => Object.values(row).every(Number.isFinite))
      .sort((left, right) => left.time - right.time);
  } finally {
    clearTimeout(timeout);
  }
}

function ema(values: number[], period: number): number[] {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const result = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    result.push(values[index] * multiplier + result[index - 1] * (1 - multiplier));
  }
  return result;
}

function atr(candles: ForwardCandle[], period = 14): number[] {
  const ranges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  const result: number[] = [];
  let running = ranges[0] ?? 0;
  for (let index = 0; index < ranges.length; index += 1) {
    running = index === 0 ? ranges[index] : (running * (period - 1) + ranges[index]) / period;
    result.push(running);
  }
  return result;
}

function rsi(values: number[], period = 14): number[] {
  if (!values.length) return [];
  const result = new Array<number>(values.length).fill(50);
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = index <= period
      ? (averageGain * (index - 1) + gain) / index
      : (averageGain * (period - 1) + gain) / period;
    averageLoss = index <= period
      ? (averageLoss * (index - 1) + loss) / index
      : (averageLoss * (period - 1) + loss) / period;
    const rs = averageLoss === 0 ? Number.POSITIVE_INFINITY : averageGain / averageLoss;
    result[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + rs);
  }
  return result;
}

function rollingAverage(values: number[], period: number): number[] {
  const result: number[] = [];
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= period) sum -= values[index - period];
    result.push(sum / Math.min(period, index + 1));
  }
  return result;
}

function aggregateCandles(candles: ForwardCandle[], bucketMs: number): ForwardCandle[] {
  const groups = new Map<number, ForwardCandle[]>();
  for (const candle of candles) {
    const bucket = Math.floor(candle.time / bucketMs) * bucketMs;
    const rows = groups.get(bucket) ?? [];
    rows.push(candle);
    groups.set(bucket, rows);
  }
  return Array.from(groups.entries()).sort((a, b) => a[0] - b[0]).map(([time, rows]) => ({
    time,
    open: rows[0].open,
    high: Math.max(...rows.map((row) => row.high)),
    low: Math.min(...rows.map((row) => row.low)),
    close: rows[rows.length - 1].close,
    volume: rows.reduce((sum, row) => sum + row.volume, 0),
    quoteVolume: rows.reduce((sum, row) => sum + row.quoteVolume, 0),
  }));
}

export function evaluateLongPullbackCandles(candles: ForwardCandle[]): ForwardTechnicalEvaluation {
  const empty: ForwardTechnicalEvaluation = {
    eligible: false,
    score: 0,
    reasons: [],
    candleTime: null,
    close: null,
    atr: null,
    ema20: null,
    ema50: null,
    rsi: null,
    macdHistogram: null,
    volumeRatio: null,
    rangeAtr: null,
    retestLevel: null,
    support: null,
    oneHourTrendUp: false,
    fourHourTrendUp: false,
    healthyForAdd: false,
  };
  if (candles.length < 220) return { ...empty, reasons: ['INSUFFICIENT_CANDLES'] };

  const closes = candles.map((row) => row.close);
  const volumes = candles.map((row) => row.volume);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const atr14 = atr(candles, 14);
  const rsi14 = rsi(closes, 14);
  const macd = ema(closes, 12).map((value, index) => value - ema(closes, 26)[index]);
  const signal = ema(macd, 9);
  const histogram = macd.map((value, index) => value - signal[index]);
  const averageVolume = rollingAverage(volumes, 20);
  const oneHour = aggregateCandles(candles, 60 * 60_000);
  const fourHour = aggregateCandles(candles, 4 * 60 * 60_000);
  const oneHourEma20 = ema(oneHour.map((row) => row.close), 20);
  const fourHourEma10 = ema(fourHour.map((row) => row.close), 10);
  const index = candles.length - 1;
  const previous = index - 1;
  const current = candles[index];
  const previousCandle = candles[previous];
  const currentAtr = atr14[index];

  let breakoutIndex = -1;
  let retestLevel: number | null = null;
  for (let cursor = Math.max(20, index - 16); cursor < index; cursor += 1) {
    const priorHigh = Math.max(...candles.slice(cursor - 20, cursor).map((row) => row.high));
    if (candles[cursor].close > priorHigh && candles[cursor].close > candles[cursor].open) {
      breakoutIndex = cursor;
      retestLevel = priorHigh;
    }
  }

  const support = retestLevel == null ? null : Math.max(ema20[index], retestLevel);
  const oneHourTrendUp = oneHourEma20.length > 5 && oneHourEma20.at(-1)! > oneHourEma20.at(-5)!;
  const fourHourTrendUp = fourHourEma10.length > 4 && fourHourEma10.at(-1)! > fourHourEma10.at(-4)!;
  const volumeRatio = averageVolume[index] > 0 ? current.volume / averageVolume[index] : null;
  const rangeAtr = currentAtr > 0 ? (current.high - current.low) / currentAtr : null;
  const distanceAtr = support != null && currentAtr > 0 ? (current.close - support) / currentAtr : null;

  const checks: Array<[boolean, string, number]> = [
    [current.close > ema20[index] && ema20[index] > ema50[index], 'EMA_TREND_NOT_ALIGNED', 15],
    [oneHourTrendUp, 'ONE_HOUR_TREND_DOWN', 12],
    [fourHourTrendUp, 'FOUR_HOUR_TREND_DOWN', 12],
    [breakoutIndex >= 0 && retestLevel != null, 'RECENT_BREAKOUT_MISSING', 12],
    [support != null && previousCandle.low <= Math.max(ema20[previous], retestLevel ?? 0) + 0.35 * currentAtr, 'PULLBACK_TOUCH_MISSING', 10],
    [previousCandle.close >= ema50[previous] - 0.3 * currentAtr, 'PULLBACK_STRUCTURE_BROKEN', 8],
    [support != null && current.close > support && current.close > current.open && current.close > previousCandle.close, 'RECLAIM_MISSING', 10],
    [current.low >= ema50[index] - 0.25 * currentAtr, 'CURRENT_STRUCTURE_WEAK', 5],
    [distanceAtr != null && distanceAtr >= 0.03 && distanceAtr <= 0.9, 'RECLAIM_DISTANCE_INVALID', 5],
    [rsi14[index] >= 49 && rsi14[index] <= 66 && rsi14[index] >= rsi14[previous], 'RSI_RECOVERY_INVALID', 5],
    [histogram[index] > 0 && histogram[index] >= histogram[previous], 'MACD_RECOVERY_INVALID', 3],
    [volumeRatio != null && volumeRatio >= 0.65 && volumeRatio <= 1.8, 'VOLUME_RATIO_INVALID', 2],
    [rangeAtr != null && rangeAtr <= 1.8, 'CHASE_CANDLE_BLOCKED', 1],
  ];
  const reasons = checks.filter(([passed]) => !passed).map(([, reason]) => reason);
  const score = checks.reduce((sum, [passed, , weight]) => sum + (passed ? weight : 0), 0);
  const healthyForAdd = current.close > ema20[index]
    && ema20[index] > ema50[index]
    && oneHourTrendUp
    && fourHourTrendUp
    && rsi14[index] >= 48
    && histogram[index] >= histogram[previous]
    && (rangeAtr ?? Number.POSITIVE_INFINITY) <= 2;

  return {
    eligible: reasons.length === 0,
    score,
    reasons,
    candleTime: current.time,
    close: current.close,
    atr: currentAtr,
    ema20: ema20[index],
    ema50: ema50[index],
    rsi: rsi14[index],
    macdHistogram: histogram[index],
    volumeRatio,
    rangeAtr,
    retestLevel,
    support,
    oneHourTrendUp,
    fourHourTrendUp,
    healthyForAdd,
  };
}

function evaluationMetrics(technical: ForwardTechnicalEvaluation): ForwardShadowEvaluation['metrics'] {
  const { eligible: _eligible, score: _score, reasons: _reasons, ...metrics } = technical;
  return metrics;
}

function addEvaluation(evaluation: ForwardShadowEvaluation): void {
  store.evaluations.push(evaluation);
  if (store.evaluations.length > MAX_EVALUATIONS) {
    store.evaluations.splice(0, store.evaluations.length - MAX_EVALUATIONS);
  }
}

function makeEvaluation(snapshot: BitgetMarketContextSnapshot, technical: ForwardTechnicalEvaluation, fxRate: number | null): ForwardShadowEvaluation {
  return {
    id: randomUUID(),
    evaluatedAt: nowIso(),
    symbol: snapshot.symbol,
    sampleId: snapshot.sampleId,
    candleTime: technical.candleTime,
    contextStatus: snapshot.policy.dataStatus,
    contextAllowed: snapshot.policy.longEntryAllowed,
    contextBlockReasons: [...snapshot.policy.blockReasons],
    contextWarnings: [...snapshot.policy.warnings],
    technicalEligible: technical.eligible,
    technicalScore: technical.score,
    technicalReasons: [...technical.reasons],
    action: 'OBSERVED',
    actionReason: 'NO_ACTION',
    marketPrice: snapshot.market.price,
    markPrice: snapshot.market.markPrice,
    fxRate,
    metrics: evaluationMetrics(technical),
  };
}

function availableCapitalKRW(): number {
  const openRealized = store.positions.reduce((sum, position) => sum + positionRealizedNet(position), 0);
  const lockedMargin = store.positions.reduce((sum, position) => sum + position.remainingMarginKRW, 0);
  return Math.max(0, FORWARD_SHADOW_POLICY.startingCapitalKRW + closedNetPnl() + openRealized - lockedMargin);
}

function currentUnrealizedPnlKRW(): number {
  return store.positions.reduce((sum, position) => {
    const entry = averageEntry(position);
    return sum + (position.latestMarketPrice - entry) * position.remainingQuantity * position.latestFxRate;
  }, 0);
}

function openEntry(
  symbol: string,
  stage: 1 | 2 | 3,
  marginKRW: number,
  marketPrice: number,
  fxRate: number,
  sampleId: string,
): EntryFill {
  const notionalKRW = marginKRW * FORWARD_SHADOW_POLICY.leverage;
  const fillPrice = marketPrice * (1 + FORWARD_SHADOW_POLICY.slippageBpsPerFill / 10_000);
  return {
    stage,
    marginKRW,
    notionalKRW,
    quantity: notionalKRW / fxRate / fillPrice,
    marketPrice,
    fillPrice,
    fxRate,
    feeKRW: bps(notionalKRW, FORWARD_SHADOW_POLICY.feeBpsPerFill),
    estimatedSlippageKRW: bps(notionalKRW, FORWARD_SHADOW_POLICY.slippageBpsPerFill),
    filledAt: nowIso(),
    sampleId,
  };
}

function recalculateLevels(position: ForwardShadowPosition, atrValue: number, support: number): void {
  const entry = averageEntry(position);
  const candidateStop = Math.min(entry - atrValue, support - 0.25 * atrValue);
  if (position.entryFills.length === 1) position.stopPrice = Math.max(0.00000001, candidateStop);
  else position.stopPrice = Math.max(position.stopPrice, position.entryFills[0].fillPrice);
  const risk = Math.max(entry - position.stopPrice, atrValue * 0.5);
  position.initialRiskPerUnit = risk;
  position.targetPrices = [entry + 1.5 * risk, entry + 2.5 * risk, entry + 4 * risk];
}

function createPosition(candidate: Candidate, fxRate: number): ForwardShadowPosition {
  const marketPrice = candidate.snapshot.market.markPrice ?? candidate.snapshot.market.price;
  if (marketPrice == null || marketPrice <= 0 || candidate.technical.atr == null || candidate.technical.support == null || candidate.technical.candleTime == null) {
    throw new Error('ENTRY_DATA_UNAVAILABLE');
  }
  const margin = FORWARD_SHADOW_POLICY.maximumPlannedMarginKRW * FORWARD_SHADOW_POLICY.entrySplits[0];
  const fill = openEntry(candidate.snapshot.symbol, 1, margin, marketPrice, fxRate, candidate.snapshot.sampleId);
  const position: ForwardShadowPosition = {
    id: randomUUID(),
    symbol: candidate.snapshot.symbol,
    direction: 'LONG',
    openedAt: nowIso(),
    updatedAt: nowIso(),
    initialCandleTime: candidate.technical.candleTime,
    lastManagedSampleId: candidate.snapshot.sampleId,
    entryFills: [fill],
    exitFills: [],
    remainingQuantity: fill.quantity,
    remainingMarginKRW: fill.marginKRW,
    stopPrice: Math.max(0.00000001, fill.fillPrice - candidate.technical.atr),
    targetPrices: [0, 0, 0],
    targetHits: [false, false, false],
    initialRiskPerUnit: candidate.technical.atr,
    retestLevel: candidate.technical.retestLevel ?? candidate.technical.support,
    latestMarketPrice: marketPrice,
    latestFxRate: fxRate,
  };
  recalculateLevels(position, candidate.technical.atr, candidate.technical.support);
  return position;
}

function closeQuantity(
  position: ForwardShadowPosition,
  quantity: number,
  reason: string,
  stage: 0 | 1 | 2 | 3,
  marketPrice: number,
  fxRate: number,
  sampleId: string,
): ExitFill {
  const actualQuantity = Math.max(0, Math.min(quantity, position.remainingQuantity));
  const fillPrice = marketPrice * (1 - FORWARD_SHADOW_POLICY.slippageBpsPerFill / 10_000);
  const exitNotionalKRW = actualQuantity * fillPrice * fxRate;
  const average = averageEntry(position);
  const fill: ExitFill = {
    stage,
    reason,
    quantity: actualQuantity,
    marketPrice,
    fillPrice,
    fxRate,
    grossPnlKRW: (fillPrice - average) * actualQuantity * fxRate,
    feeKRW: bps(exitNotionalKRW, FORWARD_SHADOW_POLICY.feeBpsPerFill),
    estimatedSlippageKRW: bps(exitNotionalKRW, FORWARD_SHADOW_POLICY.slippageBpsPerFill),
    filledAt: nowIso(),
    sampleId,
  };
  const fraction = position.remainingQuantity > 0 ? actualQuantity / position.remainingQuantity : 1;
  position.remainingQuantity = Math.max(0, position.remainingQuantity - actualQuantity);
  position.remainingMarginKRW = Math.max(0, position.remainingMarginKRW * (1 - fraction));
  position.exitFills.push(fill);
  position.updatedAt = nowIso();
  position.latestMarketPrice = marketPrice;
  position.latestFxRate = fxRate;
  return fill;
}

function finalizePosition(position: ForwardShadowPosition, reason: string): ForwardShadowTrade {
  const totalQuantity = totalEntryQuantity(position);
  const averageEntryPrice = averageEntry(position);
  const averageExitPrice = weightedAverage(position.exitFills, (row) => row.quantity, (row) => row.fillPrice);
  const grossPnlKRW = position.exitFills.reduce((sum, row) => sum + row.grossPnlKRW, 0);
  const entryFeesKRW = position.entryFills.reduce((sum, row) => sum + row.feeKRW, 0);
  const exitFeesKRW = position.exitFills.reduce((sum, row) => sum + row.feeKRW, 0);
  const totalMarginKRW = totalEntryMargin(position);
  const trade: ForwardShadowTrade = {
    id: randomUUID(),
    positionId: position.id,
    symbol: position.symbol,
    direction: 'LONG',
    openedAt: position.openedAt,
    closedAt: nowIso(),
    exitReason: reason,
    entryFills: position.entryFills,
    exitFills: position.exitFills,
    averageEntryPrice,
    averageExitPrice,
    totalMarginKRW,
    totalNotionalKRW: position.entryFills.reduce((sum, row) => sum + row.notionalKRW, 0),
    grossPnlKRW,
    entryFeesKRW,
    exitFeesKRW,
    netPnlKRW: grossPnlKRW - entryFeesKRW - exitFeesKRW,
    estimatedSlippageKRW: position.entryFills.reduce((sum, row) => sum + row.estimatedSlippageKRW, 0)
      + position.exitFills.reduce((sum, row) => sum + row.estimatedSlippageKRW, 0),
    returnOnMarginPct: totalMarginKRW > 0 ? ((grossPnlKRW - entryFeesKRW - exitFeesKRW) / totalMarginKRW) * 100 : 0,
  };
  if (totalQuantity <= 0) throw new Error('TRADE_QUANTITY_INVALID');
  store.trades.push(trade);
  if (store.trades.length > MAX_TRADES) store.trades.splice(0, store.trades.length - MAX_TRADES);
  store.positions = store.positions.filter((row) => row.id !== position.id);
  store.cooldownUntilBySymbol[position.symbol] = new Date(Date.now() + FORWARD_SHADOW_POLICY.cooldownHours * 60 * 60_000).toISOString();
  enforceLossLocks();
  return trade;
}

function hardShock(snapshot: BitgetMarketContextSnapshot): boolean {
  return snapshot.policy.blockReasons.some((reason) => [
    'FUNDING_SHOCK',
    'MARK_INDEX_DIVERGENCE',
    'MARKET_MARK_DIVERGENCE',
    'OI_5M_SHOCK',
  ].includes(reason));
}

function managePosition(
  position: ForwardShadowPosition,
  candidate: Candidate,
  fxRate: number,
): { action: string; reason: string } {
  const marketPrice = candidate.snapshot.market.markPrice ?? candidate.snapshot.market.price;
  if (marketPrice == null || marketPrice <= 0) return { action: 'POSITION_HELD', reason: 'PRICE_UNAVAILABLE' };
  position.lastManagedSampleId = candidate.snapshot.sampleId;
  position.latestMarketPrice = marketPrice;
  position.latestFxRate = fxRate;
  position.updatedAt = nowIso();

  const ageHours = (Date.now() - Date.parse(position.openedAt)) / 3_600_000;
  if (marketPrice <= position.stopPrice) {
    closeQuantity(position, position.remainingQuantity, 'STOP', 0, marketPrice, fxRate, candidate.snapshot.sampleId);
    finalizePosition(position, 'STOP');
    return { action: 'POSITION_CLOSED', reason: 'STOP' };
  }
  if (hardShock(candidate.snapshot)) {
    closeQuantity(position, position.remainingQuantity, 'CONTEXT_SHOCK', 0, marketPrice, fxRate, candidate.snapshot.sampleId);
    finalizePosition(position, 'CONTEXT_SHOCK');
    return { action: 'POSITION_CLOSED', reason: 'CONTEXT_SHOCK' };
  }
  if (ageHours >= FORWARD_SHADOW_POLICY.maximumHoldHours) {
    closeQuantity(position, position.remainingQuantity, 'MAX_HOLD', 0, marketPrice, fxRate, candidate.snapshot.sampleId);
    finalizePosition(position, 'MAX_HOLD');
    return { action: 'POSITION_CLOSED', reason: 'MAX_HOLD' };
  }

  const totalQuantity = totalEntryQuantity(position);
  for (let targetIndex = 0; targetIndex < 3; targetIndex += 1) {
    if (!position.targetHits[targetIndex] && marketPrice >= position.targetPrices[targetIndex]) {
      const desired = targetIndex === 2
        ? position.remainingQuantity
        : totalQuantity * FORWARD_SHADOW_POLICY.exitSplits[targetIndex];
      closeQuantity(position, desired, `TARGET_${targetIndex + 1}`, (targetIndex + 1) as 1 | 2 | 3, marketPrice, fxRate, candidate.snapshot.sampleId);
      position.targetHits[targetIndex] = true;
      if (targetIndex === 0) position.stopPrice = Math.max(position.stopPrice, averageEntry(position));
      if (targetIndex === 1) position.stopPrice = Math.max(position.stopPrice, position.targetPrices[0]);
      if (position.remainingQuantity <= 1e-12) {
        finalizePosition(position, `TARGET_${targetIndex + 1}`);
        return { action: 'POSITION_CLOSED', reason: `TARGET_${targetIndex + 1}` };
      }
      return { action: 'PARTIAL_EXIT', reason: `TARGET_${targetIndex + 1}` };
    }
  }

  const stages = position.entryFills.length;
  const average = averageEntry(position);
  const risk = position.initialRiskPerUnit;
  const nextStage = stages + 1;
  const addThreshold = stages === 1 ? average + 0.5 * risk : average + 1.0 * risk;
  if (
    stages < 3
    && marketPrice >= addThreshold
    && candidate.snapshot.policy.longEntryAllowed
    && candidate.technical.healthyForAdd
    && candidate.technical.atr != null
    && candidate.technical.support != null
  ) {
    const split = FORWARD_SHADOW_POLICY.entrySplits[nextStage - 1];
    const margin = FORWARD_SHADOW_POLICY.maximumPlannedMarginKRW * split;
    const fee = bps(margin * FORWARD_SHADOW_POLICY.leverage, FORWARD_SHADOW_POLICY.feeBpsPerFill);
    if (availableCapitalKRW() >= margin + fee) {
      const fill = openEntry(position.symbol, nextStage as 2 | 3, margin, marketPrice, fxRate, candidate.snapshot.sampleId);
      position.entryFills.push(fill);
      position.remainingQuantity += fill.quantity;
      position.remainingMarginKRW += fill.marginKRW;
      recalculateLevels(position, candidate.technical.atr, candidate.technical.support);
      return { action: 'POSITION_ADDED', reason: `STAGE_${nextStage}` };
    }
  }
  return { action: 'POSITION_HELD', reason: 'NO_MANAGEMENT_TRIGGER' };
}

function cooldownActive(symbol: string): boolean {
  const until = Date.parse(store.cooldownUntilBySymbol[symbol] ?? '');
  return Number.isFinite(until) && until > Date.now();
}

export async function runForwardShadowOnce(): Promise<{
  processed: number;
  opened: number;
  managed: number;
  skipped?: string;
}> {
  await ensureLoaded();
  if (monitorRunning) return { processed: 0, opened: 0, managed: 0, skipped: 'ALREADY_RUNNING' };
  monitorRunning = true;
  let processed = 0;
  let opened = 0;
  let managed = 0;
  try {
    const snapshots = await getLatestBitgetMarketContext();
    if (!snapshots.length) return { processed: 0, opened: 0, managed: 0, skipped: 'NO_CONTEXT_SNAPSHOTS' };
    let fxRate: number | null = null;
    try {
      fxRate = await usdKrwRate();
    } catch {
      fxRate = null;
    }

    const candidates: Candidate[] = [];
    for (const snapshot of snapshots) {
      if (store.lastProcessedSampleBySymbol[snapshot.symbol] === snapshot.sampleId) continue;
      let technical: ForwardTechnicalEvaluation;
      try {
        technical = evaluateLongPullbackCandles(await fetchCandles(snapshot.symbol));
      } catch (error) {
        technical = {
          eligible: false,
          score: 0,
          reasons: [`CANDLE_FETCH_FAILED:${error instanceof Error ? error.message : String(error)}`],
          candleTime: null,
          close: null,
          atr: null,
          ema20: null,
          ema50: null,
          rsi: null,
          macdHistogram: null,
          volumeRatio: null,
          rangeAtr: null,
          retestLevel: null,
          support: null,
          oneHourTrendUp: false,
          fourHourTrendUp: false,
          healthyForAdd: false,
        };
      }
      const evaluation = makeEvaluation(snapshot, technical, fxRate);
      candidates.push({ snapshot, technical, evaluation });
      store.lastProcessedSampleBySymbol[snapshot.symbol] = snapshot.sampleId;
      processed += 1;
    }

    const position = store.positions[0];
    if (position) {
      const candidate = candidates.find((row) => row.snapshot.symbol === position.symbol);
      if (candidate && fxRate != null) {
        const result = managePosition(position, candidate, fxRate);
        candidate.evaluation.action = result.action;
        candidate.evaluation.actionReason = result.reason;
        managed += 1;
      }
    }

    enforceLossLocks();
    if (!store.positions.length && !store.disabled && fxRate != null) {
      const eligible = candidates
        .filter((row) => row.snapshot.policy.longEntryAllowed && row.technical.eligible && !cooldownActive(row.snapshot.symbol))
        .sort((left, right) => right.technical.score - left.technical.score);
      const selected = eligible[0];
      if (selected && store.positions.length < FORWARD_SHADOW_POLICY.maximumConcurrentPositions) {
        const margin = FORWARD_SHADOW_POLICY.maximumPlannedMarginKRW * FORWARD_SHADOW_POLICY.entrySplits[0];
        const fee = bps(margin * FORWARD_SHADOW_POLICY.leverage, FORWARD_SHADOW_POLICY.feeBpsPerFill);
        if (availableCapitalKRW() >= margin + fee) {
          store.positions.push(createPosition(selected, fxRate));
          selected.evaluation.action = 'POSITION_OPENED';
          selected.evaluation.actionReason = 'STRICT_PULLBACK_RETEST';
          opened += 1;
        }
      }
      for (const row of eligible.slice(1)) {
        row.evaluation.action = 'CANDIDATE_NOT_SELECTED';
        row.evaluation.actionReason = 'MAX_ONE_POSITION';
      }
    }

    for (const candidate of candidates) {
      if (candidate.evaluation.action === 'OBSERVED') {
        if (fxRate == null) candidate.evaluation.actionReason = 'USDKRW_UNAVAILABLE';
        else if (store.disabled) candidate.evaluation.actionReason = store.disabledReason ?? 'SHADOW_DISABLED';
        else if (!candidate.snapshot.policy.longEntryAllowed) candidate.evaluation.actionReason = 'CONTEXT_BLOCKED';
        else if (!candidate.technical.eligible) candidate.evaluation.actionReason = 'TECHNICAL_BLOCKED';
        else if (cooldownActive(candidate.snapshot.symbol)) candidate.evaluation.actionReason = 'COOLDOWN';
        else if (store.positions.length) candidate.evaluation.actionReason = 'POSITION_CAPACITY';
      }
      addEvaluation(candidate.evaluation);
    }
    store.lastRunAt = nowIso();
    store.lastRunError = null;
    await saveStore();
    return { processed, opened, managed };
  } catch (error) {
    store.lastRunAt = nowIso();
    store.lastRunError = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    await saveStore();
    throw error;
  } finally {
    monitorRunning = false;
  }
}

export async function getForwardShadowStatus() {
  await ensureLoaded();
  const closed = closedNetPnl();
  const openRealized = store.positions.reduce((sum, position) => sum + positionRealizedNet(position), 0);
  const allocatedMargin = store.positions.reduce((sum, position) => sum + position.remainingMarginKRW, 0);
  const unrealized = currentUnrealizedPnlKRW();
  const wins = store.trades.filter((trade) => trade.netPnlKRW > 0).length;
  const losses = store.trades.filter((trade) => trade.netPnlKRW < 0).length;
  return {
    mode: 'FORWARD_SHADOW',
    realOrdersEnabled: false,
    policy: FORWARD_SHADOW_POLICY,
    account: {
      startingCapitalKRW: FORWARD_SHADOW_POLICY.startingCapitalKRW,
      equityKRW: FORWARD_SHADOW_POLICY.startingCapitalKRW + closed + openRealized + unrealized,
      availableCapitalKRW: availableCapitalKRW(),
      allocatedMarginKRW: allocatedMargin,
      realizedNetPnlKRW: closed + openRealized,
      closedTradeNetPnlKRW: closed,
      unrealizedPnlKRW: unrealized,
      dailyNetPnlKRW: dailyNetPnl(),
      trades: store.trades.length,
      wins,
      losses,
      winRatePct: store.trades.length ? (wins / store.trades.length) * 100 : 0,
    },
    engine: {
      startedAt: store.startedAt,
      updatedAt: store.updatedAt,
      disabled: store.disabled,
      disabledReason: store.disabledReason,
      monitorRunning,
      lastRunAt: store.lastRunAt,
      lastRunError: store.lastRunError,
      processedSymbols: Object.keys(store.lastProcessedSampleBySymbol).length,
    },
    positions: store.positions,
    recentTrades: store.trades.slice(-100).reverse(),
    recentEvaluations: store.evaluations.slice(-200).reverse(),
  };
}

export async function getForwardShadowEvaluations(limit = 500) {
  await ensureLoaded();
  const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
  return store.evaluations.slice(-safeLimit).reverse();
}

export async function getForwardShadowTrades(limit = 500) {
  await ensureLoaded();
  const safeLimit = Math.max(1, Math.min(2_000, Math.floor(limit)));
  return store.trades.slice(-safeLimit).reverse();
}

export async function resetForwardShadow(confirmation: string): Promise<void> {
  await ensureLoaded();
  if (confirmation !== 'RESET_STAGE6_FORWARD_SHADOW_300000') throw new Error('RESET_CONFIRMATION_INVALID');
  if (store.positions.length) throw new Error('OPEN_POSITION_EXISTS');
  store = createStore();
  await saveStore();
}

export function startForwardShadowMonitor(): void {
  if (monitorTimer || String(process.env.BITGET_FORWARD_SHADOW_ENABLED ?? 'true').toLowerCase() === 'false') return;
  const run = () => {
    void runForwardShadowOnce().catch((error) => {
      console.error('Bitget forward shadow monitor error:', error);
    });
  };
  const initial = setTimeout(run, 45_000);
  initial.unref?.();
  monitorTimer = setInterval(run, MONITOR_INTERVAL_MS);
  monitorTimer.unref?.();
  console.log(`[api-server] forward shadow monitor enabled (${MONITOR_INTERVAL_MS}ms)`);
}
