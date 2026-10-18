// Four-market trend-following backtest (research only, no orders).
//
// Owner request 2026-10-18: run the trend pilot idea on all four app markets.
// Rules are fixed before any result (same breakout as the coin-futures pilot):
//   entry   closed bar closes above the prior 55-bar high and above EMA200
//           (short mirror only where shorting exists: coin futures)
//   CRYPTO_FUTURES  Bitget BTCUSDT/ETHUSDT 4h, long+short, 5x, stop 2ATR ≤2.5%,
//                   breakeven +1R, trail 2.5ATR, max 180 bars (the pilot itself)
//   CRYPTO_SPOT     Upbit KRW majors 4h, long only, 1x, same exit as futures
//   KR_STOCK        KOSPI large caps + KODEX200, daily, long only, 1x
//   US_STOCK        large caps + index/sector ETFs, daily, long only, 1x
//   stock exit      stop 2ATR ≤10%, breakeven +1R, trail 3ATR, max 250 bars
// Sizing for every market: the live plan (2% of equity per trade, daily stop
// 2%, kill at −40% from the peak), 1,000,000 KRW start, ≤1,000,000 per order.
// Benchmarks: buy-and-hold of each symbol over the same span.
// Data before 2026 only (final holdout is never read).
import { runManagedExitBacktestV1 } from './managed-exit-backtest-v1.mjs';
import { resampleCandlesV1, simulateLivePlanV1, trendSignalsV1 } from './trend-pilot-backtest-v1.mjs';

export const FOUR_MARKET_CONTRACT_V1 = 'four-market-trend-backtest/v1';
const HOLDOUT_START = Date.UTC(2026, 0, 1);

const CRYPTO_EXIT = Object.freeze({ stopAtrMultiple: 2, maxStopFraction: 0.025, targetR: null,
  breakevenAfterR: 1, trailing: Object.freeze({ atrMultiple: 2.5 }), maxHoldBars: 180 });
const STOCK_EXIT = Object.freeze({ stopAtrMultiple: 2, maxStopFraction: 0.10, targetR: null,
  breakevenAfterR: 1, trailing: Object.freeze({ atrMultiple: 3 }), maxHoldBars: 250 });

export const FOUR_MARKET_PLAN_V1 = Object.freeze({
  startEquityKrw: 1_000_000, riskFraction: 0.02, dailyLossFraction: 0.02, killDrawdownFraction: 0.4,
  maxNotionalKrw: 1_000_000, minNotionalKrw: 7_500,
});

export const FOUR_MARKET_UNIVERSE_V1 = Object.freeze({
  CRYPTO_FUTURES: Object.freeze({ label: '코인선물', barHours: 4, sides: Object.freeze(['long', 'short']), leverage: 5, exit: CRYPTO_EXIT,
    cost: Object.freeze({ entryFeeRate: 0.0006, exitFeeRate: 0.0006, slippageRate: 0.0005, spreadRate: 0.0002 }),
    symbols: Object.freeze(['BTCUSDT', 'ETHUSDT']) }),
  CRYPTO_SPOT: Object.freeze({ label: '코인현물(업비트)', barHours: 4, sides: Object.freeze(['long']), leverage: 1, exit: CRYPTO_EXIT,
    cost: Object.freeze({ entryFeeRate: 0.0005, exitFeeRate: 0.0005, slippageRate: 0.0007, spreadRate: 0.0003 }),
    symbols: Object.freeze(['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE', 'KRW-ADA']) }),
  KR_STOCK: Object.freeze({ label: '국내주식', barHours: 24, sides: Object.freeze(['long']), leverage: 1, exit: STOCK_EXIT,
    // 0.015% fee each way + 0.18% securities tax on the sell + slippage
    cost: Object.freeze({ entryFeeRate: 0.00015, exitFeeRate: 0.00195, slippageRate: 0.001, spreadRate: 0.0005 }),
    symbols: Object.freeze(['069500', '005930', '000660', '005380', '000270', '068270', '035420', '035720', '051910', '006400',
      '005490', '105560', '055550', '012330', '028260', '066570', '003550', '034730', '017670', '207940']) }),
  US_STOCK: Object.freeze({ label: '미국주식', barHours: 24, sides: Object.freeze(['long']), leverage: 1, exit: STOCK_EXIT,
    cost: Object.freeze({ entryFeeRate: 0.0007, exitFeeRate: 0.0007, slippageRate: 0.0005, spreadRate: 0.0002 }),
    symbols: Object.freeze(['SPY', 'QQQ', 'IWM', 'GLD', 'TLT', 'XLE', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM', 'XOM']) }),
});

function ensureBars(market, cfg, candles) {
  const clean = (candles ?? []).filter((c) => c.timestamp < HOLDOUT_START).sort((a, b) => a.timestamp - b.timestamp);
  if (cfg.barHours === 24) return clean; // daily candles arrive as daily
  const hourly = clean.length > 1 && (clean[1].timestamp - clean[0].timestamp) === 3_600_000;
  return hourly ? resampleCandlesV1(clean, cfg.barHours) : clean;
}

/** Pure: trades on one symbol, one position at a time, long and short merged. */
export function fourMarketSymbolTradesV1({ market, symbol, candles, fundingRates = [], sidesOverride = null }) {
  const cfg = FOUR_MARKET_UNIVERSE_V1[market];
  if (!cfg) throw new Error(`FOUR_MARKET_UNKNOWN:${market}`);
  const bars = ensureBars(market, cfg, candles);
  if (bars.length < 260) return { status: 'INSUFFICIENT_BARS', bars: bars.length, trades: [] };
  const signals = trendSignalsV1(bars);
  const all = [];
  const sides = Array.isArray(sidesOverride) ? cfg.sides.filter((side) => sidesOverride.includes(side)) : cfg.sides;
  for (const side of sides) {
    const flags = side === 'long' ? signals.long : signals.short;
    const result = runManagedExitBacktestV1({
      backtestInput: { market, side, symbol, timeframe: cfg.barHours === 24 ? '1d' : `${cfg.barHours}h`, candles: bars,
        fundingRates: market === 'CRYPTO_FUTURES' ? fundingRates : [], initialCapital: 10_000_000, costModel: cfg.cost,
        riskModel: { riskPerTrade: 0.001, maximumCapitalFraction: 1, leverage: market === 'CRYPTO_FUTURES' ? 2 : 1 } },
      strategy: 'four_market_trend_v1', strategyVersion: `FOUR_MARKET:${market}:${side}`,
      plan: { exit: cfg.exit }, atrPeriod: 14,
      signalEvaluator: ({ index }) => (flags[index] ? { side } : null),
    });
    for (const t of result.trades) {
      all.push({ market, symbol, side, entryTime: t.entryTime, exitTime: t.exitTime, leverage: cfg.leverage,
        stopFraction: t.entryPrice > 0 ? Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice : null,
        rMultiple: Number.isFinite(t.rMultiple) ? t.rMultiple : null });
    }
  }
  all.sort((a, b) => a.entryTime - b.entryTime);
  const accepted = [];
  for (const t of all) if (!accepted.length || t.entryTime >= accepted.at(-1).exitTime) accepted.push(t);
  let peak = bars[0].close; let dd = 0;
  for (const b of bars) { peak = Math.max(peak, b.close); dd = Math.max(dd, (peak - b.close) / peak); }
  return {
    status: 'COMPLETE', bars: bars.length, trades: accepted,
    from: bars[0].timestamp, to: bars.at(-1).timestamp,
    buyHold: { totalReturn: bars.at(-1).close / bars[0].close - 1, maxDrawdownFraction: dd },
  };
}

function rStats(trades) {
  const r = trades.map((t) => t.rMultiple).filter(Number.isFinite);
  const sum = r.reduce((a, v) => a + v, 0);
  return { trades: r.length, sumR: sum, meanR: r.length ? sum / r.length : null, winRate: r.length ? r.filter((v) => v > 0).length / r.length : null };
}

/** Pure: per-market portfolio, discovery/validation split, benchmark, and the all-markets portfolio. */
export function evaluateFourMarketV1({ datasets, plan = FOUR_MARKET_PLAN_V1, splitFraction = 0.6 }) {
  const markets = [];
  const allTrades = [];
  for (const [market, cfg] of Object.entries(FOUR_MARKET_UNIVERSE_V1)) {
    const rows = datasets.filter((d) => d.market === market);
    const perSymbol = rows.map((d) => ({ symbol: d.symbol, ...fourMarketSymbolTradesV1(d) })).filter((s) => s.status === 'COMPLETE');
    const trades = perSymbol.flatMap((s) => s.trades);
    if (!perSymbol.length) { markets.push({ market, label: cfg.label, status: 'WAITING_FOR_DATA', symbols: 0 }); continue; }
    const first = Math.min(...perSymbol.map((s) => s.from)); const last = Math.max(...perSymbol.map((s) => s.to));
    const split = first + ((last - first) * splitFraction);
    allTrades.push(...trades);
    const avgHold = perSymbol.reduce((a, s) => a + s.buyHold.totalReturn, 0) / perSymbol.length;
    markets.push({
      market, label: cfg.label, status: 'COMPLETE', symbols: perSymbol.length, missing: cfg.symbols.filter((s) => !perSymbol.some((p) => p.symbol === s)),
      from: new Date(first).toISOString().slice(0, 10), to: new Date(last).toISOString().slice(0, 10), splitDate: new Date(split).toISOString().slice(0, 10),
      all: rStats(trades), discovery: rStats(trades.filter((t) => t.entryTime < split)), validation: rStats(trades.filter((t) => t.entryTime >= split)),
      portfolio: simulateLivePlanV1(trades, plan),
      validationPortfolio: simulateLivePlanV1(trades.filter((t) => t.entryTime >= split), plan),
      buyHoldAverage: avgHold,
      perSymbol: perSymbol.map((s) => ({ symbol: s.symbol, ...rStats(s.trades), buyHold: s.buyHold.totalReturn, buyHoldMaxDrawdown: s.buyHold.maxDrawdownFraction })),
    });
  }
  // All four markets share one account; the common span is where crypto data exists.
  const cryptoStart = Math.min(...allTrades.filter((t) => t.market.startsWith('CRYPTO')).map((t) => t.entryTime));
  const combinedTrades = Number.isFinite(cryptoStart) ? allTrades.filter((t) => t.entryTime >= cryptoStart) : allTrades;
  // Pre-declared comparison (same fixed rules, no tuning): does the short side crowd out longs on coin futures?
  const futuresRows = datasets.filter((d) => d.market === 'CRYPTO_FUTURES');
  const futuresVariant = (sidesOverride) => {
    const trades = futuresRows
      .map((d) => fourMarketSymbolTradesV1({ ...d, sidesOverride }))
      .filter((r) => r.status === 'COMPLETE')
      .flatMap((r) => r.trades);
    return trades.length ? { rStats: rStats(trades), portfolio: simulateLivePlanV1(trades, plan) } : null;
  };
  const futuresSideComparison = futuresRows.length
    ? { both: futuresVariant(null), longOnly: futuresVariant(['long']), shortOnly: futuresVariant(['short']) }
    : null;
  return {
    markets,
    futuresSideComparison,
    combined: {
      from: Number.isFinite(cryptoStart) ? new Date(cryptoStart).toISOString().slice(0, 10) : null,
      portfolio: simulateLivePlanV1(combinedTrades, plan),
      futuresOnlySameSpan: simulateLivePlanV1(combinedTrades.filter((t) => t.market === 'CRYPTO_FUTURES'), plan),
    },
  };
}

const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '-');
const won = (v) => (Number.isFinite(v) ? `${Math.round(v).toLocaleString('ko-KR')}원` : '-');
const r1 = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}R` : '-');

export function formatFourMarketReportKoV1(result) {
  const lines = ['4개 시장 추세 추종 과거 성적 · 1회 계좌의 2% 감수 · 하루 -2% · 자동정지 -40% · 시작 100만 원 · 2025년까지', ''];
  for (const m of result.markets) {
    if (m.status !== 'COMPLETE') { lines.push(`■ ${m.label}: 데이터 없음`); continue; }
    const p = m.portfolio; const v = m.validationPortfolio;
    lines.push(`■ ${m.label} (${m.symbols}종목, ${m.from}~${m.to})`);
    lines.push(`  전략: 100만 원 → ${won(p.endEquityKrw)} (${pct(p.totalReturn)}, 월 ${pct(p.monthlyCompound)}) · 최대 낙폭 ${pct(-p.maxDrawdownFraction)} · 거래 ${p.trades}회 · 승률 ${pct(p.winRate)}${p.killedAt ? ` · ⚠️ ${p.killedAt} 자동정지` : ''}`);
    lines.push(`  R 합계: 앞 구간 ${r1(m.discovery.sumR)} (${m.discovery.trades}회) · 뒤(검증, ${m.splitDate}~) ${r1(m.validation.sumR)} (${m.validation.trades}회) · 검증 구간만 굴리면 ${pct(v.totalReturn)} (낙폭 ${pct(-v.maxDrawdownFraction)})`);
    lines.push(`  비교: 같은 종목 그냥 보유 평균 ${pct(m.buyHoldAverage)}`);
    const best = [...m.perSymbol].sort((a, b) => b.sumR - a.sumR);
    lines.push(`  종목별 R: ${best.map((s) => `${s.symbol} ${r1(s.sumR)}`).join(' · ')}`);
    if (m.missing?.length) lines.push(`  데이터 못 받은 종목: ${m.missing.join(', ')}`);
  }
  const c = result.combined;
  lines.push('', `■ 4개 시장 한 계좌로 같이 (${c.from}~, 코인 데이터가 있는 구간)`);
  lines.push(`  100만 원 → ${won(c.portfolio.endEquityKrw)} (${pct(c.portfolio.totalReturn)}, 월 ${pct(c.portfolio.monthlyCompound)}) · 최대 낙폭 ${pct(-c.portfolio.maxDrawdownFraction)} · 거래 ${c.portfolio.trades}회${c.portfolio.killedAt ? ` · ⚠️ ${c.portfolio.killedAt} 자동정지` : ''} · 증거금 부족으로 건너뜀 ${c.portfolio.skipped.margin}회`);
  lines.push(`  같은 구간 코인선물만: ${pct(c.futuresOnlySameSpan.totalReturn)} · 낙폭 ${pct(-c.futuresOnlySameSpan.maxDrawdownFraction)}`);
  const fc = result.futuresSideComparison;
  if (fc?.both && fc.longOnly && fc.shortOnly) {
    const row = (name, v) => `  ${name}: ${pct(v.portfolio.totalReturn)} · 낙폭 ${pct(-v.portfolio.maxDrawdownFraction)} · 거래 ${v.portfolio.trades}회 · R 합계 ${r1(v.rStats.sumR)}`;
    lines.push('', '■ 코인선물 롱·숏 분리 비교 (같은 규칙, 같은 기간, 조건 변경 없음)');
    lines.push(row('롱+숏', fc.both), row('롱만', fc.longOnly), row('숏만', fc.shortOnly));
    lines.push('  숏이 롱 자리를 막았는지는 "롱만"이 "롱+숏"보다 확실히 낫고 "숏만"이 약할 때 의심합니다. 한 번의 과거 구간 결과일 뿐입니다.');
  }
  lines.push('', '주식은 1주 단위·장 시간·환전 비용을 단순화했습니다. 과거 성적일 뿐 미래 보장 아님. 주문 권한 없음.');
  return lines.join('\n');
}
