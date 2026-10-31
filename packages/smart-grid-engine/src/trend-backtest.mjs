// Common single-position long/short backtest loop for E/G/H
// Entry at next candle open after signal, SL intrabar, exit at next open

export function runTrendBacktest(candles, signals, params = {}) {
  const investmentUsdt = params.investmentUsdt || 300;
  const leverage = params.leverage || 2;
  const notionalPerTrade = params.notionalPerTrade || 300;
  const feeRate = params.feeRate || 0.0006;
  const slippage = params.slippage || 0.0002;
  const maintMargin = params.maintMargin || 0.005;
  const slAtrMult = params.slAtrMult || 2.0;
  const fundings = params.fundings || [];
  const FUNDING_MS = 8 * 3600 * 1000;

  const trs = candles.map((c, i) => i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i-1].close), Math.abs(c.low - candles[i-1].close)));
  const atr = candles.map((_, i) => i >= 13 ? trs.slice(i - 13, i + 1).reduce((s, t) => s + t, 0) / 14 : null);

  const qty = notionalPerTrade / candles[0].close;
  let position = null;
  let grossPnl = 0, feesSum = 0, fundingSum = 0;
  let liquidations = 0;
  const trades = [];
  let peak = investmentUsdt, maxDD = 0;
  let lastFundingTs = candles[0].ts;
  const processedFundings = new Set();

  function closePos(exitPrice, reason, i) {
    if (!position) return;
    const fee = exitPrice * position.qty * feeRate;
    feesSum += fee;
    const tradeGross = position.type === 'LONG' ? (exitPrice - position.entryPrice) * position.qty : (position.entryPrice - exitPrice) * position.qty;
    grossPnl += tradeGross;
    trades.push({
      type: position.type, entryIdx: position.entryIdx, exitIdx: i,
      entryPrice: position.entryPrice, exitPrice: exitPrice,
      qty: position.qty, gross: tradeGross,
      entryFee: position.entryFee, exitFee: fee,
      net: tradeGross - position.entryFee - fee,
      reason, fundingCost: position.fundingCost || 0,
    });
    position = null;
  }

  function openPos(type, price, i) {
    const entryPrice = type === 'LONG' ? price * (1 + slippage) : price * (1 - slippage);
    const fee = entryPrice * qty * feeRate;
    feesSum += fee;
    position = { type, entryPrice, entryIdx: i, qty, entryFee: fee, fundingCost: 0 };
  }

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // Step 1: process prev signal at c.open
    if (i > 0 && signals[i - 1] && signals[i - 1].action !== 'none') {
      const sig = signals[i - 1].action;
      if (sig === 'long') {
        if (position && position.type === 'SHORT') closePos(c.open * (1 + slippage), 'FLIP', i);
        if (!position) openPos('LONG', c.open, i);
      } else if (sig === 'short') {
        if (position && position.type === 'LONG') closePos(c.open * (1 - slippage), 'FLIP', i);
        if (!position) openPos('SHORT', c.open, i);
      } else if (sig === 'exit_long' && position?.type === 'LONG') {
        closePos(c.open * (1 - slippage), 'EXIT', i);
      } else if (sig === 'exit_short' && position?.type === 'SHORT') {
        closePos(c.open * (1 + slippage), 'EXIT', i);
      }
    }

    // Step 2: intrabar SL
    if (position) {
      const slDist = slAtrMult * (atr[position.entryIdx] || c.close * 0.02);
      const slPrice = position.type === 'LONG' ? position.entryPrice - slDist : position.entryPrice + slDist;
      const hit = position.type === 'LONG' ? c.low <= slPrice : c.high >= slPrice;
      if (hit) closePos(slPrice, 'SL', i);
    }

    // Step 3: liquidation check
    if (position) {
      const liq = position.type === 'LONG' ? position.entryPrice * (1 - 1/leverage + maintMargin) : position.entryPrice * (1 + 1/leverage - maintMargin);
      const liqHit = position.type === 'LONG' ? c.low <= liq : c.high >= liq;
      if (liqHit) { closePos(liq, 'LIQUIDATION', i); liquidations++; }
    }

    // Step 4: funding
    while (lastFundingTs + FUNDING_MS <= c.ts) {
      lastFundingTs += FUNDING_MS;
      if (position && !processedFundings.has(lastFundingTs)) {
        processedFundings.add(lastFundingTs);
        let rate = 0;
        if (fundings.length > 0) {
          let nearest = fundings[0], minDiff = Math.abs(fundings[0].fundingTime - lastFundingTs);
          for (const f of fundings) { const d = Math.abs(f.fundingTime - lastFundingTs); if (d < minDiff) { minDiff = d; nearest = f; } }
          if (minDiff < FUNDING_MS) rate = nearest.fundingRate;
        }
        const cost = position.entryPrice * position.qty * Math.abs(rate);
        fundingSum += cost;
        position.fundingCost = (position.fundingCost || 0) + cost;
      }
    }

    // Step 5: equity tracking
    const unreal = position ? (position.type === 'LONG' ? (c.close - position.entryPrice) : (position.entryPrice - c.close)) * position.qty - position.entryFee : 0;
    const eq = investmentUsdt + grossPnl - feesSum - fundingSum + unreal;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Force close at last candle
  if (position) closePos(candles[candles.length - 1].close, 'FINAL_CLOSE', candles.length - 1);

  const wins = trades.filter(t => t.net > 0).length;
  const grossPW = trades.filter(t => t.net > 0).reduce((s, t) => s + t.net, 0);
  const grossLW = Math.abs(trades.filter(t => t.net < 0).reduce((s, t) => s + t.net, 0));
  const pf = grossLW > 0 ? grossPW / grossLW : (grossPW > 0 ? Infinity : 0);
  const netPnl = grossPnl - feesSum - fundingSum;
  const finalEquity = investmentUsdt + netPnl;
  const longTrades = trades.filter(t => t.type === 'LONG');
  const shortTrades = trades.filter(t => t.type === 'SHORT');
  const avgWin = wins > 0 ? grossPW / wins : 0;
  const avgLoss = (trades.length - wins) > 0 ? grossLW / (trades.length - wins) : 0;

  return {
    trades: trades.length, longTrades: longTrades.length, shortTrades: shortTrades.length,
    wins, losses: trades.length - wins,
    winRate: trades.length > 0 ? +(wins / trades.length * 100).toFixed(2) : 0,
    grossPnl: +grossPnl.toFixed(4), feesSum: +feesSum.toFixed(4), fundingSum: +fundingSum.toFixed(4),
    netPnl: +netPnl.toFixed(4), finalEquity: +finalEquity.toFixed(4),
    returnPct: +((finalEquity - investmentUsdt) / investmentUsdt * 100).toFixed(2),
    profitFactor: pf === Infinity ? null : +pf.toFixed(2),
    maxDD: +maxDD.toFixed(2), liquidations,
    avgWin: +avgWin.toFixed(4), avgLoss: +avgLoss.toFixed(4),
    tradesList: trades,
  };
}
