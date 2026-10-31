// Signal generators for E (Donchian), G (Volume), H (Squeeze)
// All return { action: 'long'|'short'|'exit_long'|'exit_short'|'none', i }
// IMPORTANT: signal at candle[i] → execute at candle[i+1].open

export function getDonchianSignals(candles, params = {}) {
  const entryLB = params.entryLB || 20;
  const exitLB = params.exitLB || 10;
  const minBars = Math.max(entryLB, exitLB) + 1;
  const signals = [];
  for (let i = 0; i < candles.length; i++) {
    let action = 'none';
    if (i >= minBars) {
      const entryW = candles.slice(i - entryLB, i);
      const highN = Math.max(...entryW.map(x => x.high));
      const lowN = Math.min(...entryW.map(x => x.low));
      const exitW = candles.slice(i - exitLB, i);
      const exitHigh = Math.max(...exitW.map(x => x.high));
      const exitLow = Math.min(...exitW.map(x => x.low));
      const c = candles[i];
      if (c.close > highN) action = 'long';
      else if (c.close < lowN) action = 'short';
      else if (c.close < exitLow) action = 'exit_long';
      else if (c.close > exitHigh) action = 'exit_short';
    }
    signals.push({ action, i });
  }
  return signals;
}

export function getVolumeBreakoutSignals(candles, params = {}) {
  const rangeLB = params.rangeLB || 20;
  const volLB = params.volLB || 20;
  const volMult = params.volMult !== undefined ? params.volMult : 1.5;
  const atrPeriod = 14;
  const atrMinRatio = params.atrMinRatio || 0.005;
  const minBars = Math.max(rangeLB, volLB, atrPeriod) + 1;
  const trs = candles.map((c, i) => i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i-1].close), Math.abs(c.low - candles[i-1].close)));
  const atr = candles.map((_, i) => i >= atrPeriod - 1 ? trs.slice(i - atrPeriod + 1, i + 1).reduce((s, t) => s + t, 0) / atrPeriod : null);
  const signals = [];
  for (let i = 0; i < candles.length; i++) {
    let action = 'none';
    if (i >= minBars && atr[i] !== null) {
      const rangeW = candles.slice(i - rangeLB, i);
      const highN = Math.max(...rangeW.map(x => x.high));
      const lowN = Math.min(...rangeW.map(x => x.low));
      const volW = candles.slice(i - volLB, i);
      const avgVol = volW.reduce((s, x) => s + x.volume, 0) / volLB;
      const c = candles[i];
      const atrRatio = atr[i] / c.close;
      if (atrRatio >= atrMinRatio) {
        const volOk = volMult === 0 ? true : c.volume > volMult * avgVol;
        if (c.close > highN && volOk) action = 'long';
        else if (c.close < lowN && volOk) action = 'short';
      }
    }
    signals.push({ action, i });
  }
  return signals;
}

export function getSqueezeSignals(candles, params = {}) {
  const bbPeriod = params.bbPeriod || 20;
  const bbMult = params.bbMult || 2.0;
  const kcMult = params.kcMult || 1.5;
  const atrPeriod = 14;
  const minBars = Math.max(bbPeriod, atrPeriod) + 1;
  const trs = candles.map((c, i) => i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i-1].close), Math.abs(c.low - candles[i-1].close)));
  const atr = candles.map((_, i) => i >= atrPeriod - 1 ? trs.slice(i - atrPeriod + 1, i + 1).reduce((s, t) => s + t, 0) / atrPeriod : null);
  const sma = candles.map((_, i) => i >= bbPeriod - 1 ? candles.slice(i - bbPeriod + 1, i + 1).reduce((s, c) => s + c.close, 0) / bbPeriod : null);
  const signals = [];
  let inSqueeze = false;
  let squeezeCount = 0, releaseCount = 0;
  for (let i = 0; i < candles.length; i++) {
    let action = 'none';
    if (i >= minBars && atr[i] !== null && sma[i] !== null) {
      const w = candles.slice(i - bbPeriod + 1, i + 1);
      const variance = w.reduce((s, c) => s + Math.pow(c.close - sma[i], 2), 0) / bbPeriod;
      const std = Math.sqrt(variance);
      const bbUpper = sma[i] + bbMult * std;
      const bbLower = sma[i] - bbMult * std;
      const kcUpper = sma[i] + kcMult * atr[i];
      const kcLower = sma[i] - kcMult * atr[i];
      const isSqueeze = bbUpper < kcUpper && bbLower > kcLower;
      const c = candles[i];
      if (isSqueeze) { if (!inSqueeze) squeezeCount++; inSqueeze = true; }
      else if (!isSqueeze && inSqueeze) {
        releaseCount++;
        if (c.close > bbUpper) action = 'long';
        else if (c.close < bbLower) action = 'short';
        inSqueeze = false;
      }
    }
    signals.push({ action, i });
  }
  // Attach squeeze stats as property (for reporting)
  signals._stats = { squeezeCount, releaseCount };
  return signals;
}
