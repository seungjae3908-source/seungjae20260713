#!/usr/bin/env node
// Intraday scalp / pump-catching backtest (Korean report). Research only, public data only.
//   node research-production/bin/intraday-scalp-backtest.mjs --out <dir>
// Data (all before 2026):
//   perpetual 5m 2023–2025 and 1h 2021–2025: Binance USDⓈ-M public kline archive
//     (data.binance.vision) as the price proxy for Bitget perps (same coins, arbitraged within bps)
//   Upbit KRW spot 1h 2022–2025: Upbit public minute-candle API, top KRW markets by traded value
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { INTRADAY_PERP_SYMBOLS_V1, KLINE_END as END, binanceKlines, upbitHourly, upbitTopMarkets } from '../src/public-kline-fetch-v1.mjs';
import { createIntradayAccumulatorV1, formatIntradayReportKoV1 } from '../src/intraday-scalp-zoo-v1.mjs';

const args = process.argv.slice(2);
if (args[0] !== '--out') { process.stderr.write('usage: --out <dir>\n'); process.exit(2); }
const root = resolve(args[1] ?? 'intraday-state');
await mkdir(root, { recursive: true });
const only = (process.env.INTRADAY_VENUES ?? '').split(',').filter(Boolean);
const want = (v) => !only.length || only.includes(v);
const results = [];

const PLAN = [
  { venue: 'BITGET_5M', interval: '5m', fromYear: 2023, from: Date.UTC(2023, 0, 1) },
  { venue: 'BITGET_1H', interval: '1h', fromYear: 2021, from: Date.UTC(2021, 0, 1) },
];
for (const p of PLAN) {
  if (!want(p.venue)) continue;
  const acc = createIntradayAccumulatorV1(p.venue);
  for (const symbol of INTRADAY_PERP_SYMBOLS_V1) {
    try {
      const candles = await binanceKlines(symbol, p.interval, p.fromYear);
      if (candles.length < 2000) throw new Error(`SHORT_HISTORY_${candles.length}`);
      acc.add({ symbol, candles });
      process.stderr.write(`FETCHED:${p.venue}:${symbol}:${candles.length}\n`);
    } catch (e) { process.stderr.write(`FETCH_FAILED:${p.venue}:${symbol}:${String(e?.message ?? e).slice(0, 100)}\n`); }
  }
  const span = { from: p.from, to: END };
  results.push(acc.finish({ span, splitTime: span.from + ((span.to - span.from) * 0.6) }));
}

if (want('UPBIT_1H')) {
  const from = Date.UTC(2022, 0, 1); const acc = createIntradayAccumulatorV1('UPBIT_1H');
  let markets = [];
  try { markets = await upbitTopMarkets(60); } catch (e) { process.stderr.write(`UPBIT_TOP_FAILED:${e.message}\n`); }
  for (const market of markets) {
    try {
      const { bars, listedInWindow } = await upbitHourly(market, from);
      if (bars.length < 500) throw new Error(`SHORT_HISTORY_${bars.length}`);
      acc.add({ symbol: market, candles: bars, listedInWindow });
      process.stderr.write(`FETCHED:UPBIT_1H:${market}:${bars.length}:listed=${listedInWindow}\n`);
    } catch (e) { process.stderr.write(`FETCH_FAILED:UPBIT_1H:${market}:${String(e?.message ?? e).slice(0, 100)}\n`); }
  }
  const span = { from, to: END };
  results.push(acc.finish({ span, splitTime: span.from + ((span.to - span.from) * 0.6) }));
}

process.stdout.write(`${formatIntradayReportKoV1(results)}\n`);
await writeFile(join(root, 'intraday-scalp-v1.json'), `${JSON.stringify({ contract: 'intraday-scalp-zoo/v1', observedAt: new Date().toISOString(), venues: results, executionAuthority: 'NONE', liveTrading: false })}\n`);
