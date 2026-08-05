import type {
  KiwoomMarket,
  KiwoomRankingType,
} from '../providers/kiwoom';
import type { QuoteRow } from './market-data.service';
import {
  MarketListingService,
  type MarketKey,
} from './market-listing.service';

const CACHE_TTL_MS = 10_000;

export interface KiwoomFallbackRankingRow extends QuoteRow {
  sourceRank: number;
  provider: 'live-market-providers';
  fallbackUsed: true;
  fallbackReason: string;
  dataQualityWarnings: string[];
}

interface CachedMarketRows {
  expiresAt: number;
  rows: QuoteRow[];
}

const marketCache = new Map<KiwoomMarket, CachedMarketRows>();

function marketKeys(market: KiwoomMarket): MarketKey[] {
  return market === 'KR' ? ['KRX'] : ['NASDAQ', 'NYSE'];
}

function validRows(rows: QuoteRow[]): QuoteRow[] {
  const seen = new Set<string>();

  return rows.filter((row) => {
    const ticker = String(row.ticker ?? '').trim().toUpperCase();
    const price = Number(row.price);
    const key = `${String(row.market ?? '')}:${ticker}`;

    if (!ticker || seen.has(key) || !Number.isFinite(price) || price <= 0) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function loadMarketRows(market: KiwoomMarket): Promise<QuoteRow[]> {
  const cached = marketCache.get(market);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.rows;
  }

  const settled = await Promise.allSettled(
    marketKeys(market).map((marketKey) =>
      MarketListingService.getMarketListings(marketKey),
    ),
  );

  const rows: QuoteRow[] = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;

    rows.push(
      ...result.value.popular,
      ...result.value.gainers,
      ...result.value.losers,
      ...result.value.recommended,
    );
  }

  const uniqueRows = validRows(rows);
  if (!uniqueRows.length) {
    throw new Error('FALLBACK_MARKET_DATA_UNAVAILABLE');
  }

  marketCache.set(market, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    rows: uniqueRows,
  });

  return uniqueRows;
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function rankFallbackRows(
  rows: QuoteRow[],
  type: KiwoomRankingType,
  limit: number,
): KiwoomFallbackRankingRow[] {
  const filtered = validRows(rows).filter((row) => {
    const changePercent = numeric(row.changePercent);
    if (type === 'gainers') return changePercent != null && changePercent > 0;
    if (type === 'losers') return changePercent != null && changePercent < 0;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (type === 'volume') {
      return Number(b.volume ?? 0) - Number(a.volume ?? 0);
    }

    if (type === 'tradingValue') {
      return Number(b.tradingValue ?? 0) - Number(a.tradingValue ?? 0);
    }

    if (type === 'gainers') {
      return Number(b.changePercent ?? 0) - Number(a.changePercent ?? 0);
    }

    return Number(a.changePercent ?? 0) - Number(b.changePercent ?? 0);
  });

  const fallbackReason =
    '키움 랭킹 공급자를 사용할 수 없어 실제 대체 시장데이터 공급자의 결과를 표시합니다.';

  return sorted.slice(0, limit).map((row, index) => ({
    ...row,
    rank: index + 1,
    sourceRank: index + 1,
    provider: 'live-market-providers',
    fallbackUsed: true,
    fallbackReason,
    reason: fallbackReason,
    dataQualityWarnings: [
      '키움 원본 랭킹이 아니며 공급자별 지연 시간은 다를 수 있습니다.',
    ],
  }));
}

export async function getFallbackKiwoomRankingRows(
  market: KiwoomMarket,
  type: KiwoomRankingType,
  limit: number,
): Promise<KiwoomFallbackRankingRow[]> {
  const rows = rankFallbackRows(await loadMarketRows(market), type, limit);
  if (!rows.length) {
    throw new Error('FALLBACK_RANKING_ROWS_UNAVAILABLE');
  }
  return rows;
}

export function clearKiwoomFallbackCache(): void {
  marketCache.clear();
}
