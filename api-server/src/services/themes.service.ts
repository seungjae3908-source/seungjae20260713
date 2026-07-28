
// 공식 공시(DART/SEC) 근거형 테마 서비스.
// 회사명 키워드만으로 테마를 확정하지 않으며, 자동 분류는 후보 상태로 표시합니다.

import { cached, TTL } from '../lib/cache';
import type { AssetType } from '../data/asset-type';
import type { Currency, Market } from '../data/catalog';
import { MarketDataService, type SearchResult } from './market-data.service';
import {
  CompanyIntelligenceService,
  type CompanyEntryInput,
  type CompanyIntelligenceStatus,
  type ReviewStatus,
  type ThemeRelationRecord,
} from './company-intelligence.service';
import type { ThemeRelationLevel } from '../data/theme-taxonomy';

export interface ThemeStock {
  ticker: string;
  name: string;
  market: Market;
  currency: Currency;
  price: number | null;
  changePercent: number | null;
  marketCap?: number | null;
  assetType?: AssetType | string;
  quoteAvailable: boolean;
  themeKey: string;
  themeLabel: string;
  relationLevel: ThemeRelationLevel;
  reason: string;
  evidence: string;
  confidence: number;
  sourceType: 'DART' | 'SEC';
  sourceUrl: string;
  sourceDocumentId: string;
  sourceDate: string;
  reviewStatus: ReviewStatus;
  adminVerified: boolean;
  updatedAt: string;
}

export interface ThemeGroup {
  key: string;
  label: string;
  count: number;
  approvedCount: number;
  candidateCount: number;
  averageConfidence: number;
  stocks: ThemeStock[];
}

export interface ThemesData {
  market: 'KR' | 'US';
  themes: ThemeGroup[];
  coverage: CompanyIntelligenceStatus;
  updatedAt: string;
  notice: string;
}

const THEME_STOCK_LIMIT = 80;
const QUOTE_TICKER_LIMIT = 420;
const BACKGROUND_WARM_LIMIT = 3;

function cleanTicker(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeMarket(value: unknown): 'KR' | 'US' {
  return String(value ?? '').toUpperCase() === 'US' ? 'US' : 'KR';
}

function normalizeCurrency(value: unknown, market: 'KR' | 'US'): 'KRW' | 'USD' {
  return String(value ?? '').toUpperCase() === 'USD' || market === 'US' ? 'USD' : 'KRW';
}

function toEntry(row: SearchResult): CompanyEntryInput {
  const market = normalizeMarket(row.market);
  return {
    ticker: cleanTicker(row.ticker),
    name: String(row.name || row.ticker),
    market,
    currency: normalizeCurrency(row.currency, market),
    assetType: String(row.assetType ?? 'STOCK'),
  };
}

async function getUniverse(market: 'KR' | 'US'): Promise<CompanyEntryInput[]> {
  if (market === 'US') {
    try {
      const official = await CompanyIntelligenceService.getUsOfficialUniverse();
      if (official.length > 0) return official;
    } catch (error) {
      console.error('[themes] SEC universe load failed:', error);
    }
  }

  const rows = await MarketDataService.getUniverse(market);
  return rows
    .map(toEntry)
    .filter((row) => row.ticker && row.name)
    .filter((row, index, all) => all.findIndex((item) => item.ticker === row.ticker) === index);
}

async function mapWithConcurrency<T, R>(
  rows: T[],
  limit: number,
  worker: (row: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(rows.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, rows.length || 1)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= rows.length) return;
      output[index] = await worker(rows[index]);
    }
  });
  await Promise.all(runners);
  return output;
}

async function quoteMapForRelations(relations: ThemeRelationRecord[]): Promise<Map<string, any>> {
  const tickers = Array.from(new Set(relations.map((relation) => relation.ticker)))
    .slice(0, QUOTE_TICKER_LIMIT);
  const pairs = await mapWithConcurrency(tickers, 8, async (ticker) => {
    try {
      return [ticker, await MarketDataService.getQuoteRow(ticker)] as const;
    } catch {
      return [ticker, null] as const;
    }
  });
  return new Map(pairs);
}

function toThemeStock(relation: ThemeRelationRecord, quote: any): ThemeStock {
  const market = relation.market;
  const price = Number(quote?.price ?? quote?.currentPrice);
  const changePercent = Number(quote?.changePercent ?? quote?.percent);
  const marketCap = Number(quote?.marketCap);
  return {
    ticker: relation.ticker,
    name: relation.name,
    market: market as Market,
    currency: relation.currency as Currency,
    price: Number.isFinite(price) && price > 0 ? price : null,
    changePercent: Number.isFinite(changePercent) ? changePercent : null,
    marketCap: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null,
    assetType: quote?.assetType,
    quoteAvailable: Number.isFinite(price) && price > 0,
    themeKey: relation.themeKey,
    themeLabel: relation.themeLabel,
    relationLevel: relation.relationLevel,
    reason: relation.reason,
    evidence: relation.evidence,
    confidence: relation.confidence,
    sourceType: relation.sourceType,
    sourceUrl: relation.sourceUrl,
    sourceDocumentId: relation.sourceDocumentId,
    sourceDate: relation.sourceDate,
    reviewStatus: relation.reviewStatus,
    adminVerified: relation.adminVerified,
    updatedAt: relation.updatedAt,
  };
}

async function buildThemes(market: 'KR' | 'US'): Promise<ThemesData> {
  // 화면 조회는 저장된 결과를 즉시 반환하고, 누락 종목은 소량씩 백그라운드 보강합니다.
  void getUniverse(market)
    .then((universe) => CompanyIntelligenceService.startBackgroundRebuild(market, universe, { limit: BACKGROUND_WARM_LIMIT }))
    .catch((error) => console.error('[themes] background warm failed:', error));

  return cached(`themes:evidence:v2:${market}`, TTL.quote, async () => {
    const relations = await CompanyIntelligenceService.listRelations(market);
    const coverage = await CompanyIntelligenceService.getStatus(market);
    const usable = relations
      .filter((relation) => relation.reviewStatus !== 'rejected')
      .sort((a, b) => {
        if (a.adminVerified !== b.adminVerified) return a.adminVerified ? -1 : 1;
        return b.confidence - a.confidence;
      });
    const quoteMap = await quoteMapForRelations(usable);
    const buckets = new Map<string, ThemeRelationRecord[]>();

    for (const relation of usable) {
      const list = buckets.get(relation.themeKey) ?? [];
      if (!list.some((row) => row.ticker === relation.ticker)) list.push(relation);
      buckets.set(relation.themeKey, list);
    }

    const themes: ThemeGroup[] = Array.from(buckets.entries())
      .map(([key, rows]) => {
        const selected = rows.slice(0, THEME_STOCK_LIMIT);
        const stocks = selected.map((row) => toThemeStock(row, quoteMap.get(row.ticker)));
        const approvedCount = rows.filter((row) => row.adminVerified && row.reviewStatus === 'approved').length;
        const candidateCount = rows.filter((row) => !row.adminVerified && row.reviewStatus === 'candidate').length;
        const averageConfidence = rows.length
          ? Math.round(rows.reduce((sum, row) => sum + row.confidence, 0) / rows.length)
          : 0;
        return {
          key,
          label: rows[0]?.themeLabel ?? key,
          count: rows.length,
          approvedCount,
          candidateCount,
          averageConfidence,
          stocks,
        };
      })
      .filter((theme) => theme.count > 0)
      .sort((a, b) => {
        if (a.approvedCount !== b.approvedCount) return b.approvedCount - a.approvedCount;
        if (a.count !== b.count) return b.count - a.count;
        return a.label.localeCompare(b.label, 'ko');
      });

    return {
      market,
      themes,
      coverage,
      updatedAt: new Date().toISOString(),
      notice: '공식 공시에서 근거가 확인된 종목만 표시합니다. 자동분류는 관리자 검수 전까지 후보로 구분됩니다.',
    };
  });
}

async function getThemes(marketValue: 'KR' | 'US'): Promise<ThemesData> {
  return buildThemes(normalizeMarket(marketValue));
}

async function getStatus(marketValue: 'KR' | 'US'): Promise<CompanyIntelligenceStatus> {
  return CompanyIntelligenceService.getStatus(normalizeMarket(marketValue));
}

async function startRebuild(
  marketValue: 'KR' | 'US',
  options: { limit?: number; reset?: boolean } = {},
): Promise<{ started: boolean; message: string; universeCount: number }> {
  const market = normalizeMarket(marketValue);
  const universe = await getUniverse(market);
  const result = CompanyIntelligenceService.startBackgroundRebuild(market, universe, options);
  return { ...result, universeCount: universe.length };
}

async function reviewRelation(input: {
  market: 'KR' | 'US';
  ticker: string;
  themeKey: string;
  action: 'approve' | 'reject';
  relationLevel?: ThemeRelationLevel;
  reason?: string;
}) {
  return CompanyIntelligenceService.reviewRelation({
    ...input,
    market: normalizeMarket(input.market),
    ticker: cleanTicker(input.ticker),
  });
}

export const ThemesService = {
  getThemes,
  getStatus,
  startRebuild,
  reviewRelation,
};
