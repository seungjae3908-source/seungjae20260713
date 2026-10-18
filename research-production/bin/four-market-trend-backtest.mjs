#!/usr/bin/env node
// Four-market trend-following report (Korean). Research only, public data only.
//   node research-production/bin/four-market-trend-backtest.mjs --fetch <dir>
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { BitgetPublicClient } from '../../market-prediction-lab/src/bitget-public-client.js';
import { collectBitgetCandles } from '../../market-prediction-lab/src/bitget-candle-collector.js';
import { collectUpbitSpotHistory } from '../../market-prediction-lab/src/upbit-spot-history.js';
import { collectYahooStockHistory } from '../../market-prediction-lab/src/yahoo-stock-history.js';
import { fetchCombinationFundingRatesV1 } from '../src/combination-search-lane-v1.mjs';
import { FOUR_MARKET_UNIVERSE_V1, evaluateFourMarketV1, formatFourMarketReportKoV1 } from '../src/four-market-trend-backtest-v1.mjs';

const DAY = 86_400_000;
const END = Date.UTC(2026, 0, 1) - 3_600_000;
const CRYPTO_START = END - (820 * DAY);
const STOCK_START = Date.UTC(2016, 0, 1);

const args = process.argv.slice(2);
if (args[0] !== '--fetch') { process.stderr.write('usage: --fetch <dir>\n'); process.exit(2); }
const root = resolve(args[1] ?? 'four-market-state');
await mkdir(join(root, 'latest'), { recursive: true });
const cachePath = join(root, 'four-market-datasets.json');
let datasets = [];
try { datasets = JSON.parse(await readFile(cachePath, 'utf8')); } catch { datasets = []; }

if (!datasets.length) {
  const bitget = new BitgetPublicClient({ fetchImpl: globalThis.fetch });
  for (const [market, cfg] of Object.entries(FOUR_MARKET_UNIVERSE_V1)) {
    for (const symbol of cfg.symbols) {
      try {
        let candles = []; let fundingRates = [];
        if (market === 'CRYPTO_FUTURES') {
          candles = (await collectBitgetCandles({ client: bitget, market, symbol, timeframe: '1h', startTime: CRYPTO_START, endTime: END, maxCandles: 20_000, productType: 'usdt-futures' })).candles;
          try { fundingRates = (await fetchCombinationFundingRatesV1({ source: 'BITGET_1H', symbol, startTime: CRYPTO_START, endTime: END, fetchImpl: globalThis.fetch, minimumRecords: 0 })).rows; }
          catch (error) { process.stderr.write(`FUNDING_UNAVAILABLE:${symbol}:${String(error?.message ?? error).slice(0, 100)}\n`); }
        } else if (market === 'CRYPTO_SPOT') {
          candles = (await collectUpbitSpotHistory({ symbol, timeframe: '4h', startTime: CRYPTO_START, endTime: END, maxPages: 40, fetchImpl: globalThis.fetch })).candles;
        } else {
          candles = (await collectYahooStockHistory({ market, symbol, startTime: STOCK_START, endTime: END, fetchImpl: globalThis.fetch })).candles;
        }
        datasets.push({ market, symbol, candles: candles.map((c) => ({ timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 })), fundingRates });
        process.stderr.write(`FETCHED:${market}:${symbol}:${candles.length}\n`);
      } catch (error) {
        process.stderr.write(`FETCH_FAILED:${market}:${symbol}:${String(error?.message ?? error).slice(0, 160)}\n`);
      }
    }
  }
  await writeFile(cachePath, JSON.stringify(datasets));
}

const result = evaluateFourMarketV1({ datasets });
process.stdout.write(`${formatFourMarketReportKoV1(result)}\n`);
await writeFile(join(root, 'latest', 'four-market-trend-backtest-v1.json'), `${JSON.stringify({ contract: 'four-market-trend-backtest/v1', observedAt: new Date().toISOString(), ...result, executionAuthority: 'NONE', liveTrading: false })}\n`);
