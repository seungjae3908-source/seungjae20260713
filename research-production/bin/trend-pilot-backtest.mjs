#!/usr/bin/env node
// BTC/ETH long-short trend pilot backtest report (Korean). Research only.
//   node research-production/bin/trend-pilot-backtest.mjs [stateRoot]
//       reads the research server's cached Bitget candles
//   node research-production/bin/trend-pilot-backtest.mjs --fetch <dir>
//       fetches public Bitget candles (and funding where reachable) into <dir> first
//   node research-production/bin/trend-pilot-backtest.mjs --fetch-long <dir>
//       long-history check: Binance USDⓈ-M public archive (data.binance.vision) 1h candles and
//       funding from 2020-06 (Bitget serves ~820 days of 1h); same rules, same engine
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { BitgetPublicClient } from '../../market-prediction-lab/src/bitget-public-client.js';
import { collectBitgetCandles } from '../../market-prediction-lab/src/bitget-candle-collector.js';
import { fetchCombinationFundingRatesV1 } from '../src/combination-search-lane-v1.mjs';
import { evaluateAggressiveSleeveV1, formatAggressiveSleeveKoV1 } from '../src/aggressive-sleeve-backtest-v1.mjs';
import { formatTrendPilotReportKoV1, runTrendPilotBacktestV1 } from '../src/trend-pilot-backtest-v1.mjs';

const FETCH_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT',
  'DOTUSDT', 'LTCUSDT', 'BCHUSDT', 'ATOMUSDT', 'NEARUSDT', 'UNIUSDT', 'AAVEUSDT', 'FILUSDT', 'APTUSDT', 'TRXUSDT'];
const DAY = 86_400_000;

async function binanceArchive(symbol, kind, fromYear, fromMonth) {
  const { execFileSync } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'bv-')); const rows = [];
  try {
    for (let y = fromYear; y <= 2025; y += 1) for (let m = (y === fromYear ? fromMonth : 1); m <= 12; m += 1) {
      const mm = String(m).padStart(2, '0');
      const url = kind === 'klines'
        ? `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/1h/${symbol}-1h-${y}-${mm}.zip`
        : `https://data.binance.vision/data/futures/um/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${y}-${mm}.zip`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) }); if (!res.ok) continue;
        const file = join(dir, `${y}${mm}.zip`); await writeFile(file, Buffer.from(await res.arrayBuffer()));
        for (const line of execFileSync('unzip', ['-p', file], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).split(/\r?\n/u)) {
          const f = line.split(','); let ts = Number(f[0]); if (!Number.isSafeInteger(ts)) continue; if (ts > 1e14) ts = Math.floor(ts / 1000);
          if (kind === 'klines') { const [o, h, l, c, v] = f.slice(1, 6).map(Number); if ([o, h, l, c].every((x) => x > 0)) rows.push({ timestamp: ts, open: o, high: Math.max(o, h, c), low: Math.min(o, l, c), close: c, volume: v || 0 }); }
          else { const r = Number(f[2]); if (Number.isFinite(r)) rows.push({ timestamp: ts, rate: r }); }
        }
      } catch { /* missing month */ }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
  rows.sort((a, b) => a.timestamp - b.timestamp);
  return rows.filter((r, i) => i === 0 || r.timestamp !== rows[i - 1].timestamp);
}

const args = process.argv.slice(2);
let root;
if (args[0] === '--fetch-long') {
  root = resolve(args[1] ?? 'trend-pilot-state');
  const dir = join(root, 'combination-research', 'datasets', 'BITGET_1H');
  await mkdir(dir, { recursive: true });
  for (const symbol of FETCH_SYMBOLS) {
    try {
      const candles = (await binanceArchive(symbol, 'klines', 2020, 6)).filter((c) => c.timestamp < Date.UTC(2026, 0, 1));
      const fundingRates = await binanceArchive(symbol, 'funding', 2020, 6);
      await writeFile(join(dir, `${symbol}.json`), JSON.stringify({ symbol, candles, fundingRates, fundingSource: 'BINANCE_VISION_PROXY' }));
      process.stderr.write(`FETCHED:${symbol}:${candles.length}:funding=${fundingRates.length}:from=${candles[0] ? new Date(candles[0].timestamp).toISOString().slice(0, 10) : '-'}\n`);
    } catch (error) { process.stderr.write(`FETCH_FAILED:${symbol}:${String(error?.message ?? error).slice(0, 160)}\n`); }
  }
} else if (args[0] === '--fetch') {
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
process.stdout.write(`${formatTrendPilotReportKoV1(result)}\n\n`);

// Aggressive sleeve (max 10% of the account) on the same cached candles.
const datasetDir = join(root, 'combination-research', 'datasets', 'BITGET_1H');
const datasets = [];
for (const name of (await readdir(datasetDir).catch(() => [])).filter((n) => n.endsWith('.json') && !n.endsWith('.failure.json')).sort()) {
  const cached = JSON.parse(await readFile(join(datasetDir, name), 'utf8'));
  const candles = (cached.candles ?? []).filter((c) => c.timestamp < Date.UTC(2026, 0, 1));
  if (candles.length >= 400) datasets.push({ symbol: cached.symbol ?? name.replace(/\.json$/u, ''), candles, fundingRates: (cached.fundingRates ?? []).filter((r) => r.timestamp < Date.UTC(2026, 0, 1)) });
}
if (datasets.length) {
  const sleeve = evaluateAggressiveSleeveV1({ datasets });
  process.stdout.write(`${formatAggressiveSleeveKoV1(sleeve)}\n`);
  await writeFile(join(root, 'latest', 'aggressive-sleeve-backtest-v1.json'), `${JSON.stringify({ contract: 'aggressive-sleeve-backtest/v1', observedAt: new Date().toISOString(), symbols: datasets.map((d) => d.symbol), variants: sleeve, executionAuthority: 'NONE', liveTrading: false })}\n`);
}
