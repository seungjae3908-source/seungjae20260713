// SectorPopularService — powers the home screen "섹터별 인기종목" section.
//
// KR: classifies real listing rows (거래대금/거래량/등락률 기준) into curated
//     sectors from SECTOR_MAP. Only sectors that actually exist in SECTOR_MAP
//     are surfaced; tickers without a known sector are excluded (never guessed).
// US: takes the movers universe, enriches the top N (batched, capped) with the
//     Yahoo assetProfile.sector field, maps English Yahoo sectors to Korean
//     labels, and drops rows whose sector is unknown.
//
// The ranking basis is 거래대금 우선 → 없으면 거래량 → 등락률.
import { MarketListingService } from './market-listing.service';
import { type QuoteRow } from './market-data.service';
import { SECTOR_MAP } from '../data/sectors';
import { getYahooSector } from '../providers/yahoo';
import { cached, TTL } from '../lib/cache';

export interface SectorPopularRow {
  rank: number;
  ticker: string;
  name: string;
  market: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  price: number;
  changePercent: number;
  tradingValue: number;
  volume: number;
}

export interface SectorPopularGroup {
  key: string;
  label: string;
  rows: SectorPopularRow[];
}

export interface SectorPopularResult {
  market: 'KR' | 'US';
  sortBasis: string;
  sectors: SectorPopularGroup[];
  updatedAt: string;
}

const SORT_BASIS = '거래대금 기준';
const MAX_PER_SECTOR = 10;
const US_ENRICH_CAP = 40; // 과도한 야후 호출 방지: movers 상위 N만 sector 보강

// Ordered KR sector keys we want to surface on the home screen. Labels must
// match SECTOR_MAP values verbatim so classification stays factual.
const KR_SECTORS: { key: string; label: string }[] = [
  { key: 'semiconductor', label: '반도체' },
  { key: 'auto', label: '자동차' },
  { key: 'finance', label: '금융' },
  { key: 'bio', label: '제약·바이오' },
  { key: 'defense', label: '방산·항공우주' },
  { key: 'ship', label: '조선' },
  { key: 'battery', label: '2차전지' },
  { key: 'electronics', label: '전자부품' },
  { key: 'telecom', label: '통신' },
  { key: 'retail', label: '유통·소비재' },
  { key: 'construction', label: '지주·건설' },
  { key: 'energy', label: '에너지·정유' },
  { key: 'entertainment', label: '엔터·미디어' },
  { key: 'internet', label: '인터넷·플랫폼' },
];

// Map a curated SECTOR_MAP label into the KR home sector key (or null).
function krSectorKeyForLabel(label: string): string | null {
  const found = KR_SECTORS.find((s) => s.label === label);
  return found ? found.key : null;
}

// US home sectors + the Yahoo English sector strings that map to each.
const US_SECTORS: { key: string; label: string; yahoo: string[] }[] = [
  { key: 'technology', label: '기술', yahoo: ['Technology', 'Information Technology'] },
  { key: 'financial', label: '금융', yahoo: ['Financial Services', 'Financial'] },
  { key: 'healthcare', label: '헬스케어', yahoo: ['Healthcare', 'Health Care'] },
  { key: 'consumer', label: '소비재', yahoo: ['Consumer Cyclical', 'Consumer Defensive', 'Consumer Staples', 'Consumer Discretionary'] },
  { key: 'industrials', label: '산업재', yahoo: ['Industrials'] },
  { key: 'energy', label: '에너지', yahoo: ['Energy'] },
  { key: 'communication', label: '커뮤니케이션', yahoo: ['Communication Services'] },
  { key: 'utilities', label: '유틸리티', yahoo: ['Utilities'] },
];

// A curated SECTOR_MAP label (US tickers) → US home sector key. This lets us
// classify well-known US names without any network call; Yahoo enrichment only
// fills the gaps.
const US_CURATED_LABEL_TO_KEY: Record<string, string> = {
  반도체: 'technology',
  '소프트웨어': 'technology',
  'IT·하드웨어': 'technology',
  'IT·서비스': 'technology',
  '사이버보안': 'technology',
  '양자·신기술': 'technology',
  금융: 'financial',
  증권: 'financial',
  '금융·결제': 'financial',
  '가상자산·핀테크': 'financial',
  '제약·바이오': 'healthcare',
  의료기기: 'healthcare',
  '유통·소비재': 'consumer',
  '음식·식품': 'consumer',
  '전기차·모빌리티': 'consumer',
  자동차: 'consumer',
  '기계·중공업': 'industrials',
  '운송·물류': 'industrials',
  '항공·여행': 'industrials',
  '방산·항공우주': 'industrials',
  '에너지·정유': 'energy',
  '미디어·콘텐츠': 'communication',
  '인터넷·플랫폼': 'communication',
  통신: 'communication',
  '전력·유틸리티': 'utilities',
};

function yahooSectorToKey(sector: string): string | null {
  const normalized = sector.trim();
  for (const s of US_SECTORS) {
    if (s.yahoo.some((y) => y.toLowerCase() === normalized.toLowerCase())) {
      return s.key;
    }
  }
  return null;
}

function toRow(row: QuoteRow, rank: number): SectorPopularRow {
  return {
    rank,
    ticker: row.ticker,
    name: row.name,
    market: row.market === 'US' ? 'US' : 'KR',
    currency: row.currency === 'USD' ? 'USD' : 'KRW',
    price: Number(row.price ?? 0),
    changePercent: Number(row.changePercent ?? 0),
    tradingValue: Number(row.tradingValue ?? 0),
    volume: Number(row.volume ?? 0),
  };
}

// 거래대금 우선 → 거래량 → 등락률
function rankPopular(rows: QuoteRow[]): QuoteRow[] {
  return [...rows].sort((a, b) => {
    const tv = Number(b.tradingValue ?? 0) - Number(a.tradingValue ?? 0);
    if (tv !== 0) return tv;
    const vol = Number(b.volume ?? 0) - Number(a.volume ?? 0);
    if (vol !== 0) return vol;
    return Number(b.changePercent ?? 0) - Number(a.changePercent ?? 0);
  });
}

function uniqueRows(rows: QuoteRow[]): QuoteRow[] {
  const seen = new Set<string>();
  const out: QuoteRow[] = [];
  for (const row of rows) {
    const key = `${row.market}:${row.ticker}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(Number.isFinite(row.price) && row.price > 0)) continue;
    out.push(row);
  }
  return out;
}

async function loadUniverse(market: 'KR' | 'US'): Promise<QuoteRow[]> {
  const keys = market === 'KR' ? (['KRX'] as const) : (['NASDAQ', 'NYSE'] as const);
  const settled = await Promise.allSettled(
    keys.map((k) => MarketListingService.getMarketListings(k)),
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
  return uniqueRows(rows);
}

async function buildKr(): Promise<SectorPopularResult> {
  const ranked = rankPopular(await loadUniverse('KR'));

  const buckets = new Map<string, QuoteRow[]>();
  for (const row of ranked) {
    const label = SECTOR_MAP[row.ticker];
    if (!label) continue; // 근거 불명 → 제외
    const key = krSectorKeyForLabel(label);
    if (!key) continue; // 홈 노출 섹터에 없으면 제외
    const list = buckets.get(key) ?? [];
    if (list.length >= MAX_PER_SECTOR) continue;
    list.push(row);
    buckets.set(key, list);
  }

  const sectors: SectorPopularGroup[] = KR_SECTORS.map((s) => ({
    key: s.key,
    label: s.label,
    rows: (buckets.get(s.key) ?? []).map((row, i) => toRow(row, i + 1)),
  }));

  return {
    market: 'KR',
    sortBasis: SORT_BASIS,
    sectors,
    updatedAt: new Date().toISOString(),
  };
}

async function buildUs(): Promise<SectorPopularResult> {
  const ranked = rankPopular(await loadUniverse('US'));

  // First pass: classify using curated SECTOR_MAP labels (no network).
  const keyByTicker = new Map<string, string>();
  const needEnrich: QuoteRow[] = [];

  for (const row of ranked) {
    const label = SECTOR_MAP[row.ticker];
    const curatedKey = label ? US_CURATED_LABEL_TO_KEY[label] : undefined;
    if (curatedKey) {
      keyByTicker.set(row.ticker, curatedKey);
    } else {
      needEnrich.push(row);
    }
  }

  // Second pass: enrich only the top uncurated names via Yahoo sector (capped).
  const enrichTargets = needEnrich.slice(0, US_ENRICH_CAP);
  const enriched = await Promise.allSettled(
    enrichTargets.map(async (row) => {
      const sector = await getYahooSector(row.ticker);
      return { ticker: row.ticker, sector };
    }),
  );
  for (const result of enriched) {
    if (result.status !== 'fulfilled') continue;
    const { ticker, sector } = result.value;
    if (!sector) continue; // sector 불명 → 제외
    const key = yahooSectorToKey(sector);
    if (key) keyByTicker.set(ticker, key);
  }

  const buckets = new Map<string, QuoteRow[]>();
  for (const row of ranked) {
    const key = keyByTicker.get(row.ticker);
    if (!key) continue;
    const list = buckets.get(key) ?? [];
    if (list.length >= MAX_PER_SECTOR) continue;
    list.push(row);
    buckets.set(key, list);
  }

  const sectors: SectorPopularGroup[] = US_SECTORS.map((s) => ({
    key: s.key,
    label: s.label,
    rows: (buckets.get(s.key) ?? []).map((row, i) => toRow(row, i + 1)),
  }));

  return {
    market: 'US',
    sortBasis: SORT_BASIS,
    sectors,
    updatedAt: new Date().toISOString(),
  };
}

async function getSectorPopular(market: 'KR' | 'US'): Promise<SectorPopularResult> {
  return cached(`sector-popular:v1:${market}`, TTL.quote, async () =>
    market === 'KR' ? buildKr() : buildUs(),
  );
}

export const SectorPopularService = {
  getSectorPopular,
};
