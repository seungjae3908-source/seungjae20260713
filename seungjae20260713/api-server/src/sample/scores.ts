// Blends the fundamental and technical scores into one investment score so the
// Overview rating, AI opinion and Chart rating stay mutually consistent.
import { getCandles } from './market';
import { computeIndicators, detectSignals, technicalScore } from './indicators';
import { fundamentalScore } from './financials';
import type { Signal } from './types';

export interface Scores {
  fundamental: number;
  technical: number;
  overall: number;
  signals: Signal[];
}

export function computeScores(ticker: string): Scores {
  const candles = getCandles(ticker, '1D');
  const ind = computeIndicators(candles);
  const signals = detectSignals(candles, ind);
  const technical = technicalScore(candles, ind, signals);
  const fundamental = fundamentalScore(ticker);
  const overall = Math.round(fundamental * 0.55 + technical * 0.45);
  return { fundamental, technical, overall, signals };
}
