import {
  FuturesMarketDataError,
  normalizeFuturesSymbol,
  toFiniteNumber,
  type DataStatus,
} from './futures-market-data.service';

const BITGET_BASE_URL = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const REQUEST_TIMEOUT_MS = 8_000;
const CONTRACT_RULES_TTL_MS = 10 * 60_000;
const CONTRACT_RULES_STALE_MS = 20 * 60_000;

export type FuturesContractRules = {
  symbol: string;
  source: 'bitget';

  quantityStep: number | null;
  minimumQuantity: number | null;
  minimumNotional: number | null;

  quantityPrecision: number | null;
  pricePrecision: number | null;
  priceStep: number | null;

  minimumLeverage: number | null;
  maximumLeverage: number | null;

  maintenanceMarginRate: number | null;
  contractSize: number | null;

  status: DataStatus;
  updatedAt: string;
  warnings: string[];
};

type JsonObject = Record<string, unknown>;
type CacheEntry = { value: FuturesContractRules; expiresAt: number };

let contractCache = new Map<string, CacheEntry>();
let contractInFlight = new Map<string, Promise<FuturesContractRules>>();

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniqueWarnings(warnings: string[]) {
  return [...new Set(warnings.filter(Boolean))];
}

function safeTimestamp(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed == null || parsed <= 0) return null;
  const milliseconds = parsed < 100_000_000_000 ? parsed * 1000 : parsed;
  return Number.isFinite(milliseconds) ? Math.trunc(milliseconds) : null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  return parsed != null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function tradableStatus(value: unknown) {
  const status = String(value ?? '').trim().toLowerCase();
  return status === 'normal' || status === 'listed';
}

function priceStepFrom(row: JsonObject, pricePrecision: number | null) {
  const endStep = positiveNumber(row.priceEndStep);
  if (endStep == null || pricePrecision == null) return null;
  const value = endStep * 10 ** -pricePrecision;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Maps only fields that are present in Bitget's public contracts response.
 * Unknown or malformed values remain null and are never replaced by exchange-like defaults.
 */
export function normalizeBitgetContractRules(
  row: unknown,
  expectedSymbol: string,
  requestTime: unknown,
  now = Date.now(),
): FuturesContractRules {
  const warnings: string[] = [];
  const object = isObject(row) ? row : {};
  const symbol = String(object.symbol ?? expectedSymbol).trim().toUpperCase();
  const updatedTimestamp = safeTimestamp(requestTime);
  const updatedAt = new Date(updatedTimestamp ?? now).toISOString();
  let status: DataStatus = updatedTimestamp == null
    ? 'insufficient'
    : now - updatedTimestamp <= CONTRACT_RULES_STALE_MS
      ? 'live'
      : 'delayed';

  if (!isObject(row)) warnings.push('Bitget contracts 응답 행 형식이 올바르지 않습니다.');
  if (!tradableStatus(object.symbolStatus)) {
    status = 'insufficient';
    warnings.push('거래 중단 또는 비활성 상태의 선물 심볼입니다.');
  }
  if (updatedTimestamp == null) {
    warnings.push('거래소 계약 규칙의 갱신 시각을 확인할 수 없습니다.');
  }

  const quantityPrecision = nonNegativeInteger(object.volumePlace);
  const pricePrecision = nonNegativeInteger(object.pricePlace);
  const quantityStep = positiveNumber(object.sizeMultiplier);
  const minimumQuantity = positiveNumber(object.minTradeNum);
  const minimumNotional = positiveNumber(object.minTradeUSDT);
  const minimumLeverage = positiveNumber(object.minLever);
  const maximumLeverage = positiveNumber(object.maxLever);
  const maintenanceMarginRate = nonNegativeNumber(object.minMaintainMarginRate);
  const contractSize = positiveNumber(object.contractSize);
  const priceStep = priceStepFrom(object, pricePrecision);

  if (quantityStep == null || minimumQuantity == null || minimumNotional == null) {
    warnings.push('거래소 최소 주문 규칙을 확인할 수 없습니다.');
  }
  if (quantityPrecision == null) warnings.push('수량 소수점 자릿수를 확인할 수 없습니다.');
  if (pricePrecision == null || priceStep == null) warnings.push('가격 단위를 확인할 수 없습니다.');
  if (maximumLeverage == null) warnings.push('거래소 최대 레버리지를 확인할 수 없습니다.');
  if (maintenanceMarginRate == null) {
    warnings.push('유지증거금률은 Bitget contracts 응답에서 확인되지 않아 null입니다.');
  }
  if (contractSize == null) {
    warnings.push('계약 크기는 Bitget contracts 응답에서 확인되지 않아 null입니다.');
  }

  return {
    symbol,
    source: 'bitget',
    quantityStep,
    minimumQuantity,
    minimumNotional,
    quantityPrecision,
    pricePrecision,
    priceStep,
    minimumLeverage,
    maximumLeverage,
    maintenanceMarginRate,
    contractSize,
    status,
    updatedAt,
    warnings: uniqueWarnings(warnings),
  };
}

async function fetchBitgetContract(symbol: string): Promise<FuturesContractRules> {
  const url = new URL('/api/v2/mix/market/contracts', BITGET_BASE_URL);
  url.searchParams.set('productType', BITGET_PRODUCT_TYPE);
  url.searchParams.set('symbol', symbol);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'seungjae-investment-app/2.0',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`BITGET_HTTP_${response.status}`);
    const payload = await response.json() as unknown;
    if (!isObject(payload) || String(payload.code ?? '') !== '00000' || !Array.isArray(payload.data)) {
      throw new Error('BITGET_CONTRACTS_INVALID');
    }
    const row = payload.data
      .filter(isObject)
      .find((item) => String(item.symbol ?? '').trim().toUpperCase() === symbol);
    if (!row) {
      throw new FuturesMarketDataError(400, 'INVALID_FUTURES_SYMBOL', '지원하지 않는 선물 심볼입니다.');
    }
    if (!tradableStatus(row.symbolStatus)) {
      throw new FuturesMarketDataError(400, 'FUTURES_CONTRACT_INACTIVE', '현재 거래 가능한 선물 심볼이 아닙니다.');
    }
    return normalizeBitgetContractRules(row, symbol, payload.requestTime);
  } catch (error) {
    if (error instanceof FuturesMarketDataError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new Error('BITGET_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getFuturesContractRules(value: unknown): Promise<FuturesContractRules> {
  const symbol = normalizeFuturesSymbol(value);
  if (!symbol) {
    throw new FuturesMarketDataError(400, 'INVALID_FUTURES_SYMBOL', '지원하지 않는 선물 심볼입니다.');
  }

  const now = Date.now();
  const existing = contractCache.get(symbol);
  if (existing && existing.expiresAt > now) return existing.value;

  const running = contractInFlight.get(symbol);
  if (running) return running;

  const promise = fetchBitgetContract(symbol);
  contractInFlight.set(symbol, promise);
  try {
    const valueFromProvider = await promise;
    contractCache.set(symbol, {
      value: valueFromProvider,
      expiresAt: Date.now() + CONTRACT_RULES_TTL_MS,
    });
    return valueFromProvider;
  } catch (error) {
    if (error instanceof FuturesMarketDataError) throw error;
    if (existing) {
      return {
        ...existing.value,
        status: 'cached',
        warnings: uniqueWarnings([
          ...existing.value.warnings,
          '거래소 연결 실패로 마지막 정상 계약 규칙 캐시를 반환했습니다.',
        ]),
      };
    }
    throw new FuturesMarketDataError(
      503,
      'FUTURES_CONTRACT_RULES_UNAVAILABLE',
      '선물 계약 규칙을 불러올 수 없습니다.',
    );
  } finally {
    contractInFlight.delete(symbol);
  }
}

export function resetFuturesContractRulesStateForTests() {
  contractCache = new Map();
  contractInFlight = new Map();
}
