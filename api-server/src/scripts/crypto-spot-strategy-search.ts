import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadUpbitBacktestCandles } from '../services/upbit-backtest-data.service';
import {
  runCashBacktest,
  type CashBacktestCandle,
  type CashBacktestRequest,
  type CashBacktestResult,
} from '../services/cash-backtest-engine.service';

const DAY = 24 * 60 * 60_000;
const DAYS = 90;
const TIMEFRAME = '15m';
const END_TIME = Date.now() - 60_000;
const START_TIME = END_TIME - DAYS * DAY;
const OUTPUT_PATH = process.env.BACKTEST_OUTPUT
  ?? path.resolve(process.cwd(), 'artifacts/crypto-spot-strategy-search.json');
const SYMBOLS = ['KRW-BTC', 'KRW-ETH'] as const;

const GATE = Object.freeze({
  minimumFullTrades: 50,
  minimumFullExpectancyR: 0.1,
  minimumFullProfitFactor: 1.2,
  minimumTestTradesPerSymbol: 3,
  minimumTestExpectancyR: 0.05,
  minimumTestProfitFactor: 1.1,
  maximumDrawdownPercent: 15,
});

type Symbol = typeof SYMBOLS[number];
type SegmentName = 'training' | 'validation' | 'test' | 'full';
type Candidate = {
  id: string;
  fastPeriod: number;
  slowPeriod: number;
  oversoldRsi: number;
  recoveryRsi: number;
  oversoldLookback: number;
  stopAtrMultiplier: number;
  takeProfitR: number;
};
type SegmentResult = {
  symbol: Symbol;
  segment: SegmentName;
  startTime: number;
  endTime: number;
  totalTrades: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number | null;
  maximumDrawdownPercent: number;
  totalReturnPercent: number;
  averageWinR: number;
  averageLossR: number;
};

type CandidateAssessment = {
  candidate: Candidate;
  selectionSegments: SegmentResult[];
  minimumSelectionExpectancyR: number;
  minimumSelectionProfitFactor: number;
  selectionTrades: number;
  score: number;
};

function buildCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [fastPeriod, slowPeriod] of [[12, 36], [20, 50]] as const) {
    for (const [oversoldRsi, recoveryRsi] of [[35, 45], [40, 50], [45, 55]] as const) {
      for (const oversoldLookback of [4, 8]) {
        for (const [stopAtrMultiplier, takeProfitR] of [[1.5, 1.2], [1.5, 1.5], [2, 1.5]] as const) {
          candidates.push({
            id: `f${fastPeriod}-s${slowPeriod}-os${oversoldRsi}-rc${recoveryRsi}-lb${oversoldLookback}-atr${stopAtrMultiplier}-r${takeProfitR}`,
            fastPeriod,
            slowPeriod,
            oversoldRsi,
            recoveryRsi,
            oversoldLookback,
            stopAtrMultiplier,
            takeProfitR,
          });
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
    test: candles.slice(validationEnd),
    full: candles,
  };
}

function parameters(candidate: Candidate): Record<string, number> {
  return {
    regimeFilterEnabled: 1,
    regimeFastPeriod1h: 12,
    regimeSlowPeriod1h: 26,
    regimeFastPeriod4h: 6,
    regimeSlowPeriod4h: 18,
    minimumTrendSlopePercent: 0,
    fastPeriod: candidate.fastPeriod,
    slowPeriod: candidate.slowPeriod,
    oversoldRsi: candidate.oversoldRsi,
    recoveryRsi: candidate.recoveryRsi,
    oversoldLookback: candidate.oversoldLookback,
    maximumExtensionPercent: 2,
    volumePeriod: 20,
    volumeMultiplier: 0.5,
    rsiPeriod: 14,
    minimumEntryRsi: 0,
    maximumEntryRsi: 100,
    cooldownBars: 8,
    strategyExitEnabled: 0,
    entryOnNextOpen: 1,
    executionAtrPeriod: 14,
    stopAtrMultiplier: candidate.stopAtrMultiplier,
    minimumStopToCostRatio: 2,
  };
}

function request(symbol: Symbol, candidate: Candidate): CashBacktestRequest {
  return {
    market: 'crypto-spot',
    symbol,
    timeframe: TIMEFRAME,
    initialCapital: 1_000_000,
    strategy: 'regime_rsi_reversal',
    parameters: parameters(candidate),
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

function summarize(symbol: Symbol, segment: SegmentName, candles: CashBacktestCandle[], result: CashBacktestResult): SegmentResult {
  return {
    symbol,
    segment,
    startTime: candles.at(0)?.timestamp ?? 0,
    endTime: candles.at(-1)?.timestamp ?? 0,
    totalTrades: result.totalTrades,
    winRate: result.winRate,
    expectancyR: result.expectancy,
    profitFactor: result.profitFactor,
    maximumDrawdownPercent: result.maximumDrawdownPercent,
    totalReturnPercent: result.totalReturnPercent,
    averageWinR: result.averageWinR,
    averageLossR: result.averageLossR,
  };
}

function runSegment(symbol: Symbol, segment: SegmentName, candles: CashBacktestCandle[], candidate: Candidate) {
  const result = runCashBacktest(request(symbol, candidate), candles);
  return summarize(symbol, segment, candles, result);
}

function finiteProfitFactor(value: number | null) {
  return value == null ? Number.POSITIVE_INFINITY : value;
}

function assessCandidate(candidate: Candidate, datasets: Record<Symbol, ReturnType<typeof splitCandles>>): CandidateAssessment {
  const selectionSegments: SegmentResult[] = [];
  for (const symbol of SYMBOLS) {
    selectionSegments.push(runSegment(symbol, 'training', datasets[symbol].training, candidate));
    selectionSegments.push(runSegment(symbol, 'validation', datasets[symbol].validation, candidate));
  }
  const minimumSelectionExpectancyR = Math.min(...selectionSegments.map((result) => result.expectancyR));
  const minimumSelectionProfitFactor = Math.min(...selectionSegments.map((result) => finiteProfitFactor(result.profitFactor)));
  const selectionTrades = selectionSegments.reduce((sum, result) => sum + result.totalTrades, 0);
  const sparsePenalty = selectionSegments.reduce((sum, result) => sum + Math.max(0, 5 - result.totalTrades) * 0.05, 0);
  const score = minimumSelectionExpectancyR
    + Math.min(minimumSelectionProfitFactor, 3) * 0.05
    + Math.min(selectionTrades, 100) * 0.001
    - sparsePenalty;
  return { candidate, selectionSegments, minimumSelectionExpectancyR, minimumSelectionProfitFactor, selectionTrades, score };
}

function automationAssessment(test: SegmentResult[], full: SegmentResult[]) {
  const reasons: string[] = [];
  const fullTrades = full.reduce((sum, result) => sum + result.totalTrades, 0);
  if (fullTrades < GATE.minimumFullTrades) reasons.push('INSUFFICIENT_FULL_TRADES');
  if (full.some((result) => result.expectancyR < GATE.minimumFullExpectancyR)) reasons.push('FULL_EXPECTANCY_BELOW_MINIMUM');
  if (full.some((result) => finiteProfitFactor(result.profitFactor) < GATE.minimumFullProfitFactor)) reasons.push('FULL_PROFIT_FACTOR_BELOW_MINIMUM');
  if (full.some((result) => result.maximumDrawdownPercent > GATE.maximumDrawdownPercent)) reasons.push('DRAWDOWN_ABOVE_MAXIMUM');
  if (test.some((result) => result.totalTrades < GATE.minimumTestTradesPerSymbol)) reasons.push('INSUFFICIENT_LOCKED_TEST_TRADES');
  if (test.some((result) => result.expectancyR < GATE.minimumTestExpectancyR)) reasons.push('LOCKED_TEST_EXPECTANCY_BELOW_MINIMUM');
  if (test.some((result) => finiteProfitFactor(result.profitFactor) < GATE.minimumTestProfitFactor)) reasons.push('LOCKED_TEST_PROFIT_FACTOR_BELOW_MINIMUM');
  return { automationEligible: reasons.length === 0, automationBlockReasons: [...new Set(reasons)] };
}

const histories = {} as Record<Symbol, CashBacktestCandle[]>;
const providerWarnings = {} as Record<Symbol, string[]>;
for (const symbol of SYMBOLS) {
  const history = await loadUpbitBacktestCandles({ symbol, timeframe: TIMEFRAME, startTime: START_TIME, endTime: END_TIME });
  histories[symbol] = history.candles as CashBacktestCandle[];
  providerWarnings[symbol] = history.warnings;
}

const datasets = Object.fromEntries(SYMBOLS.map((symbol) => [symbol, splitCandles(histories[symbol])])) as Record<Symbol, ReturnType<typeof splitCandles>>;
const assessed = buildCandidates()
  .map((candidate) => assessCandidate(candidate, datasets))
  .sort((left, right) => right.score - left.score || right.selectionTrades - left.selectionTrades);
const selected = assessed[0];
if (!selected) throw new Error('NO_STRATEGY_CANDIDATE');

const lockedTest = SYMBOLS.map((symbol) => runSegment(symbol, 'test', datasets[symbol].test, selected.candidate));
const full = SYMBOLS.map((symbol) => runSegment(symbol, 'full', datasets[symbol].full, selected.candidate));
const gate = automationAssessment(lockedTest, full);

const payload = {
  ok: true,
  mode: 'backtest-only',
  orderSubmitted: false,
  strategyFamily: 'regime_rsi_reversal',
  generatedAt: new Date().toISOString(),
  period: { startTime: START_TIME, endTime: END_TIME, days: DAYS, timeframe: TIMEFRAME },
  split: { trainingPercent: 60, validationPercent: 20, lockedTestPercent: 20 },
  selectionPolicy: '후보 선택에는 학습·검증 구간만 사용하며 잠금 테스트 구간은 선택 후 한 번만 평가합니다.',
  candidateCount: assessed.length,
  selectedCandidate: selected.candidate,
  selectionSegments: selected.selectionSegments,
  lockedTest,
  full,
  ...gate,
  gate: GATE,
  topCandidates: assessed.slice(0, 10).map((assessment) => ({
    candidate: assessment.candidate,
    score: assessment.score,
    selectionTrades: assessment.selectionTrades,
    minimumSelectionExpectancyR: assessment.minimumSelectionExpectancyR,
    minimumSelectionProfitFactor: assessment.minimumSelectionProfitFactor,
  })),
  providerWarnings,
};

await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(payload, null, 2));
