import { authorizedFetch } from '@/lib/auth-fetch';
import { parsePaperPromotionTrades, type PaperPromotionTradesReadback } from './paper-promotion-trades';

export async function fetchPaperPromotionTrades(signal?: AbortSignal): Promise<PaperPromotionTradesReadback> {
  const response = await authorizedFetch('/api/paper-journal/promotion-trades', { cache: 'no-store', signal });
  const body = await response.json().catch(() => null) as unknown;
  const parsed = response.ok ? parsePaperPromotionTrades(body) : null;
  if (!parsed) throw new Error('PAPER_PROMOTION_TRADES_READ_FAILED');
  return parsed;
}
