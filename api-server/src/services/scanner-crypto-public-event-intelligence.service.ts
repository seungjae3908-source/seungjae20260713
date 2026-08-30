import { MarketInformationService } from './market-information.service';
import type {
  MarketInformationResponse,
  MarketInformationRoomId,
} from './market-information.contract';
import type { ScannerSignalCard } from './scanner-signal.types';

export type ScannerCryptoPublicEventStatus = 'READY' | 'PARTIAL' | 'NOT_AVAILABLE' | 'TIMEOUT' | 'NOT_RUN';
export type ScannerCryptoPublicEventKind = 'EXCHANGE_WARNING' | 'TRADING_STATUS' | 'PUBLIC_LIQUIDATION';

export type ScannerCryptoPublicEvent = {
  kind: ScannerCryptoPublicEventKind;
  provider: string;
  source: string;
  observedAt: string | null;
  side: 'long' | 'short' | 'unknown' | null;
  price: number | null;
  amount: number | null;
  statusValue: string | null;
  reasons: string[];
};

export type ScannerCryptoPublicEventContext = {
  contract: 'ScannerCryptoPublicEventContextV1';
  status: ScannerCryptoPublicEventStatus;
  reason: string | null;
  market: 'spot' | 'futures';
  symbol: string;
  marketWarning: boolean | null;
  tradingStatus: string | null;
  derivatives: {
    fundingRatePercent: number | null;
    openInterest: number | null;
    longRatio: number | null;
    shortRatio: number | null;
    longShortRatio: number | null;
    ratioObservedAt: string | null;
  } | null;
  events: ScannerCryptoPublicEvent[];
  verifiedCoinNews: {
    connected: boolean;
    sectionStatus: string;
    provider: string | null;
    source: string | null;
    errorCode: string | null;
  };
  sources: string[];
  warnings: string[];
  safety: {
    evidenceOnly: true;
    scoreImpact: 0;
    rankImpact: 0;
    directionImpact: 0;
    pricePlanImpact: 0;
    aiRequests: 0;
    privateExchangeRequests: 0;
    accountRequests: 0;
    positionRequests: 0;
    orderRequests: 0;
    executionAuthority: 'NONE';
    orderAllowed: false;
  };
};

export type ScannerCryptoPublicEventAugmentedCard<T extends ScannerSignalCard = ScannerSignalCard> = T & {
  cryptoPublicEventContext: ScannerCryptoPublicEventContext;
};

type RoomLoader = (room: MarketInformationRoomId, signal?: AbortSignal) => Promise<MarketInformationResponse>;

export type ScannerCryptoPublicEventOptions = {
  market: 'spot' | 'futures';
  enabled?: boolean;
  maxCandidates?: number;
  budgetMs?: number;
  loader?: RoomLoader;
  signal?: AbortSignal;
};

const SAFETY = Object.freeze({
  evidenceOnly: true as const,
  scoreImpact: 0 as const,
  rankImpact: 0 as const,
  directionImpact: 0 as const,
  pricePlanImpact: 0 as const,
  aiRequests: 0 as const,
  privateExchangeRequests: 0 as const,
  accountRequests: 0 as const,
  positionRequests: 0 as const,
  orderRequests: 0 as const,
  executionAuthority: 'NONE' as const,
  orderAllowed: false as const,
});

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function canonicalSymbol(market: 'spot' | 'futures', value: string): string {
  const normalized = value.trim().toUpperCase();
  return market === 'spot'
    ? normalized.replace(/^KRW-/, '')
    : normalized.replace(/[-_/]/g, '');
}

function normalTradingStatus(market: 'spot' | 'futures', value: string | null): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return market === 'spot'
    ? ['active', 'normal', 'trading'].includes(normalized)
    : ['normal', 'active', 'trading'].includes(normalized);
}

function emptyContext(
  market: 'spot' | 'futures',
  symbol: string,
  status: ScannerCryptoPublicEventStatus,
  reason: string,
): ScannerCryptoPublicEventContext {
  return {
    contract: 'ScannerCryptoPublicEventContextV1',
    status,
    reason,
    market,
    symbol: canonicalSymbol(market, symbol),
    marketWarning: null,
    tradingStatus: null,
    derivatives: null,
    events: [],
    verifiedCoinNews: {
      connected: false,
      sectionStatus: 'NOT_RUN',
      provider: null,
      source: null,
      errorCode: null,
    },
    sources: [],
    warnings: [reason],
    safety: SAFETY,
  };
}

function publicPolicyIsSafe(response: MarketInformationResponse): boolean {
  const policy = response.requestPolicy;
  return policy.publicMarketDataOnly === true
    && policy.privateExchangeRequests === 0
    && policy.accountRequests === 0
    && policy.balanceRequests === 0
    && policy.positionRequests === 0
    && policy.orderRequests === 0
    && policy.cancelRequests === 0
    && policy.aiRequests === 0;
}

function newsConnected(response: MarketInformationResponse): boolean {
  const status = response.sections.news.status;
  return (status === 'ready' || status === 'partial' || status === 'stale')
    && response.sections.news.data.length > 0;
}

function contextForCard(
  card: ScannerSignalCard,
  market: 'spot' | 'futures',
  response: MarketInformationResponse,
): ScannerCryptoPublicEventContext {
  const symbol = canonicalSymbol(market, card.symbol);
  if (!publicPolicyIsSafe(response)) {
    return emptyContext(market, symbol, 'NOT_AVAILABLE', 'CRYPTO_PUBLIC_EVENT_UNSAFE_REQUEST_POLICY');
  }

  const expectedRoom: MarketInformationRoomId = market === 'spot' ? 'coins-spot' : 'coins-futures';
  if (response.room !== expectedRoom) {
    return emptyContext(market, symbol, 'NOT_AVAILABLE', 'CRYPTO_PUBLIC_EVENT_ROOM_MISMATCH');
  }

  const rankings = response.sections.rankings;
  const row = rankings.data.find((item) => canonicalSymbol(market, item.symbol) === symbol) ?? null;
  if (!row) {
    const missing = emptyContext(market, symbol, 'NOT_AVAILABLE', 'CRYPTO_PUBLIC_EVENT_SYMBOL_NOT_FOUND');
    missing.verifiedCoinNews = {
      connected: newsConnected(response),
      sectionStatus: response.sections.news.status,
      provider: response.sections.news.meta.provider,
      source: response.sections.news.meta.source,
      errorCode: response.sections.news.meta.errorCode,
    };
    missing.sources = unique([rankings.meta.provider, rankings.meta.source]);
    return missing;
  }

  const events: ScannerCryptoPublicEvent[] = [];
  if (row.warning) {
    events.push({
      kind: 'EXCHANGE_WARNING',
      provider: rankings.meta.provider ?? (market === 'spot' ? 'Upbit' : 'Bitget'),
      source: rankings.meta.source ?? 'official-public-market-api',
      observedAt: row.providerUpdatedAt ?? rankings.meta.observedAt,
      side: null,
      price: null,
      amount: null,
      statusValue: row.tradingStatus,
      reasons: ['거래소 공식 공개 응답의 warning=true'],
    });
  }
  if (!normalTradingStatus(market, row.tradingStatus)) {
    events.push({
      kind: 'TRADING_STATUS',
      provider: rankings.meta.provider ?? (market === 'spot' ? 'Upbit' : 'Bitget'),
      source: rankings.meta.source ?? 'official-public-market-api',
      observedAt: row.providerUpdatedAt ?? rankings.meta.observedAt,
      side: null,
      price: null,
      amount: null,
      statusValue: row.tradingStatus,
      reasons: [`거래소 공개 tradingStatus=${row.tradingStatus}`],
    });
  }

  let derivatives: ScannerCryptoPublicEventContext['derivatives'] = null;
  const sources: Array<string | null | undefined> = [rankings.meta.provider, rankings.meta.source];
  const warnings: string[] = [];
  let relevantSectionPartial = ['partial', 'stale'].includes(rankings.status)
    || rankings.meta.isDelayed
    || rankings.meta.isStale;

  if (market === 'futures') {
    const section = response.sections.derivatives;
    const data = section.data;
    const ratioMatches = canonicalSymbol('futures', data.referenceSymbol) === symbol;
    derivatives = {
      fundingRatePercent: row.fundingRatePercent,
      openInterest: row.openInterest,
      longRatio: ratioMatches ? data.longRatio : null,
      shortRatio: ratioMatches ? data.shortRatio : null,
      longShortRatio: ratioMatches ? data.longShortRatio : null,
      ratioObservedAt: ratioMatches ? data.ratioObservedAt : null,
    };
    sources.push(section.meta.provider, section.meta.source);
    if (section.status === 'partial' || section.status === 'stale' || section.status === 'error' || section.status === 'unavailable') {
      relevantSectionPartial = true;
      warnings.push(`CRYPTO_PUBLIC_DERIVATIVES_${section.status.toUpperCase()}`);
    }
    const liquidations = data.liquidations
      .filter((item) => canonicalSymbol('futures', item.symbol) === symbol)
      .filter((item) => item.occurredAt != null)
      .sort((left, right) => Date.parse(right.occurredAt ?? '') - Date.parse(left.occurredAt ?? ''))
      .slice(0, 5);
    for (const item of liquidations) {
      events.push({
        kind: 'PUBLIC_LIQUIDATION',
        provider: section.meta.provider ?? 'Bitget',
        source: section.meta.source ?? 'Bitget public liquidation API',
        observedAt: item.occurredAt,
        side: item.side,
        price: item.price,
        amount: item.amount,
        statusValue: null,
        reasons: ['거래소 공식 공개 liquidation print; 방향 예측 또는 승률 근거로 재해석하지 않음'],
      });
    }
  }

  const verifiedCoinNews = {
    connected: newsConnected(response),
    sectionStatus: response.sections.news.status,
    provider: response.sections.news.meta.provider,
    source: response.sections.news.meta.source,
    errorCode: response.sections.news.meta.errorCode,
  };
  if (!verifiedCoinNews.connected) warnings.push('COIN_NEWS_PROVIDER_NOT_CONNECTED');

  return {
    contract: 'ScannerCryptoPublicEventContextV1',
    status: relevantSectionPartial ? 'PARTIAL' : 'READY',
    reason: null,
    market,
    symbol,
    marketWarning: row.warning,
    tradingStatus: row.tradingStatus,
    derivatives,
    events,
    verifiedCoinNews,
    sources: unique(sources),
    warnings: unique(warnings),
    safety: SAFETY,
  };
}

async function loadRoomWithBudget(
  options: ScannerCryptoPublicEventOptions,
): Promise<{ response: MarketInformationResponse | null; status: 'OK' | 'TIMEOUT' | 'FAILED' | 'ABORTED' }> {
  const budgetMs = boundedInteger(options.budgetMs, 800, 0, 1_500);
  if (budgetMs <= 0) return { response: null, status: 'TIMEOUT' };
  const loader = options.loader ?? MarketInformationService.getRoom.bind(MarketInformationService);
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(options.signal?.reason ?? new Error('SCANNER_REQUEST_ABORTED'));
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('SCANNER_CRYPTO_PUBLIC_EVENT_TIMEOUT'));
  }, budgetMs);
  try {
    const room: MarketInformationRoomId = options.market === 'spot' ? 'coins-spot' : 'coins-futures';
    return { response: await loader(room, controller.signal), status: 'OK' };
  } catch {
    if (options.signal?.aborted) return { response: null, status: 'ABORTED' };
    return { response: null, status: timedOut ? 'TIMEOUT' : 'FAILED' };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromParent);
  }
}

export async function enrichCryptoScannerCardsWithPublicEventContext<T extends ScannerSignalCard>(
  cards: T[],
  options: ScannerCryptoPublicEventOptions,
): Promise<Array<ScannerCryptoPublicEventAugmentedCard<T>>> {
  const maxCandidates = boundedInteger(options.maxCandidates, 2, 0, 3);
  if (options.enabled === false || options.signal?.aborted || maxCandidates === 0) {
    const reason = options.signal?.aborted ? 'SCANNER_REQUEST_ABORTED' : 'CRYPTO_PUBLIC_EVENT_CONTEXT_DISABLED';
    return cards.map((card) => Object.assign({ ...card }, {
      cryptoPublicEventContext: emptyContext(options.market, card.symbol, 'NOT_RUN', reason),
    }));
  }

  const loaded = await loadRoomWithBudget(options);
  if (loaded.status !== 'OK' || !loaded.response) {
    const status: ScannerCryptoPublicEventStatus = loaded.status === 'TIMEOUT' ? 'TIMEOUT' : loaded.status === 'ABORTED' ? 'NOT_RUN' : 'NOT_AVAILABLE';
    const reason = loaded.status === 'TIMEOUT'
      ? 'SCANNER_CRYPTO_PUBLIC_EVENT_TIMEOUT'
      : loaded.status === 'ABORTED'
        ? 'SCANNER_REQUEST_ABORTED'
        : 'SCANNER_CRYPTO_PUBLIC_EVENT_UNAVAILABLE';
    return cards.map((card, index) => Object.assign({ ...card }, {
      cryptoPublicEventContext: index < maxCandidates
        ? emptyContext(options.market, card.symbol, status, reason)
        : emptyContext(options.market, card.symbol, 'NOT_RUN', 'SCANNER_EVIDENCE_BUDGET_NOT_SELECTED'),
    }));
  }

  return cards.map((card, index) => Object.assign({ ...card }, {
    cryptoPublicEventContext: index < maxCandidates
      ? contextForCard(card, options.market, loaded.response!)
      : emptyContext(options.market, card.symbol, 'NOT_RUN', 'SCANNER_EVIDENCE_BUDGET_NOT_SELECTED'),
  }));
}
