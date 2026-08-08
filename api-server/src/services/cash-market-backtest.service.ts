import { runCashBacktest, type CashBacktestRequest } from './cash-backtest-engine.service';
import { loadStockBacktestCandles } from './stock-backtest-data.service';
import { loadUpbitBacktestCandles } from './upbit-backtest-data.service';
import { BacktestMarketContractError, normalizeBacktestSymbol } from './backtest-market-profile.service';

export type CashMarketBacktestInput = CashBacktestRequest & {
  startTime: number;
  endTime: number;
};

export async function runCashMarketBacktest(input: CashMarketBacktestInput, dependencies?: {
  loadSpot?: typeof loadUpbitBacktestCandles;
  loadStock?: typeof loadStockBacktestCandles;
}) {
  const symbol = normalizeBacktestSymbol(input.market, input.symbol);
  const loadSpot = dependencies?.loadSpot ?? loadUpbitBacktestCandles;
  const loadStock = dependencies?.loadStock ?? loadStockBacktestCandles;
  const history = input.market === 'crypto-spot'
    ? await loadSpot({ symbol, timeframe: input.timeframe, startTime: input.startTime, endTime: input.endTime })
    : await loadStock({ market: input.market, symbol, timeframe: input.timeframe, startTime: input.startTime, endTime: input.endTime });
  if (!history.candles.length) throw new BacktestMarketContractError('NO_HISTORICAL_DATA', '요청 기간에 백테스트할 과거 데이터가 없습니다.');
  const result = runCashBacktest({
    market: input.market,
    symbol,
    timeframe: input.timeframe,
    initialCapital: input.initialCapital,
    strategy: input.strategy,
    parameters: input.parameters,
    riskPercent: input.riskPercent,
    entryFeeRate: input.entryFeeRate,
    exitFeeRate: input.exitFeeRate,
    slippageRate: input.slippageRate,
    stopLossPercent: input.stopLossPercent,
    takeProfitR: input.takeProfitR,
    maximumTradesPerDay: input.maximumTradesPerDay,
    intrabarPriority: input.intrabarPriority,
  }, history.candles);
  result.warnings = [...new Set([...history.warnings, ...result.warnings])];
  return { ok: true as const, mode: 'backtest-only' as const, orderSubmitted: false as const, provider: history.provider, result };
}
