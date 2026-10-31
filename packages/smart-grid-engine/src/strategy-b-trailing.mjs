// Strategy B: Trailing Grid - 가격 추세에 따라 그리드 범위 단계 이동
import { calculateGridLevels, calculateGridQuantity } from './grid-math.mjs';
import { roundPrice, applySlippage } from './grid-utils.mjs';

export function runStrategyB(candles, contract, params) {
  const { gridCount, investmentUsdt, leverage, rangePct, feeRate, slippage, maintMargin } = params;
  const startPrice = candles[0].close;

  // Trailing 파라미터
  const TRAIL_TRIGGER = 0.10;   // 상/하단 10% 도달 시 이동
  const TRAIL_STEP = 0.05;      // 이동 폭 5%
  const MAX_TOTAL_SHIFT = 0.20; // 누적 최대 이동 20%
  const MIN_CANDLES_BETWEEN = 5; // 이동 최소 간격 (5 캔들)
  const CHASE_STOP = 0.05;      // 범위 이탈 5% 이상 시 추격 중지

  let currentLower = startPrice * (1 - rangePct);
  let currentUpper = startPrice * (1 + rangePct);
  let baseLower = currentLower, baseUpper = currentUpper;
  let cumulativeShift = 0;      // 누적 이동 비율 (절댓값)
  let lastShiftIdx = -999;
  let trailStopped = false;

  let levels = calculateGridLevels({ lowerPrice: currentLower, upperPrice: currentUpper, gridCount, mode: 'arithmetic', pricePlace: contract.pricePlace, priceEndStep: contract.priceEndStep });
  const quantity = calculateGridQuantity({ totalInvestmentUsdt: investmentUsdt, gridCount, currentPrice: startPrice, leverage, volumePlace: contract.volumePlace, minTradeNum: contract.minTradeNum });

  const positions = [];
  let pendingOrders = [];
  for (const lvl of levels) {
    if (lvl < startPrice) pendingOrders.push({ type: 'BUY', price: lvl, status: 'PENDING' });
    else if (lvl > startPrice) pendingOrders.push({ type: 'SELL', price: lvl, status: 'PENDING' });
  }

  let realizedPnl = 0, totalFees = 0, totalFunding = 0, completedTrades = 0, liquidations = 0;
  let fillUncertainty = 0, trailShifts = 0, rangeBreaches = 0;
  const FUNDING_MS = 8 * 3600 * 1000;
  let lastFundingTs = candles[0].ts;
  let peak = investmentUsdt, maxDD = 0;

  function resetPendingToNewRange(newLower, newUpper) {
    const newLevels = calculateGridLevels({ lowerPrice: newLower, upperPrice: newUpper, gridCount, mode: 'arithmetic', pricePlace: contract.pricePlace, priceEndStep: contract.priceEndStep });
    // 기존 PENDING만 취소 (FILLED는 유지)
    pendingOrders = pendingOrders.filter(o => o.status === 'FILLED');
    for (const lvl of newLevels) {
      const alreadyFilled = positions.some(p => Math.abs(p.price - lvl) < 1e-6);
      if (alreadyFilled) continue;
      if (lvl < candles[0].close) continue; // 참고용
    }
    // 새 레벨 기반 재주문 (현재가 기준)
    for (const lvl of newLevels) {
      if (lvl < lastClose) pendingOrders.push({ type: 'BUY', price: lvl, status: 'PENDING' });
      else if (lvl > lastClose) pendingOrders.push({ type: 'SELL', price: lvl, status: 'PENDING' });
    }
    levels = newLevels;
    currentLower = newLower; currentUpper = newUpper;
  }

  let lastClose = startPrice;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    lastClose = c.close;

    // Trailing 트리거 체크
    if (!trailStopped && i - lastShiftIdx >= MIN_CANDLES_BETWEEN) {
      const upperTrigger = currentUpper - (currentUpper - currentLower) * TRAIL_TRIGGER / rangePct;
      const lowerTrigger = currentLower + (currentUpper - currentLower) * TRAIL_TRIGGER / rangePct;
      const shiftUp = c.high >= currentUpper - (currentUpper - currentLower) * 0.1 && cumulativeShift + TRAIL_STEP <= MAX_TOTAL_SHIFT;
      const shiftDown = c.low <= currentLower + (currentUpper - currentLower) * 0.1 && cumulativeShift + TRAIL_STEP <= MAX_TOTAL_SHIFT;
      const chaseUp = c.high > currentUpper * (1 + CHASE_STOP);
      const chaseDown = c.low < currentLower * (1 - CHASE_STOP);
      if (chaseUp || chaseDown) { trailStopped = true; }

      if (!trailStopped && shiftUp) {
        const delta = (currentUpper - currentLower) * TRAIL_STEP / rangePct;
        resetPendingToNewRange(currentLower + delta, currentUpper + delta);
        cumulativeShift += TRAIL_STEP; lastShiftIdx = i; trailShifts++;
      } else if (!trailStopped && shiftDown) {
        const delta = (currentUpper - currentLower) * TRAIL_STEP / rangePct;
        resetPendingToNewRange(currentLower - delta, currentUpper - delta);
        cumulativeShift += TRAIL_STEP; lastShiftIdx = i; trailShifts++;
      }
    }

    // 펀딩비 적용
    while (lastFundingTs + FUNDING_MS <= c.ts) {
      lastFundingTs += FUNDING_MS;
      let rate = 0;
      if (params.fundings && params.fundings.length > 0) {
        let nearest = params.fundings[0], minDiff = Math.abs(params.fundings[0].fundingTime - lastFundingTs);
        for (const f of params.fundings) { const d = Math.abs(f.fundingTime - lastFundingTs); if (d < minDiff) { minDiff = d; nearest = f; } }
        if (minDiff < FUNDING_MS) rate = nearest.fundingRate;
      }
      for (const p of positions.filter(p => p.status === "OPEN")) {
        const cost = p.price * p.qty * Math.abs(rate);
        totalFunding += cost; realizedPnl -= cost;
      }
    }

    if (c.low < currentLower || c.high > currentUpper) rangeBreaches++;

    // 체결 처리 (baseline과 동일)
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
      let fillPrice = applySlippage(order.price, order.type, slippage);
      fillPrice = roundPrice(fillPrice, contract.pricePlace);
      const fee = fillPrice * quantity * feeRate;
      totalFees += fee;
      order.status = 'FILLED';

      const matchIdx = positions.findIndex(p => p.status === 'OPEN' && p.type !== order.type);
      if (matchIdx >= 0) {
        const m = positions[matchIdx];
        m.status = 'CLOSED'; m.closedAt = c.ts; m.exitPrice = fillPrice; m.exitFee = fee;
        const gross = m.type === 'BUY' ? (fillPrice - m.price) * quantity : (m.price - fillPrice) * quantity;
        m.pnl = gross - m.entryFee - fee;
        realizedPnl += m.pnl; completedTrades++;
      } else {
        positions.push({ id: positions.length + 1, type: order.type, price: fillPrice, qty: quantity, status: 'OPEN', openedAt: c.ts, entryFee: fee });
      }
      const idx = levels.findIndex(l => Math.abs(l - order.price) < 1e-6);
      if (order.type === 'BUY' && idx + 1 < levels.length) pendingOrders.push({ type: 'SELL', price: levels[idx + 1], status: 'PENDING' });
      else if (order.type === 'SELL' && idx - 1 >= 0) pendingOrders.push({ type: 'BUY', price: levels[idx - 1], status: 'PENDING' });
    }

    // 청산 체크
    for (const p of positions.filter(p => p.status === 'OPEN')) {
      const liq = p.type === 'BUY' ? p.price * (1 - 1/leverage + maintMargin) : p.price * (1 + 1/leverage - maintMargin);
      if ((p.type === 'BUY' && c.low <= liq) || (p.type === 'SELL' && c.high >= liq)) {
        p.status = 'LIQUIDATED'; p.closedAt = c.ts; p.exitPrice = liq;
        const loss = p.type === 'BUY' ? (liq - p.price) * quantity : (p.price - liq) * quantity;
        realizedPnl += loss; liquidations++;
      }
    }

    const openP = positions.filter(p => p.status === 'OPEN');
    const unrealized = openP.reduce((a, p) => a + ((p.type === 'BUY' ? c.close - p.price : p.price - c.close) * p.qty - p.entryFee), 0);
    const eq = investmentUsdt + realizedPnl - totalFees + unrealized;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const finalPrice = candles[candles.length - 1].close;
  const openPos = positions.filter(p => p.status === 'OPEN');
  const unrealizedPnl = openPos.reduce((a, p) => a + ((p.type === 'BUY' ? finalPrice - p.price : p.price - finalPrice) * p.qty - p.entryFee), 0);
  const netPnl = realizedPnl - totalFees;
  const finalEquity = investmentUsdt + netPnl + unrealizedPnl;
  const returnPct = (finalEquity - investmentUsdt) / investmentUsdt * 100;
  const closed = positions.filter(p => p.status === 'CLOSED');
  const wins = closed.filter(p => p.pnl > 0).length;
  const grossP = closed.filter(p => p.pnl > 0).reduce((s, p) => s + p.pnl, 0);
  const grossL = Math.abs(closed.filter(p => p.pnl < 0).reduce((s, p) => s + p.pnl, 0));
  const pf = grossL > 0 ? grossP / grossL : (grossP > 0 ? Infinity : 0);
  let maxConsec = 0, curr = 0;
  for (const t of closed) { if (t.pnl < 0) { curr++; if (curr > maxConsec) maxConsec = curr; } else curr = 0; }

  return { strategy: 'B-Trailing', trades: completedTrades, wins, realizedPnl, totalFees, totalFunding, netPnl, unrealizedPnl, finalEquity, returnPct, profitFactor: pf, maxDD, liquidations, openPositions: openPos.length, maxConsecLosses: maxConsec, fillUncertainty, trailShifts, trailStopped, rangeBreaches, candles: candles.length };
}
