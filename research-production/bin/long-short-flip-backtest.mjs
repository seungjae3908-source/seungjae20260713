#!/usr/bin/env node
// Long → confirmed weakness → short flip backtest reports (Korean). Research only.
//   node research-production/bin/long-short-flip-backtest.mjs [stateRoot]
//       reads the research server's cached Bitget 1h candles
//   node research-production/bin/long-short-flip-backtest.mjs --fetch <dir>
//       fetches public Bitget 1h candles and Bitget funding history into <dir> first
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { BitgetPublicClient } from '../../market-prediction-lab/src/bitget-public-client.js';
import { collectBitgetCandles } from '../../market-prediction-lab/src/bitget-candle-collector.js';
import { collectFundingRateHistory } from '../../market-prediction-lab/src/derivatives-history.js';
import { formatLongShortFlipReportKoV1, runLongShortFlipBacktestV1 } from '../src/long-short-flip-backtest-v1.mjs';
import { formatLongShortFlipReportKoV2, runLongShortFlipBacktestV2 } from '../src/long-short-flip-backtest-v2.mjs';

const FETCH_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT',
  'DOTUSDT', 'LTCUSDT', 'BCHUSDT', 'ATOMUSDT', 'NEARUSDT', 'UNIUSDT', 'AAVEUSDT', 'FILUSDT', 'APTUSDT', 'TRXUSDT',
  'SUIUSDT', 'PEPEUSDT', 'WIFUSDT', 'ARBUSDT', 'OPUSDT', 'INJUSDT', 'TIAUSDT', 'SEIUSDT'];
const DAY = 86_400_000;

const args = process.argv.slice(2);
let root;
if (args[0] === '--fetch') {
  root = resolve(args[1] ?? 'long-short-flip-state');
  const endTime = Date.UTC(2026, 0, 1) - 3_600_000;
  const startTime = endTime - (820 * DAY);
  const dir = join(root, 'combination-research', 'datasets', 'BITGET_1H');
  await mkdir(dir, { recursive: true });
  for (const symbol of FETCH_SYMBOLS) {
    try {
      const client = new BitgetPublicClient({ fetchImpl: globalThis.fetch });
      const history = await collectBitgetCandles({ client, market: 'CRYPTO_FUTURES',
        symbol, timeframe: '1h', startTime, endTime, maxCandles: 20_000, productType: 'usdt-futures' });
      // Bitget funding history directly; keep whatever pages it serves (coverage is reported).
      let fundingRates = [];
      try {
        const funding = await collectFundingRateHistory({ client, symbol, startTime, endTime, maxPages: 200 });
        fundingRates = funding.records.map((row) => ({ timestamp: row.timestamp, rate: row.rate }))
          .filter((row) => Number.isSafeInteger(row.timestamp) && Number.isFinite(row.rate)
            && row.timestamp >= startTime && row.timestamp <= endTime);
      } catch (error) {
        process.stderr.write(`FUNDING_UNAVAILABLE:${symbol}:${String(error?.message ?? error).slice(0, 120)}\n`);
      }
      await writeFile(join(dir, `${symbol}.json`), JSON.stringify({ symbol, candles: history.candles, fundingRates, fundingSource: 'BITGET' }));
      const first = fundingRates.length ? new Date(Math.min(...fundingRates.slice(0, 5000).map((r) => r.timestamp))).toISOString().slice(0, 10) : '-';
      process.stderr.write(`FETCHED:${symbol}:${history.candles.length}:funding=${fundingRates.length}:from=${first}\n`);
    } catch (error) {
      process.stderr.write(`FETCH_FAILED:${symbol}:${String(error?.message ?? error).slice(0, 160)}\n`);
    }
  }
} else {
  root = resolve(args[0] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production');
}
const v1 = await runLongShortFlipBacktestV1({ stateRoot: root });
process.stdout.write(`${formatLongShortFlipReportKoV1(v1)}\n\n`);
const v2 = await runLongShortFlipBacktestV2({ stateRoot: root });
process.stdout.write(`${formatLongShortFlipReportKoV2(v2)}\n`);
