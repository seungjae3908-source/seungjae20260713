import { discoverCandidates, evaluateForward, summarizeTrials } from './engine.mjs';

export function runHistoricalReplay({
  market,
  decisionTimes,
  universeAt,
  candlesBySymbol,
  topK = 20,
  minScore = 0,
  forwardConfig = {},
}) {
  const discoveries = [];
  const trials = [];
  for (const asOf of decisionTimes) {
    const symbols = universeAt(asOf);
    const ranked = discoverCandidates({ market, symbols, candlesBySymbol, asOf, topK, minScore });
    discoveries.push({ asOf, ranked });
    for (const candidate of ranked) {
      try {
        trials.push({
          market,
          symbol: candidate.symbol,
          rank: candidate.rank,
          score: candidate.score,
          ...evaluateForward({ candles: candlesBySymbol[candidate.symbol], discoveredAt: asOf, ...forwardConfig }),
        });
      } catch (error) {
        trials.push({
          market,
          symbol: candidate.symbol,
          rank: candidate.rank,
          score: candidate.score,
          discoveredAt: asOf,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const settled = trials.filter((trial) => Number.isFinite(trial.netReturn));
  return { market, decisionPoints: decisionTimes.length, discoveries, trials, summary: summarizeTrials(settled) };
}

export function runFourMarketReplay({ markets, ...shared }) {
  const reports = {};
  for (const [market, input] of Object.entries(markets)) {
    reports[market] = runHistoricalReplay({ market, ...shared, ...input });
  }
  return reports;
}
