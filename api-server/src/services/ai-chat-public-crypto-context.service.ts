import { MarketInformationService } from './market-information.service';
import type {
  MarketInformationAssetRow,
  MarketInformationResponse,
  MarketInformationRoomId,
} from './market-information.contract';

export type AiCryptoMarket = 'UPBIT' | 'BITGET';

export type PublicCryptoAiDisclosure = {
  status: 'complete' | 'partial' | 'unavailable';
  asOf: string | null;
  basis: 'server_collection_time';
  sources: string[];
  missing: string[];
};

export type PublicCryptoAiContext = {
  market: AiCryptoMarket;
  symbol: string;
  quote: {
    price: number | null;
    changePercent: number | null;
    high24h: number | null;
    low24h: number | null;
    volume24h: number | null;
    tradingValue24h: number | null;
    currency: string;
    exchange: string;
    warning: boolean;
    tradingStatus: string | null;
    providerUpdatedAt: string | null;
  } | null;
  derivatives: {
    fundingRatePercent: number | null;
    nextFundingAt: string | null;
    openInterest: number | null;
    rangeVolatility24hPercent: number | null;
    longRatio: number | null;
    shortRatio: number | null;
    longShortRatio: number | null;
    ratioObservedAt: string | null;
    liquidations: Array<{
      side: 'long' | 'short' | 'unknown';
      price: number | null;
      amount: number | null;
      occurredAt: string | null;
    }>;
  } | null;
  disclosure: PublicCryptoAiDisclosure;
};

export class PublicCryptoAiContextError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PublicCryptoAiContextError';
  }
}

type RoomLoader = (room: MarketInformationRoomId, signal?: AbortSignal) => Promise<MarketInformationResponse>;

function normalizeSelectedSymbol(market: AiCryptoMarket, symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (market === 'UPBIT') return normalized.startsWith('KRW-') ? normalized.slice(4) : normalized;
  return normalized.replace(/[-_/]/g, '');
}

function assertPublicOnly(response: MarketInformationResponse): void {
  const policy = response.requestPolicy;
  const privateCount = policy.privateExchangeRequests
    + policy.accountRequests
    + policy.balanceRequests
    + policy.positionRequests
    + policy.orderRequests
    + policy.cancelRequests;
  if (!policy.publicMarketDataOnly || privateCount !== 0) {
    throw new PublicCryptoAiContextError(
      'AI_CRYPTO_PRIVATE_BOUNDARY_VIOLATION',
      'AI 코인 컨텍스트는 공개 시장데이터 전용 응답만 사용할 수 있습니다.',
    );
  }
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? '').filter(Boolean))];
}

function selectedRow(response: MarketInformationResponse, market: AiCryptoMarket, symbol: string): MarketInformationAssetRow | null {
  const canonical = normalizeSelectedSymbol(market, symbol);
  return response.sections.rankings.data.find((row) => row.symbol.toUpperCase() === canonical) ?? null;
}

export function buildPublicCryptoAiContextFromRoom(
  market: AiCryptoMarket,
  symbol: string,
  response: MarketInformationResponse,
): PublicCryptoAiContext {
  assertPublicOnly(response);
  const expectedRoom: MarketInformationRoomId = market === 'UPBIT' ? 'coins-spot' : 'coins-futures';
  if (response.room !== expectedRoom) {
    throw new PublicCryptoAiContextError('AI_CRYPTO_MARKET_MISMATCH', '선택 시장과 공개 시장정보 응답이 일치하지 않습니다.');
  }

  const canonicalSymbol = normalizeSelectedSymbol(market, symbol);
  const row = selectedRow(response, market, canonicalSymbol);
  const ranking = response.sections.rankings;
  if (!row) {
    return {
      market,
      symbol: canonicalSymbol,
      quote: null,
      derivatives: null,
      disclosure: {
        status: 'unavailable',
        asOf: ranking.meta.providerUpdatedAt ?? response.fetchedAt,
        basis: 'server_collection_time',
        sources: unique([ranking.meta.provider, ranking.meta.source]),
        missing: [
          '선택 종목 공개 시세',
          'OHLCV·기술지표',
          '검증된 코인 뉴스',
        ],
      },
    };
  }

  const missing: string[] = ['OHLCV·기술지표', '검증된 코인 뉴스'];
  const quote = {
    price: row.price,
    changePercent: row.changePercent,
    high24h: row.high24h,
    low24h: row.low24h,
    volume24h: row.volume24h,
    tradingValue24h: row.tradingValue24h,
    currency: row.currency,
    exchange: row.exchange,
    warning: row.warning,
    tradingStatus: row.tradingStatus,
    providerUpdatedAt: row.providerUpdatedAt,
  };

  let derivatives: PublicCryptoAiContext['derivatives'] = null;
  const sourceNames: Array<string | null | undefined> = [ranking.meta.provider, ranking.meta.source];
  if (market === 'BITGET') {
    const derivativeSection = response.sections.derivatives;
    const derivativeData = derivativeSection.data;
    const ratioMatchesSymbol = derivativeData.referenceSymbol.toUpperCase() === canonicalSymbol;
    if (row.fundingRatePercent == null) missing.push('펀딩비');
    if (row.openInterest == null) missing.push('미결제약정');
    if (!ratioMatchesSymbol || derivativeSection.status === 'error' || derivativeSection.status === 'unavailable') {
      missing.push('선택 종목 long/short ratio');
    }
    derivatives = {
      fundingRatePercent: row.fundingRatePercent,
      nextFundingAt: row.nextFundingAt,
      openInterest: row.openInterest,
      rangeVolatility24hPercent: row.rangeVolatility24hPercent,
      longRatio: ratioMatchesSymbol ? derivativeData.longRatio : null,
      shortRatio: ratioMatchesSymbol ? derivativeData.shortRatio : null,
      longShortRatio: ratioMatchesSymbol ? derivativeData.longShortRatio : null,
      ratioObservedAt: ratioMatchesSymbol ? derivativeData.ratioObservedAt : null,
      liquidations: derivativeData.liquidations
        .filter((item) => item.symbol.toUpperCase() === canonicalSymbol)
        .slice(0, 20)
        .map((item) => ({
          side: item.side,
          price: item.price,
          amount: item.amount,
          occurredAt: item.occurredAt,
        })),
    };
    sourceNames.push(derivativeSection.meta.provider, derivativeSection.meta.source);
  }

  const degraded = response.partial
    || ranking.status === 'partial'
    || ranking.status === 'stale'
    || ranking.meta.isDelayed
    || ranking.meta.isStale;

  return {
    market,
    symbol: canonicalSymbol,
    quote,
    derivatives,
    disclosure: {
      status: degraded || missing.length > 0 ? 'partial' : 'complete',
      asOf: row.providerUpdatedAt ?? ranking.meta.providerUpdatedAt ?? response.fetchedAt,
      basis: 'server_collection_time',
      sources: unique(sourceNames),
      missing: unique(missing),
    },
  };
}

export async function loadPublicCryptoAiContext(
  market: AiCryptoMarket,
  symbol: string,
  signal?: AbortSignal,
  loader: RoomLoader = MarketInformationService.getRoom.bind(MarketInformationService),
): Promise<PublicCryptoAiContext> {
  const room: MarketInformationRoomId = market === 'UPBIT' ? 'coins-spot' : 'coins-futures';
  return buildPublicCryptoAiContextFromRoom(market, symbol, await loader(room, signal));
}
