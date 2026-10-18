#!/usr/bin/env node
// BTC/ETH long-short trend pilot backtest report (Korean). Research only.
//   node research-production/bin/trend-pilot-backtest.mjs [stateRoot]
//       reads the research server's cached Bitget candles
//   node research-production/bin/trend-pilot-backtest.mjs --fetch <dir>
//       fetches public Bitget candles (and funding where reachable) into <dir> first
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { BitgetPublicClient } from '../../market-prediction-lab/src/bitget-public-client.js';
import { collectBitgetCandles } from '../../market-prediction-lab/src/bitget-candle-collector.js';
import { fetchCombinationFundingRatesV1 } from '../src/combination-search-lane-v1.mjs';
import { formatTrendPilotReportKoV1, runTrendPilotBacktestV1 } from '../src/trend-pilot-backtest-v1.mjs';

const FETCH_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT'];
const DAY = 86_400_000;

const args = process.argv.slice(2);
let root;
if (args[0] === '--fetch') {
  root = resolve(args[1] ?? 'trend-pilot-state');
  const endTime = Date.UTC(2026, 0, 1) - 3_600_000;
  const startTime = endTime - (820 * DAY);
  const dir = join(root, 'combination-research', 'datasets', 'BITGET_1H');
  await mkdir(dir, { recursive: true });
  for (const symbol of FETCH_SYMBOLS) {
    try {
      const history = await collectBitgetCandles({ client: new BitgetPublicClient({ fetchImpl: globalThis.fetch }), market: 'CRYPTO_FUTURES',
        symbol, timeframe: '1h', startTime, endTime, maxCandles: 20_000, productType: 'usdt-futures' });
      let funding = { rows: [], fundingSource: null };
      try { funding = await fetchCombinationFundingRatesV1({ source: 'BITGET_1H', symbol, startTime, endTime, fetchImpl: globalThis.fetch, minimumRecords: 0 }); }
      catch (error) { process.stderr.write(`FUNDING_UNAVAILABLE:${symbol}:${String(error?.message ?? error).slice(0, 120)}\n`); }
      await writeFile(join(dir, `${symbol}.json`), JSON.stringify({ symbol, candles: history.candles, fundingRates: funding.rows, fundingSource: funding.fundingSource }));
      process.stderr.write(`FETCHED:${symbol}:${history.candles.length}:funding=${funding.rows.length}\n`);
    } catch (error) {
      process.stderr.write(`FETCH_FAILED:${symbol}:${String(error?.message ?? error).slice(0, 160)}\n`);
    }
  }
} else {
  root = resolve(args[0] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production');
}
const result = await runTrendPilotBacktestV1({ stateRoot: root });
process.stdout.write(`${formatTrendPilotReportKoV1(result)}\n`);
