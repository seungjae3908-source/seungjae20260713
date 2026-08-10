import { bitgetContractPriceTick, roundPriceToTick } from './market-price-precision.service';
import type {
  ScannerPricePlan,
  ScannerResponse,
  ScannerSignalCard,
  ScannerSignalDirection,
} from './scanner-signal.types';

const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const PRECISION_TIMEOUT_MS = 2_500;

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

function cardWithPrecision(card: ScannerSignalCard, tick: number | null, source: string): ScannerSignalCard {
  const snapped = tick == null ? null : snapPricePlan(card, tick);
  if (!snapped) {
    return {
      ...card,
      pricePlan: emptyPricePlan(),
      strongSignalEligible: false,
      signalState: card.signalState === 'WATCHING' ? 'DETECTED' : card.signalState,
      warnings: [...new Set([...card.warnings, '시장 가격 단위 데이터 부족'])],
    };
  }
  return {
    ...card,
    pricePlan: snapped,
    dataSources: [...new Set([...card.dataSources, source])],
  };
}

async function upbitTicks(fetcher: typeof fetch, cards: ScannerSignalCard[], signal?: AbortSignal): Promise<Map<string, number>> {
  const markets = [...new Set(cards.map((card) => `KRW-${card.symbol.trim().toUpperCase()}`))];
  if (!markets.length) return new Map();
  const rows = await fetchJson<UpbitInstrumentRow[]>(
    fetcher,
    `${UPBIT_BASE}/v1/orderbook/instruments?markets=${encodeURIComponent(markets.join(','))}`,
    signal,
  );
  const ticks = new Map<string, number>();
  for (const row of rows) {
    const market = text(row.market).toUpperCase();
    const tick = finite(row.tick_size);
    if (market.startsWith('KRW-') && tick != null) ticks.set(market.replace(/^KRW-/, ''), tick);
  }
  return ticks;
}

async function bitgetTicks(fetcher: typeof fetch, cards: ScannerSignalCard[], signal?: AbortSignal): Promise<Map<string, number>> {
  const symbols = new Set(cards.map((card) => card.symbol.trim().toUpperCase()));
  if (!symbols.size) return new Map();
  const payload = await fetchJson<BitgetEnvelope<BitgetContractRow[]>>(
    fetcher,
    `${BITGET_BASE}/api/v2/mix/market/contracts?productType=${BITGET_PRODUCT_TYPE}`,
    signal,
  );
  if (text(payload.code) !== '00000' || !Array.isArray(payload.data)) throw new Error(`BITGET_${text(payload.code) || 'INVALID'}`);
  const ticks = new Map<string, number>();
  for (const row of payload.data) {
    const symbol = text(row.symbol).toUpperCase();
    if (!symbols.has(symbol)) continue;
    const tick = bitgetContractPriceTick(row.pricePlace, row.priceEndStep);
    if (tick != null) ticks.set(symbol, tick);
  }
  return ticks;
}

export function createCryptoPricePrecisionService(fetcher: typeof fetch = fetch): CryptoPricePrecisionService {
  return {
    async align(market, response, signal) {
      if (!response.cards.length) return response;
      let ticks = new Map<string, number>();
      let precisionProviderError = false;
      try {
        ticks = market === 'spot'
          ? await upbitTicks(fetcher, response.cards, signal)
          : await bitgetTicks(fetcher, response.cards, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        precisionProviderError = true;
      }
      const source = market === 'spot' ? 'upbit-public-orderbook-instruments' : 'bitget-public-contracts';
      const cards = response.cards.map((card) => cardWithPrecision(card, ticks.get(card.symbol.trim().toUpperCase()) ?? null, source));
      const missingPrecisionCount = cards.filter((card) => card.pricePlan.riskReward == null).length;
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
