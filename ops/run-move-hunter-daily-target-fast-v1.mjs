import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { collectYahooStock60mHistory } from '../src/yahoo-stock-60m-history.mjs';
import { collectUpbitSpotHistory } from '../../../market-prediction-lab/src/upbit-spot-history.js';
import { BitgetPublicClient } from '../../../market-prediction-lab/src/bitget-public-client.js';
import { collectBitgetCandles } from '../../../market-prediction-lab/src/bitget-candle-collector.js';
import { collectFundingRateHistory } from '../../../market-prediction-lab/src/derivatives-history.js';
import {
  ONE_YEAR_BENCHMARK_END_MS,
  ONE_YEAR_BENCHMARK_START_MS,
  runOneYearDatasetBenchmark,
} from '../src/one-year-benchmark.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const WARMUP_START_MS = ONE_YEAR_BENCHMARK_START_MS - 140 * DAY_MS;
const CACHE_DIR = process.env.MOVE_HUNTER_CACHE_DIR || '/var/lib/backtest-worker/cache/move-hunter-v1';
const FEATURE_HISTORY_BARS = 300;
const MARKETS = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'];
const STOCKS = [
  { market: 'KR_STOCK', symbol: '005930' },
  { market: 'KR_STOCK', symbol: '000660' },
  { market: 'US_STOCK', symbol: 'AAPL' },
  { market: 'US_STOCK', symbol: 'NVDA' },
];
const SPOT = ['BTC', 'ETH'];
const FUTURES = ['BTCUSDT', 'ETHUSDT'];

function safe(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function pct(value, digits = 2) {
  return Number.isFinite(value) ? (value * 100).toFixed(digits) + '%' : '-';
}

function num(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

async function cached(name, loader) {
  await mkdir(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, safe(name) + '.json');
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (value && value.cacheVersion === 1 && value.payload) {
      return { payload: value.payload, cacheHit: true, path };
    }
  } catch {}
  const payload = await loader();
  const tmp = path + '.tmp-' + process.pid;
  await writeFile(tmp, JSON.stringify({
    cacheVersion: 1,
    createdAt: new Date().toISOString(),
    startTime: WARMUP_START_MS,
    endTime: ONE_YEAR_BENCHMARK_END_MS,
    payload,
  }) + '\n', 'utf8');
  await rename(tmp, path);
  return { payload, cacheHit: false, path };
}

async function collectDatasets() {
  const datasets = [];
  const failures = [];
  const cache = [];

  for (const item of STOCKS) {
    const key = [
      item.market,
      item.symbol,
      '60m',
      WARMUP_START_MS,
      ONE_YEAR_BENCHMARK_END_MS,
    ].join('-');
    try {
      const row = await cached(key, () => collectYahooStock60mHistory({
        market: item.market,
        symbol: item.symbol,
        startTime: WARMUP_START_MS,
        endTime: ONE_YEAR_BENCHMARK_END_MS,
        timeoutMs: 20_000,
      }));
      const history = row.payload;
      datasets.push({
        market: item.market,
        symbol: item.symbol,
        timeframe: '60m',
        source: history.source,
        candles: history.candles,
      });
      cache.push({ market: item.market, symbol: item.symbol, timeframe: '60m', hit: row.cacheHit });
    } catch (error) {
      failures.push({
        market: item.market,
        symbol: item.symbol,
        timeframe: '60m',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const symbol of SPOT) {
    const key = [
      'CRYPTO_SPOT',
      symbol,
      '4h',
      WARMUP_START_MS,
      ONE_YEAR_BENCHMARK_END_MS,
    ].join('-');
    try {
      const row = await cached(key, () => collectUpbitSpotHistory({
        symbol,
        timeframe: '4h',
        startTime: WARMUP_START_MS,
        endTime: ONE_YEAR_BENCHMARK_END_MS,
        minIntervalMs: 140,
        maxPages: 50,
      }));
      const history = row.payload;
      datasets.push({
        market: 'CRYPTO_SPOT',
        symbol,
        timeframe: '4H',
        source: history.source,
        candles: history.candles,
      });
      cache.push({ market: 'CRYPTO_SPOT', symbol, timeframe: '4H', hit: row.cacheHit });
    } catch (error) {
      failures.push({
        market: 'CRYPTO_SPOT',
        symbol,
        timeframe: '4H',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const client = new BitgetPublicClient({
    timeoutMs: 20_000,
    maxRetries: 4,
    minIntervalMs: 140,
  });
  for (const symbol of FUTURES) {
    const key = [
      'CRYPTO_FUTURES',
      symbol,
      '60m',
      WARMUP_START_MS,
      ONE_YEAR_BENCHMARK_END_MS,
    ].join('-');
    try {
      const row = await cached(key, async () => {
        const [history, funding] = await Promise.all([
          collectBitgetCandles({
            client,
            market: 'CRYPTO_FUTURES',
            symbol,
            timeframe: '1h',
            startTime: WARMUP_START_MS,
            endTime: ONE_YEAR_BENCHMARK_END_MS,
            productType: 'usdt-futures',
            maxCandles: 20_000,
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
        return { history, funding };
      });
      const history = row.payload.history;
      const funding = row.payload.funding;
      datasets.push({
        market: 'CRYPTO_FUTURES',
        symbol,
        timeframe: '60m',
        providerTimeframe: '1h',
        source: history.provider,
        candles: history.candles,
        fundingRates: funding.records,
      });
      cache.push({ market: 'CRYPTO_FUTURES', symbol, timeframe: '60m', hit: row.cacheHit });
    } catch (error) {
      failures.push({
        market: 'CRYPTO_FUTURES',
        symbol,
        timeframe: '60m',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { datasets, failures, cache };
}

function laneId(row) {
  return [row.market, row.symbol, row.side].join('|');
}

function aggregateLanes(lanes) {
  if (!lanes.length) {
    return {
      laneCount: 0,
      totalReturn: null,
      tradeCount: 0,
      winRate: null,
      profitFactor: null,
      conservativeLaneMaxMdd: null,
    };
  }
  const finalMultiple = lanes.reduce((sum, row) =>
    sum + row.performance.finalCapital / row.performance.initialCapital, 0) / lanes.length;
  const trades = lanes.flatMap((row) => row.trades);
  const wins = trades.filter((row) => Number(row.accountReturn) > 0).length;
  const gains = trades.filter((row) => Number(row.accountReturn) > 0)
    .reduce((sum, row) => sum + Number(row.accountReturn), 0);
  const losses = -trades.filter((row) => Number(row.accountReturn) < 0)
    .reduce((sum, row) => sum + Number(row.accountReturn), 0);
  return {
    laneCount: lanes.length,
    totalReturn: finalMultiple - 1,
    tradeCount: trades.length,
    winRate: trades.length ? wins / trades.length : 0,
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? null : 0,
    conservativeLaneMaxMdd: Math.max(...lanes.map((row) => Number(row.performance.maximumDrawdown || 0))),
  };
}

const KST_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function kstDateKey(ts) {
  const parts = Object.fromEntries(
    KST_DATE.formatToParts(new Date(ts))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function enumerateDates(startKey, endKey) {
  const values = [];
  let cursor = new Date(startKey + 'T00:00:00Z');
  const end = new Date(endKey + 'T00:00:00Z');
  while (cursor <= end) {
    values.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  return values;
}

function median(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[mid]
    : (ordered[mid - 1] + ordered[mid]) / 2;
}

function summarizeDaily(lanes, laneWeights) {
  const startKey = kstDateKey(ONE_YEAR_BENCHMARK_START_MS);
  const endKey = kstDateKey(ONE_YEAR_BENCHMARK_END_MS);
  const dates = enumerateDates(startKey, endKey);
  const equities = new Map();
  const events = new Map();
  let initialEquity = 0;
  let postWindowExitCount = 0;

  for (const lane of lanes) {
    const id = laneId(lane);
    const weight = Number(laneWeights.get(id) || 0);
    equities.set(id, weight);
    initialEquity += weight;
    for (const trade of lane.trades || []) {
      const exitTs = Number(trade.exitTs);
      if (!Number.isFinite(exitTs)) continue;
      if (exitTs > ONE_YEAR_BENCHMARK_END_MS) {
        postWindowExitCount += 1;
        continue;
      }
      if (exitTs < ONE_YEAR_BENCHMARK_START_MS) continue;
      const key = kstDateKey(exitTs);
      if (!events.has(key)) events.set(key, []);
      events.get(key).push({ id, trade });
    }
  }

  const daily = [];
  let maxConsecutiveNegativeDays = 0;
  let negativeStreak = 0;
  for (const date of dates) {
    const before = [...equities.values()].reduce((sum, value) => sum + value, 0);
    const rows = (events.get(date) || []).sort((a, b) => Number(a.trade.exitTs) - Number(b.trade.exitTs));
    for (const item of rows) {
      const current = Number(equities.get(item.id) || 0);
      const next = Math.max(0, current * (1 + Number(item.trade.accountReturn || 0)));
      equities.set(item.id, next);
    }
    const after = [...equities.values()].reduce((sum, value) => sum + value, 0);
    const dailyReturn = before > 0 ? after / before - 1 : 0;
    if (dailyReturn < -1e-12) {
      negativeStreak += 1;
      maxConsecutiveNegativeDays = Math.max(maxConsecutiveNegativeDays, negativeStreak);
    } else {
      negativeStreak = 0;
    }
    daily.push({
      date,
      realizedExitTradeCount: rows.length,
      realizedDailyReturn: dailyReturn,
      equity: after,
    });
  }

  const trading = daily.filter((row) => row.realizedExitTradeCount > 0);
  const tradingReturns = trading.map((row) => row.realizedDailyReturn);
  const hit = (threshold) => daily.filter((row) => row.realizedDailyReturn >= threshold).length;
  const hitTrading = (threshold) => trading.filter((row) => row.realizedDailyReturn >= threshold).length;
  const bestDay = daily.reduce((best, row) => !best || row.realizedDailyReturn > best.realizedDailyReturn ? row : best, null);
  const worstDay = daily.reduce((worst, row) => !worst || row.realizedDailyReturn < worst.realizedDailyReturn ? row : worst, null);
  const finalEquity = daily.length ? daily[daily.length - 1].equity : initialEquity;

  return {
    dayBoundary: 'Asia/Seoul',
    metricType: 'REALIZED_EXIT_DAY_ACCOUNT_EQUITY_CHANGE',
    totalCalendarDays: daily.length,
    tradingDays: trading.length,
    noExitDays: daily.length - trading.length,
    positiveDays: daily.filter((row) => row.realizedDailyReturn > 1e-12).length,
    negativeDays: daily.filter((row) => row.realizedDailyReturn < -1e-12).length,
    flatDays: daily.filter((row) => Math.abs(row.realizedDailyReturn) <= 1e-12).length,
    hit3PctDays: hit(0.03),
    hit5PctDays: hit(0.05),
    hit10PctDays: hit(0.10),
    hit3PctRateCalendar: daily.length ? hit(0.03) / daily.length : 0,
    hit5PctRateCalendar: daily.length ? hit(0.05) / daily.length : 0,
    hit10PctRateCalendar: daily.length ? hit(0.10) / daily.length : 0,
    hit3PctRateTrading: trading.length ? hitTrading(0.03) / trading.length : 0,
    hit5PctRateTrading: trading.length ? hitTrading(0.05) / trading.length : 0,
    hit10PctRateTrading: trading.length ? hitTrading(0.10) / trading.length : 0,
    averageCalendarDailyReturn: daily.length
      ? daily.reduce((sum, row) => sum + row.realizedDailyReturn, 0) / daily.length
      : 0,
    averageTradingDayReturn: tradingReturns.length
      ? tradingReturns.reduce((sum, value) => sum + value, 0) / tradingReturns.length
      : 0,
    medianTradingDayReturn: median(tradingReturns),
    bestDay,
    worstDay,
    maxConsecutiveNegativeDays,
    initialEquity,
    finalEquity,
    realizedWindowTotalReturn: initialEquity > 0 ? finalEquity / initialEquity - 1 : null,
    postWindowExitCount,
    daily,
  };
}

function marketWeights(lanes) {
  const map = new Map();
  const n = lanes.length;
  for (const lane of lanes) map.set(laneId(lane), n ? 1 / n : 0);
  return map;
}

function combinedWeights(lanesByMarket) {
  const map = new Map();
  for (const market of MARKETS) {
    const lanes = lanesByMarket[market] || [];
    for (const lane of lanes) {
      map.set(laneId(lane), lanes.length ? 0.25 / lanes.length : 0);
    }
  }
  return map;
}

function markdown(report) {
  const lines = [
    '# Move Hunter — Server Fast 1Y Daily Target Audit',
    '',
    '- Research SHA: ' + report.researchSha,
    '- Window: ' + new Date(report.startTime).toISOString() + ' ~ ' + new Date(report.endTime).toISOString(),
    '- Day boundary: Asia/Seoul',
    '- Strategy: IMPROVED_TECH_STRUCTURE_V2 / LONG_RUNNER_3ATR',
    '- KR/US 60m, Spot 4H, Futures 60m',
    '- Feature history: fixed past-only 300 completed bars',
    '- Replit: not used',
    '',
    '| Market | Return | Trades | PF | Conservative lane MDD | +3% days | +5% days | +10% days | Negative days |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];

  for (const market of MARKETS) {
    const row = report.markets[market];
    lines.push('| ' + [
      market,
      pct(row.performance.totalReturn),
      row.performance.tradeCount,
      num(row.performance.profitFactor),
      pct(row.performance.conservativeLaneMaxMdd),
      row.daily.hit3PctDays,
      row.daily.hit5PctDays,
      row.daily.hit10PctDays,
      row.daily.negativeDays,
    ].join(' | ') + ' |');
  }

  lines.push(
    '',
    '## Equal-market combined account',
    '',
    '- Annual modeled return: ' + pct(report.combined.performance.totalReturn),
    '- Realized-within-window return: ' + pct(report.combined.daily.realizedWindowTotalReturn),
    '- Exit trading days: ' + report.combined.daily.tradingDays,
    '- +3% days: ' + report.combined.daily.hit3PctDays + ' (' + pct(report.combined.daily.hit3PctRateTrading) + ' of exit-trading days)',
    '- +5% days: ' + report.combined.daily.hit5PctDays + ' (' + pct(report.combined.daily.hit5PctRateTrading) + ' of exit-trading days)',
    '- +10% days: ' + report.combined.daily.hit10PctDays + ' (' + pct(report.combined.daily.hit10PctRateTrading) + ' of exit-trading days)',
    '- Negative days: ' + report.combined.daily.negativeDays,
    '- Best realized exit day: ' + (report.combined.daily.bestDay ? report.combined.daily.bestDay.date + ' ' + pct(report.combined.daily.bestDay.realizedDailyReturn) : '-'),
    '- Worst realized exit day: ' + (report.combined.daily.worstDay ? report.combined.daily.worstDay.date + ' ' + pct(report.combined.daily.worstDay.realizedDailyReturn) : '-'),
    '- Max consecutive negative days: ' + report.combined.daily.maxConsecutiveNegativeDays,
    '',
    '## Evidence boundary',
    '',
    '- This is observed-history research only.',
    '- Daily percentages are realized EXIT-DAY account equity changes, not intraday peak returns and not full mark-to-market daily NAV.',
    '- Historical replay is not genuine Forward/OOS evidence.',
    '- Provider/public-data survivorship and full point-in-time universe limitations remain.',
    '- Full live-market costs/partial fills/settlement are not proven here.',
    '- Profitability claim allowed: false.',
    '- Economic sample credit: 0.',
    '- Execution authority: NONE.',
    '',
    '## Provider failures',
    '',
  );
  if (!report.collection.failures.length) lines.push('- none');
  else for (const failure of report.collection.failures) {
    lines.push('- ' + failure.market + '/' + failure.symbol + '/' + failure.timeframe + ': ' + failure.error);
  }
  return lines.join('\n') + '\n';
}

const jsonPath = process.argv[2] || '/var/lib/backtest-worker/results/move-hunter-server-fast-1y.json';
const mdPath = process.argv[3] || '/var/lib/backtest-worker/results/move-hunter-server-fast-1y.md';
const researchSha = process.env.MOVE_HUNTER_RESEARCH_SHA || 'UNKNOWN';

const collection = await collectDatasets();
const lanes = [];

for (const dataset of collection.datasets) {
  const sides = dataset.market === 'CRYPTO_FUTURES' ? ['LONG', 'SHORT'] : ['LONG'];
  for (const side of sides) {
    const result = runOneYearDatasetBenchmark(dataset, {
      variant: 'IMPROVED_TECH_STRUCTURE_V2',
      side,
      startTime: ONE_YEAR_BENCHMARK_START_MS,
      endTime: ONE_YEAR_BENCHMARK_END_MS,
      featureHistoryBars: FEATURE_HISTORY_BARS,
    });
    lanes.push(result);
  }
}

const lanesByMarket = Object.fromEntries(MARKETS.map((market) => [
  market,
  lanes.filter((row) => row.market === market),
]));

const markets = {};
for (const market of MARKETS) {
  const marketLanes = lanesByMarket[market];
  markets[market] = {
    performance: aggregateLanes(marketLanes),
    daily: summarizeDaily(marketLanes, marketWeights(marketLanes)),
    lanes: marketLanes,
  };
}

const allMarketsPresent = MARKETS.every((market) => lanesByMarket[market].length > 0);
const combinedDaily = allMarketsPresent
  ? summarizeDaily(lanes, combinedWeights(lanesByMarket))
  : null;
const marketMultiples = MARKETS
  .filter((market) => Number.isFinite(markets[market].performance.totalReturn))
  .map((market) => 1 + markets[market].performance.totalReturn);
const combinedPerformance = allMarketsPresent
  ? {
      totalReturn: marketMultiples.reduce((sum, value) => sum + value, 0) / MARKETS.length - 1,
      marketCount: MARKETS.length,
    }
  : {
      totalReturn: null,
      marketCount: marketMultiples.length,
    };

const report = {
  schemaVersion: 'move-hunter-server-fast-daily-target-audit/v1',
  generatedAt: new Date().toISOString(),
  researchSha,
  startTime: ONE_YEAR_BENCHMARK_START_MS,
  endTime: ONE_YEAR_BENCHMARK_END_MS,
  status: allMarketsPresent ? 'BOUNDED_FOUR_MARKET_RESULT' : 'PARTIAL_MARKET_RESULT',
  strategy: {
    variant: 'IMPROVED_TECH_STRUCTURE_V2',
    runner: 'LONG_RUNNER_3ATR',
    featureHistoryBars: FEATURE_HISTORY_BARS,
    timeframes: {
      KR_STOCK: '60m',
      US_STOCK: '60m',
      CRYPTO_SPOT: '4H',
      CRYPTO_FUTURES: '60m',
    },
  },
  collection: {
    datasetCount: collection.datasets.length,
    coverage: Object.fromEntries(MARKETS.map((market) => [
      market,
      collection.datasets.filter((row) => row.market === market).length,
    ])),
    cache: collection.cache,
    failures: collection.failures,
  },
  markets,
  combined: {
    performance: combinedPerformance,
    daily: combinedDaily,
  },
  evidenceBoundary: {
    historicalReplayOnly: true,
    dailyMetricType: 'REALIZED_EXIT_DAY_ACCOUNT_EQUITY_CHANGE',
    markToMarketDailyNav: false,
    intradayTargetHitRate: false,
    pointInTimeFullUniverseProven: false,
    canonicalFullCostProven: false,
    oosCredit: 0,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
    liveTrading: false,
    realOrder: false,
    privateApi: false,
  },
};

await mkdir(dirname(jsonPath), { recursive: true });
await mkdir(dirname(mdPath), { recursive: true });
await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
await writeFile(mdPath, markdown(report), 'utf8');

const consoleSummary = {
  status: report.status,
  datasetCount: report.collection.datasetCount,
  coverage: report.collection.coverage,
  cache: report.collection.cache,
  failures: report.collection.failures,
  markets: Object.fromEntries(MARKETS.map((market) => [market, {
    totalReturn: report.markets[market].performance.totalReturn,
    tradeCount: report.markets[market].performance.tradeCount,
    profitFactor: report.markets[market].performance.profitFactor,
    conservativeLaneMaxMdd: report.markets[market].performance.conservativeLaneMaxMdd,
    hit3PctDays: report.markets[market].daily.hit3PctDays,
    hit5PctDays: report.markets[market].daily.hit5PctDays,
    hit10PctDays: report.markets[market].daily.hit10PctDays,
    negativeDays: report.markets[market].daily.negativeDays,
  }])),
  combined: report.combined.daily ? {
    totalReturn: report.combined.performance.totalReturn,
    realizedWindowTotalReturn: report.combined.daily.realizedWindowTotalReturn,
    tradingDays: report.combined.daily.tradingDays,
    hit3PctDays: report.combined.daily.hit3PctDays,
    hit5PctDays: report.combined.daily.hit5PctDays,
    hit10PctDays: report.combined.daily.hit10PctDays,
    negativeDays: report.combined.daily.negativeDays,
    bestDay: report.combined.daily.bestDay,
    worstDay: report.combined.daily.worstDay,
    maxConsecutiveNegativeDays: report.combined.daily.maxConsecutiveNegativeDays,
  } : null,
  outputs: { jsonPath, mdPath },
};

console.log(JSON.stringify(consoleSummary, null, 2));
