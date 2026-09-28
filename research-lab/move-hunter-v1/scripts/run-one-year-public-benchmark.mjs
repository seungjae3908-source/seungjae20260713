import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  collectYahooStockHistory,
} from '../../../market-prediction-lab/src/yahoo-stock-history.js';
import {
  collectUpbitSpotHistory,
} from '../../../market-prediction-lab/src/upbit-spot-history.js';
import {
  BinanceFuturesPublicClient,
  collectBinanceFuturesDailyKlines,
  collectBinanceFuturesFundingRates,
} from '../../../market-prediction-lab/src/binance-futures-history.js';
import {
  ONE_YEAR_BENCHMARK_END_MS,
  ONE_YEAR_BENCHMARK_START_MS,
  runFourMarketOneYearBenchmark,
} from '../src/one-year-benchmark.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const WARMUP_START_MS = ONE_YEAR_BENCHMARK_START_MS - 140 * DAY_MS;

const STOCKS = Object.freeze([
  { market: 'KR_STOCK', symbol: '005930' },
  { market: 'KR_STOCK', symbol: '000660' },
  { market: 'US_STOCK', symbol: 'AAPL' },
  { market: 'US_STOCK', symbol: 'NVDA' },
]);
const SPOT = Object.freeze(['BTC', 'ETH']);
const FUTURES = Object.freeze(['BTCUSDT', 'ETHUSDT']);

function pct(value) {
  return value == null || !Number.isFinite(value) ? '-' : (value * 100).toFixed(2) + '%';
}
function num(value) {
  return value == null || !Number.isFinite(value) ? '-' : value.toFixed(3);
}
function rowForMarket(name, row) {
  return [
    name,
    pct(row.baseline.totalReturn),
    row.baseline.tradeCount,
    pct(row.baseline.maximumDrawdown),
    num(row.baseline.profitFactor),
    pct(row.improved.totalReturn),
    row.improved.tradeCount,
    pct(row.improved.maximumDrawdown),
    num(row.improved.profitFactor),
  ];
}
function markdown(result, failures, datasetCount) {
  const lines = [
    '# Move Hunter — 1Y Four-Market Public Benchmark',
    '',
    '- Window: ' + new Date(result.startTime).toISOString() + ' ~ ' + new Date(result.endTime).toISOString(),
    '- Dataset count: ' + datasetCount,
    '- Status: ' + result.status,
    '- Historical replay only: true',
    '- Profitability claim allowed: false',
    '- Replit: not used',
    '',
    '| Market | Baseline return | B trades | B MDD | B PF | Improved return | I trades | I MDD | I PF |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [market, row] of Object.entries(result.markets)) {
    lines.push('| ' + rowForMarket(market, row).join(' | ') + ' |');
  }
  lines.push(
    '',
    '## Evidence boundary',
    '',
    '- Full point-in-time historical universe: NOT PROVEN',
    '- Canonical full cost: NOT PROVEN',
    '- News/disclosure one-year PIT archive: NOT AVAILABLE',
    '- Historical AI decision packet: NOT RUN',
    '- OOS/economic credit: 0',
    '',
    '## Provider failures',
    '',
  );
  if (!failures.length) lines.push('- none');
  else for (const item of failures) lines.push('- ' + item.market + '/' + item.symbol + ': ' + item.error);
  return lines.join('\n') + '\n';
}

async function collectStocks(datasets, failures) {
  for (const item of STOCKS) {
    try {
      const history = await collectYahooStockHistory({
        market: item.market,
        symbol: item.symbol,
        startTime: WARMUP_START_MS,
        endTime: ONE_YEAR_BENCHMARK_END_MS,
        timeoutMs: 20_000,
      });
      datasets.push({
        market: item.market,
        symbol: item.symbol,
        timeframe: '1d',
        source: history.source,
        candles: history.candles,
      });
    } catch (error) {
      failures.push({
        market: item.market,
        symbol: item.symbol,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function collectSpot(datasets, failures) {
  for (const symbol of SPOT) {
    try {
      const history = await collectUpbitSpotHistory({
        symbol,
        timeframe: '4h',
        startTime: WARMUP_START_MS,
        endTime: ONE_YEAR_BENCHMARK_END_MS,
        minIntervalMs: 140,
        maxPages: 50,
      });
      datasets.push({
        market: 'CRYPTO_SPOT',
        symbol,
        timeframe: '4h',
        source: history.source,
        candles: history.candles,
      });
    } catch (error) {
      failures.push({
        market: 'CRYPTO_SPOT',
        symbol,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function collectFutures(datasets, failures) {
  const client = new BinanceFuturesPublicClient({ timeoutMs: 20_000, maxRetries: 4 });
  for (const symbol of FUTURES) {
    try {
      const [history, funding] = await Promise.all([
        collectBinanceFuturesDailyKlines({
          client,
          symbol,
          startTime: WARMUP_START_MS,
          endTime: ONE_YEAR_BENCHMARK_END_MS,
        }),
        collectBinanceFuturesFundingRates({
          client,
          symbol,
          startTime: WARMUP_START_MS,
          endTime: ONE_YEAR_BENCHMARK_END_MS,
        }),
      ]);
      datasets.push({
        market: 'CRYPTO_FUTURES',
        symbol,
        timeframe: '1d',
        source: history.provider,
        candles: history.candles,
        fundingRates: funding.records,
      });
    } catch (error) {
      failures.push({
        market: 'CRYPTO_FUTURES',
        symbol,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const jsonPath = process.argv[2] || 'research-lab/move-hunter-v1/docs/one-year-four-market-public-benchmark.json';
const mdPath = process.argv[3] || 'research-lab/move-hunter-v1/docs/one-year-four-market-public-benchmark.md';
const datasets = [];
const failures = [];

await collectStocks(datasets, failures);
await collectSpot(datasets, failures);
await collectFutures(datasets, failures);

if (datasets.length === 0) throw new Error('NO_PUBLIC_BENCHMARK_DATA_COLLECTED');

const result = runFourMarketOneYearBenchmark({ datasets });
const coverage = Object.fromEntries(
  ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'].map((market) => [
    market,
    datasets.filter((dataset) => dataset.market === market).length,
  ]),
);
const report = {
  ...result,
  collection: {
    warmupStartTime: WARMUP_START_MS,
    datasetCount: datasets.length,
    coverage,
    failures,
  },
};

await mkdir(dirname(jsonPath), { recursive: true });
await mkdir(dirname(mdPath), { recursive: true });
await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
await writeFile(mdPath, markdown(result, failures, datasets.length), 'utf8');

console.log(JSON.stringify({
  status: result.status,
  datasetCount: datasets.length,
  coverage,
  failures,
  outputs: { jsonPath, mdPath },
}, null, 2));
