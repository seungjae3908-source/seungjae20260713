// Strategy C: Neutral Grid - Long/Short 양방향, ADX 필터
import { calculateGridLevels, calculateGridQuantity } from './grid-math.mjs';
import { computeADX, roundPrice, applySlippage } from './grid-utils.mjs';

export function runStrategyC(candles, contract, params) {
  const { gridCount, investmentUsdt, leverage, rangePct, feeRate, slippage, maintMargin } = params;
  const startPrice = candles[0].close;
  const lowerPrice = startPrice * (1 - rangePct);
  const upperPrice = startPrice * (1 + rangePct);

  const LONG_MAX_NOTIONAL = investmentUsdt * 0.5;  // 150 USDT
  const SHORT_MAX_NOTIONAL = investmentUsdt * 0.5;
  const NET_MAX_NOTIONAL = investmentUsdt / 3;     // 100 USDT

  // 양방향 그리드: lower~current = BUY, current~upper = SELL
  const midPrice = (lowerPrice + upperPrice) / 2;
  const longLevels = calculateGridLevels({ lowerPrice, upperPrice: midPrice, gridCount: Math.floor(gridCount / 2), mode: 'arithmetic', pricePlace: contract.pricePlace, priceEndStep: contract.priceEndStep });
  const shortLevels = calculateGridLevels({ lowerPrice: midPrice, upperPrice, gridCount: Math.floor(gridCount / 2), mode: 'arithmetic', pricePlace: contract.pricePlace, priceEndStep: contract.priceEndStep });
  const quantity = calculateGridQuantity({ totalInvestmentUsdt: investmentUsdt, gridCount, currentPrice: startPrice, leverage, volumePlace: contract.volumePlace, minTradeNum: contract.minTradeNum });

  let pendingOrders = [];
  for (const lvl of longLevels) if (lvl < startPrice) pendingOrders.push({ type: 'BUY', price: lvl, status: 'PENDING', side: 'LONG' });
  for (const lvl of shortLevels) if (lvl > startPrice) pendingOrders.push({ type: 'SELL', price: lvl, status: 'PENDING', side: 'SHORT' });

  const longPositions = [], shortPositions = [];
  let realizedPnl = 0, totalFees = 0, totalFunding = 0, completedTrades = 0, liquidations = 0;
  let fillUncertainty = 0, entriesBlocked = 0;
  const FUNDING_MS = 8 * 3600 * 1000;
  let lastFundingTs = candles[0].ts;
  let peak = investmentUsdt, maxDD = 0;
  const entryLog = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // 펀딩비 적용
    while (lastFundingTs + FUNDING_MS <= c.ts) {
      lastFundingTs += FUNDING_MS;
      let rate = 0;
      if (params.fundings && params.fundings.length > 0) {
        let nearest = params.fundings[0], minDiff = Math.abs(params.fundings[0].fundingTime - lastFundingTs);
        for (const f of params.fundings) { const d = Math.abs(f.fundingTime - lastFundingTs); if (d < minDiff) { minDiff = d; nearest = f; } }
        if (minDiff < FUNDING_MS) rate = nearest.fundingRate;
      }
      for (const p of [...longPositions, ...shortPositions].filter(p => p.status === "OPEN")) {
        const cost = p.price * p.qty * Math.abs(rate);
        totalFunding += cost; realizedPnl -= cost;
      }
    }

    // ADX 필터: 각 캔들마다 최신 ADX 계산
    const adx = computeADX(candles.slice(Math.max(0, i - 40), i + 1), 14);
    const allowNewEntry = adx !== null && adx < 20;
    const blockAll = adx !== null && adx > 30;

    const candidates = pendingOrders.filter(o => o.status === 'PENDING' && (
      (o.type === 'BUY' && c.low <= o.price) || (o.type === 'SELL' && c.high >= o.price)));
    if (candidates.length === 0) continue;

    const hasBuy = candidates.some(o => o.type === 'BUY');
    const hasSell = candidates.some(o => o.type === 'SELL');
    if (hasBuy && hasSell) fillUncertainty++;

    const isGreen = c.close >= c.open;
    const sorted = [...candidates].sort((a, b) => {
      if (a.type === b.type) return a.type === 'BUY' ? b.price - a.price : a.price - b.price;
      if (isGreen) return a.type === 'BUY' ? -1 : 1;
      return a.type === 'SELL' ? -1 : 1;
    });

    for (const order of sorted) {
      if (order.status !== 'PENDING') continue;

      // 노출 체크 (신규 진입 시)
      const longNotional = longPositions.filter(p => p.status === 'OPEN').reduce((s, p) => s + p.price * p.qty, 0);
      const shortNotional = shortPositions.filter(p => p.status === 'OPEN').reduce((s, p) => s + p.price * p.qty, 0);
      const netExposure = Math.abs(longNotional - shortNotional);

      // 매수 체결 (Long 진입 or Short 청산)
      if (order.type === 'BUY') {
        const matchIdx = shortPositions.findIndex(p => p.status === 'OPEN');
        if (matchIdx >= 0) {
          // Short 청산
          let fillPrice = roundPrice(applySlippage(order.price, 'BUY', slippage), contract.pricePlace);
          const fee = fillPrice * quantity * feeRate; totalFees += fee;
          const m = shortPositions[matchIdx];
          m.status = 'CLOSED'; m.closedAt = c.ts; m.exitPrice = fillPrice; m.exitFee = fee;
          const gross = (m.price - fillPrice) * quantity;
          m.pnl = gross - m.entryFee - fee; realizedPnl += m.pnl; completedTrades++;
          order.status = 'FILLED';
          const lIdx = longLevels.findIndex(l => Math.abs(l - order.price) < 1e-6);
          if (lIdx + 1 < longLevels.length) pendingOrders.push({ type: 'SELL', price: longLevels[lIdx + 1], status: 'PENDING', side: 'SHORT' });
        } else if (allowNewEntry && !blockAll && longNotional + order.price * quantity <= LONG_MAX_NOTIONAL && netExposure + order.price * quantity <= NET_MAX_NOTIONAL + longNotional * 0.5) {
          let fillPrice = roundPrice(applySlippage(order.price, 'BUY', slippage), contract.pricePlace);
          const fee = fillPrice * quantity * feeRate; totalFees += fee;
          longPositions.push({ id: longPositions.length + 1, type: 'BUY', price: fillPrice, qty: quantity, status: 'OPEN', openedAt: c.ts, entryFee: fee });
          order.status = 'FILLED';
          entryLog.push({ ts: c.ts, side: 'LONG', adx, price: fillPrice });
        } else { entriesBlocked++; }
      }
      // 매도 체결 (Short 진입 or Long 청산)
      else if (order.type === 'SELL') {
        const matchIdx = longPositions.findIndex(p => p.status === 'OPEN');
        if (matchIdx >= 0) {
          let fillPrice = roundPrice(applySlippage(order.price, 'SELL', slippage), contract.pricePlace);
          const fee = fillPrice * quantity * feeRate; totalFees += fee;
          const m = longPositions[matchIdx];
          m.status = 'CLOSED'; m.closedAt = c.ts; m.exitPrice = fillPrice; m.exitFee = fee;
          const gross = (fillPrice - m.price) * quantity;
          m.pnl = gross - m.entryFee - fee; realizedPnl += m.pnl; completedTrades++;
          order.status = 'FILLED';
          const sIdx = shortLevels.findIndex(l => Math.abs(l - order.price) < 1e-6);
          if (sIdx - 1 >= 0) pendingOrders.push({ type: 'BUY', price: shortLevels[sIdx - 1], status: 'PENDING', side: 'LONG' });
        } else if (allowNewEntry && !blockAll && shortNotional + order.price * quantity <= SHORT_MAX_NOTIONAL) {
          let fillPrice = roundPrice(applySlippage(order.price, 'SELL', slippage), contract.pricePlace);
          const fee = fillPrice * quantity * feeRate; totalFees += fee;
          shortPositions.push({ id: shortPositions.length + 1, type: 'SELL', price: fillPrice, qty: quantity, status: 'OPEN', openedAt: c.ts, entryFee: fee });
          order.status = 'FILLED';
          entryLog.push({ ts: c.ts, side: 'SHORT', adx, price: fillPrice });
        } else { entriesBlocked++; }
      }
    }

    // 청산 체크 (양쪽)
    for (const p of [...longPositions, ...shortPositions].filter(p => p.status === 'OPEN')) {
      const liq = p.type === 'BUY' ? p.price * (1 - 1/leverage + maintMargin) : p.price * (1 + 1/leverage - maintMargin);
      if ((p.type === 'BUY' && c.low <= liq) || (p.type === 'SELL' && c.high >= liq)) {
        p.status = 'LIQUIDATED'; p.closedAt = c.ts; p.exitPrice = liq;
        const loss = p.type === 'BUY' ? (liq - p.price) * quantity : (p.price - liq) * quantity;
        realizedPnl += loss; liquidations++;
      }
    }

    const allOpen = [...longPositions, ...shortPositions].filter(p => p.status === 'OPEN');
    const unrealized = allOpen.reduce((a, p) => a + ((p.type === 'BUY' ? c.close - p.price : p.price - c.close) * p.qty - p.entryFee), 0);
    const eq = investmentUsdt + realizedPnl - totalFees + unrealized;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const finalPrice = candles[candles.length - 1].close;
  const closedAll = [...longPositions, ...shortPositions].filter(p => p.status === 'CLOSED');
  const openAll = [...longPositions, ...shortPositions].filter(p => p.status === 'OPEN');
  const unrealizedPnl = openAll.reduce((a, p) => a + ((p.type === 'BUY' ? finalPrice - p.price : p.price - finalPrice) * p.qty - p.entryFee), 0);
  const netPnl = realizedPnl - totalFees;
  const finalEquity = investmentUsdt + netPnl + unrealizedPnl;
  const returnPct = (finalEquity - investmentUsdt) / investmentUsdt * 100;
  const wins = closedAll.filter(p => p.pnl > 0).length;
  const grossP = closedAll.filter(p => p.pnl > 0).reduce((s, p) => s + p.pnl, 0);
  const grossL = Math.abs(closedAll.filter(p => p.pnl < 0).reduce((s, p) => s + p.pnl, 0));
  const pf = grossL > 0 ? grossP / grossL : (grossP > 0 ? Infinity : 0);
  let maxConsec = 0, curr = 0;
  const sortedClosed = [...closedAll].sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
  for (const t of sortedClosed) { if (t.pnl < 0) { curr++; if (curr > maxConsec) maxConsec = curr; } else curr = 0; }

  return { strategy: 'C-Neutral', trades: completedTrades, wins, realizedPnl, totalFees, totalFunding, netPnl, unrealizedPnl, finalEquity, returnPct, profitFactor: pf, maxDD, liquidations, openPositions: openAll.length, maxConsecLosses: maxConsec, fillUncertainty, entriesBlocked, longOpened: longPositions.length, shortOpened: shortPositions.length, candles: candles.length };
}
