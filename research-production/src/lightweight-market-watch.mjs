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
  return sourceResult(
    'CRYPTO_FUTURES', 'BITGET_PUBLIC_TICKERS', 'READY',
    payload.data.length, quotes,
  );
}
export function normalizeStockFeed(raw, market, nowMs) {
  if (market !== 'KR_STOCK' && market !== 'US_STOCK')
    throw new Error('STOCK_MARKET_INVALID');
  if (!raw || raw.schemaVersion !== 'research-stock-public-snapshot-v1'
    || raw.market !== market || typeof raw.source !== 'string'
    || !/^[a-zA-Z0-9._-]{3,64}$/.test(raw.source)
    || typeof raw.completeUniverse !== 'boolean'
    || !Array.isArray(raw.quotes) || raw.quotes.length > 30_000) {
    throw new Error('STOCK_PUBLIC_FEED_INVALID');
  }
  const observed = Date.parse(raw.asOf);
  if (!validAge(observed, nowMs)) throw new Error('STOCK_PUBLIC_FEED_STALE');
  const quotes = [];
  for (const row of raw.quotes) {
    const ticker = symbol(row?.symbol);
    const price = number(row?.price);
    const turnover = number(row?.turnover24h);
    const percent = number(row?.change24hPercent);
    if (!ticker || !(price > 0) || !(turnover >= 0) || percent == null) continue;
    quotes.push(Object.freeze({
      symbol: ticker, price,
      turnover24h: turnover, change24hPercent: percent,
      sourceAtMs: observed,
    }));
  }
  if (!quotes.length) throw new Error('STOCK_PUBLIC_FEED_EMPTY');
  return sourceResult(
    market, raw.source,
    raw.completeUniverse && quotes.length === raw.quotes.length
      ? 'READY' : 'PARTIAL_UNIVERSE',
    raw.quotes.length, quotes,
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
  const comparable = elapsed != null
    && elapsed >= WATCH_LIMITS.minComparisonAgeMs
    && elapsed <= WATCH_LIMITS.maxComparisonAgeMs;
  const minValue = WATCH_LIMITS.minTurnover[market];
  const candidates = [];
  for (const row of rows) {
    if (!(row.turnover24h >= minValue) || !comparable) continue;
    const old = prior.get(row.symbol);
    if (!old || !(old.price > 0) || !(row.sourceAtMs > old.sourceAtMs)) continue;
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
      quotes: rows.map((row) => ({
        symbol: row.symbol, price: row.price, sourceAtMs: row.sourceAtMs,
      })),
    }),
  });
}
export function watchCycleDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
