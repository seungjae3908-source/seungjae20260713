// Deterministic research "atoms": closed-candle boolean conditions built only
// from candles[0..i]. Each atom is one ingredient (indicator formula, candle
// pattern, swing/wave structure or chart pattern). The combination search
// joins atoms with AND. Nothing here places orders or calls an AI provider.

export const COMBINATION_ATOM_LIBRARY_VERSION = 'combination-atoms-v1.0';

export const ATOM_FAMILIES = Object.freeze(['TREND', 'MOMENTUM', 'VOLATILITY', 'VOLUME', 'CANDLE', 'WAVE', 'PATTERN']);

// side: LONG = buy/long idea, SHORT = short idea, BOTH = direction-neutral filter.
export const COMBINATION_ATOMS_V1 = Object.freeze([
  ['T_CLOSE_ABOVE_SMA50', 'TREND', 'LONG', '종가 > 50봉 이동평균'],
  ['T_CLOSE_BELOW_SMA50', 'TREND', 'SHORT', '종가 < 50봉 이동평균'],
  ['T_CLOSE_ABOVE_SMA200', 'TREND', 'LONG', '종가 > 200봉 이동평균'],
  ['T_CLOSE_BELOW_SMA200', 'TREND', 'SHORT', '종가 < 200봉 이동평균'],
  ['T_SMA20_ABOVE_SMA50', 'TREND', 'LONG', '20봉 평균 > 50봉 평균(정배열)'],
  ['T_SMA20_BELOW_SMA50', 'TREND', 'SHORT', '20봉 평균 < 50봉 평균(역배열)'],
  ['T_EMA12_CROSS_UP_EMA26', 'TREND', 'LONG', 'EMA12가 EMA26 상향 돌파(골든크로스)'],
  ['T_EMA12_CROSS_DOWN_EMA26', 'TREND', 'SHORT', 'EMA12가 EMA26 하향 돌파(데드크로스)'],
  ['T_ADX14_GT_25', 'TREND', 'BOTH', 'ADX14 > 25(추세 강함)'],
  ['M_RSI14_LT_30', 'MOMENTUM', 'LONG', 'RSI14 < 30(과매도)'],
  ['M_RSI14_GT_70', 'MOMENTUM', 'SHORT', 'RSI14 > 70(과매수)'],
  ['M_RSI14_GT_50', 'MOMENTUM', 'LONG', 'RSI14 > 50'],
  ['M_RSI14_LT_50', 'MOMENTUM', 'SHORT', 'RSI14 < 50'],
  ['M_RSI14_CROSS_UP_30', 'MOMENTUM', 'LONG', 'RSI14가 30을 상향 돌파'],
  ['M_RSI14_CROSS_DOWN_70', 'MOMENTUM', 'SHORT', 'RSI14가 70을 하향 돌파'],
  ['M_MACD_HIST_POS', 'MOMENTUM', 'LONG', 'MACD 히스토그램 > 0'],
  ['M_MACD_HIST_NEG', 'MOMENTUM', 'SHORT', 'MACD 히스토그램 < 0'],
  ['M_MACD_CROSS_UP', 'MOMENTUM', 'LONG', 'MACD가 시그널 상향 돌파'],
  ['M_MACD_CROSS_DOWN', 'MOMENTUM', 'SHORT', 'MACD가 시그널 하향 돌파'],
  ['M_ROC10_POS', 'MOMENTUM', 'LONG', '10봉 변화율 > 0'],
  ['M_ROC10_NEG', 'MOMENTUM', 'SHORT', '10봉 변화율 < 0'],
  ['M_STOCH14_LT_20', 'MOMENTUM', 'LONG', '스토캐스틱 %K14 < 20'],
  ['M_STOCH14_GT_80', 'MOMENTUM', 'SHORT', '스토캐스틱 %K14 > 80'],
  ['V_BB20_BELOW_LOWER', 'VOLATILITY', 'LONG', '종가가 볼린저 하단 아래'],
  ['V_BB20_ABOVE_UPPER', 'VOLATILITY', 'SHORT', '종가가 볼린저 상단 위'],
  ['V_BB20_SQUEEZE', 'VOLATILITY', 'BOTH', '볼린저 폭이 최근 120봉 하위 20%(수축)'],
  ['V_ATR14_EXPANDING', 'VOLATILITY', 'BOTH', 'ATR14 > ATR14의 50봉 평균 × 1.2(변동성 확대)'],
  ['U_RVOL20_GT_1_5', 'VOLUME', 'BOTH', '거래량 > 직전 20봉 평균 × 1.5'],
  ['U_OBV_ABOVE_SMA20', 'VOLUME', 'LONG', 'OBV > OBV 20봉 평균'],
  ['U_OBV_BELOW_SMA20', 'VOLUME', 'SHORT', 'OBV < OBV 20봉 평균'],
  ['C_BULLISH_ENGULFING', 'CANDLE', 'LONG', '상승 장악형 캔들'],
  ['C_BEARISH_ENGULFING', 'CANDLE', 'SHORT', '하락 장악형 캔들'],
  ['C_HAMMER', 'CANDLE', 'LONG', '망치형(하락 후 긴 아래꼬리)'],
  ['C_SHOOTING_STAR', 'CANDLE', 'SHORT', '유성형(상승 후 긴 위꼬리)'],
  ['C_THREE_WHITE_SOLDIERS', 'CANDLE', 'LONG', '적삼병'],
  ['C_THREE_BLACK_CROWS', 'CANDLE', 'SHORT', '흑삼병'],
  ['C_INSIDE_BAR', 'CANDLE', 'BOTH', '인사이드 바(직전 봉 범위 안)'],
  ['W_SWING_UPTREND', 'WAVE', 'LONG', '스윙 고점·저점 모두 상승(HH+HL)'],
  ['W_SWING_DOWNTREND', 'WAVE', 'SHORT', '스윙 고점·저점 모두 하락(LH+LL)'],
  ['W_WAVE_PULLBACK_LONG', 'WAVE', 'LONG', '상승 파동 뒤 38.2~61.8% 되돌림(2·4파 근사)'],
  ['W_WAVE_BOUNCE_SHORT', 'WAVE', 'SHORT', '하락 파동 뒤 38.2~61.8% 반등(2·4파 근사)'],
  ['W_HIGHER_LOW_CONFIRMED', 'WAVE', 'LONG', '직전보다 높은 스윙 저점 확정'],
  ['W_LOWER_HIGH_CONFIRMED', 'WAVE', 'SHORT', '직전보다 낮은 스윙 고점 확정'],
  ['P_DONCHIAN20_BREAKOUT', 'PATTERN', 'LONG', '직전 20봉 최고가 돌파'],
  ['P_DONCHIAN20_BREAKDOWN', 'PATTERN', 'SHORT', '직전 20봉 최저가 이탈'],
  ['P_DOUBLE_BOTTOM_BREAK', 'PATTERN', 'LONG', '쌍바닥 후 넥라인 돌파'],
  ['P_DOUBLE_TOP_BREAK', 'PATTERN', 'SHORT', '쌍봉 후 넥라인 이탈'],
].map(([id, family, side, label]) => Object.freeze({ id, family, side, label })));

const ATOM_BY_ID = new Map(COMBINATION_ATOMS_V1.map((atom) => [atom.id, atom]));

export function combinationAtomV1(id) {
  const atom = ATOM_BY_ID.get(id);
  if (!atom) throw new Error(`COMBINATION_ATOM_UNKNOWN:${id}`);
  return atom;
}

export function atomsForDirectionV1(direction) {
  if (!['LONG', 'SHORT'].includes(direction)) throw new Error('COMBINATION_DIRECTION_INVALID');
  return Object.freeze(COMBINATION_ATOMS_V1.filter((atom) => atom.side === direction || atom.side === 'BOTH'));
}

// ---------- indicator series (null until warm) ----------

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v == null) { sum = 0; valid = 0; continue; }
    sum += v; valid += 1;
    if (valid > period) { sum -= values[i - period]; valid = period; }
    if (valid === period) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let current = null;
  let seed = 0;
  let count = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v == null) continue;
    if (current == null) {
      seed += v; count += 1;
      if (count === period) { current = seed / period; out[i] = current; }
    } else {
      current = ((v - current) * k) + current;
      out[i] = current;
    }
  }
  return out;
}

function rsi(close, period) {
  const out = new Array(close.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < close.length; i += 1) {
    const delta = close[i] - close[i - 1];
    const g = Math.max(delta, 0);
    const l = Math.max(-delta, 0);
    if (i <= period) {
      gain += g; loss += l;
      if (i === period) { gain /= period; loss /= period; out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - (100 / (1 + (gain / loss))); }
    } else {
      gain = ((gain * (period - 1)) + g) / period;
      loss = ((loss * (period - 1)) + l) / period;
      out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - (100 / (1 + (gain / loss)));
    }
  }
  return out;
}

function trueRange(c, i) {
  if (i === 0) return c[0].high - c[0].low;
  return Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
}

function adx(c, period) {
  const out = new Array(c.length).fill(null);
  let tr = 0; let plus = 0; let minus = 0;
  const seed = [];
  let current = null;
  const dx = () => {
    if (!(tr > 0)) return 0;
    const p = 100 * (plus / tr); const m = 100 * (minus / tr);
    return p + m === 0 ? 0 : 100 * (Math.abs(p - m) / (p + m));
  };
  for (let i = 1; i < c.length; i += 1) {
    const up = c[i].high - c[i - 1].high;
    const down = c[i - 1].low - c[i].low;
    const pdm = up > down && up > 0 ? up : 0;
    const mdm = down > up && down > 0 ? down : 0;
    const t = trueRange(c, i);
    if (i <= period) {
      tr += t; plus += pdm; minus += mdm;
      if (i === period) seed.push(dx());
      continue;
    }
    tr = tr - (tr / period) + t; plus = plus - (plus / period) + pdm; minus = minus - (minus / period) + mdm;
    const value = dx();
    if (current == null) {
      seed.push(value);
      if (seed.length === period) { current = seed.reduce((a, b) => a + b, 0) / period; out[i] = current; }
    } else {
      current = ((current * (period - 1)) + value) / period;
      out[i] = current;
    }
  }
  return out;
}

function atr(c, period) {
  const tr = c.map((_, i) => (i === 0 ? null : trueRange(c, i)));
  return sma(tr, period);
}

function rollingStd(values, means, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    if (means[i] == null) continue;
    let s = 0;
    for (let j = i - period + 1; j <= i; j += 1) s += (values[j] - means[i]) ** 2;
    out[i] = Math.sqrt(s / period);
  }
  return out;
}

function priorExtreme(values, period, pick) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i += 1) {
    let best = values[i - period];
    for (let j = i - period + 1; j < i; j += 1) best = pick(best, values[j]);
    out[i] = best;
  }
  return out;
}

function rollingPercentRank(values, window) {
  const out = new Array(values.length).fill(null);
  for (let i = window - 1; i < values.length; i += 1) {
    const v = values[i];
    if (v == null) continue;
    let below = 0; let n = 0;
    for (let j = i - window + 1; j <= i; j += 1) {
      if (values[j] == null) continue;
      n += 1;
      if (values[j] <= v) below += 1;
    }
    if (n === window) out[i] = below / n;
  }
  return out;
}

// Swing pivots with k bars on each side. A pivot at bar j is only *known* at
// bar j + k, so every wave/pattern atom below reads pivots confirmed <= i.
function swingTimeline(c, k) {
  const highs = []; const lows = [];
  const highsAt = new Array(c.length); const lowsAt = new Array(c.length);
  const newHighAt = new Array(c.length).fill(false); const newLowAt = new Array(c.length).fill(false);
  for (let i = 0; i < c.length; i += 1) {
    const j = i - k;
    if (j >= k) {
      let isHigh = true; let isLow = true;
      for (let m = j - k; m <= j + k; m += 1) {
        if (m === j) continue;
        if (m < j ? c[m].high >= c[j].high : c[m].high > c[j].high) isHigh = false;
        if (m < j ? c[m].low <= c[j].low : c[m].low < c[j].low) isLow = false;
      }
      if (isHigh) { highs.push({ index: j, price: c[j].high }); newHighAt[i] = true; }
      if (isLow) { lows.push({ index: j, price: c[j].low }); newLowAt[i] = true; }
    }
    highsAt[i] = highs.length; lowsAt[i] = lows.length;
  }
  return { highs, lows, highsAt, lowsAt, newHighAt, newLowAt };
}

export function swingLookbackForTimeframeV1(timeframe) {
  return timeframe === '1d' ? 3 : 5;
}

/**
 * Returns Map<atomId, Uint8Array> where 1 means the atom is true on the
 * closed candle at that index. Index i uses only candles[0..i].
 */
export function computeCombinationAtomsV1(candles, { timeframe = '1h' } = {}) {
  if (!Array.isArray(candles) || candles.length < 60) throw new Error('COMBINATION_ATOMS_INSUFFICIENT_CANDLES');
  const n = candles.length;
  const close = candles.map((x) => x.close);
  const volume = candles.map((x) => x.volume);
  const sma20 = sma(close, 20); const sma50 = sma(close, 50); const sma200 = sma(close, 200);
  const ema12 = ema(close, 12); const ema26 = ema(close, 26);
  const macdLine = ema12.map((v, i) => (v == null || ema26[i] == null ? null : v - ema26[i]));
  const macdSignal = ema(macdLine, 9);
  const macdHist = macdLine.map((v, i) => (v == null || macdSignal[i] == null ? null : v - macdSignal[i]));
  const rsi14 = rsi(close, 14);
  const adx14 = adx(candles, 14);
  const atr14 = atr(candles, 14);
  const atrMean50 = sma(atr14, 50);
  const bbStd = rollingStd(close, sma20, 20);
  const bbUpper = sma20.map((m, i) => (m == null || bbStd[i] == null ? null : m + (2 * bbStd[i])));
  const bbLower = sma20.map((m, i) => (m == null || bbStd[i] == null ? null : m - (2 * bbStd[i])));
  const bbWidth = sma20.map((m, i) => (m == null || bbStd[i] == null || m === 0 ? null : (4 * bbStd[i]) / m));
  const bbWidthRank = rollingPercentRank(bbWidth, 120);
  const priorVolMean = volume.map((_, i) => {
    if (i < 20) return null;
    let s = 0; for (let j = i - 20; j < i; j += 1) s += volume[j];
    return s / 20;
  });
  const obv = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) obv[i] = obv[i - 1] + (close[i] > close[i - 1] ? volume[i] : close[i] < close[i - 1] ? -volume[i] : 0);
  const obvSma20 = sma(obv, 20);
  const priorHigh20 = priorExtreme(candles.map((x) => x.high), 20, Math.max);
  const priorLow20 = priorExtreme(candles.map((x) => x.low), 20, Math.min);
  const stochK = candles.map((_, i) => {
    if (i < 13) return null;
    let hi = -Infinity; let lo = Infinity;
    for (let j = i - 13; j <= i; j += 1) { hi = Math.max(hi, candles[j].high); lo = Math.min(lo, candles[j].low); }
    return hi === lo ? 50 : (100 * (close[i] - lo)) / (hi - lo);
  });
  const k = swingLookbackForTimeframeV1(timeframe);
  const swings = swingTimeline(candles, k);

  const atoms = new Map(COMBINATION_ATOMS_V1.map((atom) => [atom.id, new Uint8Array(n)]));
  const set = (id, i, value) => { if (value === true) atoms.get(id)[i] = 1; };
  const ok = (...values) => values.every((v) => v != null && Number.isFinite(v));

  for (let i = 1; i < n; i += 1) {
    const c = candles[i]; const p = candles[i - 1];
    if (ok(sma50[i])) { set('T_CLOSE_ABOVE_SMA50', i, close[i] > sma50[i]); set('T_CLOSE_BELOW_SMA50', i, close[i] < sma50[i]); }
    if (ok(sma200[i])) { set('T_CLOSE_ABOVE_SMA200', i, close[i] > sma200[i]); set('T_CLOSE_BELOW_SMA200', i, close[i] < sma200[i]); }
    if (ok(sma20[i], sma50[i])) { set('T_SMA20_ABOVE_SMA50', i, sma20[i] > sma50[i]); set('T_SMA20_BELOW_SMA50', i, sma20[i] < sma50[i]); }
    if (ok(ema12[i], ema26[i], ema12[i - 1], ema26[i - 1])) {
      set('T_EMA12_CROSS_UP_EMA26', i, ema12[i - 1] <= ema26[i - 1] && ema12[i] > ema26[i]);
      set('T_EMA12_CROSS_DOWN_EMA26', i, ema12[i - 1] >= ema26[i - 1] && ema12[i] < ema26[i]);
    }
    if (ok(adx14[i])) set('T_ADX14_GT_25', i, adx14[i] > 25);
    if (ok(rsi14[i])) {
      set('M_RSI14_LT_30', i, rsi14[i] < 30); set('M_RSI14_GT_70', i, rsi14[i] > 70);
      set('M_RSI14_GT_50', i, rsi14[i] > 50); set('M_RSI14_LT_50', i, rsi14[i] < 50);
      if (ok(rsi14[i - 1])) {
        set('M_RSI14_CROSS_UP_30', i, rsi14[i - 1] <= 30 && rsi14[i] > 30);
        set('M_RSI14_CROSS_DOWN_70', i, rsi14[i - 1] >= 70 && rsi14[i] < 70);
      }
    }
    if (ok(macdHist[i])) {
      set('M_MACD_HIST_POS', i, macdHist[i] > 0); set('M_MACD_HIST_NEG', i, macdHist[i] < 0);
      if (ok(macdHist[i - 1])) {
        set('M_MACD_CROSS_UP', i, macdHist[i - 1] <= 0 && macdHist[i] > 0);
        set('M_MACD_CROSS_DOWN', i, macdHist[i - 1] >= 0 && macdHist[i] < 0);
      }
    }
    if (i >= 10) { set('M_ROC10_POS', i, close[i] > close[i - 10]); set('M_ROC10_NEG', i, close[i] < close[i - 10]); }
    if (ok(stochK[i])) { set('M_STOCH14_LT_20', i, stochK[i] < 20); set('M_STOCH14_GT_80', i, stochK[i] > 80); }
    if (ok(bbLower[i], bbUpper[i])) { set('V_BB20_BELOW_LOWER', i, close[i] < bbLower[i]); set('V_BB20_ABOVE_UPPER', i, close[i] > bbUpper[i]); }
    if (ok(bbWidthRank[i])) set('V_BB20_SQUEEZE', i, bbWidthRank[i] <= 0.2);
    if (ok(atr14[i], atrMean50[i])) set('V_ATR14_EXPANDING', i, atr14[i] > atrMean50[i] * 1.2);
    if (ok(priorVolMean[i]) && priorVolMean[i] > 0) set('U_RVOL20_GT_1_5', i, volume[i] > priorVolMean[i] * 1.5);
    if (ok(obvSma20[i])) { set('U_OBV_ABOVE_SMA20', i, obv[i] > obvSma20[i]); set('U_OBV_BELOW_SMA20', i, obv[i] < obvSma20[i]); }

    // Candles
    const body = Math.abs(c.close - c.open); const range = c.high - c.low;
    const pBody = Math.abs(p.close - p.open);
    set('C_BULLISH_ENGULFING', i, p.close < p.open && c.close > c.open && c.open <= p.close && c.close >= p.open && body > pBody);
    set('C_BEARISH_ENGULFING', i, p.close > p.open && c.close < c.open && c.open >= p.close && c.close <= p.open && body > pBody);
    if (range > 0 && i >= 5) {
      const lowerWick = Math.min(c.open, c.close) - c.low; const upperWick = c.high - Math.max(c.open, c.close);
      set('C_HAMMER', i, body <= 0.35 * range && lowerWick >= 0.6 * range && close[i - 1] < close[i - 5]);
      set('C_SHOOTING_STAR', i, body <= 0.35 * range && upperWick >= 0.6 * range && close[i - 1] > close[i - 5]);
    }
    if (i >= 2) {
      const three = [candles[i - 2], p, c];
      const strong = three.every((x) => x.high > x.low && Math.abs(x.close - x.open) >= 0.5 * (x.high - x.low));
      set('C_THREE_WHITE_SOLDIERS', i, strong && three.every((x) => x.close > x.open) && c.close > p.close && p.close > three[0].close);
      set('C_THREE_BLACK_CROWS', i, strong && three.every((x) => x.close < x.open) && c.close < p.close && p.close < three[0].close);
    }
    set('C_INSIDE_BAR', i, c.high < p.high && c.low > p.low);

    // Waves (confirmed pivots only)
    const hN = swings.highsAt[i]; const lN = swings.lowsAt[i];
    if (hN >= 2 && lN >= 2) {
      const h2 = swings.highs[hN - 1]; const h1 = swings.highs[hN - 2];
      const l2 = swings.lows[lN - 1]; const l1 = swings.lows[lN - 2];
      const up = h2.price > h1.price && l2.price > l1.price;
      const down = h2.price < h1.price && l2.price < l1.price;
      set('W_SWING_UPTREND', i, up); set('W_SWING_DOWNTREND', i, down);
      if (up && h2.index > l2.index) {
        const leg = h2.price - l2.price;
        const retrace = leg > 0 ? (h2.price - close[i]) / leg : -1;
        set('W_WAVE_PULLBACK_LONG', i, retrace >= 0.382 && retrace <= 0.618);
      }
      if (down && l2.index > h2.index) {
        const leg = h2.price - l2.price;
        const bounce = leg > 0 ? (close[i] - l2.price) / leg : -1;
        set('W_WAVE_BOUNCE_SHORT', i, bounce >= 0.382 && bounce <= 0.618);
      }
      set('W_HIGHER_LOW_CONFIRMED', i, swings.newLowAt[i] && l2.price > l1.price);
      set('W_LOWER_HIGH_CONFIRMED', i, swings.newHighAt[i] && h2.price < h1.price);
      // Double bottom / top: two latest pivots within 0.75 ATR, neckline cross within 30 bars.
      if (ok(atr14[i])) {
        if (Math.abs(l2.price - l1.price) <= 0.75 * atr14[i] && i - l2.index <= 30) {
          let neck = -Infinity;
          for (let j = l1.index; j <= l2.index; j += 1) neck = Math.max(neck, candles[j].high);
          set('P_DOUBLE_BOTTOM_BREAK', i, close[i - 1] <= neck && close[i] > neck);
        }
        if (Math.abs(h2.price - h1.price) <= 0.75 * atr14[i] && i - h2.index <= 30) {
          let neck = Infinity;
          for (let j = h1.index; j <= h2.index; j += 1) neck = Math.min(neck, candles[j].low);
          set('P_DOUBLE_TOP_BREAK', i, close[i - 1] >= neck && close[i] < neck);
        }
      }
    }
    if (ok(priorHigh20[i])) set('P_DONCHIAN20_BREAKOUT', i, close[i] > priorHigh20[i]);
    if (ok(priorLow20[i])) set('P_DONCHIAN20_BREAKDOWN', i, close[i] < priorLow20[i]);
  }
  return atoms;
}
