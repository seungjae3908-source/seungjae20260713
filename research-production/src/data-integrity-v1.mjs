// Dataset attestation and liquidity-aware cost for research datasets.
//
// verifyCandleDatasetV1: content hash, coverage, duplicate/out-of-order rows,
// OHLC consistency, missing bars and frozen (zero-volume) stretches. A FAIL
// dataset never enters a backtest; WARN is recorded and shown in the report.
//
// liquidityImpactV1: square-root market-impact estimate. A fixed slippage of a
// few basis points is fine for BTC or Samsung Electronics, but understates the
// cost of trading small names, which is exactly where a full-market universe
// adds symbols. Impact per side ~= daily volatility * sqrt(order / daily
// traded value), capped. Research only, executionAuthority NONE.

import { createHash } from 'node:crypto';

export const DATA_INTEGRITY_VERSION_V1 = 'data-integrity/v1';
export const LIQUIDITY_COST_MODEL_VERSION_V1 = 'sqrt-impact/v1';

const INTERVAL_MS = Object.freeze({ '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 });

export const DATA_INTEGRITY_POLICY_V1 = Object.freeze({
  warnMissingShare: 0.01,
  failMissingShare: 0.05,
  failOhlcViolations: 0,
  warnZeroVolumeShare: 0.02,
  failZeroVolumeShare: 0.2,
  // Daily stock data skips weekends and holidays; only a gap longer than this
  // many calendar days counts as missing data.
  dailyCalendarGapDays: 6,
});

export function candleDigestV1(candles) {
  const hash = createHash('sha256');
  for (const row of candles) hash.update(`${row.timestamp},${row.open},${row.high},${row.low},${row.close},${row.volume}\n`);
  return hash.digest('hex');
}

export function verifyCandleDatasetV1(candles, { timeframe = '1h', policy = DATA_INTEGRITY_POLICY_V1 } = {}) {
  const findings = [];
  if (!Array.isArray(candles) || candles.length === 0) {
    return Object.freeze({ version: DATA_INTEGRITY_VERSION_V1, status: 'FAIL', findings: ['EMPTY'], count: 0, sha256: null });
  }
  let outOfOrder = 0; let duplicates = 0; let ohlc = 0; let zeroVolume = 0; let missingBars = 0; let maxGapBars = 0;
  const interval = INTERVAL_MS[timeframe] ?? null;
  for (let i = 0; i < candles.length; i += 1) {
    const row = candles[i];
    const values = [row.open, row.high, row.low, row.close, row.volume];
    if (!values.every(Number.isFinite) || row.low <= 0 || row.high < row.low
      || row.open > row.high || row.open < row.low || row.close > row.high || row.close < row.low || row.volume < 0) ohlc += 1;
    if (!(row.volume > 0)) zeroVolume += 1;
    if (i === 0) continue;
    const delta = row.timestamp - candles[i - 1].timestamp;
    if (delta === 0) duplicates += 1;
    else if (delta < 0) outOfOrder += 1;
    else if (interval) {
      if (timeframe === '1d') {
        const gapDays = delta / 86_400_000;
        if (gapDays > policy.dailyCalendarGapDays) {
          const lost = Math.round(gapDays * (5 / 7)) - 1;
          missingBars += lost; maxGapBars = Math.max(maxGapBars, lost);
        }
      } else if (delta > interval) {
        const lost = Math.round(delta / interval) - 1;
        missingBars += lost; maxGapBars = Math.max(maxGapBars, lost);
      }
    }
  }
  const expected = candles.length + missingBars;
  const missingShare = expected > 0 ? missingBars / expected : 0;
  const zeroShare = zeroVolume / candles.length;
  if (outOfOrder > 0) findings.push(`OUT_OF_ORDER:${outOfOrder}`);
  if (duplicates > 0) findings.push(`DUPLICATE_TIMESTAMPS:${duplicates}`);
  if (ohlc > policy.failOhlcViolations) findings.push(`OHLC_VIOLATIONS:${ohlc}`);
  if (missingShare > policy.warnMissingShare) findings.push(`MISSING_BARS:${missingBars}`);
  if (zeroShare > policy.warnZeroVolumeShare) findings.push(`ZERO_VOLUME_BARS:${zeroVolume}`);
  const fail = outOfOrder > 0 || duplicates > 0 || ohlc > policy.failOhlcViolations
    || missingShare > policy.failMissingShare || zeroShare > policy.failZeroVolumeShare;
  const warn = !fail && findings.length > 0;
  return Object.freeze({
    version: DATA_INTEGRITY_VERSION_V1,
    status: fail ? 'FAIL' : warn ? 'WARN' : 'PASS',
    findings: Object.freeze(findings),
    count: candles.length,
    first: candles[0].timestamp,
    last: candles.at(-1).timestamp,
    missingBars,
    missingShare: Number(missingShare.toFixed(6)),
    maxGapBars,
    zeroVolumeShare: Number(zeroShare.toFixed(6)),
    sha256: candleDigestV1(candles),
  });
}

/** Daily traded-value and volatility profile of a candle series (any timeframe). */
export function liquidityProfileV1(candles, { timeframe = '1h', windowDays = 120 } = {}) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const byDay = new Map();
  for (const row of candles) {
    const day = Math.floor(row.timestamp / 86_400_000);
    const entry = byDay.get(day) ?? { value: 0, close: row.close, open: row.open };
    entry.value += Number(row.close) * Number(row.volume);
    entry.close = row.close;
    byDay.set(day, entry);
  }
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row).slice(-windowDays);
  if (days.length < 10) return null;
  const values = days.map((row) => row.value).sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const medianDailyValue = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  const returns = [];
  for (let i = 1; i < days.length; i += 1) if (days[i - 1].close > 0) returns.push(Math.log(days[i].close / days[i - 1].close));
  const mean = returns.reduce((s, r) => s + r, 0) / Math.max(1, returns.length);
  const dailyVolatility = Math.sqrt(returns.reduce((s, r) => s + ((r - mean) ** 2), 0) / Math.max(1, returns.length - 1));
  return Object.freeze({ medianDailyValue, dailyVolatility, days: days.length, timeframe });
}

/**
 * Extra slippage per side from market impact. `notional` and
 * `medianDailyValue` are in the venue currency.
 */
export function liquidityImpactV1({ notional, medianDailyValue, dailyVolatility, cap = 0.02 }) {
  if (!(notional > 0)) return 0;
  if (!(medianDailyValue > 0) || !Number.isFinite(dailyVolatility)) return cap;
  const participation = notional / medianDailyValue;
  return Math.min(cap, Math.max(0, dailyVolatility) * Math.sqrt(participation));
}
