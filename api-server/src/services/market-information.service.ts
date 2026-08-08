import { runBoundedWorkPool } from '../lib/bounded-work-pool';
import { providerStatus } from '../lib/config';
import type { QuoteRow } from './market-data.service';
import { FilingService } from './filing.service';
import { MarketListingService, type MarketKey } from './market-listing.service';
import { NewsService } from './news.service';
import { SectorPopularService } from './sector-popular.service';
import {
  bitgetDataArray,
  dedupeMarketNews,
  emptyDerivatives,
  finite,
  isMarketInformationRoomId,
  latestIso,
  makeMeta,
  nonNegative,
  normalizeBitgetDerivatives,
  normalizeBitgetTickers,
  normalizeUpbitMarkets,
  normalizeUpbitTickers,
  positive,
  ROOM_CONFIG,
  safeIso,
  section,
  type MarketInformationAssetRow,
  type MarketInformationCurrency,
  type MarketInformationDerivativesData,
  type MarketInformationIndexRow,
  type MarketInformationNewsRow,
  type MarketInformationResponse,
  type MarketInformationRoomId,
  type MarketInformationSection,
  type MarketInformationSectionStatus,
  type MarketInformationSectorRow,
} from './market-information.contract';
import {
  fetchPublicMarketJson,
  loadMarketInformationCache,
  MarketInformationError,
  resetMarketInformationCacheForTests,
  validatePublicMarketUrl,
} from './public-market-http';

export {
  dedupeMarketNews,
  fetchPublicMarketJson,
  isMarketInformationRoomId,
  MarketInformationError,
  normalizeBitgetDerivatives,
  normalizeBitgetTickers,
  normalizeUpbitMarkets,
  normalizeUpbitTickers,
  resetMarketInformationCacheForTests,
  validatePublicMarketUrl,
};
export type {
  MarketInformationMeta,
  MarketInformationNewsRow,
  MarketInformationResponse,
  MarketInformationRoomId,
} from './market-information.contract';

const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const PRODUCT_TYPE = 'USDT-FUTURES';

type CacheLoad<T> = { value: T; stale: boolean };
type UpbitMarket = { market: string; symbol: string; name: string; warning: boolean };

function status(stale: boolean, partial: boolean, count: number): MarketInformationSectionStatus {
  if (stale) return 'stale';
  if (partial) return 'partial';
  return count > 0 ? 'ready' : 'empty';
}

function unsupported<T>(room: MarketInformationRoomId, data: T, fields: string[], message: string): MarketInformationSection<T> {
  return section('unsupported', data, makeMeta({
    room,
    provider: null,
    source: null,
    unavailableFields: fields,
    errorCode: 'PROVIDER_UNSUPPORTED',
  }), message);
}

function unavailable<T>(
  room: MarketInformationRoomId,
  data: T,
  code: string,
  message: string,
  retryable: boolean,
): MarketInformationSection<T> {
  return section('unavailable', data, makeMeta({
    room,
    provider: null,
    source: null,
    unavailableFields: ['all'],
    errorCode: code,
    retryable,
  }), message);
}

function errorSection<T>(room: MarketInformationRoomId, data: T, error: unknown): MarketInformationSection<T> {
  const known = error instanceof MarketInformationError
    ? error
    : new MarketInformationError(
      error instanceof Error && error.message ? error.message : 'MARKET_INFORMATION_PROVIDER_ERROR',
      502,
      true,
      '시장정보 제공기관 응답을 확인하지 못했습니다.',
    );
  return section('error', data, makeMeta({
    room,
    provider: null,
    source: null,
    unavailableFields: ['all'],
    errorCode: known.code,
    retryable: known.retryable,
  }), known.message);
}

function assetFromQuote(row: QuoteRow, currency: MarketInformationCurrency): MarketInformationAssetRow | null {
  const symbol = String(row.ticker ?? '').trim().toUpperCase();
  const price = positive(row.price);
  if (!symbol || price == null) return null;
  return {
    symbol,
    name: String(row.name ?? symbol).trim() || symbol,
    exchange: String(row.exchange ?? (row.market === 'US' ? 'US' : 'KRX')).trim(),
    currency,
    price,
    changePercent: finite(row.changePercent),
    high24h: positive(row.high),
    low24h: positive(row.low),
    volume24h: nonNegative(row.volume),
    tradingValue24h: nonNegative(row.tradingValue),
    marketCap: null,
    warning: false,
    tradingStatus: null,
    fundingRatePercent: null,
    nextFundingAt: null,
    openInterest: null,
    rangeVolatility24hPercent: null,
    providerUpdatedAt: safeIso(row.updatedAt),
  };
}

function dedupeAssets(rows: MarketInformationAssetRow[]): MarketInformationAssetRow[] {
  const result = new Map<string, MarketInformationAssetRow>();
  for (const row of rows) if (!result.has(row.symbol)) result.set(row.symbol, row);
  return [...result.values()];
}

async function stockRankings(
  room: 'stocks-kr' | 'stocks-us',
  signal?: AbortSignal,
): Promise<CacheLoad<MarketInformationAssetRow[]>> {
  const marketKeys: MarketKey[] = room === 'stocks-kr' ? ['KRX'] : ['NASDAQ', 'NYSE'];
  const currency = room === 'stocks-kr' ? 'KRW' as const : 'USD' as const;
  return loadMarketInformationCache(`information:rankings:${room}`, 30_000, 5 * 60_000, async () => {
    const pool = await runBoundedWorkPool(
      marketKeys,
      async (marketKey) => MarketListingService.getMarketListings(marketKey),
      { concurrency: 2, deadlineMs: 20_000, itemTimeoutMs: 15_000, signal },
    );
    const rows: MarketInformationAssetRow[] = [];
    for (const outcome of pool.outcomes) {
      if (outcome.status !== 'fulfilled' || !outcome.value) continue;
      const listings = outcome.value;
      for (const raw of [...listings.popular, ...listings.gainers, ...listings.losers]) {
        const normalized = assetFromQuote(raw, currency);
        if (normalized) rows.push(normalized);
      }
    }
    const result = dedupeAssets(rows)
      .sort((left, right) => Number(right.tradingValue24h ?? -1) - Number(left.tradingValue24h ?? -1))
      .slice(0, 120);
    if (!result.length) {
      throw new MarketInformationError('STOCK_RANKINGS_UNAVAILABLE', 503, true, '주식 시장 순위를 불러오지 못했습니다.');
    }
    return result;
  });
}

async function stockIndices(room: 'stocks-kr' | 'stocks-us'): Promise<CacheLoad<MarketInformationIndexRow[]>> {
  return loadMarketInformationCache(`information:indices:${room}`, 30_000, 5 * 60_000, async () => {
    const keys = room === 'stocks-kr'
      ? new Set(['kospi', 'kosdaq'])
      : new Set(['nasdaq', 'sp500', 'dow', 'russell']);
    const rows = (await MarketListingService.getMarketSummary())
      .filter((row) => row.ok && keys.has(row.key))
      .map((row) => ({
        key: row.key.toUpperCase(),
        label: row.label,
        value: positive(row.price),
        changePercent: finite(row.changePercent),
      }))
      .filter((row): row is MarketInformationIndexRow => row.value != null);
    if (!rows.length) {
      throw new MarketInformationError('STOCK_INDICES_UNAVAILABLE', 503, true, '시장 지수를 불러오지 못했습니다.');
    }
    return rows;
  });
}

async function stockSectors(room: 'stocks-kr' | 'stocks-us'): Promise<CacheLoad<MarketInformationSectorRow[]>> {
  return loadMarketInformationCache(`information:sectors:${room}`, 60_000, 10 * 60_000, async () => {
    const result = await SectorPopularService.getSectorPopular(room === 'stocks-kr' ? 'KR' : 'US');
    return result.sectors.map((group) => ({
      key: group.key,
      label: group.label,
      tradingValue: group.rows.length
        ? group.rows.reduce((sum, row) => sum + Number(row.tradingValue || 0), 0)
        : null,
      constituentCount: group.rows.length,
      changePercent: null,
    }));
  });
}

async function stockNews(
  room: 'stocks-kr' | 'stocks-us',
  candidates: MarketInformationAssetRow[],
  signal?: AbortSignal,
): Promise<CacheLoad<MarketInformationNewsRow[]>> {
  return loadMarketInformationCache(`information:news:${room}`, 5 * 60_000, 60 * 60_000, async () => {
    const pool = await runBoundedWorkPool(
      candidates.slice(0, 6),
      async (target) => ({ target, data: await NewsService.getNews(target.symbol) }),
      { concurrency: 3, deadlineMs: 20_000, itemTimeoutMs: 10_000, signal },
    );
    const rows: MarketInformationNewsRow[] = [];
    for (const outcome of pool.outcomes) {
      if (outcome.status !== 'fulfilled' || !outcome.value) continue;
      const { target, data } = outcome.value;
      if (!data) continue;
      for (const item of [...data.positive, ...data.negative]) {
        const title = item.title.trim();
        const publishedAt = safeIso(item.date);
        if (!title || !item.url || !publishedAt || !item.sourceDomain) continue;
        rows.push({
          id: `news:${target.symbol}:${title}:${publishedAt}`,
          kind: 'news',
          symbol: target.symbol,
          title,
          summary: item.summary?.trim() || null,
          provider: item.sourceDomain,
          source: item.source,
          url: item.url,
          publishedAt,
        });
      }
    }
    return dedupeMarketNews(rows).slice(0, 40);
  });
}

async function stockDisclosures(
  room: 'stocks-kr' | 'stocks-us',
  candidates: MarketInformationAssetRow[],
  signal?: AbortSignal,
): Promise<CacheLoad<MarketInformationNewsRow[]>> {
  return loadMarketInformationCache(`information:disclosures:${room}`, 10 * 60_000, 2 * 60 * 60_000, async () => {
    const pool = await runBoundedWorkPool(
      candidates.slice(0, 6),
      async (target) => ({ target, data: await FilingService.getFilings(target.symbol) }),
      { concurrency: 3, deadlineMs: 20_000, itemTimeoutMs: 10_000, signal },
    );
    const rows: MarketInformationNewsRow[] = [];
    for (const outcome of pool.outcomes) {
      if (outcome.status !== 'fulfilled' || !outcome.value) continue;
      const { target, data } = outcome.value;
      if (!data) continue;
      for (const item of data.filings) {
        const publishedAt = safeIso(item.date);
        if (!publishedAt || !item.url || !item.form.trim()) continue;
        rows.push({
          id: `sec:${target.symbol}:${item.form}:${publishedAt}`,
          kind: 'disclosure',
          symbol: target.symbol,
          title: `${item.form} · ${item.description}`,
          summary: item.description,
          provider: 'SEC EDGAR',
          source: 'SEC',
          url: item.url,
          publishedAt,
        });
      }
      for (const item of data.disclosures) {
        const publishedAt = safeIso(item.date);
        if (!publishedAt || !item.url || !item.report.trim()) continue;
        rows.push({
          id: `dart:${target.symbol}:${item.report}:${publishedAt}`,
          kind: 'disclosure',
          symbol: target.symbol,
          title: item.report,
          summary: item.description,
          provider: 'OpenDART',
          source: '금융감독원 전자공시',
          url: item.url,
          publishedAt,
        });
      }
    }
    return dedupeMarketNews(rows).slice(0, 40);
  });
}

async function buildStockRoom(
  room: 'stocks-kr' | 'stocks-us',
  signal?: AbortSignal,
): Promise<MarketInformationResponse> {
  const [rankingResult, indexResult, sectorResult] = await Promise.allSettled([
    stockRankings(room, signal),
    stockIndices(room),
    stockSectors(room),
  ]);
  const rankingRows = rankingResult.status === 'fulfilled' ? rankingResult.value.value : [];
  const newsPromise = rankingRows.length
    ? stockNews(room, rankingRows, signal)
    : Promise.reject(new MarketInformationError('NEWS_CANDIDATES_UNAVAILABLE', 503, true, '뉴스 대상 종목을 확인할 수 없습니다.'));
  const disclosurePromise = room === 'stocks-kr' && !providerStatus().dart
    ? Promise.reject(new MarketInformationError('DART_NOT_CONFIGURED', 503, false, 'DART_API_KEY가 설정되지 않아 국내 공시가 연결되지 않았습니다.'))
    : rankingRows.length
      ? stockDisclosures(room, rankingRows, signal)
      : Promise.reject(new MarketInformationError('DISCLOSURE_CANDIDATES_UNAVAILABLE', 503, true, '공시 대상 종목을 확인할 수 없습니다.'));
  const [newsResult, disclosureResult] = await Promise.allSettled([newsPromise, disclosurePromise]);

  const rankings = rankingResult.status === 'fulfilled'
    ? section(status(rankingResult.value.stale, false, rankingRows.length), rankingRows, makeMeta({
      room,
      provider: room === 'stocks-kr' ? 'KRX/Naver/Yahoo' : 'Yahoo Finance',
      source: '기존 공개 시세·상장종목 provider',
      providerUpdatedAt: latestIso(rankingRows.map((row) => row.providerUpdatedAt)),
      partial: rankingRows.some((row) => row.marketCap == null),
      unavailableFields: ['marketCap'],
      staleAfterMs: 2 * 60_000,
      forceStale: rankingResult.value.stale,
    }))
    : errorSection(room, [], rankingResult.reason);

  const indices = indexResult.status === 'fulfilled'
    ? section(status(indexResult.value.stale, false, indexResult.value.value.length), indexResult.value.value, makeMeta({
      room,
      provider: 'Yahoo Finance',
      source: '공개 지수 quote',
      observedAt: new Date().toISOString(),
      unavailableFields: ['providerUpdatedAt', 'exchangeHolidayCalendar'],
      forceStale: indexResult.value.stale,
    }))
    : errorSection(room, [], indexResult.reason);

  const sectors = sectorResult.status === 'fulfilled'
    ? section(status(sectorResult.value.stale, false, sectorResult.value.value.length), sectorResult.value.value, makeMeta({
      room,
      provider: room === 'stocks-kr' ? 'SECTOR_MAP + public quotes' : 'Yahoo assetProfile + public quotes',
      source: '검증된 업종 분류와 거래대금',
      observedAt: new Date().toISOString(),
      unavailableFields: ['providerUpdatedAt', 'sectorChangePercent'],
      staleAfterMs: 5 * 60_000,
      forceStale: sectorResult.value.stale,
    }))
    : errorSection(room, [], sectorResult.reason);

  const news = newsResult.status === 'fulfilled'
    ? section(status(newsResult.value.stale, false, newsResult.value.value.length), newsResult.value.value, makeMeta({
      room,
      provider: room === 'stocks-us' ? 'Finnhub/Google News RSS' : 'Google News RSS',
      source: '공개 기업 뉴스',
      providerUpdatedAt: latestIso(newsResult.value.value.map((row) => row.publishedAt)),
      staleAfterMs: 24 * 60 * 60_000,
      forceStale: newsResult.value.stale,
    }), newsResult.value.value.length ? null : '표시 가능한 최신 기업 뉴스가 없습니다.')
    : errorSection(room, [], newsResult.reason);

  const disclosures = disclosureResult.status === 'fulfilled'
    ? section(status(disclosureResult.value.stale, false, disclosureResult.value.value.length), disclosureResult.value.value, makeMeta({
      room,
      provider: room === 'stocks-us' ? 'SEC EDGAR' : 'OpenDART',
      source: room === 'stocks-us' ? '미국 증권거래위원회 공시' : '금융감독원 전자공시',
      providerUpdatedAt: latestIso(disclosureResult.value.value.map((row) => row.publishedAt)),
      unavailableFields: ['companyIrMaterials'],
      staleAfterMs: 24 * 60 * 60_000,
      forceStale: disclosureResult.value.stale,
    }), disclosureResult.value.value.length ? null : '표시 가능한 최신 공시가 없습니다.')
    : errorSection(room, [], disclosureResult.reason);

  return makeResponse(room, {
    indices,
    rankings,
    sectors,
    news,
    disclosures,
    derivatives: unsupported(
      room,
      emptyDerivatives(),
      ['fundingRate', 'openInterest', 'longShortRatio', 'liquidations'],
      '주식 정보방에는 선물 파생지표를 표시하지 않습니다.',
    ),
  });
}

async function upbitMarkets(signal?: AbortSignal): Promise<CacheLoad<UpbitMarket[]>> {
  return loadMarketInformationCache('information:upbit:markets', 10 * 60_000, 60 * 60_000, async () => {
    const payload = await fetchPublicMarketJson(`${UPBIT_BASE}/v1/market/all?isDetails=true`, {
      provider: 'Upbit',
      signal,
    });
    const rows = normalizeUpbitMarkets(payload);
    if (!rows.length) {
      throw new MarketInformationError('UPBIT_MARKETS_EMPTY', 502, true, 'Upbit KRW 현물 시장 목록이 비어 있습니다.');
    }
    return rows;
  });
}

async function upbitTickers(markets: UpbitMarket[], signal?: AbortSignal) {
  return loadMarketInformationCache('information:upbit:tickers', 15_000, 2 * 60_000, async () => {
    const chunks: string[][] = [];
    for (let index = 0; index < markets.length; index += 100) {
      chunks.push(markets.slice(index, index + 100).map((item) => item.market));
    }
    const pool = await runBoundedWorkPool(
      chunks,
      async (chunk, _index, itemSignal) => fetchPublicMarketJson(
        `${UPBIT_BASE}/v1/ticker?markets=${encodeURIComponent(chunk.join(','))}`,
        { provider: 'Upbit', signal: itemSignal },
      ),
      { concurrency: 2, deadlineMs: 16_000, itemTimeoutMs: 8_000, signal },
    );
    const names = new Map(markets.map((item) => [item.market, { name: item.name, warning: item.warning }]));
    const rows = pool.outcomes.flatMap((outcome) => (
      outcome.status === 'fulfilled' ? normalizeUpbitTickers(outcome.value, names) : []
    ));
    if (!rows.length) {
      throw new MarketInformationError('UPBIT_TICKERS_UNAVAILABLE', 503, true, 'Upbit 현물 시세를 불러오지 못했습니다.');
    }
    return {
      rows: dedupeAssets(rows).sort((left, right) => Number(right.tradingValue24h ?? -1) - Number(left.tradingValue24h ?? -1)),
      partial: pool.fulfilledCount !== chunks.length,
    };
  });
}

async function buildSpotRoom(signal?: AbortSignal): Promise<MarketInformationResponse> {
  const room = 'coins-spot' as const;
  let rankings: MarketInformationSection<MarketInformationAssetRow[]>;
  try {
    const markets = await upbitMarkets(signal);
    const tickers = await upbitTickers(markets.value, signal);
    rankings = section(status(tickers.stale, tickers.value.partial, tickers.value.rows.length), tickers.value.rows, makeMeta({
      room,
      provider: 'Upbit',
      source: 'Upbit 공식 공개 Quotation API',
      providerUpdatedAt: latestIso(tickers.value.rows.map((row) => row.providerUpdatedAt)),
      partial: tickers.value.partial,
      unavailableFields: ['marketCap'],
      staleAfterMs: 60_000,
      forceStale: markets.stale || tickers.stale,
    }), tickers.value.partial ? '일부 ticker 청크만 응답하여 부분 데이터를 표시합니다.' : null);
  } catch (error) {
    rankings = errorSection(room, [], error);
  }

  return makeResponse(room, {
    indices: unsupported(room, [], ['indices'], '코인 현물에는 주식 시장 지수를 표시하지 않습니다.'),
    rankings,
    sectors: unsupported(room, [], ['sectors'], 'Upbit 공개 응답은 업종·섹터를 제공하지 않습니다.'),
    news: unavailable(room, [], 'COIN_NEWS_PROVIDER_NOT_CONNECTED', '검증된 코인 뉴스 provider가 아직 연결되지 않았습니다.', false),
    disclosures: unsupported(room, [], ['disclosures'], '코인 현물에는 기업 공시를 표시하지 않습니다.'),
    derivatives: unsupported(
      room,
      emptyDerivatives(),
      ['leverage', 'short', 'fundingRate', 'openInterest', 'liquidations', 'positions'],
      '현물 정보방에는 레버리지·숏·펀딩비·OI·청산·포지션 정보를 표시하지 않습니다.',
    ),
  });
}

async function bitgetContracts(signal?: AbortSignal): Promise<CacheLoad<Map<string, string>>> {
  return loadMarketInformationCache('information:bitget:contracts', 10 * 60_000, 60 * 60_000, async () => {
    const payload = await fetchPublicMarketJson(
      `${BITGET_BASE}/api/v2/mix/market/contracts?productType=${PRODUCT_TYPE}`,
      { provider: 'Bitget', signal },
    );
    const result = new Map<string, string>();
    for (const row of bitgetDataArray(payload, 'BITGET_CONTRACTS')) {
      const symbol = String(row.symbol ?? '').trim().toUpperCase();
      if (symbol.endsWith('USDT')) {
        result.set(symbol, String(row.symbolStatus ?? row.deliveryStatus ?? 'unknown'));
      }
    }
    if (!result.size) {
      throw new MarketInformationError('BITGET_CONTRACTS_EMPTY', 502, true, 'Bitget USDT 선물 상품 목록이 비어 있습니다.');
    }
    return result;
  });
}

function bitgetFundingMap(payload: unknown): Map<string, { rate: number | null; next: string | null }> {
  return new Map(bitgetDataArray(payload, 'BITGET_FUNDING').map((row) => [
    String(row.symbol ?? '').trim().toUpperCase(),
    { rate: finite(row.fundingRate), next: safeIso(row.nextUpdate) },
  ]));
}

async function bitgetRankings(contracts: Map<string, string>, signal?: AbortSignal) {
  return loadMarketInformationCache('information:bitget:tickers', 10_000, 60_000, async () => {
    const [tickerResult, fundingResult] = await Promise.allSettled([
      fetchPublicMarketJson(
        `${BITGET_BASE}/api/v2/mix/market/tickers?productType=${PRODUCT_TYPE}`,
        { provider: 'Bitget', signal },
      ),
      fetchPublicMarketJson(
        `${BITGET_BASE}/api/v2/mix/market/current-fund-rate?productType=${PRODUCT_TYPE}`,
        { provider: 'Bitget', signal },
      ),
    ]);
    if (tickerResult.status !== 'fulfilled') throw tickerResult.reason;
    const funding = fundingResult.status === 'fulfilled'
      ? bitgetFundingMap(fundingResult.value)
      : new Map<string, { rate: number | null; next: string | null }>();
    const rows = normalizeBitgetTickers(tickerResult.value, contracts, funding)
      .sort((left, right) => Number(right.tradingValue24h ?? -1) - Number(left.tradingValue24h ?? -1));
    if (!rows.length) {
      throw new MarketInformationError('BITGET_TICKERS_EMPTY', 502, true, 'Bitget USDT 선물 시세가 비어 있습니다.');
    }
    return { rows, partial: fundingResult.status !== 'fulfilled' };
  });
}

async function bitgetDerivatives(signal?: AbortSignal): Promise<CacheLoad<MarketInformationDerivativesData>> {
  return loadMarketInformationCache('information:bitget:derivatives', 60_000, 5 * 60_000, async () => {
    const [ratio, liquidations] = await Promise.all([
      fetchPublicMarketJson(
        `${BITGET_BASE}/api/v3/market/futures-long-short?symbol=BTCUSDT&period=5m`,
        { provider: 'Bitget', signal },
      ),
      fetchPublicMarketJson(
        `${BITGET_BASE}/api/v3/market/liquidations?category=${PRODUCT_TYPE}&limit=100`,
        { provider: 'Bitget', signal },
      ),
    ]);
    return normalizeBitgetDerivatives(ratio, liquidations);
  });
}

async function buildFuturesRoom(signal?: AbortSignal): Promise<MarketInformationResponse> {
  const room = 'coins-futures' as const;
  let rankings: MarketInformationSection<MarketInformationAssetRow[]>;
  let derivatives: MarketInformationSection<MarketInformationDerivativesData>;

  try {
    const contracts = await bitgetContracts(signal);
    const loaded = await bitgetRankings(contracts.value, signal);
    rankings = section(status(contracts.stale || loaded.stale, loaded.value.partial, loaded.value.rows.length), loaded.value.rows, makeMeta({
      room,
      provider: 'Bitget',
      source: 'Bitget 공식 공개 USDT-FUTURES market API',
      providerUpdatedAt: latestIso(loaded.value.rows.map((row) => row.providerUpdatedAt)),
      partial: loaded.value.partial,
      unavailableFields: ['marketCap'],
      staleAfterMs: 30_000,
      forceStale: contracts.stale || loaded.stale,
    }), loaded.value.partial ? '펀딩비 세부 응답 일부가 실패해 ticker에 포함된 값만 표시합니다.' : null);
  } catch (error) {
    rankings = errorSection(room, [], error);
  }

  try {
    const loaded = await bitgetDerivatives(signal);
    derivatives = section(loaded.stale ? 'stale' : 'ready', loaded.value, makeMeta({
      room,
      provider: 'Bitget',
      source: 'Bitget 공개 long-short·liquidation API',
      providerUpdatedAt: latestIso([
        loaded.value.ratioObservedAt,
        ...loaded.value.liquidations.map((row) => row.occurredAt),
      ]),
      unavailableFields: ['accountBalance', 'userPositions', 'userLiquidationPrice'],
      staleAfterMs: 5 * 60_000,
      forceStale: loaded.stale,
    }));
  } catch (error) {
    derivatives = errorSection(room, emptyDerivatives(), error);
  }

  return makeResponse(room, {
    indices: unsupported(room, [], ['indices'], '코인 선물에는 주식 시장 지수를 표시하지 않습니다.'),
    rankings,
    sectors: unsupported(room, [], ['sectors'], 'Bitget 공개 선물 응답은 업종·섹터를 제공하지 않습니다.'),
    news: unavailable(room, [], 'COIN_NEWS_PROVIDER_NOT_CONNECTED', '검증된 코인 뉴스 provider가 아직 연결되지 않았습니다.', false),
    disclosures: unsupported(room, [], ['disclosures'], '코인 선물에는 기업 공시를 표시하지 않습니다.'),
    derivatives,
  });
}

function makeResponse(
  room: MarketInformationRoomId,
  sections: MarketInformationResponse['sections'],
): MarketInformationResponse {
  const config = ROOM_CONFIG[room];
  const partial = Object.values(sections).some((item) => (
    item.status === 'partial'
    || item.status === 'stale'
    || item.status === 'unavailable'
    || item.status === 'error'
  ));
  return {
    ok: true,
    room,
    market: config.market,
    assetType: config.assetType,
    currency: config.currency,
    fetchedAt: new Date().toISOString(),
    partial,
    sections,
    requestPolicy: {
      publicMarketDataOnly: true,
      privateExchangeRequests: 0,
      accountRequests: 0,
      balanceRequests: 0,
      positionRequests: 0,
      orderRequests: 0,
      cancelRequests: 0,
      aiRequests: 0,
    },
  };
}

export const MarketInformationService = {
  async getRoom(room: MarketInformationRoomId, signal?: AbortSignal): Promise<MarketInformationResponse> {
    if (signal?.aborted) {
      const error = new Error('Request aborted');
      error.name = 'AbortError';
      throw error;
    }
    if (room === 'stocks-kr' || room === 'stocks-us') return buildStockRoom(room, signal);
    if (room === 'coins-spot') return buildSpotRoom(signal);
    return buildFuturesRoom(signal);
  },
};
