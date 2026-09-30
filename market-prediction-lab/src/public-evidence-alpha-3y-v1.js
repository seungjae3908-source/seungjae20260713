import {
  BENCHMARK_PERIOD,
  summarizePerformanceWindows,
  summarizeReturnSeries,
} from "./evidence-backed-3y-benchmark-v1.js";

export const PUBLIC_EVIDENCE_ALPHA_3Y_V1 = "public-evidence-alpha-3y-v1";

export const EVIDENCE_ALPHA_PARAMETERS = Object.freeze({
  stockRoundTripBps: 20,
  us: Object.freeze({
    gapThreshold: 0.0075,
    maximumGap: 0.10,
    priorRvolThreshold: 1.20,
    volumeLookback: 20,
    maxCandidates: 3,
  }),
  kr: Object.freeze({
    gapThreshold: 0.005,
    maximumGap: 0.10,
    maxCandidates: 3,
  }),
  crypto: Object.freeze({
    flowLookbackBars: 24,
    holdingBars: 4,
    flowThreshold: 0.03,
    perSideCostBps: 10,
  }),
});

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function intersectTimestamps(datasets) {
  if (!Array.isArray(datasets) || datasets.length === 0) return [];
  const maps = datasets.map(({ candles }) => new Map(candles.map((row) => [row.timestamp, row])));
  const first = [...maps[0].keys()].sort((a, b) => a - b);
  return first.filter((timestamp) => maps.every((map) => map.has(timestamp)));
}

function mapsBySymbol(datasets) {
  return Object.fromEntries(datasets.map(({ symbol, candles }) => [
    symbol,
    new Map(candles.map((row) => [row.timestamp, row])),
  ]));
}

function finalize({ family, observations, barsPerYear, details }) {
  const returns = observations.map((row) => row.return);
  return Object.freeze({
    family,
    researchOnly: true,
    sourceFaithfulReplication: false,
    executionAuthority: "NONE",
    profitabilityCredit: 0,
    promotionEligible: false,
    details: Object.freeze(details),
    performance: summarizeReturnSeries(returns, { barsPerYear }),
    periodAnalysis: summarizePerformanceWindows(observations),
  });
}

export function runUsPriorRvolGapContinuationProxy({
  datasets,
  startTime = BENCHMARK_PERIOD.startTime,
  endTime = BENCHMARK_PERIOD.endTime,
  parameters = EVIDENCE_ALPHA_PARAMETERS.us,
  roundTripBps = EVIDENCE_ALPHA_PARAMETERS.stockRoundTripBps,
} = {}) {
  if (!Array.isArray(datasets) || datasets.length < 2) throw new TypeError("US datasets must contain at least two symbols");
  const timestamps = intersectTimestamps(datasets);
  const maps = mapsBySymbol(datasets);
  const symbols = datasets.map((row) => row.symbol);
  const observations = [];
  let candidateDays = 0;
  let trades = 0;
  const cost = roundTripBps / 10_000;

  for (let index = parameters.volumeLookback + 2; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    if (timestamp < startTime) continue;
    if (timestamp > endTime) break;
    const previousTimestamp = timestamps[index - 1];
    const candidates = [];

    for (const symbol of symbols) {
      const today = maps[symbol].get(timestamp);
      const previous = maps[symbol].get(previousTimestamp);
      if (!today || !previous || !(today.open > 0 && today.close > 0 && previous.close > 0 && previous.open > 0)) continue;
      const historicalVolumes = [];
      for (let lookback = index - 1 - parameters.volumeLookback; lookback < index - 1; lookback += 1) {
        const row = maps[symbol].get(timestamps[lookback]);
        if (row && Number.isFinite(row.volume) && row.volume >= 0) historicalVolumes.push(row.volume);
      }
      if (historicalVolumes.length !== parameters.volumeLookback) continue;
      const averageVolume = mean(historicalVolumes);
      if (!(averageVolume > 0)) continue;
      const priorRvol = previous.volume / averageVolume;
      const gap = today.open / previous.close - 1;
      const priorBody = previous.close / previous.open - 1;
      if (Math.abs(gap) < parameters.gapThreshold || Math.abs(gap) > parameters.maximumGap) continue;
      if (priorRvol < parameters.priorRvolThreshold) continue;
      if (Math.sign(gap) === 0 || Math.sign(gap) !== Math.sign(priorBody)) continue;
      candidates.push({
        symbol,
        direction: Math.sign(gap),
        score: Math.abs(gap) * priorRvol,
        intradayReturn: Math.sign(gap) * (today.close / today.open - 1) - cost,
      });
    }

    candidates.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    const selected = candidates.slice(0, parameters.maxCandidates);
    if (selected.length) candidateDays += 1;
    trades += selected.length;
    observations.push(Object.freeze({
      timestamp,
      return: selected.length ? mean(selected.map((row) => row.intradayReturn)) : 0,
    }));
  }

  return finalize({
    family: "US_PRIOR_RVOL_GAP_CONTINUATION_PROXY",
    observations,
    barsPerYear: 252,
    details: {
      evidenceRole: "STOCKS_IN_PLAY_OPENING_CONTINUATION_PROXY",
      exactStocksInPlayReplication: false,
      missingSourceFaithfulInputs: [
        "POINT_IN_TIME_FULL_US_UNIVERSE",
        "EXACT_5M_OPENING_RANGE",
        "FIRST_5M_RELATIVE_VOLUME",
        "OPENING_AUCTION_IMBALANCE_HISTORY",
        "TRANSACTION_LEVEL_SHORT_FLOW",
      ],
      parameters,
      roundTripBps,
      candidateDays,
      trades,
      symbols,
    },
  });
}

export function runKrOvernightDaytimeReversalProxy({
  datasets,
  startTime = BENCHMARK_PERIOD.startTime,
  endTime = BENCHMARK_PERIOD.endTime,
  parameters = EVIDENCE_ALPHA_PARAMETERS.kr,
  roundTripBps = EVIDENCE_ALPHA_PARAMETERS.stockRoundTripBps,
} = {}) {
  if (!Array.isArray(datasets) || datasets.length < 2) throw new TypeError("KR datasets must contain at least two symbols");
  const timestamps = intersectTimestamps(datasets);
  const maps = mapsBySymbol(datasets);
  const symbols = datasets.map((row) => row.symbol);
  const observations = [];
  let candidateDays = 0;
  let trades = 0;
  const cost = roundTripBps / 10_000;

  for (let index = 1; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    if (timestamp < startTime) continue;
    if (timestamp > endTime) break;
    const previousTimestamp = timestamps[index - 1];
    const candidates = [];
    for (const symbol of symbols) {
      const today = maps[symbol].get(timestamp);
      const previous = maps[symbol].get(previousTimestamp);
      if (!today || !previous || !(today.open > 0 && today.close > 0 && previous.close > 0)) continue;
      const gap = today.open / previous.close - 1;
      if (Math.abs(gap) < parameters.gapThreshold || Math.abs(gap) > parameters.maximumGap) continue;
      candidates.push({
        symbol,
        score: Math.abs(gap),
        intradayReturn: -Math.sign(gap) * (today.close / today.open - 1) - cost,
      });
    }
    candidates.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    const selected = candidates.slice(0, parameters.maxCandidates);
    if (selected.length) candidateDays += 1;
    trades += selected.length;
    observations.push(Object.freeze({
      timestamp,
      return: selected.length ? mean(selected.map((row) => row.intradayReturn)) : 0,
    }));
  }

  return finalize({
    family: "KR_OVERNIGHT_DAYTIME_REVERSAL_PROXY",
    observations,
    barsPerYear: 252,
    details: {
      evidenceRole: "KOREA_OVERNIGHT_DAYTIME_REVERSAL_PROXY",
      exactInvestorFlowRouterReplication: false,
      missingSourceFaithfulInputs: [
        "POINT_IN_TIME_INVESTOR_COUNTERPARTY_ORDER_FLOW",
        "POINT_IN_TIME_FOREIGN_HOLDINGS_AND_SHORT_INTEREST_NAT",
        "FIRST_30M_INTRADAY_BARS",
      ],
      parameters,
      roundTripBps,
      candidateDays,
      trades,
      symbols,
    },
  });
}

function flowScore(candles, index, lookbackBars) {
  if (index < lookbackBars) return null;
  let volume = 0;
  let takerBuy = 0;
  for (let cursor = index - lookbackBars; cursor < index; cursor += 1) {
    const row = candles[cursor];
    if (!row || !(row.volume >= 0) || !(row.takerBuyVolume >= 0)) return null;
    volume += row.volume;
    takerBuy += row.takerBuyVolume;
  }
  if (!(volume > 0)) return null;
  return (2 * takerBuy - volume) / volume;
}

function fundingBetween(records, startExclusive, endInclusive) {
  return (records ?? [])
    .filter((row) => row.timestamp > startExclusive && row.timestamp <= endInclusive)
    .reduce((sum, row) => sum + row.rate, 0);
}

export function runCryptoOrderFlowProxy({
  datasets,
  market,
  fundingBySymbol = {},
  startTime = BENCHMARK_PERIOD.startTime,
  endTime = BENCHMARK_PERIOD.endTime,
  parameters = EVIDENCE_ALPHA_PARAMETERS.crypto,
} = {}) {
  if (!Array.isArray(datasets) || datasets.length < 2) throw new TypeError("crypto datasets must contain at least two symbols");
  if (!["CRYPTO_SPOT", "CRYPTO_FUTURES"].includes(market)) throw new TypeError("market must be CRYPTO_SPOT or CRYPTO_FUTURES");
  const timestamps = intersectTimestamps(datasets);
  const maps = mapsBySymbol(datasets);
  const arrays = Object.fromEntries(datasets.map((row) => [row.symbol, row.candles]));
  const symbols = datasets.map((row) => row.symbol);
  const costRate = parameters.perSideCostBps / 10_000;
  const observations = [];
  let weights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  let rebalanceCount = 0;
  let activeIntervals = 0;

  for (let index = parameters.flowLookbackBars; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    if (timestamp < startTime) continue;
    if (timestamp > endTime) break;
    const previousTimestamp = timestamps[index - 1];
    let turnover = 0;

    if ((index - parameters.flowLookbackBars) % parameters.holdingBars === 0) {
      const scored = symbols.map((symbol) => ({
        symbol,
        score: flowScore(arrays[symbol], index, parameters.flowLookbackBars),
      })).filter((row) => Number.isFinite(row.score))
        .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
      const next = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
      if (market === "CRYPTO_SPOT") {
        const top = scored[0];
        if (top && top.score >= parameters.flowThreshold) next[top.symbol] = 1;
      } else {
        const top = scored[0];
        const bottom = scored.at(-1);
        const longOk = top && top.score >= parameters.flowThreshold;
        const shortOk = bottom && bottom.score <= -parameters.flowThreshold;
        if (longOk && shortOk && top.symbol !== bottom.symbol) {
          next[top.symbol] = 0.5;
          next[bottom.symbol] = -0.5;
        } else if (longOk) next[top.symbol] = 1;
        else if (shortOk) next[bottom.symbol] = -1;
      }
      turnover = symbols.reduce((sum, symbol) => sum + Math.abs(next[symbol] - weights[symbol]), 0);
      weights = next;
      rebalanceCount += 1;
    }

    let intervalReturn = -turnover * costRate;
    let grossExposure = 0;
    for (const symbol of symbols) {
      const weight = weights[symbol];
      grossExposure += Math.abs(weight);
      if (weight === 0) continue;
      const previous = maps[symbol].get(previousTimestamp);
      const current = maps[symbol].get(timestamp);
      if (!(previous?.close > 0 && current?.close > 0)) continue;
      intervalReturn += weight * (current.close / previous.close - 1);
      if (market === "CRYPTO_FUTURES") {
        intervalReturn += -weight * fundingBetween(fundingBySymbol[symbol], previousTimestamp, timestamp);
      }
    }
    if (grossExposure > 0) activeIntervals += 1;
    observations.push(Object.freeze({ timestamp, return: intervalReturn }));
  }

  return finalize({
    family: market === "CRYPTO_SPOT"
      ? "CRYPTO_SPOT_TAKER_FLOW_SELECTIVE_LONG_PROXY"
      : "CRYPTO_FUTURES_TAKER_FLOW_FUNDING_LONG_SHORT_PROXY",
    observations,
    barsPerYear: 365 * 24,
    details: {
      evidenceRole: market === "CRYPTO_SPOT"
        ? "ORDER_FLOW_CROSS_SECTIONAL_SELECTIVE_LONG_PROXY"
        : "ORDER_FLOW_PLUS_FUNDING_INTRADAY_LONG_SHORT_PROXY",
      exactGlobalOrderFlowPaperReplication: false,
      missingSourceFaithfulInputs: market === "CRYPTO_SPOT"
        ? ["84_COIN_GLOBAL_MULTI_EXCHANGE_ORDER_FLOW", "NONLINEAR_ML_MODEL"]
        : ["MULTI_VENUE_L2_DEPTH", "OPEN_INTEREST_HISTORY", "LIQUIDATION_HISTORY", "PRESSURE_VS_ABSORPTION"],
      parameters,
      rebalanceCount,
      activeIntervals,
      symbols,
      fundingIncluded: market === "CRYPTO_FUTURES",
    },
  });
}

export function evidenceAlphaSafety() {
  return Object.freeze({
    researchOnly: true,
    profitabilityProven: false,
    economicCreditGranted: false,
    automaticActivationAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  });
}
