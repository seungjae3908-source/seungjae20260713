import { createHash } from "node:crypto";
import { ResearchContractError } from "./research-governance.js";
import { RESEARCH_BACKTEST_PERIOD, runV1Backtest } from "./multi-market-backtest-engine.js";
import { runIndependentSignalFinalHoldout } from "./independent-strategy-backtest.js";
import { calculateV6Signal } from "./v6-independent-breakout-retest-optimizer.js";

export const FINAL_HOLDOUT_START = RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime;
// At the approved one-shot evaluation time (2026-08-09 08:34 KST),
// 2026-08-07 is the latest common fully closed UTC daily candle already
// demonstrated by the spot dataset. The final holdout is therefore fixed here
// before reading any 2026 candidate result.
export const FINAL_HOLDOUT_END = Date.UTC(2026, 7, 8) - 1;
export const FINAL_HOLDOUT_WARMUP_START = Date.UTC(2025, 8, 1);

const SELECTION_EVIDENCE = Object.freeze({
  v2ResultMarkdownBlobSha: "97145f64022d88913371c0dc108d0fa8c985582e",
  v6ResultMarkdownBlobSha: "0cc305b3c945887db361d2ed7e420565c57220d9",
  selectionDataEnd: Date.UTC(2026, 0, 1) - 1,
  finalHoldoutUsedForSelection: false,
});

export const FROZEN_FINAL_HOLDOUT_CANDIDATES = Object.freeze([
  Object.freeze({
    id: "btc-spot-long-v2",
    market: "CRYPTO_SPOT",
    symbol: "USDT-BTC",
    exchangeSymbol: "BTCUSDT",
    side: "long",
    version: "V2",
    strategy: "v1_ema_atr",
    entryModel: "ema_pullback",
    parameters: Object.freeze({ fastPeriod: 10, slowPeriod: 80, atrPeriod: 14, pullbackTolerancePct: 1, stopAtrMultiple: 1.5, targetRiskMultiple: 2 }),
  }),
  Object.freeze({
    id: "btc-futures-long-v2",
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    exchangeSymbol: "BTCUSDT",
    side: "long",
    version: "V2",
    strategy: "v1_ema_atr",
    entryModel: "ema_pullback",
    parameters: Object.freeze({ fastPeriod: 8, slowPeriod: 30, atrPeriod: 14, pullbackTolerancePct: 0.75, stopAtrMultiple: 2, targetRiskMultiple: 3 }),
  }),
  Object.freeze({
    id: "btc-futures-short-v2",
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    exchangeSymbol: "BTCUSDT",
    side: "short",
    version: "V2",
    strategy: "v1_ema_atr",
    entryModel: "ema_pullback",
    parameters: Object.freeze({ fastPeriod: 12, slowPeriod: 30, atrPeriod: 14, pullbackTolerancePct: 0.25, stopAtrMultiple: 1.5, targetRiskMultiple: 3 }),
  }),
  Object.freeze({
    id: "eth-spot-long-v6",
    market: "CRYPTO_SPOT",
    symbol: "USDT-ETH",
    exchangeSymbol: "ETHUSDT",
    side: "long",
    version: "V6",
    strategy: "v6_independent_breakout_retest",
    entryModel: "breakout_retest_directional_body",
    parameters: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 1.25, targetRiskMultiple: 2.5 }),
    filter: Object.freeze({ structureLookback: 20, breakoutRecencyBars: 1, retestToleranceAtr: 0.5, confirmationMode: "directional_body" }),
  }),
  Object.freeze({
    id: "eth-futures-long-v6",
    market: "CRYPTO_FUTURES",
    symbol: "ETHUSDT",
    exchangeSymbol: "ETHUSDT",
    side: "long",
    version: "V6",
    strategy: "v6_independent_breakout_retest",
    entryModel: "breakout_retest_directional_body",
    parameters: Object.freeze({ atrPeriod: 14, stopAtrMultiple: 1, targetRiskMultiple: 2 }),
    filter: Object.freeze({ structureLookback: 10, breakoutRecencyBars: 1, retestToleranceAtr: 0.5, confirmationMode: "directional_body" }),
  }),
]);

function stableCandidateManifest() {
  return JSON.stringify(FROZEN_FINAL_HOLDOUT_CANDIDATES.map((candidate) => ({
    id: candidate.id,
    market: candidate.market,
    symbol: candidate.symbol,
    side: candidate.side,
    version: candidate.version,
    strategy: candidate.strategy,
    entryModel: candidate.entryModel,
    parameters: candidate.parameters,
    filter: candidate.filter ?? null,
  })));
}

export const FROZEN_CANDIDATE_MANIFEST_SHA256 = createHash("sha256").update(stableCandidateManifest()).digest("hex");

export function buildFinalHoldoutPeriod(endTime = FINAL_HOLDOUT_END) {
  if (!Number.isInteger(endTime) || endTime < FINAL_HOLDOUT_START || endTime > FINAL_HOLDOUT_END) {
    throw new ResearchContractError("INVALID_FINAL_HOLDOUT_END", "final holdout end must be within the predeclared one-shot window", { endTime, maximum: FINAL_HOLDOUT_END });
  }
  return Object.freeze({
    startTime: FINAL_HOLDOUT_START,
    endTime,
    includeFinalHoldout: true,
  });
}

function compact(result) {
  return Object.freeze({
    initialCapital: result.initialCapital,
    finalCapital: result.finalCapital,
    returnPercent: result.totalReturnPercent,
    successRateDefinition: result.successRateDefinition,
    successRatePercent: result.successRatePercent,
    tpBeforeSlRatePercent: result.tpBeforeSlRatePercent,
    netProfitableTradeRatePercent: result.netProfitableTradeRatePercent,
    barrierResolvedTradeCount: result.barrierResolvedTradeCount,
    tpHitCount: result.tpHitCount,
    slHitCount: result.slHitCount,
    censoredTradeCount: result.censoredTradeCount,
    profitFactor: result.profitFactor,
    maximumDrawdownPercent: result.maximumDrawdownPercent,
    expectancy: result.expectancy,
    trades: result.totalTrades,
  });
}

export function classifyFinalHoldout(result) {
  if (!result || typeof result !== "object") throw new ResearchContractError("INVALID_FINAL_HOLDOUT_RESULT", "holdout result is required");
  const trades = Number(result.totalTrades ?? 0);
  const returnPercent = Number(result.totalReturnPercent ?? 0);
  const expectancy = Number(result.expectancy ?? 0);
  const profitFactor = Number(result.profitFactor);
  if (trades === 0) {
    return Object.freeze({ effect: "no_signals", sample: "insufficient", promotionEvidence: false });
  }
  const pfPositive = profitFactor > 1 || profitFactor === Number.POSITIVE_INFINITY;
  const positive = returnPercent > 0 && expectancy > 0 && pfPositive;
  const sample = trades < 10 ? "low" : trades < 30 ? "limited" : "research_sufficient";
  return Object.freeze({
    effect: positive ? "positive" : "negative_or_unstable",
    sample,
    promotionEvidence: positive && trades >= 30,
  });
}

function assertInputMatchesCandidate(candidate, backtestInput) {
  if (!candidate || !FROZEN_FINAL_HOLDOUT_CANDIDATES.some((row) => row.id === candidate.id)) {
    throw new ResearchContractError("UNFROZEN_FINAL_HOLDOUT_CANDIDATE", "candidate must be one of the pre-2026 frozen candidates");
  }
  if (backtestInput.market !== candidate.market || backtestInput.symbol !== candidate.symbol || (backtestInput.side ?? "long") !== candidate.side) {
    throw new ResearchContractError("FINAL_HOLDOUT_CANDIDATE_INPUT_MISMATCH", "backtest input must match the frozen candidate", {
      candidate: candidate.id,
      market: backtestInput.market,
      symbol: backtestInput.symbol,
      side: backtestInput.side,
    });
  }
}

export function runFrozenFinalHoldout({ candidate, backtestInput, endTime = FINAL_HOLDOUT_END } = {}) {
  if (!backtestInput || typeof backtestInput !== "object") throw new ResearchContractError("INVALID_FINAL_HOLDOUT_INPUT", "backtestInput is required");
  assertInputMatchesCandidate(candidate, backtestInput);
  const period = buildFinalHoldoutPeriod(endTime);
  let result;
  if (candidate.version === "V2") {
    result = runV1Backtest({
      ...backtestInput,
      parameters: candidate.parameters,
      period,
    });
  } else if (candidate.version === "V6") {
    result = runIndependentSignalFinalHoldout({
      backtestInput,
      strategy: candidate.strategy,
      strategyVersion: "V6_FINAL_HOLDOUT",
      parameters: candidate.parameters,
      period,
      signalEvaluator: ({ side, candles, atr, index }) => calculateV6Signal({ side, candles, atr, index, filter: candidate.filter }),
    });
  } else {
    throw new ResearchContractError("UNSUPPORTED_FROZEN_VERSION", `unsupported frozen version: ${candidate.version}`);
  }
  if (result.trades.some((trade) => trade.signalTime < FINAL_HOLDOUT_START || trade.phase !== "final_holdout")) {
    throw new ResearchContractError("FINAL_HOLDOUT_TRADE_LEAKAGE", "final holdout contains a trade outside the 2026 holdout");
  }
  const assessment = classifyFinalHoldout(result);
  return Object.freeze({
    schemaVersion: 1,
    mode: "backtest-only",
    evaluation: "one-shot-final-holdout",
    candidate: Object.freeze({ ...candidate }),
    candidateManifestSha256: FROZEN_CANDIDATE_MANIFEST_SHA256,
    selectionEvidence: SELECTION_EVIDENCE,
    period: Object.freeze({ ...period }),
    metrics: compact(result),
    assessment,
    trades: result.trades,
    safeguards: Object.freeze({
      candidateGridUsed: false,
      optimizerUsed: false,
      parametersChangedFromFrozenSelection: false,
      finalHoldoutUsedForSelection: false,
      finalHoldoutRetuningAllowed: false,
      orderSubmitted: false,
      privateAccountRequestAllowed: false,
      liveOrderAllowed: false,
    }),
  });
}
