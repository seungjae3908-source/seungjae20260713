import { readFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const root = path.basename(cwd) === 'api-server' ? path.resolve(cwd, '..') : path.resolve(cwd);
const source = await readFile(path.join(root, 'stock-analyzer/src/lib/unified-chart-data.ts'), 'utf8');

const assert = (condition, message) => {
  if (!condition) throw new Error(`[production-us-chart-priority] ${message}`);
};

const usBlock = source.match(/if \(input\.market === 'US'\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
const krBlock = source.match(/if \(input\.market === 'KR'\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';

assert(usBlock, 'US chart URL block is required');
assert(krBlock, 'KR chart URL block is required');

const usCandles = usBlock.indexOf('/candles?tf=');
const usChart = usBlock.indexOf('/chart?tf=');
assert(usCandles >= 0, 'US chart must include the bounded candle endpoint');
assert(usChart >= 0, 'US chart must preserve the enriched chart fallback endpoint');
assert(usCandles < usChart, 'US chart must request candles before the heavier enriched chart endpoint');

const krChart = krBlock.indexOf('/chart?tf=');
const krCandles = krBlock.indexOf('/candles?tf=');
assert(krChart >= 0 && krCandles >= 0, 'KR stock chart endpoints must remain available');
assert(krChart < krCandles, 'KR chart endpoint ordering must remain unchanged');

assert(source.includes("if (input.market === 'UPBIT')"), 'Upbit chart routing must remain explicit');
assert(source.includes('/api/crypto/spot/candles?'), 'Upbit public candle endpoint must remain unchanged');
assert(source.includes('/api/crypto/futures/candles?'), 'Bitget futures public candle endpoint must remain unchanged');
assert(source.includes('const DEFAULT_TIMEOUT_MS = 12_000;'), 'existing client timeout contract must remain unchanged');

console.log('Production US chart candle priority contract verified.');
console.log('- US stocks request the bounded candle endpoint before optional enriched chart fallback');
console.log('- KR stock endpoint ordering is unchanged');
console.log('- Upbit/Bitget public candle routing and client timeout remain unchanged');
