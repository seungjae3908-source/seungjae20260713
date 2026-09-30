import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles } from "../src/bitget-candle-collector.js";
import {
  BinanceFuturesPublicClient,
  collectBinanceFuturesFundingRates,
} from "../src/binance-futures-history.js";
import { collectVisionFuturesDailyKlines } from "../src/binance-vision-futures-archive.js";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import {
  BENCHMARK_HORIZONS,
  BENCHMARK_PERIOD,
  BENCHMARK_PROFILE_PLAN,
  COMMON_FRICTION_STRESS_BPS_PER_SIDE,
  SOURCE_REFERENCE_RECIPES,
  barsPerYearForProfile,
  benchmarkSafetyEnvelope,
  coverageSummary,
  runCrossSectionalMomentumProxy,
  runFundingCarryProxy,
  runEqualWeightBuyHoldBaseline,
  runTimeSeriesMomentumProxy,
} from "../src/evidence-backed-3y-benchmark-v1.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const OUTPUT = resolve(process.argv[2] ?? "docs/evidence-backed-3y-benchmark-v1-result.json");

const STOCK_BASKETS = Object.freeze({
  KR_STOCK: Object.freeze(["005930", "000660", "005380", "105560"]),
  US_STOCK: Object.freeze(["AAPL", "MSFT", "JPM", "XOM"]),
});

const CRYPTO_BASKETS = Object.freeze({
  SHORT: Object.freeze(["BTCUSDT", "ETHUSDT"]),
  SWING: Object.freeze(["BTCUSDT", "ETHUSDT"]),
  POSITION: Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT"]),
});

const BINANCE_INTERVAL_MS = Object.freeze({
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
});

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error).slice(0, 1_500),
    details: error?.details ?? null,
    stack: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 10) : [],
  };
}

async function fetchJsonWithRetry(url, { attempts = 4, minDelayMs = 150 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "market-prediction-lab/3y-benchmark-v1",
        },
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`BINANCE_NON_JSON_${response.status}:${text.slice(0, 160)}`);
      }
      if (!response.ok) {
        const error = Object.assign(new Error(`BINANCE_HTTP_${response.status}:${payload?.msg ?? "unknown"}`), {
          status: response.status,
        });
        if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          lastError = error;
          await sleep(minDelayMs * (2 ** attempt));
          continue;
        }
        throw error;
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts) throw error;
      await sleep(minDelayMs * (2 ** attempt));
    }
  }
  throw lastError ?? new Error("BINANCE_FETCH_FAILED");
}

function normalizeBinanceKline(row, symbol) {
  if (!Array.isArray(row) || row.length < 6) throw new Error("BINANCE_KLINE_INVALID");
  const candle = {
    symbol,
    timestamp: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
  if (!Number.isSafeInteger(candle.timestamp)
      || candle.timestamp <= 0
      || [candle.open, candle.high, candle.low, candle.close].some((value) => !(value > 0))
      || !(candle.volume >= 0)
      || candle.high < Math.max(candle.open, candle.close)
      || candle.low > Math.min(candle.open, candle.close)
      || candle.high < candle.low) {
    throw new Error("BINANCE_KLINE_OHLCV_INVALID");
  }
  return Object.freeze({
    ...candle,
    observedAt: candle.timestamp,
    isClosed: true,
  });
}

async function collectBinanceKlines({
  market,
  symbol,
  timeframe,
  startTime,
  endTime,
}) {
  const intervalMs = BINANCE_INTERVAL_MS[timeframe];
  if (!intervalMs) throw new Error(`BINANCE_INTERVAL_UNSUPPORTED:${timeframe}`);
  const base = market === "CRYPTO_FUTURES"
    ? "https://fapi.binance.com/fapi/v1/klines"
    : "https://api.binance.com/api/v3/klines";
  const rows = [];
  let cursor = Math.floor(startTime / intervalMs) * intervalMs;
  let pages = 0;

  while (cursor <= endTime) {
    const url = new URL(base);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", timeframe);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(endTime));
    url.searchParams.set("limit", "1000");
    const payload = await fetchJsonWithRetry(url);
    if (!Array.isArray(payload)) throw new Error("BINANCE_KLINE_RESPONSE_INVALID");
    if (payload.length === 0) break;
    const normalized = payload.map((row) => normalizeBinanceKline(row, symbol))
      .filter((row) => row.timestamp >= startTime && row.timestamp <= endTime);
    rows.push(...normalized);
    pages += 1;
    const newest = Number(payload.at(-1)?.[0]);
    if (!Number.isSafeInteger(newest)) throw new Error("BINANCE_KLINE_CURSOR_INVALID");
    const next = newest + intervalMs;
    if (next <= cursor) throw new Error("BINANCE_KLINE_CURSOR_STALLED");
    cursor = next;
    if (payload.length < 1000) break;
    await sleep(90);
  }

  const byTimestamp = new Map();
  for (const row of rows) byTimestamp.set(row.timestamp, row);
  const candles = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (candles.length < 60) throw new Error(`BINANCE_KLINES_INSUFFICIENT:${market}:${symbol}:${timeframe}:${candles.length}`);
  return Object.freeze({
    provider: market === "CRYPTO_FUTURES" ? "binance-usdm-public-rest" : "binance-spot-public-rest",
    market,
    symbol,
    timeframe,
    pages,
    candles: Object.freeze(candles),
  });
}

async function collectCryptoKlines(input) {
  try {
    return await collectBinanceKlines(input);
  } catch (binanceError) {
    let visionError = null;
    if (input.market === "CRYPTO_FUTURES" && input.timeframe === "1d") {
      try {
        const vision = await collectVisionFuturesDailyKlines({
          symbol: input.symbol,
          startTime: input.startTime,
          endTime: input.endTime,
          concurrency: 6,
        });
        return Object.freeze({
          provider: vision.provider,
          market: input.market,
          symbol: input.symbol,
          timeframe: input.timeframe,
          pages: vision.manifests?.length ?? null,
          candles: vision.candles,
          fallbackReason: serializeError(binanceError),
        });
      } catch (error) {
        visionError = error;
      }
    }
    const client = new BitgetPublicClient({
      minIntervalMs: 125,
      maxRetries: 4,
      timeoutMs: 12_000,
    });
    const intervalMs = BINANCE_INTERVAL_MS[input.timeframe];
    const maxCandles = Math.min(
      500_000,
      Math.max(60, Math.ceil((input.endTime - input.startTime) / intervalMs) + 2_000),
    );
    try {
      const fallback = await collectBitgetCandles({
        client,
        market: input.market,
        symbol: input.symbol,
        timeframe: input.timeframe,
        startTime: input.startTime,
        endTime: input.endTime + intervalMs,
        maxCandles,
      });
      return Object.freeze({
        provider: `${fallback.provider}:fallback_after_binance`,
        market: input.market,
        symbol: input.symbol,
        timeframe: input.timeframe,
        pages: null,
        candles: fallback.candles.map((row) => Object.freeze({
          ...row,
          symbol: input.symbol,
          observedAt: row.timestamp,
          isClosed: true,
        })),
        fallbackReason: serializeError(binanceError),
      });
    } catch (bitgetError) {
      const error = new Error(`CRYPTO_PUBLIC_COLLECTION_FAILED:${input.market}:${input.symbol}:${input.timeframe}`);
      error.details = {
        binance: serializeError(binanceError),
        vision: visionError ? serializeError(visionError) : null,
        bitget: serializeError(bitgetError),
      };
      throw error;
    }
  }
}

function warmupStart(horizon) {
  const definition = BENCHMARK_HORIZONS[horizon];
  const warmupBars = Math.max(definition.tsmomLookbackBars * 2, 320);
  return BENCHMARK_PERIOD.startTime - warmupBars * definition.intervalMs;
}

async function collectStockProfile(market) {
  const datasets = [];
  for (const symbol of STOCK_BASKETS[market]) {
    const history = await collectYahooStockHistory({
      market,
      symbol,
      startTime: BENCHMARK_PERIOD.startTime - 420 * DAY_MS,
      endTime: BENCHMARK_PERIOD.endTime + DAY_MS,
    });
    datasets.push(Object.freeze({
      symbol,
      provider: history.source,
      candles: history.candles.map((row) => Object.freeze({
        ...row,
        symbol,
        observedAt: row.timestamp,
        isClosed: true,
      })),
    }));
  }
  return Object.freeze(datasets);
}

async function collectCryptoProfile(market, horizon) {
  const timeframe = BENCHMARK_HORIZONS[horizon].timeframe;
  const datasets = [];
  for (const symbol of CRYPTO_BASKETS[horizon]) {
    const collected = await collectCryptoKlines({
      market,
      symbol,
      timeframe,
      startTime: warmupStart(horizon),
      endTime: BENCHMARK_PERIOD.endTime,
    });
    datasets.push(Object.freeze({
      symbol,
      provider: collected.provider,
      fallbackReason: collected.fallbackReason ?? null,
      candles: collected.candles,
    }));
  }
  return Object.freeze(datasets);
}

function profileCoverage(datasets) {
  const rows = datasets.map((dataset) => ({
    symbol: dataset.symbol,
    provider: dataset.provider,
    coverage: coverageSummary({ candles: dataset.candles }),
  }));
  const blockers = rows.flatMap((row) => row.coverage.blockers.map((reason) => `${row.symbol}:${reason}`));
  return Object.freeze({
    status: blockers.length ? "BLOCKED_DATA" : "READY",
    blockers: Object.freeze(blockers),
    datasets: Object.freeze(rows),
  });
}

function resultRow({
  profile,
  strategy,
  costBps,
  result,
  evidenceRole,
  sourceRecipeId = null,
}) {
  return Object.freeze({
    profileId: profile.profileId,
    market: profile.market,
    horizon: profile.horizon,
    timeframe: profile.timeframe,
    strategy,
    sourceRecipeId,
    status: "MEASURED_PROXY",
    evidenceRole,
    commonFrictionBpsPerSide: costBps,
    sourceFaithfulReplication: result.sourceFaithfulReplication === true,
    performance: result.performance,
    periodAnalysis: result.periodAnalysis ?? null,
    profitabilityCredit: 0,
    promotionEligible: false,
    executionAuthority: "NONE",
  });
}

async function collectFundingRecords(startTime, endTime) {
  const client = new BinanceFuturesPublicClient({
    timeoutMs: 12_000,
    maxRetries: 4,
  });
  const result = await collectBinanceFuturesFundingRates({
    client,
    symbol: "BTCUSDT",
    startTime,
    endTime,
  });
  return result.records;
}

function selectBenchmarkRows(rows) {
  const measured = rows.filter((row) => row.status === "MEASURED_PROXY"
    && Number.isFinite(row.performance?.cagr)
    && Number.isFinite(row.performance?.maximumDrawdown));
  const passive = measured.filter((row) => row.strategy === "EQUAL_WEIGHT_BUY_HOLD_BASELINE");
  const active = measured.filter((row) => row.strategy !== "EQUAL_WEIGHT_BUY_HOLD_BASELINE");
  const baselineByProfile = new Map(passive.map((row) => [row.profileId, row]));
  const byCagr = [...active].sort((a, b) =>
    b.performance.cagr - a.performance.cagr
    || (b.performance.annualizedSharpe ?? Number.NEGATIVE_INFINITY)
      - (a.performance.annualizedSharpe ?? Number.NEGATIVE_INFINITY));
  const bySharpe = [...active].sort((a, b) =>
    (b.performance.annualizedSharpe ?? Number.NEGATIVE_INFINITY)
      - (a.performance.annualizedSharpe ?? Number.NEGATIVE_INFINITY)
    || b.performance.cagr - a.performance.cagr);
  const activeVsPassive = active.map((row) => {
    const baseline = baselineByProfile.get(row.profileId) ?? null;
    return Object.freeze({
      profileId: row.profileId,
      strategy: row.strategy,
      baselineStrategy: baseline?.strategy ?? null,
      cagr: row.performance.cagr,
      baselineCagr: baseline?.performance?.cagr ?? null,
      cagrExcess: baseline ? row.performance.cagr - baseline.performance.cagr : null,
      totalReturnExcess: baseline ? row.performance.totalReturn - baseline.performance.totalReturn : null,
      sharpeDelta: baseline && Number.isFinite(row.performance.annualizedSharpe)
        && Number.isFinite(baseline.performance.annualizedSharpe)
        ? row.performance.annualizedSharpe - baseline.performance.annualizedSharpe
        : null,
      drawdownImprovement: baseline
        ? baseline.performance.maximumDrawdown - row.performance.maximumDrawdown
        : null,
    });
  }).sort((a, b) =>
    (b.cagrExcess ?? Number.NEGATIVE_INFINITY) - (a.cagrExcess ?? Number.NEGATIVE_INFINITY)
    || b.cagr - a.cagr);
  return Object.freeze({
    comparisonOnly: true,
    noPromotionAuthority: true,
    passiveBaselines: Object.freeze(passive),
    highestCagrMeasuredProxy: byCagr[0] ?? null,
    highestSharpeMeasuredProxy: bySharpe[0] ?? null,
    activeVsPassive: Object.freeze(activeVsPassive),
  });
}

const startedAt = Date.now();
const profileReports = [];
const strategyRows = [];
const collectedCache = new Map();

for (const profile of BENCHMARK_PROFILE_PLAN) {
  if (profile.status === "BLOCKED_DATA") {
    profileReports.push(Object.freeze({
      ...profile,
      resultStatus: "BLOCKED_DATA",
      blockers: profile.blockers,
      coverage: null,
    }));
    continue;
  }

  try {
    let datasets;
    if (profile.market === "KR_STOCK" || profile.market === "US_STOCK") {
      const key = `${profile.market}:POSITION`;
      if (!collectedCache.has(key)) collectedCache.set(key, await collectStockProfile(profile.market));
      datasets = collectedCache.get(key);
    } else {
      const key = `${profile.market}:${profile.horizon}`;
      if (!collectedCache.has(key)) collectedCache.set(key, await collectCryptoProfile(profile.market, profile.horizon));
      datasets = collectedCache.get(key);
    }

    const coverage = profileCoverage(datasets);
    if (coverage.status !== "READY") {
      profileReports.push(Object.freeze({
        ...profile,
        resultStatus: "BLOCKED_DATA",
        blockers: coverage.blockers,
        coverage,
      }));
      continue;
    }

    profileReports.push(Object.freeze({
      ...profile,
      resultStatus: "READY",
      blockers: Object.freeze([]),
      coverage,
      basket: Object.freeze(datasets.map((row) => row.symbol)),
    }));

    const definition = BENCHMARK_HORIZONS[profile.horizon];
    const barsPerYear = barsPerYearForProfile(profile.market, profile.horizon);
    const longShort = profile.market === "CRYPTO_FUTURES";

    for (const costBps of COMMON_FRICTION_STRESS_BPS_PER_SIDE) {
      const buyHold = runEqualWeightBuyHoldBaseline({
        datasets,
        perSideCostBps: costBps,
        barsPerYear,
      });
      strategyRows.push(resultRow({
        profile,
        strategy: "EQUAL_WEIGHT_BUY_HOLD_BASELINE",
        costBps,
        result: buyHold,
        evidenceRole: "FIXED_BASKET_PASSIVE_BASELINE",
        sourceRecipeId: null,
      }));

      const tsmom = runTimeSeriesMomentumProxy({
        datasets,
        lookbackBars: definition.tsmomLookbackBars,
        perSideCostBps: costBps,
        longShort,
        barsPerYear,
      });
      strategyRows.push(resultRow({
        profile,
        strategy: "TSMOM_FIXED_PROXY",
        costBps,
        result: tsmom,
        evidenceRole: "LOCAL_FIXED_HORIZON_ADAPTATION_NOT_SOURCE_FAITHFUL_REPLICATION",
        sourceRecipeId: "TIME_SERIES_MOMENTUM_V1",
      }));

      const relative = runCrossSectionalMomentumProxy({
        datasets,
        lookbackBars: definition.tsmomLookbackBars,
        rebalanceBars: definition.rebalanceBars,
        perSideCostBps: costBps,
        longShort,
        barsPerYear,
      });
      strategyRows.push(resultRow({
        profile,
        strategy: "RELATIVE_MOMENTUM_PROXY",
        costBps,
        result: relative,
        evidenceRole: "FIXED_REPRESENTATIVE_BASKET_PROXY_NOT_PIT_UNIVERSE_REPLICATION",
        sourceRecipeId: profile.market === "CRYPTO_SPOT"
          ? "LIU_TSYVINSKI_WU_CRYPTO_CROSS_SECTIONAL_MOMENTUM_V1"
          : "CROSS_SECTIONAL_PRICE_MOMENTUM_V1",
      }));

      if (profile.market === "CRYPTO_SPOT") {
        const riskManaged = runCrossSectionalMomentumProxy({
          datasets,
          lookbackBars: definition.tsmomLookbackBars,
          rebalanceBars: definition.rebalanceBars,
          perSideCostBps: costBps,
          longShort: false,
          volatilityManaged: true,
          volatilityLookbackBars: Math.max(20, definition.rebalanceBars),
          targetAnnualVolatility: 0.15,
          barsPerYear,
        });
        strategyRows.push(resultRow({
          profile,
          strategy: "RISK_MANAGED_RELATIVE_MOMENTUM_PROXY",
          costBps,
          result: riskManaged,
          evidenceRole: "FIXED_BASKET_VOLATILITY_MANAGED_PROXY_NOT_PAPER_REPLICATION",
          sourceRecipeId: "CRYPTO_RISK_MANAGED_MOMENTUM_V1",
        }));
      }
    }
  } catch (error) {
    profileReports.push(Object.freeze({
      ...profile,
      resultStatus: "TECHNICAL_FAILURE",
      blockers: Object.freeze(["PUBLIC_DATA_OR_RUNTIME_FAILURE"]),
      error: serializeError(error),
    }));
  }
}

const cryptoPositionSpot = collectedCache.get("CRYPTO_SPOT:POSITION");
const cryptoPositionFutures = collectedCache.get("CRYPTO_FUTURES:POSITION");
if (cryptoPositionSpot && cryptoPositionFutures) {
  const spotBtc = cryptoPositionSpot.find((row) => row.symbol === "BTCUSDT");
  const futuresBtc = cryptoPositionFutures.find((row) => row.symbol === "BTCUSDT");
  if (spotBtc && futuresBtc) {
    const sameVenueBinance = String(spotBtc.provider).startsWith("binance-spot-public-rest")
      && String(futuresBtc.provider).startsWith("binance-usdm-public-rest");
    if (!sameVenueBinance) {
      strategyRows.push(Object.freeze({
        profileId: "CRYPTO_FUTURES:POSITION",
        market: "CRYPTO_FUTURES",
        horizon: "POSITION",
        timeframe: "1d",
        strategy: "SAME_VENUE_FUNDING_CARRY_PROXY",
        sourceRecipeId: "FUNDING_RATE_ARBITRAGE_CEX_DEX_V1",
        status: "BLOCKED_DATA",
        blockers: Object.freeze(["SAME_VENUE_BINANCE_SPOT_PERP_PRICE_PROVENANCE_REQUIRED"]),
        profitabilityCredit: 0,
        promotionEligible: false,
        executionAuthority: "NONE",
      }));
    } else try {
      const fundingRecords = await collectFundingRecords(
        BENCHMARK_PERIOD.startTime - 14 * DAY_MS,
        BENCHMARK_PERIOD.endTime,
      );
      const profile = BENCHMARK_PROFILE_PLAN.find((row) => row.profileId === "CRYPTO_FUTURES:POSITION");
      for (const costBps of COMMON_FRICTION_STRESS_BPS_PER_SIDE) {
        const carry = runFundingCarryProxy({
          spotCandles: spotBtc.candles,
          futuresCandles: futuresBtc.candles,
          fundingRecords,
          perSideCostBps: costBps,
          trailingFundingDays: 7,
        });
        strategyRows.push(resultRow({
          profile,
          strategy: "SAME_VENUE_FUNDING_CARRY_PROXY",
          costBps,
          result: carry,
          evidenceRole: "BINANCE_SPOT_PERP_DELTA_NEUTRAL_PROXY_NOT_CEX_DEX_SOURCE_REPLICATION",
          sourceRecipeId: "FUNDING_RATE_ARBITRAGE_CEX_DEX_V1",
        }));
      }
    } catch (error) {
      strategyRows.push(Object.freeze({
        profileId: "CRYPTO_FUTURES:POSITION",
        market: "CRYPTO_FUTURES",
        horizon: "POSITION",
        timeframe: "1d",
        strategy: "SAME_VENUE_FUNDING_CARRY_PROXY",
        sourceRecipeId: "FUNDING_RATE_ARBITRAGE_CEX_DEX_V1",
        status: "TECHNICAL_FAILURE",
        blockers: Object.freeze(["BINANCE_HISTORICAL_FUNDING_COLLECTION_FAILED"]),
        error: serializeError(error),
        profitabilityCredit: 0,
        promotionEligible: false,
        executionAuthority: "NONE",
      }));
    }
  }
}

const baseCostRows = strategyRows.filter((row) => row.commonFrictionBpsPerSide === 10);
const report = Object.freeze({
  schemaVersion: 1,
  contract: "evidence-backed-3y-benchmark/v1",
  status: profileReports.some((row) => row.resultStatus === "READY") ? "PASS_WITH_EXPLICIT_BLOCKS" : "BLOCKED_NO_MEASURED_PROFILE",
  generatedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  period: BENCHMARK_PERIOD,
  methodology: Object.freeze({
    exactThreeYearWindow: true,
    warmupExcludedFromReturns: true,
    commonFrictionStressBpsPerSide: COMMON_FRICTION_STRESS_BPS_PER_SIDE,
    marketSpecificFullCostClaimed: false,
    fixedRepresentativeStockBasket: true,
    pointInTimeFullUniverseClaimed: false,
    proxyResultsMayNotSetProfitabilityProven: true,
  }),
  profileReports: Object.freeze(profileReports),
  strategyRows: Object.freeze(strategyRows),
  sourceReferenceReadiness: SOURCE_REFERENCE_RECIPES,
  baseCostComparison: selectBenchmarkRows(baseCostRows),
  safety: benchmarkSafetyEnvelope(),
});

await save(OUTPUT, report);
console.log(JSON.stringify({
  status: report.status,
  output: OUTPUT,
  durationMs: report.durationMs,
  readyProfiles: report.profileReports.filter((row) => row.resultStatus === "READY").map((row) => row.profileId),
  blockedProfiles: report.profileReports.filter((row) => row.resultStatus !== "READY").map((row) => ({
    profileId: row.profileId,
    status: row.resultStatus,
    blockers: row.blockers,
  })),
  measuredRows: report.strategyRows.filter((row) => row.status === "MEASURED_PROXY").length,
  baseCostComparison: report.baseCostComparison,
}, null, 2));
