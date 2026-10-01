import { yahooStockProviderCandidates } from '../../../market-prediction-lab/src/yahoo-stock-history.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 729 * DAY_MS;
const DEFAULT_TIMEOUT_MS = 20_000;

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function linkedSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('YAHOO_STOCK_60M_TIMEOUT')), timeoutMs);
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}
async function fetchJson(fetchImpl, url, signal, timeoutMs) {
  const linked = linkedSignal(signal, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: linked.signal,
      headers: {
        accept: 'application/json,text/plain,*/*',
        'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) MoveHunterResearch/1.0',
      },
    });
    if (!response.ok) {
      const error = Object.assign(new Error('YAHOO_STOCK_60M_HTTP_' + response.status), {
        status: response.status,
      });
      throw error;
    }
    return response.json();
  } finally {
    linked.clear();
  }
}
function parseCandles(result, startTime, endTime) {
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0];
  if (!quote) return [];
  const rows = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestampSeconds = finite(timestamps[index]);
    const open = finite(quote.open?.[index]);
    const high = finite(quote.high?.[index]);
    const low = finite(quote.low?.[index]);
    const close = finite(quote.close?.[index]);
    const volume = finite(quote.volume?.[index]);
    const timestamp = timestampSeconds == null ? null : timestampSeconds * 1000;
    if (timestamp == null || timestamp < startTime || timestamp > endTime) continue;
    if ([open, high, low, close, volume].some((value) => value == null)) continue;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) continue;
    if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) continue;
    rows.push(Object.freeze({ timestamp, open, high, low, close, volume }));
  }
  const byTimestamp = new Map(rows.map((row) => [row.timestamp, row]));
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
}

export async function collectYahooStock60mHistory(raw = {}) {
  const market = String(raw.market ?? '').toUpperCase();
  const symbol = String(raw.symbol ?? '').trim().toUpperCase();
  const endTime = Number(raw.endTime ?? Date.now());
  const startTime = Number(raw.startTime ?? endTime - 365 * DAY_MS);
  const timeoutMs = Number(raw.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetchImpl = raw.fetchImpl ?? globalThis.fetch;

  if (!['KR_STOCK', 'US_STOCK'].includes(market)) throw new TypeError('market must be KR_STOCK or US_STOCK');
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime <= 0 || endTime <= startTime) {
    throw new TypeError('invalid 60m stock history range');
  }
  if (endTime - startTime > MAX_RANGE_MS) throw new RangeError('YAHOO_STOCK_60M_RANGE_EXCEEDS_729_DAYS');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new RangeError('timeoutMs invalid');

  const candidates = yahooStockProviderCandidates(market, symbol);
  const query = [
    'period1=' + Math.floor(startTime / 1000),
    'period2=' + Math.ceil(endTime / 1000),
    'interval=60m',
    'events=history',
    'includeAdjustedClose=true',
    'includePrePost=false',
  ].join('&');
  const failures = [];

  for (const providerSymbol of candidates) {
    const encoded = encodeURIComponent(providerSymbol);
    for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
      const url = 'https://' + host + '/v8/finance/chart/' + encoded + '?' + query;
      try {
        const payload = await fetchJson(fetchImpl, url, raw.signal, timeoutMs);
        const chartError = payload?.chart?.error;
        if (chartError) throw new Error('YAHOO_STOCK_60M_CHART_ERROR:' + (chartError.code ?? chartError.description ?? 'UNKNOWN'));
        const candles = parseCandles(payload?.chart?.result?.[0], startTime, endTime);
        if (candles.length < 120) throw new Error('YAHOO_STOCK_60M_INSUFFICIENT_' + candles.length);
        return Object.freeze({
          schemaVersion: 1,
          market,
          symbol,
          providerSymbol,
          timeframe: '60m',
          source: 'yahoo-public-chart-60m',
          requestedStartTime: startTime,
          requestedEndTime: endTime,
          candleCount: candles.length,
          firstTimestamp: candles[0].timestamp,
          lastTimestamp: candles.at(-1).timestamp,
          candles: Object.freeze(candles),
          historicalReplayOnly: true,
          canonicalProviderAuthority: false,
          economicSampleCredit: 0,
          executionAuthority: 'NONE',
        });
      } catch (error) {
        if (raw.signal?.aborted) throw error;
        failures.push(providerSymbol + ':' + (error instanceof Error ? error.message : String(error)));
      }
    }
  }
  throw new Error('YAHOO_STOCK_60M_HISTORY_FAILED:' + symbol + ':' + failures.join('|'));
}
