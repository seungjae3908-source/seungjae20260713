import type { Rating, RatingResult } from './types';

// Maps a 0-100 investment score to a five-level rating + confidence.
export function scoreToRating(score: number): RatingResult {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  let rating: Rating;
  if (s >= 80) rating = 'STRONG_BUY';
  else if (s >= 60) rating = 'BUY';
  else if (s >= 40) rating = 'HOLD';
  else if (s >= 20) rating = 'SELL';
  else rating = 'STRONG_SELL';
  // Confidence is higher the further the score sits from a neutral 50.
  const dist = Math.abs(s - 50) / 50; // 0..1
  const confidence = Math.round(58 + dist * 38); // 58..96
  return { rating, confidence, score: s };
}
