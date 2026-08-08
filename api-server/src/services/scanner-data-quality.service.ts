export type ScannerDataQualityState = 'TRUSTED' | 'DEGRADED' | 'DATA_UNTRUSTED';

export type ScannerDataQualityCode =
  | 'STALE_TIMESTAMP'
  | 'MISSING_CANDLE'
  | 'DUPLICATE_CANDLE'
  | 'INVALID_OHLC'
  | 'INVALID_VOLUME'
  | 'ABNORMAL_SPIKE'
  | 'SYMBOL_MISMATCH'
  | 'PROVIDER_DISAGREEMENT'
  | 'MARKET_CLOSED'
  | 'TRADING_HALT';

export interface ScannerQualityCandle {
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ScannerProviderObservation {
  provider: string;
  symbol: string;
  price: number;
  observedAt: string | number;
}

export interface ScannerDataQualityIssue {
  code: ScannerDataQualityCode;
  severity: 'warning' | 'blocking';
  message: string;
}

export interface ScannerDataQualityResult {
  state: ScannerDataQualityState;
  score: number;
  strongSignalAllowed: boolean;
  issues: ScannerDataQualityIssue[];
  observedCandleCount: number;
  expectedIntervalMs: number | null;
  lastTimestamp: string | null;
}

export interface ScannerDataQualityInput {
  symbol: string;
  timeframe: string;
  candles: ScannerQualityCandle[];
  now?: number;
  providerObservations?: ScannerProviderObservation[];
  marketClosed?: boolean;
  tradingHalt?: boolean;
  sessionAware?: boolean;
  staleMultiplier?: number;
  providerDisagreementPercent?: number;
}

const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '60m': 60 * 60_000,
  '1H': 60 * 60_000,
  '4H': 4 * 60 * 60_000,
  '1D': 24 * 60 * 60_000,
  '1W': 7 * 24 * 60 * 60_000,
};

function compactKoreaTimestamp(value: string): number | null {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 8 && digits.length !== 14) return null;
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  const hour = digits.length === 14 ? digits.slice(8, 10) : '00';
  const minute = digits.length === 14 ? digits.slice(10, 12) : '00';
  const second = digits.length === 14 ? digits.slice(12, 14) : '00';
  const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value: string | number): number | null {
  if (typeof value === 'number') {
    const parsed = value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const compact = compactKoreaTimestamp(value);
  if (compact != null) return compact;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function pushIssue(
  issues: ScannerDataQualityIssue[],
  code: ScannerDataQualityCode,
  severity: ScannerDataQualityIssue['severity'],
  message: string,
): void {
  if (issues.some((issue) => issue.code === code && issue.severity === severity)) return;
  issues.push({ code, severity, message });
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function shouldInspectGap(
  gap: number,
  expectedIntervalMs: number,
  timeframe: string,
  sessionAware: boolean,
): boolean {
  if (gap <= expectedIntervalMs * 1.8) return false;
  if (!sessionAware) return true;
  if (timeframe === '1D' || timeframe === '1W') return false;
  // Overnight/weekend closures are expected in stock markets. Six hours is
  // safely above an in-session interruption while below normal overnight gaps.
  if (gap >= 6 * 60 * 60_000) return false;
  return true;
}

function inspectCandles(
  input: ScannerDataQualityInput,
  issues: ScannerDataQualityIssue[],
  expectedIntervalMs: number | null,
  now: number,
): string | null {
  const seen = new Set<number>();
  const ordered: Array<{ at: number; candle: ScannerQualityCandle }> = [];

  for (const candle of input.candles) {
    const at = timestamp(candle.time);
    if (at == null) {
      pushIssue(issues, 'INVALID_OHLC', 'blocking', '캔들 timestamp가 유효하지 않습니다.');
      continue;
    }
    if (seen.has(at)) {
      pushIssue(issues, 'DUPLICATE_CANDLE', 'blocking', '동일 timestamp 캔들이 중복되었습니다.');
    }
    seen.add(at);
    ordered.push({ at, candle });

    const { open, high, low, close, volume } = candle;
    const prices = [open, high, low, close];
    const validPrices = prices.every((price) => Number.isFinite(price) && price > 0);
    if (!validPrices || high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      pushIssue(issues, 'INVALID_OHLC', 'blocking', 'OHLC 가격 관계가 유효하지 않습니다.');
    }
    if (!Number.isFinite(volume) || volume < 0) {
      pushIssue(issues, 'INVALID_VOLUME', 'blocking', '거래량이 음수이거나 유효한 숫자가 아닙니다.');
    }
  }

  ordered.sort((left, right) => left.at - right.at);
  if (!ordered.length) {
    pushIssue(issues, 'MISSING_CANDLE', 'blocking', '검증 가능한 캔들이 없습니다.');
    return null;
  }

  if (expectedIntervalMs != null && ordered.length >= 2) {
    const largeGaps = ordered.slice(1).filter((row, index) => shouldInspectGap(
      row.at - ordered[index].at,
      expectedIntervalMs,
      input.timeframe,
      input.sessionAware === true,
    ));
    if (largeGaps.length) {
      const ratio = largeGaps.length / Math.max(1, ordered.length - 1);
      pushIssue(
        issues,
        'MISSING_CANDLE',
        ratio >= 0.08 ? 'blocking' : 'warning',
        `예상 간격보다 큰 거래 구간 내 캔들 공백 ${largeGaps.length}개가 발견되었습니다.`,
      );
    }
  }

  const last = ordered.at(-1)!;
  if (expectedIntervalMs != null) {
    const staleMultiplier = Math.max(1.5, input.staleMultiplier ?? 3);
    if (now - last.at > expectedIntervalMs * staleMultiplier) {
      pushIssue(issues, 'STALE_TIMESTAMP', 'blocking', '최신 캔들 timestamp가 허용 범위를 벗어났습니다.');
    }
  }

  if (ordered.length >= 8) {
    const returns: number[] = [];
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1].candle.close;
      const current = ordered[index].candle.close;
      if (previous > 0 && current > 0) returns.push(Math.abs(current / previous - 1));
    }
    const baseline = median(returns.slice(0, -1));
    const latestMove = returns.at(-1) ?? 0;
    const dynamicLimit = Math.max(0.12, (baseline ?? 0) * 12);
    if (latestMove > dynamicLimit) {
      pushIssue(
        issues,
        'ABNORMAL_SPIKE',
        latestMove >= 0.45 ? 'blocking' : 'warning',
        `직전 캔들 대비 ${(latestMove * 100).toFixed(2)}% 급변이 감지되었습니다.`,
      );
    }
  }

  return new Date(last.at).toISOString();
}

function inspectProviders(
  input: ScannerDataQualityInput,
  issues: ScannerDataQualityIssue[],
): void {
  const observations = (input.providerObservations ?? []).filter((row) => (
    row.provider.trim()
    && Number.isFinite(row.price)
    && row.price > 0
  ));
  for (const row of observations) {
    if (row.symbol.trim().toUpperCase() !== input.symbol.trim().toUpperCase()) {
      pushIssue(
        issues,
        'SYMBOL_MISMATCH',
        'blocking',
        `provider ${row.provider}의 심볼이 요청 심볼과 일치하지 않습니다.`,
      );
    }
  }
  if (observations.length < 2) return;
  const prices = observations.map((row) => row.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const midpoint = (low + high) / 2;
  const disagreement = midpoint > 0 ? (high - low) / midpoint * 100 : Number.POSITIVE_INFINITY;
  const threshold = Math.max(0.1, input.providerDisagreementPercent ?? 2);
  if (disagreement > threshold) {
    pushIssue(
      issues,
      'PROVIDER_DISAGREEMENT',
      disagreement >= threshold * 2 ? 'blocking' : 'warning',
      `provider 가격 차이가 ${disagreement.toFixed(2)}%로 허용 범위를 넘었습니다.`,
    );
  }
}

export function evaluateScannerDataQuality(input: ScannerDataQualityInput): ScannerDataQualityResult {
  const issues: ScannerDataQualityIssue[] = [];
  const now = input.now ?? Date.now();
  const expectedIntervalMs = TIMEFRAME_MS[input.timeframe] ?? null;
  const lastTimestamp = inspectCandles(input, issues, expectedIntervalMs, now);
  inspectProviders(input, issues);

  if (input.marketClosed) {
    pushIssue(issues, 'MARKET_CLOSED', 'blocking', '현재 시장이 거래 가능 상태가 아닙니다.');
  }
  if (input.tradingHalt) {
    pushIssue(issues, 'TRADING_HALT', 'blocking', '거래 정지 상태가 감지되었습니다.');
  }

  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const blockingCount = issues.filter((issue) => issue.severity === 'blocking').length;
  const score = Math.round(clamp(100 - warningCount * 10 - blockingCount * 35));
  const state: ScannerDataQualityState = blockingCount > 0
    ? 'DATA_UNTRUSTED'
    : warningCount > 0
      ? 'DEGRADED'
      : 'TRUSTED';

  return {
    state,
    score,
    strongSignalAllowed: state !== 'DATA_UNTRUSTED' && score >= 80,
    issues,
    observedCandleCount: input.candles.length,
    expectedIntervalMs,
    lastTimestamp,
  };
}
