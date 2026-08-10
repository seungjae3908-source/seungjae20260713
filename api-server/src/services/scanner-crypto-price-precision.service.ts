import { bitgetContractPriceTick, roundPriceToTick } from './market-price-precision.service';
import type {
  ScannerPricePlan,
  ScannerResponse,
  ScannerSignalCard,
} from './scanner-signal.types';

const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const PRECISION_TIMEOUT_MS = 2_500;
const PRECISION_CACHE_TTL_MS = 5 * 60_000;

interface UpbitInstrumentRow {
  market?: unknown;
  tick_size?: unknown;
}

interface BitgetContractRow {
  symbol?: unknown;
  pricePlace?: unknown;
  priceEndStep?: unknown;
}

interface BitgetEnvelope<T> {
  code?: unknown;
  data?: T;
}

interface CachedTick {
  tick: number;
  expiresAt: number;
}

interface AlignedCard {
  card: ScannerSignalCard;
  precisionMissing: boolean;
}

export type CryptoPrecisionMarket = 'spot' | 'futures';

export interface CryptoPricePrecisionService {
  align(
    market: CryptoPrecisionMarket,
    response: ScannerResponse,
    signal?: AbortSignal,
  ): Promise<ScannerResponse>;
}

function emptyPricePlan(): ScannerPricePlan {
  return { entryZone: null, invalidation: null, stopLoss: null, targets: [], riskReward: null };
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function linkedSignal(parent?: AbortSignal): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('CRYPTO_PRECISION_TIMEOUT')),
    PRECISION_TIMEOUT_MS,
  );
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abort);
    },
  };
}

async function fetchJson<T>(fetcher: typeof fetch, url: string, signal?: AbortSignal): Promise<T> {
  const linked = linkedSignal(signal);
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'seungjae-signal-scanner/1.0' },
      signal: linked.signal,
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json() as T;
  } finally {
    linked.clear();
  }
}

function hasPricePlan(card: ScannerSignalCard): boolean {
  return card.pricePlan.entryZone != null
    && card.pricePlan.stopLoss != null
    && card.pricePlan.invalidation != null
    && card.pricePlan.targets.length > 0
    && card.pricePlan.riskReward != null;
}

function recomputeRiskReward(card: ScannerSignalCard, plan: ScannerPricePlan): number | null {
  const stop = plan.stopLoss;
  const target = plan.targets[0] ?? null;
  if (stop == null || target == null || !(card.price > 0)) return null;
  if (card.direction === 'LONG') {
    const risk = card.price - stop;
    const reward = target - card.price;
    return risk > 0 && reward > 0 ? Math.round((reward / risk) * 100) / 100 : null;
  }
  if (card.direction === 'SHORT') {
    const risk = stop - card.price;
    const reward = card.price - target;
    return risk > 0 && reward > 0 ? Math.round((reward / risk) * 100) / 100 : null;
  }
  return null;
}

function snapPricePlan(card: ScannerSignalCard, tick: number): ScannerPricePlan | null {
  const plan = card.pricePlan;
  if (!plan.entryZone || plan.stopLoss == null || plan.invalidation == null || plan.targets.length === 0) return null;
  const from = roundPriceToTick(plan.entryZone.from, tick);
  const to = roundPriceToTick(plan.entryZone.to, tick);
  const invalidation = roundPriceToTick(plan.invalidation, tick);
  const stopLoss = roundPriceToTick(plan.stopLoss, tick);
  const targets = plan.targets
    .map((value) => roundPriceToTick(value, tick))
    .filter((value): value is number => value != null);
  if (from == null || to == null || invalidation == null || stopLoss == null || targets.length !== plan.targets.length) return null;
  const snapped: ScannerPricePlan = {
    entryZone: { from: Math.min(from, to), to: Math.max(from, to) },
    invalidation,
    stopLoss,
    targets,
    riskReward: null,
  };
  snapped.riskReward = recomputeRiskReward(card, snapped);
  return snapped.riskReward != null ? snapped : null;
}

function cardWithPrecision(card: ScannerSignalCard, tick: number | null, source: string): AlignedCard {
  if (!hasPricePlan(card)) return { card, precisionMissing: false };
  const snapped = tick == null ? null : snapPricePlan(card, tick);
  if (!snapped) {
    return {
      precisionMissing: true,
      card: {
        ...card,
        pricePlan: emptyPricePlan(),
        strongSignalEligible: false,
        signalState: card.signalState === 'WATCHING' ? 'DETECTED' : card.signalState,
        warnings: [...new Set([...card.warnings, '시장 가격 단위 데이터 부족'])],
      },
    };
  }
  return {
    precisionMissing: false,
    card: {
      ...card,
      pricePlan: snapped,
      dataSources: [...new Set([...card.dataSources, source])],
    },
  };
}

function symbolKey(market: CryptoPrecisionMarket, symbol: string): string {
  return `${market}:${symbol.trim().toUpperCase()}`;
}

function uniqueSymbols(cards: ScannerSignalCard[]): string[] {
  return [...new Set(cards.map((card) => card.symbol.trim().toUpperCase()).filter(Boolean))];
}

export function createCryptoPricePrecisionService(fetcher: typeof fetch = fetch): CryptoPricePrecisionService {
  const cache = new Map<string, CachedTick>();
  let upbitRefreshPromise: Promise<void> | null = null;
  let bitgetRefreshPromise: Promise<void> | null = null;

  const cachedTick = (market: CryptoPrecisionMarket, symbol: string): number | null => {
    const key = symbolKey(market, symbol);
    const row = cache.get(key);
    if (!row) return null;
    if (row.expiresAt <= Date.now()) {
      cache.delete(key);
      return null;
    }
    return row.tick;
  };

  const cacheTick = (market: CryptoPrecisionMarket, symbol: string, tick: number) => {
    cache.set(symbolKey(market, symbol), { tick, expiresAt: Date.now() + PRECISION_CACHE_TTL_MS });
  };

  const upbitTicks = async (cards: ScannerSignalCard[], signal?: AbortSignal): Promise<Map<string, number>> => {
    const symbols = uniqueSymbols(cards);
    let missing = symbols.filter((symbol) => cachedTick('spot', symbol) == null);
    if (missing.length && upbitRefreshPromise) {
      await upbitRefreshPromise;
      missing = symbols.filter((symbol) => cachedTick('spot', symbol) == null);
    }
    if (missing.length) {
      const markets = missing.map((symbol) => `KRW-${symbol}`);
      upbitRefreshPromise = (async () => {
        const rows = await fetchJson<UpbitInstrumentRow[]>(
          fetcher,
          `${UPBIT_BASE}/v1/orderbook/instruments?markets=${encodeURIComponent(markets.join(','))}`,
          signal,
        );
        for (const row of rows) {
          const market = text(row.market).toUpperCase();
          const tick = finite(row.tick_size);
          if (market.startsWith('KRW-') && tick != null) cacheTick('spot', market.replace(/^KRW-/, ''), tick);
        }
      })();
      try {
        await upbitRefreshPromise;
      } finally {
        upbitRefreshPromise = null;
      }
    }
    const ticks = new Map<string, number>();
    for (const symbol of symbols) {
      const tick = cachedTick('spot', symbol);
      if (tick != null) ticks.set(symbol, tick);
    }
    return ticks;
  };

  const bitgetTicks = async (cards: ScannerSignalCard[], signal?: AbortSignal): Promise<Map<string, number>> => {
    const symbols = uniqueSymbols(cards);
    let missing = symbols.filter((symbol) => cachedTick('futures', symbol) == null);
    if (missing.length && bitgetRefreshPromise) {
      await bitgetRefreshPromise;
      missing = symbols.filter((symbol) => cachedTick('futures', symbol) == null);
    }
    if (missing.length) {
      bitgetRefreshPromise = (async () => {
        const payload = await fetchJson<BitgetEnvelope<BitgetContractRow[]>>(
          fetcher,
          `${BITGET_BASE}/api/v2/mix/market/contracts?productType=${BITGET_PRODUCT_TYPE}`,
          signal,
        );
        if (text(payload.code) !== '00000' || !Array.isArray(payload.data)) {
          throw new Error(`BITGET_${text(payload.code) || 'INVALID'}`);
        }
        for (const row of payload.data) {
          const symbol = text(row.symbol).toUpperCase();
          if (!symbol) continue;
          const tick = bitgetContractPriceTick(row.pricePlace, row.priceEndStep);
          if (tick != null) cacheTick('futures', symbol, tick);
        }
      })();
      try {
        await bitgetRefreshPromise;
      } finally {
        bitgetRefreshPromise = null;
      }
    }
    const ticks = new Map<string, number>();
    for (const symbol of symbols) {
      const tick = cachedTick('futures', symbol);
      if (tick != null) ticks.set(symbol, tick);
    }
    return ticks;
  };

  return {
    async align(market, response, signal) {
      const cardsRequiringPrecision = response.cards.filter(hasPricePlan);
      if (!cardsRequiringPrecision.length) return response;
      let ticks = new Map<string, number>();
      let precisionProviderError = false;
      try {
        ticks = market === 'spot'
          ? await upbitTicks(cardsRequiringPrecision, signal)
          : await bitgetTicks(cardsRequiringPrecision, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        precisionProviderError = true;
      }
      const source = market === 'spot' ? 'upbit-public-orderbook-instruments' : 'bitget-public-contracts';
      const alignedCards = response.cards.map((card) => cardWithPrecision(
        card,
        ticks.get(card.symbol.trim().toUpperCase()) ?? null,
        source,
      ));
      const cards = alignedCards.map((item) => item.card);
      const missingPrecisionCount = alignedCards.filter((item) => item.precisionMissing).length;
      const precisionIncomplete = precisionProviderError || missingPrecisionCount > 0;
      return {
        ...response,
        cards,
        alerts: precisionIncomplete ? [] : response.alerts,
        execution: {
          ...response.execution,
          providerErrorCount: response.execution.providerErrorCount + (precisionProviderError ? 1 : 0),
          partial: response.execution.partial || precisionIncomplete,
        },
        dataState: response.dataState === 'complete' && precisionIncomplete ? 'partial' : response.dataState,
        message: precisionProviderError
          ? '시장 가격 단위 공급자 응답이 없어 가격 계획을 비운 상태로 후보를 표시합니다.'
          : missingPrecisionCount > 0
            ? `${missingPrecisionCount}개 후보의 시장 가격 단위를 확인하지 못해 해당 가격 계획을 비웠습니다.`
            : response.message,
        orderSubmitted: false,
        exchangeRequestSent: false,
      };
    },
  };
}

export const CryptoPricePrecisionService = createCryptoPricePrecisionService();
