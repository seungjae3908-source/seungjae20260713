export type ChartCandleTimeframe =
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1H'
  | '4H'
  | '1D'
  | '5D'
  | '20D';

export type NormalizedChartCandle = {
  time: number;
  sourceTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
  closeStateSource: 'provider' | 'sequence' | 'clock' | 'unknown';
};

export type ChartCandleDiscontinuity = {
  previousTime: number;
  nextTime: number;
  elapsedSeconds: number;
  expectedSeconds: number;
  estimatedMissingBars: number;
};

export type ChartCandleNormalizationResult = {
  candles: NormalizedChartCandle[];
  droppedRows: number;
  duplicateRows: number;
  discontinuities: ChartCandleDiscontinuity[];
  warnings: string[];
};

type RawCandle = Record<string, unknown>;

export function chartTimeframeSeconds(timeframe: ChartCandleTimeframe): number {
  const seconds: Record<ChartCandleTimeframe, number> = {
    '1m': 60,
    '3m': 180,
    '5m': 300,
    '15m': 900,
    '30m': 1_800,
    '1H': 3_600,
    '4H': 14_400,
    '1D': 86_400,
    '5D': 432_000,
    '20D': 1_728_000,
  };
  return seconds[timeframe];
}

function finite(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/,/g, '')
    .replace(/%/g, '')
    .replace(/[₩$원배]/g, '')
    .trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCompactDate(value: string): number | null {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 14) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6)) - 1;
  const day = Number(digits.slice(6, 8));
  const hour = digits.length >= 10 ? Number(digits.slice(8, 10)) : 0;
  const minute = digits.length >= 12 ? Number(digits.slice(10, 12)) : 0;
  const second = digits.length >= 14 ? Number(digits.slice(12, 14)) : 0;
  const timestamp = Date.UTC(year, month, day, hour, minute, second);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
  return Math.floor(timestamp / 1_000);
}

export function parseChartCandleTime(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw > 10_000_000_000) return Math.floor(raw / 1_000);
    if (raw > 1_000_000_000) return Math.floor(raw);
    return null;
  }

  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/^\d{8,14}$/.test(text)) return parseCompactDate(text);

  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 1_000_000_000) {
    return Math.floor(numeric > 10_000_000_000 ? numeric / 1_000 : numeric);
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : null;
}

function explicitClosed(row: RawCandle): boolean | null {
  for (const value of [row.isClosed, row.closed, row.final]) {
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function rawTimestamp(row: RawCandle): unknown {
  return row.time ?? row.date ?? row.datetime ?? row.timestamp ?? row.dt;
}

function normalizeRow(row: RawCandle): Omit<NormalizedChartCandle, 'isClosed' | 'closeStateSource'> | null {
  const close = finite(row.close ?? row.closePrice ?? row.cur_prc ?? row.currentPrice ?? row.price);
  const open = finite(row.open ?? row.openPrice ?? row.open_prc);
  const high = finite(row.high ?? row.highPrice ?? row.high_prc);
  const low = finite(row.low ?? row.lowPrice ?? row.low_prc);
  const volume = finite(row.volume ?? row.acc_trde_qty ?? row.tradeVolume ?? row.tradingVolume ?? 0);
  const sourceTime = String(rawTimestamp(row) ?? '').trim();
  const time = parseChartCandleTime(sourceTime);

  if (close == null || open == null || high == null || low == null || time == null) return null;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) return null;
  if (volume == null || volume < 0) return null;

  return {
    time,
    sourceTime,
    open,
    high,
    low,
    close,
    volume,
  };
}

function closeState(
  row: RawCandle,
  time: number,
  nextTime: number | null,
  intervalSeconds: number,
  nowSeconds: number,
): Pick<NormalizedChartCandle, 'isClosed' | 'closeStateSource'> {
  const providerState = explicitClosed(row);
  if (providerState != null) {
    return { isClosed: providerState, closeStateSource: 'provider' };
  }
  if (nextTime != null && nextTime > time) {
    return { isClosed: true, closeStateSource: 'sequence' };
  }
  if (Number.isFinite(nowSeconds) && nowSeconds >= time + intervalSeconds + 5) {
    return { isClosed: true, closeStateSource: 'clock' };
  }
  return { isClosed: false, closeStateSource: 'unknown' };
}

export function normalizeChartCandles(
  rows: RawCandle[],
  timeframe: ChartCandleTimeframe,
  nowSeconds = Math.floor(Date.now() / 1_000),
): ChartCandleNormalizationResult {
  const accepted: Array<{ normalized: Omit<NormalizedChartCandle, 'isClosed' | 'closeStateSource'>; raw: RawCandle }> = [];
  let droppedRows = 0;

  for (const row of rows) {
    const normalized = normalizeRow(row);
    if (!normalized) {
      droppedRows += 1;
      continue;
    }
    accepted.push({ normalized, raw: row });
  }

  accepted.sort((left, right) => left.normalized.time - right.normalized.time);
  const byTime = new Map<number, { normalized: Omit<NormalizedChartCandle, 'isClosed' | 'closeStateSource'>; raw: RawCandle }>();
  let duplicateRows = 0;
  for (const item of accepted) {
    if (byTime.has(item.normalized.time)) duplicateRows += 1;
    byTime.set(item.normalized.time, item);
  }

  const unique = [...byTime.values()].sort((left, right) => left.normalized.time - right.normalized.time);
  const intervalSeconds = chartTimeframeSeconds(timeframe);
  const candles = unique.map((item, index) => {
    const nextTime = unique[index + 1]?.normalized.time ?? null;
    return {
      ...item.normalized,
      ...closeState(item.raw, item.normalized.time, nextTime, intervalSeconds, nowSeconds),
    };
  });

  const discontinuities: ChartCandleDiscontinuity[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1];
    const current = candles[index];
    const elapsedSeconds = current.time - previous.time;
    if (elapsedSeconds <= intervalSeconds * 1.5) continue;
    discontinuities.push({
      previousTime: previous.time,
      nextTime: current.time,
      elapsedSeconds,
      expectedSeconds: intervalSeconds,
      estimatedMissingBars: Math.max(0, Math.round(elapsedSeconds / intervalSeconds) - 1),
    });
  }

  const warnings: string[] = [];
  if (droppedRows) warnings.push(`유효하지 않은 캔들 ${droppedRows}개 제외`);
  if (duplicateRows) warnings.push(`중복 시각 캔들 ${duplicateRows}개 병합`);
  if (discontinuities.length) warnings.push(`시간 불연속 구간 ${discontinuities.length}개 감지`);
  if (!candles.length) warnings.push('사용 가능한 실제 캔들이 없음');

  return { candles, droppedRows, duplicateRows, discontinuities, warnings };
}
