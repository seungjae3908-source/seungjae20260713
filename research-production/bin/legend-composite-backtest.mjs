#!/usr/bin/env node
// Legend-trader composite portfolio backtest (Korean report). Research only, public data only.
//   node research-production/bin/legend-composite-backtest.mjs --out <dir>
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { evaluateLegendCompositeV1, formatLegendCompositeReportKoV1 } from '../src/legend-composite-v1.mjs';
import { INTRADAY_PERP_SYMBOLS_V1, KLINE_END as END, binanceFunding, binanceKlines, upbitHourly, upbitTopMarkets } from '../src/public-kline-fetch-v1.mjs';

const args = process.argv.slice(2);
if (args[0] !== '--out') { process.stderr.write('usage: --out <dir>\n'); process.exit(2); }
const root = resolve(args[1] ?? 'legend-state');
await mkdir(root, { recursive: true });
const only = (process.env.LEGEND_VENUES ?? '').split(',').filter(Boolean);
const want = (v) => !only.length || only.includes(v);
const results = [];

if (want('PERP_1H')) {
  const from = Date.UTC(2021, 0, 1); const datasets = [];
  for (const symbol of INTRADAY_PERP_SYMBOLS_V1) {
    try {
      const candles = await binanceKlines(symbol, '1h', 2020, 11); // 2 months warm-up for the 50-day regime EMA
      const fundingRates = await binanceFunding(symbol, 2020);
      if (candles.length < 3000) throw new Error(`SHORT_HISTORY_${candles.length}`);
      datasets.push({ symbol, candles, fundingRates });
      process.stderr.write(`FETCHED:PERP_1H:${symbol}:${candles.length}:funding=${fundingRates.length}\n`);
    } catch (e) { process.stderr.write(`FETCH_FAILED:PERP_1H:${symbol}:${String(e?.message ?? e).slice(0, 100)}\n`); }
  }
  const span = { from, to: END };
  results.push(evaluateLegendCompositeV1({ venue: 'PERP_1H', datasets, span, splitTime: span.from + ((span.to - span.from) * 0.6) }));
  process.stderr.write('EVALUATED:PERP_1H\n');
}

if (want('UPBIT_1H')) {
  const from = Date.UTC(2022, 0, 1); const datasets = [];
  let markets = [];
  try { markets = await upbitTopMarkets(60); } catch (e) { process.stderr.write(`UPBIT_TOP_FAILED:${e.message}\n`); }
  if (!markets.includes('KRW-BTC')) markets.unshift('KRW-BTC');
  for (const market of markets) {
    try {
      const { bars } = await upbitHourly(market, Date.UTC(2021, 10, 1));
      if (bars.length < 2000) throw new Error(`SHORT_HISTORY_${bars.length}`);
      datasets.push({ symbol: market, candles: bars });
      process.stderr.write(`FETCHED:UPBIT_1H:${market}:${bars.length}\n`);
    } catch (e) { process.stderr.write(`FETCH_FAILED:UPBIT_1H:${market}:${String(e?.message ?? e).slice(0, 100)}\n`); }
  }
  const span = { from, to: END };
  results.push(evaluateLegendCompositeV1({ venue: 'UPBIT_1H', datasets, span, splitTime: span.from + ((span.to - span.from) * 0.6) }));
  process.stderr.write('EVALUATED:UPBIT_1H\n');
}

process.stdout.write(`${formatLegendCompositeReportKoV1(results)}\n`);
await writeFile(join(root, 'legend-composite-v1.json'), `${JSON.stringify({ contract: 'legend-composite/v1', observedAt: new Date().toISOString(), venues: results, executionAuthority: 'NONE', liveTrading: false })}\n`);
