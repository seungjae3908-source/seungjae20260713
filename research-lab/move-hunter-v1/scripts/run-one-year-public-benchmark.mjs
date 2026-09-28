import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  collectYahooStockHistory,
} from '../../../market-prediction-lab/src/yahoo-stock-history.js';
import { collectYahooStock60mHistory } from '../src/yahoo-stock-60m-history.mjs';
import {
  collectUpbitSpotHistory,
} from '../../../market-prediction-lab/src/upbit-spot-history.js';
import { BitgetPublicClient } from '../../../market-prediction-lab/src/bitget-public-client.js';
import { collectBitgetCandles } from '../../../market-prediction-lab/src/bitget-candle-collector.js';
import { collectFundingRateHistory } from '../../../market-prediction-lab/src/derivatives-history.js';
import { freezeMarketSpecificHypotheses } from '../src/market-specific-hypothesis.mjs';
import {
  ONE_YEAR_BENCHMARK_END_MS,
  ONE_YEAR_BENCHMARK_START_MS,
  runFourMarketOneYearAblation,
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
function ablationRows(ablation) {
  const lines = [
    '',
    '## Factor ablation — fixed-candidate decision-layer removal',
    '',
    '| Market | Variant | Return | Trades | MDD | PF | Return Δ vs Full |',
    '|---|---|---:|---:|---:|---:|---:|',
  ];
  for (const [market, marketResult] of Object.entries(ablation.markets)) {
    for (const id of ['FULL', 'NO_TREND', 'NO_MOMENTUM', 'NO_STRUCTURE', 'NO_VOLUME', 'NO_VOLATILITY']) {
      const row = marketResult.variants[id];
      const delta = id === 'FULL' ? 0 : marketResult.deltas[id]?.returnDeltaVsFull;
      lines.push('| ' + [
        market,
        id,
        pct(row.totalReturn),
        row.tradeCount,
        pct(row.maximumDrawdown),
        num(row.profitFactor),
        pct(delta),
      ].join(' | ') + ' |');
    }
  }
  lines.push(
    '',
    '> Candidate prefilter is frozen across variants; only the final decision layer removes one factor family. Results are observed-history diagnostics only. Choosing a market-specific rule from this same window creates selection bias and receives zero OOS/economic credit.',
  );
  return lines;
}

function hypothesisRows(hypotheses) {
  const lines = [
    '',
    '## Market-specific future-validation hypotheses',
    '',
    '| Market | Descriptive best | Status | Frozen candidate | Source→Forward TF | Forward admission | Reasons |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const [market, row] of Object.entries(hypotheses.markets)) {
    lines.push('| ' + [
      market,
      row.descriptiveBestVariant,
      row.status,
      row.selectedVariant ?? '-',
      (row.futureValidation.sourceTimeframe ?? '?') + '→' + (row.futureValidation.targetForwardTimeframe ?? '?'),
      row.futureValidation.forwardAdmissionStatus,
      row.reasons.length ? row.reasons.join(', ') : '-',
    ].join(' | ') + ' |');
  }
  lines.push(
    '',
    '> A frozen hypothesis is selected from observed history and has zero OOS/economic credit now. Forward use additionally requires exact timeframe identity; cross-timeframe credit is forbidden.',
  );
  return lines;
}

function comparisonFromAblation(ablation) {
  return {
    startTime: ablation.startTime,
    endTime: ablation.endTime,
    markets: Object.fromEntries(Object.entries(ablation.markets).map(([market, row]) => [
      market,
      { market, baseline: row.variants.BASELINE, improved: row.variants.FULL },
    ])),
  };
}

function laneAlignedRows(comparison, hypotheses, failures, datasetCount) {
  const lines = [
    '',
    '## Forward-lane-aligned one-year benchmark',
    '',
    '- Dataset count: ' + datasetCount,
    '- KR/US=60m, Spot=4H, Futures=60m',
    '- Purpose: exact timeframe research alignment with current Forward Observer lanes',
    '- Feature history: fixed past-only 300 completed bars per decision',
    '',
    '| Market | Baseline return | B trades | B MDD | B PF | Improved return | I trades | I MDD | I PF |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [market, row] of Object.entries(comparison.markets)) {
    lines.push('| ' + rowForMarket(market, row).join(' | ') + ' |');
  }
  lines.push(...hypothesisRows(hypotheses));
  lines.push('', '### Lane-aligned provider failures', '');
  if (!failures.length) lines.push('- none');
  else for (const item of failures) lines.push('- ' + item.market + '/' + item.symbol + ': ' + item.error);
  return lines;
}

function markdown(result, ablation, hypotheses, laneAligned, failures, datasetCount) {
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
  lines.push(...ablationRows(ablation));
  lines.push(...hypothesisRows(hypotheses));
  if (laneAligned) {
    lines.push(...laneAlignedRows(
      laneAligned.comparison,
      laneAligned.hypotheses,
      laneAligned.failures,
      laneAligned.datasetCount,
    ));
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
  const client = new BitgetPublicClient({
    timeoutMs: 20_000,
    maxRetries: 4,
    minIntervalMs: 140,
  });
  for (const symbol of FUTURES) {
    try {
      const [history, funding] = await Promise.all([
        collectBitgetCandles({
          client,
          market: 'CRYPTO_FUTURES',
          symbol,
          timeframe: '4h',
          startTime: WARMUP_START_MS,
          endTime: ONE_YEAR_BENCHMARK_END_MS,
          productType: 'usdt-futures',
          maxCandles: 10_000,
        }),
        collectFundingRateHistory({
          client,
          symbol,
          startTime: WARMUP_START_MS,
          endTime: ONE_YEAR_BENCHMARK_END_MS,
          productType: 'usdt-futures',
          pageSize: 100,
          maxPages: 30,
        }),
      ]);
      datasets.push({
        market: 'CRYPTO_FUTURES',
        symbol,
        timeframe: '4h',
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


async function collectLaneAlignedStocks(datasets, failures) {
  for (const item of STOCKS) {
    try {
      const history = await collectYahooStock60mHistory({
        market: item.market,
        symbol: item.symbol,
        startTime: WARMUP_START_MS,
        endTime: ONE_YEAR_BENCHMARK_END_MS,
        timeoutMs: 20_000,
      });
      datasets.push({
        market: item.market,
        symbol: item.symbol,
        timeframe: '60m',
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

async function collectLaneAlignedFutures(datasets, failures, descriptiveDatasets) {
  const client = new BitgetPublicClient({
    timeoutMs: 20_000,
    maxRetries: 4,
    minIntervalMs: 140,
  });
  for (const symbol of FUTURES) {
    try {
      const history = await collectBitgetCandles({
        client,
        market: 'CRYPTO_FUTURES',
        symbol,
        timeframe: '1h',
        startTime: WARMUP_START_MS,
        endTime: ONE_YEAR_BENCHMARK_END_MS,
        productType: 'usdt-futures',
        maxCandles: 20_000,
      });
      const existing = descriptiveDatasets.find((row) =>
        row.market === 'CRYPTO_FUTURES' && row.symbol === symbol);
      let fundingRates = existing?.fundingRates ?? [];
      if (!Array.isArray(fundingRates) || fundingRates.length === 0) {
        const funding = await collectFundingRateHistory({
          client,
          symbol,
          startTime: WARMUP_START_MS,
          endTime: ONE_YEAR_BENCHMARK_END_MS,
          productType: 'usdt-futures',
          pageSize: 100,
          maxPages: 30,
        });
        fundingRates = funding.records;
      }
      if (!Array.isArray(fundingRates) || fundingRates.length === 0) {
        throw new Error('LANE_ALIGNED_FUNDING_HISTORY_REQUIRED');
      }
      datasets.push({
        market: 'CRYPTO_FUTURES',
        symbol,
        timeframe: '60m',
        providerTimeframe: '1h',
        source: history.provider,
        candles: history.candles,
        fundingRates,
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
const laneAlignedDatasets = [];
const laneAlignedFailures = [];

await collectStocks(datasets, failures);
await collectSpot(datasets, failures);
await collectFutures(datasets, failures);

await collectLaneAlignedStocks(laneAlignedDatasets, laneAlignedFailures);
laneAlignedDatasets.push(...datasets
  .filter((row) => row.market === 'CRYPTO_SPOT')
  .map((row) => ({ ...row, timeframe: '4H' })));
await collectLaneAlignedFutures(laneAlignedDatasets, laneAlignedFailures, datasets);

if (datasets.length === 0) throw new Error('NO_PUBLIC_BENCHMARK_DATA_COLLECTED');

const result = runFourMarketOneYearBenchmark({ datasets });
const ablation = runFourMarketOneYearAblation({ datasets });
const hypotheses = freezeMarketSpecificHypotheses(ablation);
const laneAlignedAblation = runFourMarketOneYearAblation({
  datasets: laneAlignedDatasets,
  featureHistoryBars: 300,
});
const laneAlignedHypotheses = freezeMarketSpecificHypotheses(laneAlignedAblation);
const laneAlignedComparison = comparisonFromAblation(laneAlignedAblation);
const laneAligned = {
  comparison: laneAlignedComparison,
  ablation: laneAlignedAblation,
  hypotheses: laneAlignedHypotheses,
  failures: laneAlignedFailures,
  datasetCount: laneAlignedDatasets.length,
};
const coverage = Object.fromEntries(
  ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'].map((market) => [
    market,
    datasets.filter((dataset) => dataset.market === market).length,
  ]),
);
const report = {
  ...result,
  ablation,
  marketSpecificHypotheses: hypotheses,
  laneAligned,
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
await writeFile(mdPath, markdown(result, ablation, hypotheses, laneAligned, failures, datasets.length), 'utf8');

console.log(JSON.stringify({
  status: result.status,
  datasetCount: datasets.length,
  coverage,
  failures,
  ablation: Object.fromEntries(Object.entries(ablation.markets).map(([market, row]) => [
    market,
    Object.fromEntries(Object.entries(row.variants).map(([id, metrics]) => [id, {
      totalReturn: metrics.totalReturn,
      tradeCount: metrics.tradeCount,
      maximumDrawdown: metrics.maximumDrawdown,
      profitFactor: metrics.profitFactor,
    }])),
  ])),
  marketSpecificHypotheses: Object.fromEntries(Object.entries(hypotheses.markets).map(([market, row]) => [
    market,
    {
      status: row.status,
      descriptiveBestVariant: row.descriptiveBestVariant,
      selectedVariant: row.selectedVariant,
      sourceTimeframe: row.futureValidation.sourceTimeframe,
      targetForwardTimeframe: row.futureValidation.targetForwardTimeframe,
      timeframeMatch: row.futureValidation.timeframeMatch,
      forwardAdmissionStatus: row.futureValidation.forwardAdmissionStatus,
      forwardAdmissionReasons: row.futureValidation.forwardAdmissionReasons,
      reasons: row.reasons,
    },
  ])),
  laneAligned: {
    datasetCount: laneAlignedDatasets.length,
    failures: laneAlignedFailures,
    hypotheses: Object.fromEntries(Object.entries(laneAlignedHypotheses.markets).map(([market, row]) => [
      market,
      {
        status: row.status,
        descriptiveBestVariant: row.descriptiveBestVariant,
        selectedVariant: row.selectedVariant,
        sourceTimeframe: row.futureValidation.sourceTimeframe,
        targetForwardTimeframe: row.futureValidation.targetForwardTimeframe,
        timeframeMatch: row.futureValidation.timeframeMatch,
        forwardAdmissionStatus: row.futureValidation.forwardAdmissionStatus,
        forwardAdmissionReasons: row.futureValidation.forwardAdmissionReasons,
        reasons: row.reasons,
      },
    ])),
  },
  outputs: { jsonPath, mdPath },
}, null, 2));
