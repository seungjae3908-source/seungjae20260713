import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadUpbitBacktestCandles } from '../services/upbit-backtest-data.service';
import { loadStockBacktestCandles } from '../services/stock-backtest-data.service';
import { runCashBacktest, type CashBacktestCandle, type CashBacktestStrategy } from '../services/cash-backtest-engine.service';
import { loadHistoricalBacktestCandles } from '../services/backtest-data.service';
import { getFuturesContractRules } from '../services/futures-contract-rules.service';
import { runBacktest, type BacktestSide, type BacktestStrategyType } from '../services/backtest-engine.service';

const DAY = 24 * 60 * 60_000;
const now = Date.now();
const days = Math.min(90, Math.max(7, Number(process.env.BACKTEST_DAYS ?? 30)));
const startTime = now - days * DAY;
const endTime = now - 60_000;
const timeframe = String(process.env.BACKTEST_TIMEFRAME ?? '15m');
const outputPath = process.env.BACKTEST_OUTPUT ?? path.resolve(process.cwd(), 'artifacts/public-backtest-results.json');
const baselineCashStrategies: CashBacktestStrategy[] = ['trend_pullback', 'breakout', 'vwap_reclaim'];
const futuresStrategies: BacktestStrategyType[] = ['trend_pullback', 'breakout', 'vwap_reclaim'];
const futuresSides: BacktestSide[] = ['long', 'short', 'both'];

const AUTOMATION_GATE = Object.freeze({
  minimumTrades: 50,
  minimumExpectancyR: 0.1,
  minimumProfitFactor: 1.2,
  maximumDrawdownPercent: 15,
});

type Row = Record<string, unknown>;
const rows: Row[] = [];

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function automationAssessment(input: {
  totalTrades: number;
  expectancyR: number;
  profitFactor: number | null;
  maximumDrawdownPercent: number;
}) {
  const reasons: string[] = [];
  if (input.totalTrades < AUTOMATION_GATE.minimumTrades) reasons.push('INSUFFICIENT_TRADES');
  if (input.expectancyR < AUTOMATION_GATE.minimumExpectancyR) reasons.push('EXPECTANCY_BELOW_MINIMUM');
  if (input.profitFactor == null || input.profitFactor < AUTOMATION_GATE.minimumProfitFactor) reasons.push('PROFIT_FACTOR_BELOW_MINIMUM');
  if (input.maximumDrawdownPercent > AUTOMATION_GATE.maximumDrawdownPercent) reasons.push('DRAWDOWN_ABOVE_MAXIMUM');
  return { automationEligible: reasons.length === 0, automationBlockReasons: reasons };
}

function cashSummary(input: {
  market: 'kr-stock' | 'us-stock' | 'crypto-spot';
  symbol: string;
  provider: string;
  strategy: CashBacktestStrategy;
  result: ReturnType<typeof runCashBacktest>;
  profile: string;
}): Row {
  const { result } = input;
  return {
    market: input.market,
    symbol: input.symbol,
    provider: input.provider,
    strategy: input.strategy,
    action: 'BUY_SELL',
    timeframe,
    profile: input.profile,
    totalTrades: result.totalTrades,
    winRate: result.winRate,
    averageWinR: result.averageWinR,
    averageLossR: result.averageLossR,
    expectancyR: result.expectancy,
    profitFactor: result.profitFactor,
    totalReturnPercent: result.totalReturnPercent,
    maximumDrawdownPercent: result.maximumDrawdownPercent,
    totalFees: result.totalFees,
    totalSlippage: result.totalSlippage,
    ...automationAssessment({
      totalTrades: result.totalTrades,
      expectancyR: result.expectancy,
      profitFactor: result.profitFactor,
      maximumDrawdownPercent: result.maximumDrawdownPercent,
    }),
    warnings: result.warnings,
  };
}

function regimePullbackV4Parameters(): Record<string, number> {
  return {
    regimeFilterEnabled: 1,
    regimeFastPeriod1h: 12,
    regimeSlowPeriod1h: 26,
    regimeFastPeriod4h: 12,
    regimeSlowPeriod4h: 26,
    minimumTrendSlopePercent: 0,
    fastPeriod: 20,
    slowPeriod: 50,
    pullbackTolerancePercent: 0.2,
    maximumExtensionPercent: 0.6,
    volumePeriod: 20,
    volumeMultiplier: 0.9,
    rsiPeriod: 14,
    minimumEntryRsi: 45,
    maximumEntryRsi: 68,
    cooldownBars: 24,
    strategyExitEnabled: 0,
    entryOnNextOpen: 1,
    executionAtrPeriod: 14,
    stopAtrMultiplier: 1.5,
  };
}

function baselineParameters(strategy: CashBacktestStrategy): Record<string, number> {
  if (strategy === 'trend_pullback') {
    return { fastPeriod: 20, slowPeriod: 50, pullbackTolerancePercent: 0.5, volumePeriod: 20, volumeMultiplier: 1 };
  }
  if (strategy === 'breakout') return { lookback: 20, volumePeriod: 20, volumeMultiplier: 1.2 };
  return { volumePeriod: 20, volumeMultiplier: 1.1 };
}

async function runCashInstrument(input: { market: 'kr-stock' | 'us-stock' | 'crypto-spot'; symbol: string }) {
  try {
    const history = input.market === 'crypto-spot'
      ? await loadUpbitBacktestCandles({ symbol: input.symbol, timeframe, startTime, endTime })
      : await loadStockBacktestCandles({ market: input.market, symbol: input.symbol, timeframe, startTime, endTime });
    const candles = history.candles as CashBacktestCandle[];
    const strategies: CashBacktestStrategy[] = input.market === 'crypto-spot' ? ['regime_pullback'] : baselineCashStrategies;
    for (const strategy of strategies) {
      const crypto = input.market === 'crypto-spot';
      const result = runCashBacktest({
        market: input.market,
        symbol: input.symbol,
        timeframe,
        initialCapital: 1_000_000,
        strategy,
        parameters: crypto ? regimePullbackV4Parameters() : baselineParameters(strategy),
        riskPercent: crypto ? 0.15 : 0.25,
        entryFeeRate: crypto ? 0.0005 : 0.00015,
        exitFeeRate: crypto ? 0.0005 : 0.00015,
        slippageRate: input.market === 'us-stock' ? 0.001 : 0.0005,
        stopLossPercent: crypto ? 1.5 : 1,
        takeProfitR: crypto ? 2 : 1.5,
        maximumTradesPerDay: crypto ? 2 : 10,
        intrabarPriority: 'stop_first',
      }, candles);
      rows.push(cashSummary({
        market: input.market,
        symbol: input.symbol,
        provider: history.provider,
        strategy,
        result,
        profile: crypto ? 'crypto-spot-regime-pullback-v4' : 'baseline-v1',
      }));
    }
  } catch (error) {
    rows.push({
      market: input.market,
      symbol: input.symbol,
      action: 'BUY_SELL',
      timeframe,
      automationEligible: false,
      automationBlockReasons: ['BACKTEST_ERROR'],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function futuresParameters(strategy: BacktestStrategyType): Record<string, number | boolean> {
  if (strategy === 'trend_pullback') {
    return { fastPeriod: 20, slowPeriod: 50, pullbackTolerancePercent: 0.5, volumePeriod: 20, volumeMultiplier: 1 };
  }
  if (strategy === 'breakout') return { lookback: 20, volumePeriod: 20, volumeMultiplier: 1.2 };
  return { volumePeriod: 20, volumeMultiplier: 1.1 };
}

async function runFuturesInstrument(symbol: string) {
  try {
    const [history, rules] = await Promise.all([
      loadHistoricalBacktestCandles({ symbol, timeframe, startTime, endTime }),
      getFuturesContractRules(symbol),
    ]);
    for (const strategy of futuresStrategies) {
      for (const side of futuresSides) {
        const result = runBacktest({
          market: 'crypto-futures',
          symbol,
          timeframe,
          startTime,
          endTime,
          initialCapital: 10_000,
          strategy,
          side,
          parameters: futuresParameters(strategy),
          riskPercent: 0.1,
          leverage: 1,
          entryFeeRate: 0.0006,
          exitFeeRate: 0.0006,
          slippageRate: 0.0005,
          fundingRatePerInterval: 0,
          fundingIntervalHours: 8,
          stopLossMode: 'percent',
          stopLossValue: 1,
          takeProfitMode: 'risk_multiple',
          takeProfitValue: 1.5,
          trailingStop: { enabled: false },
          maximumConcurrentPositions: 1,
          maximumTradesPerDay: 10,
          intrabarPriority: 'stop_first',
          quantityStep: rules.quantityStep,
          quantityPrecision: rules.quantityPrecision,
          minimumQuantity: rules.minimumQuantity,
          minimumNotional: rules.minimumNotional,
          maximumLeverage: rules.maximumLeverage,
          contractRulesStatus: rules.status,
        }, history.candles);
        const winningR = result.trades.filter((trade) => trade.netPnl > 0).map((trade) => trade.rMultiple);
        const losingR = result.trades.filter((trade) => trade.netPnl <= 0).map((trade) => trade.rMultiple);
        rows.push({
          market: 'crypto-futures',
          symbol,
          provider: 'bitget',
          strategy,
          action: side.toUpperCase(),
          timeframe,
          profile: 'baseline-v1',
          totalTrades: result.totalTrades,
          winRate: result.winRate,
          averageWinR: average(winningR),
          averageLossR: average(losingR),
          expectancyR: result.averageRMultiple,
          profitFactor: result.profitFactor,
          totalReturnPercent: result.totalReturnPercent,
          maximumDrawdownPercent: result.maximumDrawdownPercent,
          totalFees: result.totalFees,
          totalSlippage: result.totalSlippage,
          totalFunding: result.totalFunding,
          ...automationAssessment({
            totalTrades: result.totalTrades,
            expectancyR: result.averageRMultiple,
            profitFactor: result.profitFactor,
            maximumDrawdownPercent: result.maximumDrawdownPercent,
          }),
          warnings: [...history.warnings, ...rules.warnings, ...result.warnings],
        });
      }
    }
  } catch (error) {
    rows.push({
      market: 'crypto-futures',
      symbol,
      action: 'LONG_SHORT',
      timeframe,
      automationEligible: false,
      automationBlockReasons: ['BACKTEST_ERROR'],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

await runCashInstrument({ market: 'kr-stock', symbol: '005930' });
await runCashInstrument({ market: 'us-stock', symbol: 'AAPL' });
await runCashInstrument({ market: 'crypto-spot', symbol: 'KRW-BTC' });
await runCashInstrument({ market: 'crypto-spot', symbol: 'KRW-ETH' });
await runFuturesInstrument('BTCUSDT');
await runFuturesInstrument('ETHUSDT');

const payload = {
  ok: rows.some((row) => !('error' in row)),
  mode: 'backtest-only',
  orderSubmitted: false,
  generatedAt: new Date().toISOString(),
  period: { startTime, endTime, days, timeframe },
  automationGate: AUTOMATION_GATE,
  rows,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(payload, null, 2));
