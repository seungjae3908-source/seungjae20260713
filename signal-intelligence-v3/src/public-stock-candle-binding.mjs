/** Isolated public-only Signal V3 source binding.
 * The real Stock Scanner reads getCandlesMeta through its provider health
 * wrapper. Replacing getCandles alone silently misses that call path.
 * This helper never issues requests itself and always restores both methods.
 */
export function bindPublicStockCandleSource(service, fetchCandles, { now = Date.now } = {}) {
  if (!service || typeof service.getCandles !== 'function'
    || typeof service.getCandlesMeta !== 'function'
    || typeof fetchCandles !== 'function' || typeof now !== 'function') {
    throw new TypeError('PUBLIC_STOCK_BINDING_INVALID');
  }
  const previousCandles = service.getCandles;
  const previousMeta = service.getCandlesMeta;
  const candles = async (ticker, timeframe = '1D') => {
    const result = await fetchCandles(ticker, timeframe);
    // Do not convert empty or failed public data into apparently valid bars;
    // the existing health and quality gates must inspect the actual result.
    if (!Array.isArray(result)) throw new TypeError('PUBLIC_STOCK_CANDLES_INVALID');
    return result;
  };
  service.getCandles = candles;
  service.getCandlesMeta = async (ticker, timeframe = '1D') => ({
    candles: await candles(ticker, timeframe),
    provider: 'yahoo-public',
    fetchedAt: new Date(now()).toISOString(),
  });
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    service.getCandles = previousCandles;
    service.getCandlesMeta = previousMeta;
  };
}
