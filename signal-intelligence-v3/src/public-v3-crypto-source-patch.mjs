/** Pure, exact-marker V3-only bundler transform. NEVER edit the shared
 * scanner or the authoritative Paper runtime package.
 */
const CURSOR='      const cursor = Math.max(0, Math.min(universe.rows.length, Math.floor(request.cursor) || 0));';
const PAGE='      const batch = universe.rows.slice(cursor, cursor + batchSize);';
const REPLACEMENT=`      // Public V3 pagination is stable, without changing regular member/Paper.
      const publicV3Rows = request.memberId === 'signal-intelligence-v3-public-only'
        ? stablePublicV3CryptoRows(universe.rows) : universe.rows;
      const cursor = Math.max(0, Math.min(publicV3Rows.length, Math.floor(request.cursor) || 0));
      const batch = request.memberId === 'signal-intelligence-v3-public-only'
        ? prioritizeV3CurrentCryptoPage(publicV3Rows.slice(cursor, cursor + batchSize),request.market)
        : publicV3Rows.slice(cursor, cursor + batchSize);`;
const UPBIT_OLD="      const rows = await fetchJson<UpbitCandleRow[]>(`${UPBIT_BASE}${spotCandlePath(symbol, timeframe)}`, signal);\n      return normalizeCandles(rows.map((row) => ({\n        time: finite(row.timestamp) ?? Date.parse(text(row.candle_date_time_utc)),\n        open: finite(row.opening_price) ?? Number.NaN,\n        high: finite(row.high_price) ?? Number.NaN,\n        low: finite(row.low_price) ?? Number.NaN,\n        close: finite(row.trade_price) ?? Number.NaN,\n        volume: finite(row.candle_acc_trade_volume) ?? Number.NaN,\n        quoteVolume: finite(row.candle_acc_trade_price),\n      })), Date.now());";
const UPBIT_NEW="      const rows = await fetchJson<UpbitCandleRow[]>(`${UPBIT_BASE}${spotCandlePath(symbol, timeframe)}`, signal);\n      // V3-bundle only: canonical UTC open, closed bars, strict OHLC.\n      return normalizeV3UpbitCandles(rows, {symbol, timeframe, nowMs: Date.now()});";
const CRYPTO_BUDGET_ORIGINAL="const DEADLINE_MS = 12_000;\nconst ITEM_TIMEOUT_MS = 3_500;";
const CRYPTO_BUDGET_V3="// V3-only: allow paced public Upbit requests to complete without early item abort.\nconst DEADLINE_MS = 16_000;\nconst ITEM_TIMEOUT_MS = 5_000;";
export function patchV3CryptoScannerSource(source){
  const original=CURSOR+'\n'+PAGE;
  if(typeof source!=='string'||source.split(original).length!==2
    ||source.split(UPBIT_OLD).length!==2
    ||source.split(CRYPTO_BUDGET_ORIGINAL).length!==2
    ||source.includes('stablePublicV3CryptoRows')
    ||source.includes('normalizeV3UpbitCandles')
    ||source.includes('prioritizeV3CurrentCryptoPage')
    ||!source.includes('export function createCryptoSignalScannerService('))
    throw new Error('PUBLIC_V3_CRYPTO_SCANNER_BUILD_CONTRACT_INVALID');
  const imp="import {stablePublicV3CryptoRows} from '../../../signal-intelligence-v3/src/public-v3-crypto-ordered-page.mjs';\n"+
  "import {normalizeV3UpbitCandles} from '../../../signal-intelligence-v3/src/public-v3-upbit-candles.mjs';\n"+
  "import {prioritizeV3CurrentCryptoPage} from '../../../signal-intelligence-v3/src/public-watch-v3-priority.mjs';\n";
  return imp+source.replace(original,REPLACEMENT)
    .replace(UPBIT_OLD,UPBIT_NEW)
    .replace(CRYPTO_BUDGET_ORIGINAL,CRYPTO_BUDGET_V3);
}
