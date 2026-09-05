import { readFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const root = path.basename(cwd) === 'api-server' ? path.resolve(cwd, '..') : path.resolve(cwd);
const source = await readFile(path.join(root, 'stock-analyzer/src/lib/unified-chart-data.ts'), 'utf8');
const marketDataSource = await readFile(path.join(root, 'api-server/src/services/market-data.service.ts'), 'utf8');

const assert = (condition, message) => {
  if (!condition) throw new Error(`[production-stock-chart-priority] ${message}`);
};

const stockBlock = source.match(/if \(input\.market === 'US' \|\| input\.market === 'KR'\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
assert(stockBlock, 'shared US/KR stock chart URL block is required');

const stockCandles = stockBlock.indexOf('/candles?tf=');
const stockChart = stockBlock.indexOf('/chart?tf=');
assert(stockCandles >= 0, 'stock chart must include the bounded candle endpoint');
assert(stockChart >= 0, 'stock chart must preserve the enriched chart fallback endpoint');
assert(stockCandles < stockChart, 'US/KR stock charts must request candles before the heavier enriched chart endpoint');

assert(source.includes("if (input.market === 'UPBIT')"), 'Upbit chart routing must remain explicit');
assert(source.includes('/api/crypto/spot/candles?'), 'Upbit public candle endpoint must remain unchanged');
assert(source.includes('/api/crypto/futures/candles?'), 'Bitget futures public candle endpoint must remain unchanged');
assert(source.includes('const DEFAULT_TIMEOUT_MS = 12_000;'), 'existing client timeout contract must remain unchanged');
assert(source.includes('const PRIMARY_STOCK_ENDPOINT_TIMEOUT_MS = 2_500;'), 'bounded primary stock endpoint timeout must remain explicit');

assert(
  /INSUFFICIENT_CANDLES\|차트 데이터가 부족/.test(marketDataSource),
  'KR bounded provider must classify both canonical and Korean insufficient-candle failures',
);
assert(
  marketDataSource.includes("reason: kiwoomFailure ?? 'HEDGE_WON_BEFORE_KIWOOM_TERMINAL'"),
  'Yahoo hedge success must preserve Kiwoom fallback provenance',
);
assert(
  /if \(isBoundedKrIntradayRequest\(ticker, timeframe\)\) \{\s*return getBoundedKrIntradayCandlesMeta\(ticker, timeframe\);\s*\}/.test(marketDataSource),
  'bounded KR intraday requests must never re-enter deep Kiwoom history',
);

console.log('Production stock chart candle priority contract verified.');
console.log('- US and KR stocks request the bounded candle endpoint before optional enriched chart fallback');
console.log('- KR bounded fallback keeps insufficient-data classification and public hedge provenance');
console.log('- Upbit/Bitget public candle routing is unchanged');
console.log('- existing total client timeout and bounded primary stock endpoint timeout are preserved');