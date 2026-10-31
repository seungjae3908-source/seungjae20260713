// market-regime-classifier.mjs
// BLOCK 19 Step 1 — AI 시장 국면 분류기
//
// 국면(REGIME):
//   STRONG_UPTREND / STRONG_DOWNTREND / SIDEWAYS / HIGH_VOLATILITY
//   FAIL_CLOSED — 데이터 부족/오래됨/이상 → 신규 진입 절대 금지
//
// 원칙:
//   - Look-ahead bias 금지: 현재·과거 데이터만 사용
//   - HIGH_VOLATILITY 는 추세보다 우선 판정 (신규 진입 차단)
//   - fail-closed 시 allowNewEntry=false 강제

export const REGIME = Object.freeze({
  STRONG_UPTREND: 'STRONG_UPTREND',
  STRONG_DOWNTREND: 'STRONG_DOWNTREND',
  SIDEWAYS: 'SIDEWAYS',
  HIGH_VOLATILITY: 'HIGH_VOLATILITY',
  FAIL_CLOSED: 'FAIL_CLOSED',
});

const DEFAULTS = Object.freeze({
  maxDataAgeMs: 60_000,
  minCandles: 30,
  adxTrendMin: 25,
  adxStrongMin: 40,
  rsiUpMin: 55,
  rsiDownMax: 45,
  bbWidthHigh: 0.06,
  atrPctHigh: 0.04,
});

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function failClosed(reason) {
  return {
    regime: REGIME.FAIL_CLOSED,
    confidence: 0,
    reasons: [reason],
    failClosed: true,
    allowNewEntry: false,
    indicators: null,
  };
}

function hasFiniteNumber(obj, key) {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v);
}

export function classifyRegime(input = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();

  const lastUpdateMs = Number(input.lastUpdateMs);
  if (!Number.isFinite(lastUpdateMs)) return failClosed('STALE_UNKNOWN');
  if (lastUpdateMs > now + 5_000) return failClosed('CLOCK_SKEW');
  if (now - lastUpdateMs > o.maxDataAgeMs) return failClosed('STALE_DATA');

  const candles = Array.isArray(input.candles) ? input.candles : [];
  if (candles.length < o.minCandles) return failClosed('INSUFFICIENT_CANDLES');

  const required = ['atr', 'adx', 'rsi', 'macdHistogram', 'bbWidth', 'vwap', 'currentPrice'];
  for (const k of required) {
    if (!hasFiniteNumber(input, k)) return failClosed(`MISSING_OR_NAN:${k}`);
  }

  const { atr, adx, rsi, macdHistogram, bbWidth, vwap, currentPrice } = input;

  if (!(currentPrice > 0)) return failClosed('INVALID_PRICE');
  if (!(atr >= 0)) return failClosed('INVALID_ATR');
  if (!(adx >= 0 && adx <= 100)) return failClosed('INVALID_ADX');
  if (!(rsi >= 0 && rsi <= 100)) return failClosed('INVALID_RSI');
  if (!(bbWidth >= 0)) return failClosed('INVALID_BB_WIDTH');
  if (!(vwap > 0)) return failClosed('INVALID_VWAP');

  const atrPct = currentPrice > 0 ? atr / currentPrice : 0;

  const highVolReasons = [];
  if (bbWidth >= o.bbWidthHigh) {
    highVolReasons.push(`bbWidth=${bbWidth.toFixed(4)}>=${o.bbWidthHigh}`);
  }
  if (atrPct >= o.atrPctHigh) {
    highVolReasons.push(`atrPct=${atrPct.toFixed(4)}>=${o.atrPctHigh}`);
  }
  if (highVolReasons.length >= 1) {
    return {
      regime: REGIME.HIGH_VOLATILITY,
      confidence: clamp01(highVolReasons.length / 2),
      reasons: highVolReasons,
      failClosed: false,
      allowNewEntry: false,
      indicators: { atr, atrPct, adx, rsi, macdHistogram, bbWidth, vwap, currentPrice },
    };
  }

  if (adx >= o.adxTrendMin) {
    const strong = adx >= o.adxStrongMin;

    if (rsi >= o.rsiUpMin && macdHistogram > 0 && currentPrice > vwap) {
      return {
        regime: REGIME.STRONG_UPTREND,
        confidence: strong ? 0.9 : 0.7,
        reasons: [
          `adx=${adx.toFixed(1)}>=${o.adxTrendMin}`,
          `rsi=${rsi.toFixed(1)}>=${o.rsiUpMin}`,
          'macdHistogram>0',
          'price>vwap',
        ],
        failClosed: false,
        allowNewEntry: true,
        indicators: { atr, atrPct, adx, rsi, macdHistogram, bbWidth, vwap, currentPrice },
      };
    }

    if (rsi <= o.rsiDownMax && macdHistogram < 0 && currentPrice < vwap) {
      return {
        regime: REGIME.STRONG_DOWNTREND,
        confidence: strong ? 0.9 : 0.7,
        reasons: [
          `adx=${adx.toFixed(1)}>=${o.adxTrendMin}`,
          `rsi=${rsi.toFixed(1)}<=${o.rsiDownMax}`,
          'macdHistogram<0',
          'price<vwap',
        ],
        failClosed: false,
        allowNewEntry: true,
        indicators: { atr, atrPct, adx, rsi, macdHistogram, bbWidth, vwap, currentPrice },
      };
    }
  }

  const sideReasons = [];
  if (adx < o.adxTrendMin) sideReasons.push(`adx=${adx.toFixed(1)}<${o.adxTrendMin}`);
  if (rsi > o.rsiDownMax && rsi < o.rsiUpMin) {
    sideReasons.push(`rsi=${rsi.toFixed(1)} neutral`);
  }

  return {
    regime: REGIME.SIDEWAYS,
    confidence: clamp01(sideReasons.length / 2),
    reasons: sideReasons.length ? sideReasons : ['default_sideways'],
    failClosed: false,
    allowNewEntry: true,
    indicators: { atr, atrPct, adx, rsi, macdHistogram, bbWidth, vwap, currentPrice },
  };
}

export function allowsNewEntry(input = {}, opts = {}) {
  return classifyRegime(input, opts).allowNewEntry === true;
}

export { DEFAULTS as REGIME_DEFAULTS };
