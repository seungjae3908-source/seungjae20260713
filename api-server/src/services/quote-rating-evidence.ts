import type { QuoteRow } from './market-data.service';
import type { RatingResult } from '../sample/types';

export function hasQuoteRating(row: QuoteRow): row is QuoteRow & { rating: RatingResult } {
  return row.rating != null
    && row.ratingStatus !== 'MISSING_EVIDENCE'
    && ['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL'].includes(row.rating.rating)
    && typeof row.rating.score === 'number'
    && Number.isFinite(row.rating.score)
    && row.rating.score >= 0 && row.rating.score <= 100;
}
