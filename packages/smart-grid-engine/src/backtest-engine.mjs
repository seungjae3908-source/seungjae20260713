import { fetchCandles, fetchFundingRateHistory, fetchContractInfo } from './bitget-adapter.mjs';
import { calculateGridLevels, calculateGridQuantity } from './grid-math.mjs';

const FEE_RATE = 0.0006;
const SLIPPAGE = 0.0002;
const MAINT_MARGIN = 0.005;
const MAX_PAGES = 500;
const FUNDING_MS = 8 * 3600 * 1000;

function intervalMs(iv) {
  const m = { '1m': 60000, '5m': 300000, '15m': 900000, '1H': 3600000, '4H': 14400000, '1D': 86400000 };
  return m[iv] || 14400000;
}

export async function runBacktest({ symbol = 'BTCUSDT', gridCount = 10, investmentUsdt = 300, leverage = 5, days = 180, interval = '4H', rangePct = 0.10 }) {
  console.log(`\n=== [백테스트] ${symbol} | ${days}일 | ${interval} | ${investmentUsdt}U | ${leverage}x ===`);

  const contract = await fetchContractInfo(symbol);
  console.log(`계약: minTradeNum=${contract.minTradeNum}, minUSDT=${contract.minTradeUSDT}, pricePlace=${contract.pricePlace}, volPlace=${contract.volumePlace}, status=${contract.status}`);
  if (contract.status !== 'online') throw new Error(`NOT_TRADEABLE:${contract.status}`);

  const endTime = Date.now();
  const startTime = endTime - days * 86400000;
  const ivMs = intervalMs(interval);
  console.log(`수집 목표: ${new Date(startTime).toISOString().slice(0,10)} ~ ${new Date(endTime).toISOString().slice(0,10)}`);

  const all = [];
  const seenTs = new Set();
  let requestStart = startTime;
  let page = 0;

  while (requestStart < endTime && page < MAX_PAGES) {
    let batch;
    try {
      batch = await fetchCandles(symbol, interval, requestStart, undefined, 1000);
    } catch (err) {
      console.log(`  page ${page+1} 오류: ${err.message}`);
      break;
    }
    if (!batch || batch.length === 0) { console.log(`  page ${page+1}: 0개 → 종료`); break; }
    const valid = batch.filter(c => c.ts >= startTime && c.ts <= endTime);
    if (valid.length === 0) { console.log(`  page ${page+1}: 유효 0개 → 종료`); break; }
    let added = 0;
    for (const c of valid) { if (!seenTs.has(c.ts)) { seenTs.add(c.ts); all.push(c); added++; } }
    page++;
    const lastTs = valid[valid.length - 1].ts;
    console.log(`  page ${page}: ${batch.length}개 수신 (신규 ${added}), ${new Date(valid[0].ts).toISOString().slice(0,10)} ~ ${new Date(lastTs).toISOString().slice(0,10)}`);
    requestStart = lastTs + ivMs;
  }

  if (all.length === 0) throw new Error('NO_CANDLES_FETCHED');
  const candles = all.sort((a, b) => a.ts - b.ts);
  const actualDays = (candles[candles.length - 1].ts - candles[0].ts) / 86400000;
  console.log(`수집 완료: ${candles.length} 캔들, ${actualDays.toFixed(1)}일`);
  if (candles.length < 20) throw new Error('INSUFFICIENT_DATA');

  let fundings = [];
  try {
    fundings = await fetchFundingRateHistory(symbol);
    console.log(`펀딩비 이력: ${fundings.length}건`);
  } catch (e) {
    console.log(`펀딩비 수집 실패: ${e.message} → 0 처리`);
  }

  const startPrice = candles[0].close;
  const lowerPrice = startPrice * (1 - rangePct);
  const upperPrice = startPrice * (1 + rangePct);
  const levels = calculateGridLevels({ lowerPrice, upperPrice, gridCount, mode: 'arithmetic', pricePlace: contract.pricePlace, priceEndStep: contract.priceEndStep });
  const quantity = calculateGridQuantity({ totalInvestmentUsdt: investmentUsdt, gridCount, currentPrice: startPrice, leverage, volumePlace: contract.volumePlace, minTradeNum: contract.minTradeNum });
  console.log(`시작가=${startPrice.toFixed(2)}, 수량=${quantity}, 범위=${levels[0].toFixed(2)}~${levels[levels.length-1].toFixed(2)}`);

  const positions = [];
  const pendingOrders = [];
  for (const lvl of levels) {
    if (lvl < startPrice) pendingOrders.push({ type: 'BUY', price: lvl, status: 'PENDING' });
    else if (lvl > startPrice) pendingOrders.push({ type: 'SELL', price: lvl, status: 'PENDING' });
  }

  let realizedPnl = 0, totalFees = 0, totalFunding = 0, completedTrades = 0, liquidations = 0;
  let lastFundingTs = candles[0].ts;
  let peak = investmentUsdt, maxDD = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    while (lastFundingTs + FUNDING_MS <= c.ts) {
      lastFundingTs += FUNDING_MS;
      let rate = 0;
      if (fundings.length > 0) {
        let nearest = fundings[0];
        let minDiff = Math.abs(fundings[0].fundingTime - lastFundingTs);
        for (const f of fundings) {
          const d = Math.abs(f.fundingTime - lastFundingTs);
          if (d < minDiff) { minDiff = d; nearest = f; }
        }
        if (minDiff < FUNDING_MS) rate = nearest.fundingRate;
      }
      for (const p of positions.filter(p => p.status === 'OPEN')) {
        const cost = p.price * p.qty * Math.abs(rate);
        totalFunding += cost;
        realizedPnl -= cost;
      }
    }

    const snapshot = pendingOrders.slice();
    for (const order of snapshot) {
      if (order.status !== 'PENDING') continue;
      let fillPrice = null;
      if (order.type === 'BUY' && c.low <= order.price) fillPrice = order.price * (1 + SLIPPAGE);
      else if (order.type === 'SELL' && c.high >= order.price) fillPrice = order.price * (1 - SLIPPAGE);
      if (fillPrice === null) continue;
      const pf = Math.pow(10, contract.pricePlace);
      fillPrice = Math.round(fillPrice * pf) / pf;
      const fee = fillPrice * quantity * FEE_RATE;
      totalFees += fee;
      order.status = 'FILLED';

      const matchIdx = positions.findIndex(p => p.status === 'OPEN' && p.type !== order.type);
      if (matchIdx >= 0) {
        const m = positions[matchIdx];
        m.status = 'CLOSED';
        m.closedAt = c.ts;
        m.exitPrice = fillPrice;
        m.exitFee = fee;
        const gross = m.type === 'BUY' ? (fillPrice - m.price) * quantity : (m.price - fillPrice) * quantity;
        m.pnl = gross - m.entryFee - fee;
        realizedPnl += m.pnl;
        completedTrades++;
      } else {
        positions.push({ id: positions.length + 1, type: order.type, price: fillPrice, qty: quantity, status: 'OPEN', openedAt: c.ts, entryFee: fee });
      }

      const idx = levels.findIndex(l => Math.abs(l - order.price) < 1e-6);
      if (order.type === 'BUY' && idx + 1 < levels.length) pendingOrders.push({ type: 'SELL', price: levels[idx + 1], status: 'PENDING' });
      else if (order.type === 'SELL' && idx - 1 >= 0) pendingOrders.push({ type: 'BUY', price: levels[idx - 1], status: 'PENDING' });
    }

    for (const p of positions.filter(p => p.status === 'OPEN')) {
      const liq = p.type === 'BUY' ? p.price * (1 - 1/leverage + MAINT_MARGIN) : p.price * (1 + 1/leverage - MAINT_MARGIN);
      if ((p.type === 'BUY' && c.low <= liq) || (p.type === 'SELL' && c.high >= liq)) {
        p.status = 'LIQUIDATED';
        p.closedAt = c.ts;
        p.exitPrice = liq;
        const loss = p.type === 'BUY' ? (liq - p.price) * quantity : (p.price - liq) * quantity;
        realizedPnl += loss;
        liquidations++;
      }
    }

    const unreal = positions.filter(p => p.status === 'OPEN').reduce((a, p) => a + (p.type === 'BUY' ? (c.close - p.price) * p.qty : (p.price - c.close) * p.qty) - p.entryFee, 0);
    // [D-3b fixed] fees are already net in realizedPnl and unreal; totalFees is audit-only
    const eq = investmentUsdt + realizedPnl + unreal;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const finalPrice = candles[candles.length - 1].close;
  const openPos = positions.filter(p => p.status === 'OPEN');
  const unrealizedPnl = openPos.reduce((a, p) => a + (p.type === 'BUY' ? (finalPrice - p.price) * p.qty : (p.price - finalPrice) * p.qty) - p.entryFee, 0);
  // [D-3 fixed] single source of truth — see computeFinalTotals() below
  const { netPnl, finalEquity, returnPct } = computeFinalTotals({ realizedPnl, unrealizedPnl, investmentUsdt });
  const closed = positions.filter(p => p.status === 'CLOSED');
  const wins = closed.filter(p => p.pnl > 0).length;
  const grossP = closed.filter(p => p.pnl > 0).reduce((s, p) => s + p.pnl, 0);
  const grossL = Math.abs(closed.filter(p => p.pnl < 0).reduce((s, p) => s + p.pnl, 0));
  const pf = grossL > 0 ? grossP / grossL : (grossP > 0 ? Infinity : 0);
  // [D-3 fixed] PF Infinity를 JSON-safe하게 명시 (Infinity는 stringify 시 null이 됨)
  const profitFactorJsonSafe = Number.isFinite(pf) ? pf : (pf === Infinity ? 'inf' : null);

  console.log('\n=== [결과] ===');
  console.log(`기간: ${actualDays.toFixed(1)}일 | 캔들: ${candles.length}`);
  console.log(`거래: ${completedTrades}회 (승 ${wins} / 패 ${completedTrades - wins})`);
  console.log(`실현 손익(Net, 수수료/펀딩 반영): ${realizedPnl.toFixed(2)}U`);
  console.log(`수수료: -${totalFees.toFixed(2)}U`);
  console.log(`펀딩비: -${totalFunding.toFixed(2)}U (실현 손익에 포함)`);
  console.log(`순손익: ${netPnl.toFixed(2)}U`);
  console.log(`미실현: ${unrealizedPnl.toFixed(2)}U (${openPos.length}개 오픈)`);
  console.log(`최종 평가: ${finalEquity.toFixed(2)}U (${returnPct.toFixed(2)}%)`);
  console.log(`PF: ${pf.toFixed(2)} | MDD: ${maxDD.toFixed(2)}% | 청산: ${liquidations}건`);

  return { days: actualDays, candles: candles.length, candlesData: candles, levels: levels, completedTrades, wins, realizedPnl, totalFees, totalFunding, netPnl, unrealizedPnl, finalEquity, returnPct, profitFactor: pf, profitFactorJsonSafe, maxDD, liquidations, positions, trades: closed };
}

// ─────────────────────────────────────────────────────────────
// BLOCK 19 Phase 1 helpers — 순수 회계 함수 (테스트용, 네트워크 미사용)
// ─────────────────────────────────────────────────────────────
export function computeTradeNetPnl({ entryPrice, exitPrice, qty, direction, feeRate }) {
  const gross = direction === 'BUY'
    ? (exitPrice - entryPrice) * qty
    : (entryPrice - exitPrice) * qty;
  const entryFee = entryPrice * qty * feeRate;
  const exitFee  = exitPrice  * qty * feeRate;
  return { gross, entryFee, exitFee, netPnl: gross - entryFee - exitFee, totalFees: entryFee + exitFee };
}

export function computeUnrealizedPnl({ entryPrice, markPrice, qty, direction, entryFee }) {
  const diff = direction === 'BUY'
    ? (markPrice - entryPrice) * qty
    : (entryPrice - markPrice) * qty;
  return diff - entryFee;
}

export function computeFinalTotals({ realizedPnl, unrealizedPnl, investmentUsdt }) {
  const netPnl = realizedPnl + unrealizedPnl;
  const finalEquity = investmentUsdt + netPnl;
  const returnPct = investmentUsdt > 0 ? (netPnl / investmentUsdt) * 100 : 0;
  return { netPnl, finalEquity, returnPct };
}
