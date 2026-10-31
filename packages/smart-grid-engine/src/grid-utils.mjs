// grid-utils.mjs - ADX, Wilder smoothing, 공통 헬퍼
export function computeADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high, down = p.low - c.low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const wilder = (arr) => {
    if (arr.length < period) return [];
    const out = [];
    let sum = arr.slice(0, period).reduce((a, b) => a + b, 0);
    out.push(sum);
    for (let i = period; i < arr.length; i++) { sum = sum - sum / period + arr[i]; out.push(sum); }
    return out;
  };
  const trS = wilder(tr), plusS = wilder(plusDM), minusS = wilder(minusDM);
  const dx = [];
  for (let i = 0; i < Math.min(trS.length, plusS.length, minusS.length); i++) {
    if (trS[i] <= 0) { dx.push(0); continue; }
    const pdi = 100 * plusS[i] / trS[i];
    const mdi = 100 * minusS[i] / trS[i];
    const sum = pdi + mdi;
    dx.push(sum > 0 ? 100 * Math.abs(pdi - mdi) / sum : 0);
  }
  const adxArr = wilder(dx);
  return adxArr.length > 0 ? +(adxArr[adxArr.length - 1] / period).toFixed(2) : null;
}

export function roundPrice(price, pricePlace) {
  const f = Math.pow(10, pricePlace);
  return Math.round(price * f) / f;
}

export function applySlippage(price, side, slippage) {
  return side === 'BUY' ? price * (1 + slippage) : price * (1 - slippage);
}

export const COMMON_CONSTANTS = {
  FEE_RATE: 0.0006,
  SLIPPAGE: 0.0002,
  MAINT_MARGIN: 0.005,
};
