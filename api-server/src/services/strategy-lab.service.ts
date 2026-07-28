export type BacktestBar = {
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type StrategyParams = {
  fast: number;
  slow: number;
  stopPct: number;
  takePct: number;
};

type Metrics = {
  trades: number;
  winRate: number;
  netReturnPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  score: number;
};

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function simulate(bars: BacktestBar[], params: StrategyParams, feePct: number, slippagePct: number): Metrics {
  let cash = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let entry = 0;
  let wins = 0;
  let trades = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  const closes: number[] = [];

  const exit = (price: number) => {
    const effective = price * (1 - slippagePct / 100);
    const pnlPct = ((effective - entry) / entry) * 100 - feePct * 2;
    cash *= Math.max(0.01, 1 + pnlPct / 100);
    peak = Math.max(peak, cash);
    maxDrawdown = Math.max(maxDrawdown, ((peak - cash) / peak) * 100);
    trades += 1;
    if (pnlPct > 0) { wins += 1; grossProfit += pnlPct; }
    else grossLoss += Math.abs(pnlPct);
    entry = 0;
  };

  for (const bar of bars) {
    closes.push(bar.close);
    if (closes.length < params.slow + 1) continue;
    const fastNow = mean(closes.slice(-params.fast));
    const slowNow = mean(closes.slice(-params.slow));
    const fastPrev = mean(closes.slice(-params.fast - 1, -1));
    const slowPrev = mean(closes.slice(-params.slow - 1, -1));

    if (!entry && fastPrev <= slowPrev && fastNow > slowNow) {
      entry = bar.close * (1 + slippagePct / 100);
      continue;
    }
    if (!entry) continue;
    const change = ((bar.close - entry) / entry) * 100;
    if (change <= -params.stopPct || change >= params.takePct || (fastPrev >= slowPrev && fastNow < slowNow)) {
      exit(bar.close);
    }
  }
  if (entry) exit(bars[bars.length - 1].close);

  const netReturnPct = (cash - 1) * 100;
  const winRate = trades ? (wins / trades) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 10 : 0;
  const score = netReturnPct - maxDrawdown * 1.4 + Math.min(profitFactor, 4) * 3 + Math.min(trades, 20) * 0.15;
  return { trades, winRate, netReturnPct, maxDrawdownPct: maxDrawdown, profitFactor, score };
}

function cleanBars(value: unknown): BacktestBar[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-2500).map((raw: any, index) => ({
    time: raw?.time ?? raw?.date ?? index,
    open: Number(raw?.open), high: Number(raw?.high), low: Number(raw?.low), close: Number(raw?.close), volume: Number(raw?.volume ?? 0),
  })).filter((bar) => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) && bar.close > 0);
}

export function runRepeatedBacktest(input: {
  bars: unknown;
  feePct?: unknown;
  slippagePct?: unknown;
  maxRuns?: unknown;
}) {
  const bars = cleanBars(input.bars);
  if (bars.length < 120) throw new Error('BACKTEST_REQUIRES_120_BARS');
  const feePct = Math.max(0, Math.min(1, Number(input.feePct ?? 0.05)));
  const slippagePct = Math.max(0, Math.min(1, Number(input.slippagePct ?? 0.05)));
  const maxRuns = Math.max(50, Math.min(2000, Number(input.maxRuns ?? 720) || 720));
  const split = Math.max(80, Math.floor(bars.length * 0.7));
  const train = bars.slice(0, split);
  const test = bars.slice(Math.max(0, split - 80));
  const candidates: Array<{ params: StrategyParams; train: Metrics }> = [];

  outer: for (const fast of [3, 5, 8, 10, 12, 15, 20]) {
    for (const slow of [20, 30, 40, 50, 60, 80, 100]) {
      if (fast >= slow) continue;
      for (const stopPct of [0.8, 1, 1.5, 2, 3, 4, 5]) {
        for (const takePct of [1, 1.5, 2, 3, 4, 6, 8]) {
          candidates.push({ params: { fast, slow, stopPct, takePct }, train: simulate(train, { fast, slow, stopPct, takePct }, feePct, slippagePct) });
          if (candidates.length >= maxRuns) break outer;
        }
      }
    }
  }

  const ranked = candidates
    .filter((item) => item.train.trades >= 2)
    .sort((a, b) => b.train.score - a.train.score)
    .slice(0, 20)
    .map((item) => ({ ...item, validation: simulate(test, item.params, feePct, slippagePct) }))
    .sort((a, b) => b.validation.score - a.validation.score);
  const best = ranked[0] ?? null;
  const accepted = Boolean(best && best.validation.trades >= 2 && best.validation.netReturnPct > 0 && best.validation.maxDrawdownPct <= 20 && best.validation.profitFactor >= 1.05);

  return {
    ok: true,
    simulationOnly: true,
    realOrdersBlocked: true,
    runs: candidates.length,
    bars: bars.length,
    assumptions: { feePct, slippagePct, trainBars: train.length, validationBars: test.length },
    accepted,
    decision: accepted ? 'PAPER_STRATEGY_SELECTED' : 'NO_STRATEGY_PASSED_VALIDATION',
    best,
    finalists: ranked.slice(0, 5),
  };
}
