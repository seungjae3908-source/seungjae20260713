const BASE_URL = 'https://api.bitget.com';
const PRODUCT_TYPE = 'USDT-FUTURES';
export const REFERENCE_NOTIONALS_USDT = Object.freeze([100, 500, 1000]);

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSymbol(value) {
  const symbol = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/gu, '');
  if (!symbol.endsWith('USDT')) throw new TypeError('BITGET_SYMBOL_INVALID');
  return symbol;
}

function normalizeDepthLevels(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    if (!Array.isArray(row) || row.length < 2) return [];
    const price = finite(row[0]);
    const quantity = finite(row[1]);
    return price != null && price > 0 && quantity != null && quantity > 0
      ? [{ price, quantity }]
      : [];
  });
}

export function estimateReferenceSlippage(levels, direction, notionalUsdt) {
  const side = String(direction ?? '').toUpperCase();
  const target = finite(notionalUsdt);
  if (!['LONG', 'SHORT'].includes(side)) throw new TypeError('FUTURES_DIRECTION_INVALID');
  if (target == null || target <= 0) throw new TypeError('REFERENCE_NOTIONAL_INVALID');
  if (!Array.isArray(levels) || !levels.length) throw new Error('BITGET_DEPTH_EMPTY');

  let remainingQuote = target;
  let acquiredBase = 0;
  let spentQuote = 0;
  const bestPrice = levels[0].price;
  for (const level of levels) {
    const levelQuote = level.price * level.quantity;
    const takeQuote = Math.min(remainingQuote, levelQuote);
    const takeBase = takeQuote / level.price;
    acquiredBase += takeBase;
    spentQuote += takeQuote;
    remainingQuote -= takeQuote;
    if (remainingQuote <= 1e-8) break;
  }
  if (remainingQuote > 1e-6 || acquiredBase <= 0 || spentQuote <= 0) {
    return Object.freeze({
      notionalUsdt: target,
      available: false,
      bestPrice,
      vwap: null,
      slippagePct: null,
      filledQuoteUsdt: spentQuote,
      unfilledQuoteUsdt: remainingQuote,
    });
  }
  const vwap = spentQuote / acquiredBase;
  const slippagePct = side === 'LONG'
    ? Math.max(0, (vwap - bestPrice) / bestPrice * 100)
    : Math.max(0, (bestPrice - vwap) / bestPrice * 100);
  return Object.freeze({
    notionalUsdt: target,
    available: true,
    bestPrice,
    vwap,
    slippagePct,
    filledQuoteUsdt: spentQuote,
    unfilledQuoteUsdt: 0,
  });
}

async function fetchDepth(symbol, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('BITGET_DEPTH_TIMEOUT')), 5_000);
  try {
    const url = new URL('/api/v2/mix/market/merge-depth', BASE_URL);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('productType', PRODUCT_TYPE);
    url.searchParams.set('precision', 'scale0');
    url.searchParams.set('limit', 'max');
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'signal-intelligence-v3/1.0' },
    });
    if (!response.ok) throw new Error(`BITGET_DEPTH_HTTP_${response.status}`);
    const body = await response.json();
    if (!body || body.code !== '00000' || !body.data) throw new Error('BITGET_DEPTH_PROVIDER_ERROR');
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildBitgetReferenceDepthEvidence(input, fetchImpl = fetch) {
  const symbol = normalizeSymbol(input?.symbol);
  const direction = String(input?.direction ?? '').toUpperCase();
  if (!['LONG', 'SHORT'].includes(direction)) throw new TypeError('FUTURES_DIRECTION_INVALID');
  const data = await fetchDepth(symbol, fetchImpl);
  const levels = normalizeDepthLevels(direction === 'LONG' ? data.asks : data.bids);
  if (!levels.length) throw new Error('BITGET_DEPTH_SIDE_EMPTY');
  const curve = REFERENCE_NOTIONALS_USDT.map((notional) => estimateReferenceSlippage(levels, direction, notional));
  const reference = curve.find((row) => row.notionalUsdt === 1000);
  if (!reference?.available || reference.slippagePct == null) throw new Error('BITGET_DEPTH_1000_USDT_INSUFFICIENT');
  return Object.freeze({
    symbol,
    direction,
    provider: 'bitget-public-merge-depth',
    referenceNotionalUsdt: 1000,
    referenceSlippagePct: reference.slippagePct,
    bestPrice: reference.bestPrice,
    curve: Object.freeze(curve),
    matchingEngineTimestamp: finite(data.ts),
    precision: String(data.precision ?? 'scale0'),
    publicOnly: true,
    privateAccountStateUsed: false,
    executionAuthority: 'NONE',
  });
}
