import { createHash } from 'node:crypto';

export const WATCH_MARKETS = Object.freeze([
  'KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES',
]);
export const WATCH_CONTRACT = 'lightweight-market-opportunity-watch-v1';
export const WATCH_SAFETY = Object.freeze({
  researchOnly: true,
  orderAuthority: 'NONE',
  liveTrading: false,
  privateProviderApi: false,
  paperAdmissionAllowed: false,
  profitabilityProven: false,
  aiPassInvented: false,
});
export const WATCH_LIMITS = Object.freeze({
  intervalMs: 120_000,
  maxSymbolsPerMarket: 8_000,
  maxCandidatesPerMarket: 12,
  maxSourceAgeMs: 180_000,
  maxComparisonAgeMs: 300_000,
  minComparisonAgeMs: 15_000,
  cooldownMs: 15 * 60_000,
  minDiskFreeBytes: 5 * 1024 ** 3,
  memoryHoldBytes: 512 * 1024 ** 2,
  memoryThrottleBytes: 768 * 1024 ** 2,
  minTurnover: Object.freeze({
    KR_STOCK: 500_000_000,
    US_STOCK: 1_000_000,
    CRYPTO_SPOT: 500_000_000,
    CRYPTO_FUTURES: 5_000_000,
  }),
  minPriceMovePercent: 0.7,
});

function number(value) {
  if ((typeof value !== 'string' && typeof value !== 'number')
    || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function symbol(value) {
  const s = String(value ?? '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(s) ? s : null;
}
function stockSymbol(value, market) {
  const code = symbol(value);
  if (!code) return null;
  // Market-specific labels prevent cross-market false candidates. KRX short
  // codes are six alphanumeric characters; US may use class share suffixes.
  if (market === 'KR_STOCK') return /^[A-Z0-9]{6}$/.test(code) ? code : null;
  if (market === 'US_STOCK') return /^[A-Z][A-Z0-9]{0,14}(?:[.-][A-Z0-9]{1,6})?$/.test(code)
    ? code : null;
  return null;
}
function validAge(timestamp, nowMs) {
  return Number.isFinite(timestamp) && timestamp > 0
    && timestamp <= nowMs + 5_000
    && nowMs - timestamp <= WATCH_LIMITS.maxSourceAgeMs;
}
function uniqueQuotes(rows) {
  const map = new Map();
  for (const row of rows) {
    const old = map.get(row.symbol);
    if (!old || row.sourceAtMs >= old.sourceAtMs) map.set(row.symbol, row);
  }
  return [...map.values()].sort((a, b) =>
    b.turnover24h - a.turnover24h || a.symbol.localeCompare(b.symbol))
    .slice(0, WATCH_LIMITS.maxSymbolsPerMarket);
}
function sourceResult(market, source, status, listedCount, quotes) {
  return Object.freeze({
    market, source, status, listedCount,
    quotes: Object.freeze(uniqueQuotes(quotes)),
  });
}
export function blockedSource(market, reason) {
  if (!WATCH_MARKETS.includes(market)) throw new Error('UNKNOWN_MARKET');
  return sourceResult(market, 'NONE', reason, 0, []);
}

// Enforce a hard post-decompression byte ceiling. Content-Length alone is not
// enough: provider responses may be chunked, compressed, or misconfigured.
// A small server must never buffer an unbounded public HTTP payload.
export async function parseBoundedPublicJson(response, maxBytes = 4_000_000) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4_000_000)
    throw new Error('PUBLIC_RESPONSE_LIMIT_INVALID');
  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : 0;
    throw new Error('PUBLIC_HTTP_' + status);
  }
  const declared = response.headers?.get?.('content-length');
  if (declared != null && declared !== '') {
    const size = Number(declared);
    if (Number.isFinite(size) && size > maxBytes)
      throw new Error('PUBLIC_RESPONSE_OVERSIZE');
  }
  if (!response.body || typeof response.body.getReader !== 'function')
    throw new Error('PUBLIC_RESPONSE_BODY_MISSING');
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value?.byteLength ?? 0;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error('PUBLIC_RESPONSE_OVERSIZE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    throw new Error('PUBLIC_RESPONSE_JSON_INVALID');
  }
}
export function normalizeUpbitSnapshot(marketRows, tickerRows, nowMs) {
  if (!Array.isArray(marketRows) || !Array.isArray(tickerRows))
    throw new Error('UPBIT_PUBLIC_SHAPE_INVALID');
  const listed = new Map();
  for (const row of marketRows) {
    const market = String(row?.market ?? '').trim().toUpperCase();
    if (!/^KRW-[A-Z0-9._-]{1,32}$/.test(market)) continue;
    if (String(row.market_warning ?? 'NONE').toUpperCase() !== 'NONE') continue;
    listed.set(market, market.slice(4));
  }
  const quotes = [];
  for (const row of tickerRows) {
    const market = String(row?.market ?? '').trim().toUpperCase();
    if (!listed.has(market)) continue;
    const price = number(row?.trade_price);
    const turnover = number(row?.acc_trade_price_24h);
    const percent = number(row?.signed_change_rate);
    const observed = number(row?.timestamp);
    if (!(price > 0) || !(turnover >= 0) || percent == null
      || !validAge(observed, nowMs)) continue;
    quotes.push(Object.freeze({
      symbol: listed.get(market), price,
      turnover24h: turnover,
      change24hPercent: percent * 100,
      sourceAtMs: observed,
    }));
  }
  if (!listed.size || !quotes.length) throw new Error('UPBIT_PUBLIC_QUOTES_UNAVAILABLE');
  const status = quotes.length === listed.size ? 'READY' : 'PARTIAL_TICKERS';
  return sourceResult('CRYPTO_SPOT', 'UPBIT_PUBLIC_TICKERS', status, listed.size, quotes);
}
export function normalizeBitgetSnapshot(payload, nowMs) {
  if (!payload || String(payload.code) !== '00000' || !Array.isArray(payload.data))
    throw new Error('BITGET_PUBLIC_SHAPE_INVALID');
  const quotes = [];
  for (const row of payload.data) {
    const ticker = symbol(row?.symbol);
    const price = number(row?.lastPr);
    const turnover = number(row?.usdtVolume);
    const percent = number(row?.change24h);
    const observed = number(row?.ts);
    if (!ticker || !(price > 0) || !(turnover >= 0) || percent == null
      || !validAge(observed, nowMs)) continue;
    quotes.push(Object.freeze({
      symbol: ticker, price,
      turnover24h: turnover,
      change24hPercent: percent * 100,
      sourceAtMs: observed,
    }));
  }
  if (!quotes.length) throw new Error('BITGET_PUBLIC_QUOTES_UNAVAILABLE');
  // Public APIs can return a partially usable market list. A subset must
  // never be displayed to Research as verified full-universe coverage.
  const quoteSymbols = new Set(quotes.map((row) => row.symbol));
  const complete = quoteSymbols.size === payload.data.length;
  return sourceResult(
    'CRYPTO_FUTURES', 'BITGET_PUBLIC_TICKERS',
    complete ? 'READY' : 'PARTIAL_TICKERS',
    payload.data.length, quotes,
  );
}
export function normalizeStockFeed(raw, market, nowMs) {
  if (market !== 'KR_STOCK' && market !== 'US_STOCK')
    throw new Error('STOCK_MARKET_INVALID');
  if (!raw || raw.schemaVersion !== 'research-stock-public-snapshot-v1'
    || raw.market !== market || typeof raw.source !== 'string'
    // Source identities also flow into local Node and Python admin
    // readbacks; never accept a name those readers reject. "NONE" is
    // reserved for an unavailable/blocked feed, not a healthy provider.
    || !/^[A-Za-z0-9_-]{3,64}$/.test(raw.source)
    || raw.source === 'NONE'
    || typeof raw.completeUniverse !== 'boolean'
    || !Array.isArray(raw.quotes) || raw.quotes.length > 30_000) {
    throw new Error('STOCK_PUBLIC_FEED_INVALID');
  }
  const observed = Date.parse(raw.asOf);
  if (!validAge(observed, nowMs)) throw new Error('STOCK_PUBLIC_FEED_STALE');
  const quotes = [];
  for (const row of raw.quotes) {
    const ticker = stockSymbol(row?.symbol, market);
    const price = number(row?.price);
    const turnover = number(row?.turnover24h);
    const percent = number(row?.change24hPercent);
    // A freshly written file does not prove that each stock quotation is fresh.
    // Require an independent as-of timestamp for the exact symbol and price.
    const quoteAtMs = typeof row?.asOf === 'string' ? Date.parse(row.asOf) : NaN;
    if (!ticker || !(price > 0) || !(turnover >= 0) || percent == null
      || !validAge(quoteAtMs, nowMs) || quoteAtMs > observed + 5_000) continue;
    quotes.push(Object.freeze({
      symbol: ticker, price,
      turnover24h: turnover, change24hPercent: percent,
      sourceAtMs: quoteAtMs,
    }));
  }
  if (!quotes.length) throw new Error('STOCK_PUBLIC_FEED_EMPTY');
  // Self-declared completeUniverse in this same local payload is not
  // independent licensed/provider/roster evidence of complete market coverage.
  // Until a separately validated source binding exists, no stock market may
  // turn READY solely on a file-supplied flag or a one-ticker sample.
  return sourceResult(
    market, raw.source, 'PARTIAL_UNIVERSE', raw.quotes.length, quotes,
  );
}
export function evaluateWatchBudget(telemetry) {
  const count = number(telemetry?.cpuCount);
  const load = number(telemetry?.loadOne);
  const available = number(telemetry?.memoryAvailableBytes);
  const disk = number(telemetry?.diskFreeBytes);
  if (!(count >= 1) || !(load >= 0) || !(available >= 0) || !(disk >= 0)) {
    return Object.freeze({ status: 'HOLD', reason: 'INVALID_RESOURCE_EVIDENCE' });
  }
  if (disk < WATCH_LIMITS.minDiskFreeBytes)
    return Object.freeze({ status: 'HOLD', reason: 'LOW_DISK_SPACE' });
  if (available < WATCH_LIMITS.memoryHoldBytes)
    return Object.freeze({ status: 'HOLD', reason: 'MEMORY_PRESSURE' });
  if (available < WATCH_LIMITS.memoryThrottleBytes || load / count >= 0.85)
    return Object.freeze({ status: 'THROTTLED', reason: 'HOST_PRESSURE' });
  return Object.freeze({ status: 'RUN', reason: 'WITHIN_BUDGET' });
}
export function evaluateMarketOpportunities(input) {
  const { market, source, previous, nowMs } = input;
  if (!WATCH_MARKETS.includes(market) || source?.market !== market)
    throw new Error('WATCH_MARKET_SOURCE_MISMATCH');
  const rows = source.quotes ?? [];
  const previousRows = Array.isArray(previous?.quotes) ? previous.quotes : [];
  const prior = new Map(previousRows.map((row) => [row.symbol, row]));
  const priorAt = number(previous?.observedAtMs);
  const elapsed = priorAt == null ? null : nowMs - priorAt;
  // Baselines from another provider, or without known source identity, are
  // never comparable even if their ticker string happens to match.
  const comparable = elapsed != null
    && (source.status === 'READY'
      || source.status === 'PARTIAL_UNIVERSE'
      || source.status === 'PARTIAL_TICKERS')
    && typeof previous?.source === 'string'
    && previous.source === source.source
    && elapsed >= WATCH_LIMITS.minComparisonAgeMs
    && elapsed <= WATCH_LIMITS.maxComparisonAgeMs;
  const minValue = WATCH_LIMITS.minTurnover[market];
  const candidates = [];
  for (const row of rows) {
    if (!(row.turnover24h >= minValue) || !comparable) continue;
    const old = prior.get(row.symbol);
    if (!old || !(old.price > 0) || !validAge(old.sourceAtMs, nowMs)
      || !(old.sourceAtMs <= priorAt + 5_000)
      || !(row.sourceAtMs > old.sourceAtMs)) continue;
    const movePercent = (row.price / old.price - 1) * 100;
    if (!Number.isFinite(movePercent)
      || Math.abs(movePercent) < WATCH_LIMITS.minPriceMovePercent) continue;
    const bias = movePercent > 0 ? 'UP' : 'DOWN';
    const key = market + ':' + row.symbol + ':' + bias;
    const alertAt = number(input.lastAlerts?.[key]);
    if (alertAt != null && nowMs - alertAt < WATCH_LIMITS.cooldownMs) continue;
    candidates.push(Object.freeze({
      schemaVersion: WATCH_CONTRACT,
      market, symbol: row.symbol,
      direction: bias, // Observation only. No stock/spot short or any trade request.
      source: source.source,
      universeStatus: source.status,
      kind: 'PROVISIONAL_PRICE_ACCELERATION',
      observedAt: new Date(nowMs).toISOString(),
      priorObservedAt: new Date(priorAt).toISOString(),
      comparisonMinutes: Math.round(elapsed / 60_000 * 100) / 100,
      sourceAtMs: row.sourceAtMs,
      priorSourceAtMs: old.sourceAtMs,
      movePercent: Math.round(movePercent * 10_000) / 10_000,
      change24hPercent: row.change24hPercent,
      turnover24h: row.turnover24h,
      score: Math.round(Math.abs(movePercent) * 10_000) / 10_000,
      executionAuthority: 'NONE',
      isTradingSignal: false,
      aiReviewed: false,
      oosPassed: false,
      paperAdmitted: false,
    }));
  }
  candidates.sort((a, b) =>
    b.score - a.score || a.symbol.localeCompare(b.symbol));
  const selected = Object.freeze(candidates.slice(0, WATCH_LIMITS.maxCandidatesPerMarket));
  return Object.freeze({
    summary: Object.freeze({
      market, status: source.status, source: source.source,
      listedCount: source.listedCount,
      observedCount: rows.length,
      newCandidates: selected.length,
      previousSnapshotComparable: comparable,
      executionAuthority: 'NONE',
    }),
    candidates: selected,
    next: Object.freeze({
      observedAtMs: nowMs,
      source: source.source,
      quotes: rows.map((row) => ({
        symbol: row.symbol, price: row.price, sourceAtMs: row.sourceAtMs,
      })),
    }),
  });
}
export function watchCycleDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
