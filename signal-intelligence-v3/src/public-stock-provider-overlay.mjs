// Signal V3 read-only public STOCK overlay. ScannerProviderHealthTracker
// calls getCandlesMeta, not just getCandles: both must be intercepted to
// prevent bypassing the public-only Yahoo source through app/cache/private
// provider fallbacks. Every override is restored even if a scan throws.
const active = new WeakSet();

export async function withReadOnlyStockProviderOverlay({
  marketData, scannerUniverse, scannerMarket, targetUniverse,
  readPublicCandles, readPublicQuote, operation,
}) {
  if (!marketData || !scannerUniverse || !targetUniverse
    || typeof readPublicCandles !== 'function'
    || typeof readPublicQuote !== 'function'
    || typeof operation !== 'function')
    throw new Error('PUBLIC_STOCK_OVERLAY_INPUT_REQUIRED');
  if (active.has(marketData))
    throw new Error('PUBLIC_STOCK_OVERLAY_CONCURRENT');
  active.add(marketData);
  const originals = {
    getCandles: marketData.getCandles,
    getCandlesMeta: marketData.getCandlesMeta,
    getQuote: marketData.getQuote,
    getUniverse: scannerUniverse.get,
  };
  const entries = new Map((targetUniverse.entries ?? [])
    .map(row => [String(row.ticker ?? '').toUpperCase(), row]));
  try {
    marketData.getCandlesMeta = async (ticker, timeframe = '1D') => {
      const canonical = String(ticker ?? '').toUpperCase();
      const result = await readPublicCandles(canonical, timeframe, entries.get(canonical));
      const candles = Array.isArray(result) ? result : result?.candles;
      const provider = Array.isArray(result) ? 'yahoo-public' : result?.provider;
      if (!Array.isArray(candles) || !['yahoo-public', 'naver-public-dayCandle'].includes(provider))
        throw new Error('PUBLIC_STOCK_CANDLES_INVALID');
      return { candles, provider, fetchedAt: new Date().toISOString() };
    };
    marketData.getCandles = async (ticker, timeframe = '1D') =>
      (await marketData.getCandlesMeta(ticker, timeframe)).candles;
    marketData.getQuote = async (ticker) => {
      const canonical = String(ticker ?? '').toUpperCase();
      const entry = entries.get(canonical);
      const quote = await readPublicQuote(canonical, entry);
      if (!quote || typeof quote !== 'object')
        throw new Error('PUBLIC_STOCK_QUOTE_INVALID');
      return {
        ...quote, ticker: canonical, symbol: canonical,
        name: entry?.name ?? quote.name ?? canonical,
      };
    };
    scannerUniverse.get = async (market, signal, deadlineMs) =>
      market === scannerMarket
        ? targetUniverse
        : originals.getUniverse.call(scannerUniverse, market, signal, deadlineMs);
    return await operation();
  } finally {
    marketData.getCandles = originals.getCandles;
    marketData.getCandlesMeta = originals.getCandlesMeta;
    marketData.getQuote = originals.getQuote;
    scannerUniverse.get = originals.getUniverse;
    active.delete(marketData);
  }
}
