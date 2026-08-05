import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadUpbitBacktestCandles } from '../services/upbit-backtest-data.service';
import {
  runCashBacktest,
  type CashBacktestCandle,
  type CashBacktestRequest,
  type CashBacktestResult,
  type CashBacktestStrategy,
} from '../services/cash-backtest-engine.service';

const DAY = 24 * 60 * 60_000;
const DAYS = 90;
const TIMEFRAME = '15m';
const END_TIME = Date.now() - 60_000;
const START_TIME = END_TIME - DAYS * DAY;
const OUTPUT_PATH = process.env.BACKTEST_OUTPUT
  ?? path.resolve(process.cwd(), 'artifacts/crypto-spot-engine-family-search.json');
const SYMBOLS = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE', 'KRW-ADA'] as const;
const SELECTION_MINIMUM = Object.freeze({ trainingTrades: 30, validationTrades: 10, activeSymbols: 4 });
const GATE = Object.freeze({
  minimumFullTrades: 50,
  minimumFullExpectancyR: 0.1,
  minimumFullProfitFactor: 1.2,
  minimumLockedTestTrades: 10,
  minimumLockedTestExpectancyR: 0.05,
  minimumLockedTestProfitFactor: 1.1,
  minimumActiveSymbols: 4,
  maximumDrawdownPercent: 15,
});

type Symbol = typeof SYMBOLS[number];
type SegmentName = 'training' | 'validation' | 'locked-test' | 'full';
type Candidate = {
  id: string;
  family: Extract<CashBacktestStrategy, 'regime_pullback' | 'regime_breakout_retest'>;
  parameters: Record<string, number>;
  stopAtrMultiplier: number;
  takeProfitR: number;
};
type SymbolResult = {
  symbol: Symbol;
  segment: SegmentName;
  totalTrades: number;
  wins: number;
  losses: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  expectancyR: number;
  maximumDrawdownPercent: number;
  totalReturnPercent: number;
};
type AggregateResult = {
  segment: SegmentName;
  symbolResults: SymbolResult[];
  activeSymbols: number;
  totalTrades: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number | null;
  maximumDrawdownPercent: number;
  totalReturnPercent: number;
};
type CandidateAssessment = {
  candidate: Candidate;
  training: AggregateResult;
  validation: AggregateResult;
  selectionQualified: boolean;
  score: number;
};

function commonParameters() {
  return {
    regimeFilterEnabled: 1,
    regimeFastPeriod1h: 12,
    regimeSlowPeriod1h: 26,
    regimeFastPeriod4h: 6,
    regimeSlowPeriod4h: 18,
    minimumTrendSlopePercent: 0,
    rsiPeriod: 14,
    minimumEntryRsi: 40,
    maximumEntryRsi: 75,
    cooldownBars: 16,
    strategyExitEnabled: 0,
    entryOnNextOpen: 1,
    executionAtrPeriod: 14,
    minimumStopToCostRatio: 2,
  };
}

function buildCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [fastPeriod, slowPeriod] of [[12, 36], [20, 50]] as const) {
    for (const pullbackTolerancePercent of [0.15, 0.35]) {
      for (const volumeMultiplier of [0.7, 1]) {
        for (const [stopAtrMultiplier, takeProfitR] of [[1.5, 1.5], [1.5, 2], [2, 2]] as const) {
          candidates.push({
            id: `pullback-f${fastPeriod}-s${slowPeriod}-p${pullbackTolerancePercent}-v${volumeMultiplier}-atr${stopAtrMultiplier}-r${takeProfitR}`,
            family: 'regime_pullback',
            parameters: {
              ...commonParameters(),
              fastPeriod,
              slowPeriod,
              pullbackTolerancePercent,
              maximumExtensionPercent: 1,
              volumePeriod: 20,
              volumeMultiplier,
              stopAtrMultiplier,
            },
            stopAtrMultiplier,
            takeProfitR,
          });
        }
      }
    }
  }
  for (const lookback of [32, 64]) {
    for (const [minimumBreakoutAtr, maximumBreakoutAtr] of [[0.05, 0.6], [0.1, 1]] as const) {
      for (const retestBars of [8, 16]) {
        for (const retestTolerancePercent of [0.15, 0.35]) {
          for (const [stopAtrMultiplier, takeProfitR] of [[1.5, 1.5], [1.5, 2], [2, 2]] as const) {
            candidates.push({
              id: `retest-lb${lookback}-bo${minimumBreakoutAtr}-${maximumBreakoutAtr}-bars${retestBars}-tol${retestTolerancePercent}-atr${stopAtrMultiplier}-r${takeProfitR}`,
              family: 'regime_breakout_retest',
              parameters: {
                ...commonParameters(),
                lookback,
                atrPeriod: 14,
                minimumBreakoutAtr,
                maximumBreakoutAtr,
                retestBars,
                retestTolerancePercent,
                retestInvalidationPercent: 0.6,
                maximumExtensionPercent: 1,
                volumePeriod: 20,
                volumeMultiplier: 0.7,
                stopAtrMultiplier,
              },
              stopAtrMultiplier,
              takeProfitR,
            });
          }
        }
      }
    }
  }
  return candidates;
}

function splitCandles(candles: CashBacktestCandle[]) {
  const trainingEnd = Math.floor(candles.length * 0.6);
  const validationEnd = Math.floor(candles.length * 0.8);
  return {
    training: candles.slice(0, trainingEnd),
    validation: candles.slice(trainingEnd, validationEnd),
    lockedTest: candles.slice(validationEnd),
    full: candles,
  };
}

function request(symbol: Symbol, candidate: Candidate): CashBacktestRequest {
  return {
    market: 'crypto-spot',
    symbol,
    timeframe: TIMEFRAME,
    initialCapital: 1_000_000,
    strategy: candidate.family,
    parameters: candidate.parameters,
    riskPercent: 0.15,
    entryFeeRate: 0.0005,
    exitFeeRate: 0.0005,
    slippageRate: 0.0005,
    stopLossPercent: 1.5,
    takeProfitR: candidate.takeProfitR,
    maximumTradesPerDay: 2,
    intrabarPriority: 'stop_first',
  };
}

function summarize(symbol: Symbol, segment: SegmentName, result: CashBacktestResult): SymbolResult {
  const winning = result.trades.filter((trade) => trade.netPnl > 0);
  const losing = result.trades.filter((trade) => trade.netPnl <= 0);
  return {
    symbol,
    segment,
    totalTrades: result.totalTrades,
    wins: winning.length,
    losses: losing.length,
    netPnl: result.finalCapital - result.initialCapital,
    grossProfit: winning.reduce((sum, trade) => sum + trade.netPnl, 0),
    grossLoss: Math.abs(losing.reduce((sum, trade) => sum + trade.netPnl, 0)),
    expectancyR: result.expectancy,
    maximumDrawdownPercent: result.maximumDrawdownPercent,
    totalReturnPercent: result.totalReturnPercent,
  };
}

function aggregate(segment: SegmentName, symbolResults: SymbolResult[]): AggregateResult {
  const totalTrades = symbolResults.reduce((sum, result) => sum + result.totalTrades, 0);
  const wins = symbolResults.reduce((sum, result) => sum + result.wins, 0);
  const grossProfit = symbolResults.reduce((sum, result) => sum + result.grossProfit, 0);
  const grossLoss = symbolResults.reduce((sum, result) => sum + result.grossLoss, 0);
  const weightedExpectancy = totalTrades
    ? symbolResults.reduce((sum, result) => sum + result.expectancyR * result.totalTrades, 0) / totalTrades
    : 0;
  return {
    segment,
    symbolResults,
    activeSymbols: symbolResults.filter((result) => result.totalTrades > 0).length,
    totalTrades,
    winRate: totalTrades ? wins / totalTrades * 100 : 0,
    expectancyR: weightedExpectancy,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    maximumDrawdownPercent: Math.max(0, ...symbolResults.map((result) => result.maximumDrawdownPercent)),
    totalReturnPercent: symbolResults.reduce((sum, result) => sum + result.totalReturnPercent, 0) / Math.max(1, symbolResults.length),
  };
}

function runAggregate(
  segment: SegmentName,
  candidate: Candidate,
  datasets: Record<Symbol, ReturnType<typeof splitCandles>>,
) {
  const results = SYMBOLS.map((symbol) => {
    const candles = segment === 'locked-test' ? datasets[symbol].lockedTest : datasets[symbol][segment];
    return summarize(symbol, segment, runCashBacktest(request(symbol, candidate), candles));
  });
  return aggregate(segment, results);
}

function finiteProfitFactor(value: number | null) {
  return value == null ? Number.POSITIVE_INFINITY : value;
}

function assess(candidate: Candidate, datasets: Record<Symbol, ReturnType<typeof splitCandles>>): CandidateAssessment {
  const training = runAggregate('training', candidate, datasets);
  const validation = runAggregate('validation', candidate, datasets);
  const selectionQualified = training.totalTrades >= SELECTION_MINIMUM.trainingTrades
    && validation.totalTrades >= SELECTION_MINIMUM.validationTrades
    && training.activeSymbols >= SELECTION_MINIMUM.activeSymbols
    && validation.activeSymbols >= Math.min(3, SELECTION_MINIMUM.activeSymbols);
  const minimumExpectancy = Math.min(training.expectancyR, validation.expectancyR);
  const minimumProfitFactor = Math.min(finiteProfitFactor(training.profitFactor), finiteProfitFactor(validation.profitFactor));
  const score = selectionQualified
    ? minimumExpectancy + Math.min(minimumProfitFactor, 3) * 0.05 + Math.min(training.totalTrades + validation.totalTrades, 150) * 0.001
    : -1_000_000 + training.totalTrades + validation.totalTrades;
  return { candidate, training, validation, selectionQualified, score };
}

function eligibility(selectionQualified: boolean, lockedTest: AggregateResult, full: AggregateResult) {
  const reasons: string[] = [];
  if (!selectionQualified) reasons.push('NO_SELECTION_CANDIDATE_WITH_ADEQUATE_SAMPLE');
  if (full.totalTrades < GATE.minimumFullTrades) reasons.push('INSUFFICIENT_FULL_TRADES');
  if (full.expectancyR < GATE.minimumFullExpectancyR) reasons.push('FULL_EXPECTANCY_BELOW_MINIMUM');
  if (finiteProfitFactor(full.profitFactor) < GATE.minimumFullProfitFactor) reasons.push('FULL_PROFIT_FACTOR_BELOW_MINIMUM');
  if (full.activeSymbols < GATE.minimumActiveSymbols) reasons.push('INSUFFICIENT_ACTIVE_SYMBOLS');
  if (full.maximumDrawdownPercent > GATE.maximumDrawdownPercent) reasons.push('DRAWDOWN_ABOVE_MAXIMUM');
  if (lockedTest.totalTrades < GATE.minimumLockedTestTrades) reasons.push('INSUFFICIENT_LOCKED_TEST_TRADES');
  if (lockedTest.expectancyR < GATE.minimumLockedTestExpectancyR) reasons.push('LOCKED_TEST_EXPECTANCY_BELOW_MINIMUM');
  if (finiteProfitFactor(lockedTest.profitFactor) < GATE.minimumLockedTestProfitFactor) reasons.push('LOCKED_TEST_PROFIT_FACTOR_BELOW_MINIMUM');
  return { automationEligible: reasons.length === 0, automationBlockReasons: reasons };
}

const histories = {} as Record<Symbol, CashBacktestCandle[]>;
const providerWarnings: Record<string, string[]> = {};
const providerErrors: Record<string, string> = {};
for (const symbol of SYMBOLS) {
  try {
    const history = await loadUpbitBacktestCandles({ symbol, timeframe: TIMEFRAME, startTime: START_TIME, endTime: END_TIME });
    histories[symbol] = history.candles as CashBacktestCandle[];
    providerWarnings[symbol] = history.warnings;
  } catch (error) {
    providerErrors[symbol] = error instanceof Error ? error.message : String(error);
    histories[symbol] = [];
  }
}

const usableSymbols = SYMBOLS.filter((symbol) => histories[symbol].length >= 60);
if (usableSymbols.length < 4) throw new Error('INSUFFICIENT_LIQUID_UNIVERSE_DATA');
const datasets = Object.fromEntries(
  SYMBOLS.map((symbol) => [symbol, splitCandles(histories[symbol])]),
) as Record<Symbol, ReturnType<typeof splitCandles>>;

const ranked = buildCandidates().map((candidate) => assess(candidate, datasets))
  .sort((left, right) => right.score - left.score || right.training.totalTrades - left.training.totalTrades);
const selected = ranked[0];
if (!selected) throw new Error('NO_STRATEGY_CANDIDATE');
const lockedTest = runAggregate('locked-test', selected.candidate, datasets);
const full = runAggregate('full', selected.candidate, datasets);
const gate = eligibility(selected.selectionQualified, lockedTest, full);

const payload = {
  ok: true,
  mode: 'backtest-only',
  orderSubmitted: false,
  strategyFamilies: ['regime_pullback', 'regime_breakout_retest'],
  generatedAt: new Date().toISOString(),
  period: { startTime: START_TIME, endTime: END_TIME, days: DAYS, timeframe: TIMEFRAME },
  universe: SYMBOLS,
  usableSymbols,
  split: { trainingPercent: 60, validationPercent: 20, lockedTestPercent: 20 },
  selectionMinimum: SELECTION_MINIMUM,
  selectionPolicy: '여러 유동성 상위 코인에 공통 적용되는 후보만 학습·검증에서 선택하고 잠금 테스트는 선택 후 한 번만 평가합니다.',
  candidateCount: ranked.length,
  selectedCandidate: selected.candidate,
  selectionQualified: selected.selectionQualified,
  training: selected.training,
  validation: selected.validation,
  lockedTest,
  full,
  ...gate,
  gate: GATE,
  topCandidates: ranked.slice(0, 10).map((item) => ({
    candidate: item.candidate,
    selectionQualified: item.selectionQualified,
    score: item.score,
    trainingTrades: item.training.totalTrades,
    validationTrades: item.validation.totalTrades,
    trainingExpectancyR: item.training.expectancyR,
    validationExpectancyR: item.validation.expectancyR,
    trainingProfitFactor: item.training.profitFactor,
    validationProfitFactor: item.validation.profitFactor,
  })),
  providerWarnings,
  providerErrors,
};

await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(payload, null, 2));
