import * as yahoo from '../../api-server/src/providers/yahoo';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTicker(value) {
  return String(value ?? '').trim().toUpperCase();
}

function providerCandidates(market, ticker, entry) {
  const clean = normalizeTicker(ticker);
  if (!clean) return [];
  if (market === 'KR_STOCK' && /^\d{6}$/u.test(clean)) {
    const exchange = String(entry?.exchange ?? '').toUpperCase();
    const kosdaq = /KOSDAQ|코스닥/u.test(exchange);
    const primary = `${clean}.${kosdaq ? 'KQ' : 'KS'}`;
    return [primary, `${clean}.${kosdaq ? 'KS' : 'KQ'}`];
  }
  if (market === 'US_STOCK') {
    const rows = [clean];
    if (clean.includes('.')) rows.push(clean.replace(/\./gu, '-'));
    if (clean.includes('-')) rows.push(clean.replace(/-/gu, '.'));
    return [...new Set(rows)];
  }
  return [clean];
}

function createScheduler(minimumStartIntervalMs = 70) {
  let tail = Promise.resolve();
  let nextAt = 0;
  return async (operation) => {
    let release;
    const previous = tail;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    const wait = Math.max(0, nextAt - Date.now());
    if (wait > 0) await sleep(wait);
    nextAt = Date.now() + minimumStartIntervalMs;
    release();
    return operation();
  };
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try { results[index] = { status: 'fulfilled', value: await worker(items[index], index) }; }
      catch (error) { results[index] = { status: 'rejected', reason: error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => run()));
  return results;
}

function errorCode(error) {
  return (error instanceof Error ? error.message : String(error ?? 'UNKNOWN')).split(':')[0].slice(0, 120);
}

export async function buildPublicStockPrefetch(input) {
  const market = String(input?.market ?? '').toUpperCase();
  if (!['KR_STOCK', 'US_STOCK'].includes(market)) throw new TypeError('PUBLIC_STOCK_PREFETCH_MARKET_INVALID');
  const entries = Array.isArray(input?.entries) ? input.entries : [];
  const cursor = Math.max(0, Math.floor(Number(input?.cursor ?? 0)) || 0);
  const batchSize = Math.max(1, Math.min(200, Math.floor(Number(input?.batchSize ?? entries.length)) || entries.length || 1));
  const timeframes = [...new Set((Array.isArray(input?.timeframes) ? input.timeframes : []).map(String).filter(Boolean))];
  if (!timeframes.length) throw new TypeError('PUBLIC_STOCK_PREFETCH_TIMEFRAMES_REQUIRED');
  const selected = entries.slice(cursor, cursor + batchSize);
  const schedule = createScheduler(Number(input?.minimumStartIntervalMs ?? 70));
  const candleCache = new Map();
  const quoteCache = new Map();
  const failures = [];

  async function withFallback(entry, operation) {
    const candidates = providerCandidates(market, entry.ticker, entry);
    let lastError;
    for (const providerSymbol of candidates) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try { return { value: await schedule(() => operation(providerSymbol)), providerSymbol }; }
        catch (error) {
          lastError = error;
          if (attempt < 3) await sleep(120 * attempt);
        }
      }
    }
    throw lastError ?? new Error('PUBLIC_STOCK_PROVIDER_CANDIDATES_EMPTY');
  }

  const tasks = [];
  for (const entry of selected) {
    for (const timeframe of timeframes) tasks.push({ type: 'candles', entry, timeframe });
    tasks.push({ type: 'quote', entry });
  }
  await runPool(tasks, Number(input?.concurrency ?? 4), async (task) => {
    const ticker = normalizeTicker(task.entry.ticker);
    if (task.type === 'candles') {
      const key = `${ticker}|${task.timeframe}`;
      try {
        const resolved = await withFallback(task.entry, (providerSymbol) => yahoo.getCandles(providerSymbol, task.timeframe));
        candleCache.set(key, { ok: true, value: resolved.value, providerSymbol: resolved.providerSymbol });
      } catch (error) {
        candleCache.set(key, { ok: false, error });
        failures.push({ ticker, kind: `candles:${task.timeframe}`, reason: errorCode(error) });
      }
      return;
    }
    try {
      const resolved = await withFallback(task.entry, (providerSymbol) => yahoo.getQuote(providerSymbol));
      quoteCache.set(ticker, { ok: true, value: { ...resolved.value, ticker, symbol: ticker, name: task.entry.name ?? resolved.value?.name ?? ticker }, providerSymbol: resolved.providerSymbol });
    } catch (error) {
      quoteCache.set(ticker, { ok: false, error });
      failures.push({ ticker, kind: 'quote', reason: errorCode(error) });
    }
  });

  return Object.freeze({
    market,
    selectedCount: selected.length,
    timeframes: Object.freeze(timeframes),
    failures: Object.freeze(failures),
    async getCandles(ticker, timeframe) {
      const row = candleCache.get(`${normalizeTicker(ticker)}|${String(timeframe)}`);
      if (!row) throw new Error(`PUBLIC_STOCK_PREFETCH_MISS:CANDLES:${normalizeTicker(ticker)}:${String(timeframe)}`);
      if (!row.ok) throw row.error;
      return row.value;
    },
    async getQuote(ticker) {
      const row = quoteCache.get(normalizeTicker(ticker));
      if (!row) throw new Error(`PUBLIC_STOCK_PREFETCH_MISS:QUOTE:${normalizeTicker(ticker)}`);
      if (!row.ok) throw row.error;
      return row.value;
    },
  });
}
