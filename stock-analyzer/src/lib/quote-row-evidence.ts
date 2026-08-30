import type { QuoteRow, RatingResult } from './api';

// Runtime quote responses can have prices without rating evidence. Keep this
// boundary explicit while the shared API contract is coordinated separately.
export type QuoteEvidenceRow = Omit<QuoteRow, 'rating'> & {
  rating: RatingResult | null;
  ratingStatus?: 'MISSING_EVIDENCE';
};

export function quoteRating(row: QuoteEvidenceRow): RatingResult | null {
  const rating = row.rating;
  if (!rating || row.ratingStatus === 'MISSING_EVIDENCE'
    || !['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL'].includes(rating.rating)
    || typeof rating.score !== 'number' || !Number.isFinite(rating.score)
    || rating.score < 0 || rating.score > 100) return null;
  return rating;
}
