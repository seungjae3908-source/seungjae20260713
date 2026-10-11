// Public-only research adapter. Intercept the metadata path actually consumed
// by ScannerProviderHealthTracker, not only the legacy candles convenience API.
export async function withPublicStockProvider({ marketData, yahoo, entries, market }, operation) {
  const original = { getCandles: marketData.getCandles, getCandlesMeta: marketData.getCandlesMeta, getQuote: marketData.getQuote };
  const entryByTicker = new Map(entries.map(entry => [String(entry.ticker).toUpperCase(), entry]));
  const providerSymbol = ticker => {
    const clean = String(ticker ?? '').trim().toUpperCase();
    if (!clean) throw new Error('PUBLIC_STOCK_SYMBOL_EMPTY');
    if (market === 'KR_STOCK' && /^\d{6}$/u.test(clean)) {
      const exchange = String(entryByTicker.get(clean)?.exchange ?? '').toUpperCase();
      if (!/KOSPI|KOSDAQ|코스피|코스닥/u.test(exchange)) throw new Error('PUBLIC_KR_EXCHANGE_MAPPING_UNAVAILABLE');
      return `${clean}.${/KOSDAQ|코스닥/u.test(exchange) ? 'KQ' : 'KS'}`;
    }
    return market === 'US_STOCK' && /^[A-Z0-9]+\.[A-Z0-9]+$/u.test(clean) ? clean.replace(/\./gu, '-') : clean;
  };
  marketData.getCandlesMeta = async (ticker, timeframe = '1D', options = {}) => ({
    candles: await yahoo.getCandles(providerSymbol(ticker), timeframe, { ...options, purpose: 'scanner' }),
    provider: 'yahoo', fetchedAt: new Date().toISOString(),
  });
  marketData.getCandles = async (ticker, timeframe = '1D', options = {}) => (await marketData.getCandlesMeta(ticker, timeframe, options)).candles;
  marketData.getQuote = async (ticker, options = {}) => {
    const clean = String(ticker).toUpperCase();
    const entry = entryByTicker.get(clean);
    const quote = await yahoo.getQuote(providerSymbol(clean), options);
    return { ...quote, ticker: clean, symbol: clean, name: entry?.name ?? quote.name ?? clean };
  };
  try { return await operation(); }
  finally { Object.assign(marketData, original); }
}
