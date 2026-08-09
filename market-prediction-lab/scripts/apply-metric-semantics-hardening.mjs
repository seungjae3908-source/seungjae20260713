import { readFile, writeFile } from "node:fs/promises";

async function patch(path, transforms) {
  let text = await readFile(path, "utf8");
  for (const [label, before, after] of transforms) {
    const count = text.split(before).length - 1;
    if (count !== 1) throw new Error(`${path}: ${label} expected exactly once, found ${count}`);
    text = text.replace(before, after);
  }
  await writeFile(path, text, "utf8");
}

await patch("src/multi-market-backtest-engine.js", [
  [
    "metric import",
    `import {\n  calculateExecutionAwareTrade,\n  summarizeResearchPerformance,\n} from "./research-validation-layer.js";`,
    `import {\n  calculateExecutionAwareTrade,\n  summarizeResearchPerformance,\n} from "./research-validation-layer.js";\nimport { summarizeTradeOutcomeMetrics } from "./research-metric-semantics.js";`,
  ],
  [
    "year success semantics",
    `      successRate: summary.winRate,\n      netPnl: summary.netPnl,`,
    `      successRateDefinition: "tp_before_sl_resolved_barriers",\n      successRate: summarizeTradeOutcomeMetrics(yearTrades).tpBeforeSlRate,\n      netProfitableTradeRate: summary.winRate,\n      netPnl: summary.netPnl,`,
  ],
  [
    "single backtest metric calculation",
    `  const performance = summarizeResearchPerformance(orderedTrades, { initialCapital });\n  const overall = performance.overall;\n  return Object.freeze({`,
    `  const performance = summarizeResearchPerformance(orderedTrades, { initialCapital });\n  const overall = performance.overall;\n  const outcomeMetrics = summarizeTradeOutcomeMetrics(orderedTrades);\n  return Object.freeze({`,
  ],
  [
    "single backtest success output",
    `    successRatePercent: overall.winRate * 100,\n    totalTrades: overall.sampleCount,`,
    `    successRateDefinition: outcomeMetrics.successRateDefinition,\n    successRatePercent: outcomeMetrics.tpBeforeSlRate * 100,\n    tpBeforeSlRatePercent: outcomeMetrics.tpBeforeSlRate * 100,\n    tpBeforeSlRateAvailable: outcomeMetrics.tpBeforeSlRateAvailable,\n    netProfitableRateDefinition: outcomeMetrics.netProfitableRateDefinition,\n    netProfitableTradeRatePercent: outcomeMetrics.netProfitableTradeRate * 100,\n    barrierResolvedTradeCount: outcomeMetrics.barrierResolvedTradeCount,\n    tpHitCount: outcomeMetrics.tpHitCount,\n    slHitCount: outcomeMetrics.slHitCount,\n    censoredTradeCount: outcomeMetrics.censoredCount,\n    totalTrades: overall.sampleCount,`,
  ],
  [
    "universe metric calculation",
    `  const trades = Object.freeze(symbolResults.flatMap((result) => result.trades).sort((left, right) => left.exitTime - right.exitTime || left.id.localeCompare(right.id)));\n  const performance = summarizeResearchPerformance(trades, { initialCapital });\n  const bySymbol = Object.freeze(Object.fromEntries(symbolResults.map((result) => [result.symbol, Object.freeze({`,
    `  const trades = Object.freeze(symbolResults.flatMap((result) => result.trades).sort((left, right) => left.exitTime - right.exitTime || left.id.localeCompare(right.id)));\n  const performance = summarizeResearchPerformance(trades, { initialCapital });\n  const outcomeMetrics = summarizeTradeOutcomeMetrics(trades);\n  const bySymbol = Object.freeze(Object.fromEntries(symbolResults.map((result) => [result.symbol, Object.freeze({`,
  ],
  [
    "universe by symbol metrics",
    `    totalReturnPercent: result.totalReturnPercent,\n    successRatePercent: result.successRatePercent,\n    totalTrades: result.totalTrades,`,
    `    totalReturnPercent: result.totalReturnPercent,\n    successRateDefinition: result.successRateDefinition,\n    successRatePercent: result.successRatePercent,\n    tpBeforeSlRatePercent: result.tpBeforeSlRatePercent,\n    netProfitableTradeRatePercent: result.netProfitableTradeRatePercent,\n    totalTrades: result.totalTrades,`,
  ],
  [
    "universe success output",
    `    totalReturnPercent: performance.overall.totalReturn * 100,\n    successRatePercent: performance.overall.winRate * 100,\n    totalTrades: performance.overall.sampleCount,`,
    `    totalReturnPercent: performance.overall.totalReturn * 100,\n    successRateDefinition: outcomeMetrics.successRateDefinition,\n    successRatePercent: outcomeMetrics.tpBeforeSlRate * 100,\n    tpBeforeSlRatePercent: outcomeMetrics.tpBeforeSlRate * 100,\n    tpBeforeSlRateAvailable: outcomeMetrics.tpBeforeSlRateAvailable,\n    netProfitableTradeRatePercent: outcomeMetrics.netProfitableTradeRate * 100,\n    barrierResolvedTradeCount: outcomeMetrics.barrierResolvedTradeCount,\n    tpHitCount: outcomeMetrics.tpHitCount,\n    slHitCount: outcomeMetrics.slHitCount,\n    censoredTradeCount: outcomeMetrics.censoredCount,\n    totalTrades: performance.overall.sampleCount,`,
  ],
  [
    "comparison semantics",
    `    objective: "joint_return_and_success_rate",\n    note: "No scalar score is used; return and success rate must be reviewed together with drawdown and sample size.",`,
    `    objective: "joint_return_and_tp_before_sl_success_rate",\n    successRateDefinition: "tp_before_sl_resolved_barriers",\n    note: "No scalar score is used; return and TP-before-SL success rate must be reviewed together with drawdown and sample size.",`,
  ],
  [
    "table metrics",
    `    netReturnPercent: result.totalReturnPercent,\n    successRatePercent: result.successRatePercent,\n    profitFactor: result.profitFactor,`,
    `    netReturnPercent: result.totalReturnPercent,\n    successRateDefinition: result.successRateDefinition,\n    successRatePercent: result.successRatePercent,\n    tpBeforeSlRatePercent: result.tpBeforeSlRatePercent,\n    netProfitableTradeRatePercent: result.netProfitableTradeRatePercent,\n    profitFactor: result.profitFactor,`,
  ],
]);

await patch("src/independent-strategy-backtest.js", [
  [
    "metric import",
    `import {\n  calculateExecutionAwareTrade,\n  summarizeResearchPerformance,\n} from "./research-validation-layer.js";`,
    `import {\n  calculateExecutionAwareTrade,\n  summarizeResearchPerformance,\n} from "./research-validation-layer.js";\nimport { summarizeTradeOutcomeMetrics } from "./research-metric-semantics.js";`,
  ],
  [
    "outcome calculation",
    `  const performance = summarizeResearchPerformance(orderedTrades, { initialCapital });\n  const overall = performance.overall;\n  return Object.freeze({`,
    `  const performance = summarizeResearchPerformance(orderedTrades, { initialCapital });\n  const overall = performance.overall;\n  const outcomeMetrics = summarizeTradeOutcomeMetrics(orderedTrades);\n  return Object.freeze({`,
  ],
  [
    "success output",
    `    totalReturnPercent: overall.totalReturn * 100,\n    successRatePercent: overall.winRate * 100,\n    profitFactor: overall.profitFactor,`,
    `    totalReturnPercent: overall.totalReturn * 100,\n    successRateDefinition: outcomeMetrics.successRateDefinition,\n    successRatePercent: outcomeMetrics.tpBeforeSlRate * 100,\n    tpBeforeSlRatePercent: outcomeMetrics.tpBeforeSlRate * 100,\n    tpBeforeSlRateAvailable: outcomeMetrics.tpBeforeSlRateAvailable,\n    netProfitableRateDefinition: outcomeMetrics.netProfitableRateDefinition,\n    netProfitableTradeRatePercent: outcomeMetrics.netProfitableTradeRate * 100,\n    barrierResolvedTradeCount: outcomeMetrics.barrierResolvedTradeCount,\n    tpHitCount: outcomeMetrics.tpHitCount,\n    slHitCount: outcomeMetrics.slHitCount,\n    censoredTradeCount: outcomeMetrics.censoredCount,\n    profitFactor: overall.profitFactor,`,
  ],
]);

await patch("src/final-holdout-evaluator.js", [
  [
    "compact metric semantics",
    `    returnPercent: result.totalReturnPercent,\n    successRatePercent: result.successRatePercent,\n    profitFactor: result.profitFactor,`,
    `    returnPercent: result.totalReturnPercent,\n    successRateDefinition: result.successRateDefinition,\n    successRatePercent: result.successRatePercent,\n    tpBeforeSlRatePercent: result.tpBeforeSlRatePercent,\n    netProfitableTradeRatePercent: result.netProfitableTradeRatePercent,\n    barrierResolvedTradeCount: result.barrierResolvedTradeCount,\n    tpHitCount: result.tpHitCount,\n    slHitCount: result.slHitCount,\n    censoredTradeCount: result.censoredTradeCount,\n    profitFactor: result.profitFactor,`,
  ],
]);

await patch("src/eth-v6-forward-validation.js", [
  [
    "metric imports",
    `import { ResearchContractError } from "./research-governance.js";`,
    `import { ResearchContractError } from "./research-governance.js";\nimport {\n  buildStandardizedResearchMetrics,\n  evaluateForwardPromotionGate,\n} from "./research-metric-semantics.js";`,
  ],
  [
    "shadow trade exit reason",
    `    regime: "forward_shadow",\n    netPnl: record.hypotheticalPnl,`,
    `    regime: "forward_shadow",\n    exitReason: record.subsequentMarketResult?.exitReason ?? null,\n    netPnl: record.hypotheticalPnl,`,
  ],
  [
    "forward standardized metrics",
    `  const performance = summarizeResearchPerformance(trades, { initialCapital: state.paper.initialCapital }).overall;\n  const elapsedMs = Math.max(0, state.updatedAt - state.startedAt);\n  const researchSample = performance.sampleCount >= 30;\n  return Object.freeze({`,
    `  const performance = summarizeResearchPerformance(trades, { initialCapital: state.paper.initialCapital }).overall;\n  const elapsedMs = Math.max(0, state.updatedAt - state.startedAt);\n  const elapsedDays = elapsedMs / DAY_MS;\n  const standardizedMetrics = buildStandardizedResearchMetrics({\n    trades,\n    initialCapital: state.paper.initialCapital,\n    totalReturnPercent: performance.totalReturn * 100,\n    profitFactor: performance.profitFactor,\n    maximumDrawdownPercent: performance.maximumDrawdownPercent * 100,\n    expectancy: performance.expectancy,\n  });\n  const promotionGate = evaluateForwardPromotionGate({\n    metrics: standardizedMetrics,\n    elapsedDays,\n    safeguards: state.safeguards,\n  });\n  const researchSample = performance.sampleCount >= 30;\n  return Object.freeze({`,
  ],
  [
    "forward metric output",
    `    totalReturnPercent: performance.totalReturn * 100,\n    successRatePercent: performance.winRate * 100,\n    profitFactor: performance.profitFactor,\n    maximumDrawdownPercent: performance.maximumDrawdownPercent * 100,\n    expectancy: performance.expectancy,\n    elapsedDays: elapsedMs / DAY_MS,\n    researchSampleSufficient: researchSample,\n    status: researchSample ? "shadow_evidence_available" : "shadow_continue",\n    nextStage: researchSample ? "manual_review" : "paper_shadow",\n    safeguards: state.safeguards,`,
    `    totalReturnPercent: standardizedMetrics.totalReturnPercent,\n    successRateDefinition: standardizedMetrics.successRateDefinition,\n    successRatePercent: standardizedMetrics.successRatePercent,\n    tpBeforeSlRatePercent: standardizedMetrics.tpBeforeSlRatePercent,\n    tpBeforeSlRateAvailable: standardizedMetrics.tpBeforeSlRateAvailable,\n    netProfitableTradeRatePercent: standardizedMetrics.netProfitableTradeRatePercent,\n    barrierResolvedTradeCount: standardizedMetrics.barrierResolvedTradeCount,\n    tpHitCount: standardizedMetrics.tpHitCount,\n    slHitCount: standardizedMetrics.slHitCount,\n    censoredTradeCount: standardizedMetrics.censoredCount,\n    profitFactor: standardizedMetrics.profitFactor,\n    maximumDrawdownPercent: standardizedMetrics.maximumDrawdownPercent,\n    expectancy: standardizedMetrics.expectancy,\n    costStress: standardizedMetrics.costStress,\n    elapsedDays,\n    researchSampleSufficient: researchSample,\n    status: promotionGate.status,\n    nextStage: promotionGate.nextStage,\n    promotionGate,\n    safeguards: state.safeguards,`,
  ],
]);

await patch("scripts/run-eth-v6-replay-proof.js", [
  [
    "replay compact metrics",
    `    returnPercent: metrics.returnPercent,\n    successRatePercent: metrics.successRatePercent,\n    profitFactor: metrics.profitFactor,`,
    `    returnPercent: metrics.returnPercent,\n    successRateDefinition: metrics.successRateDefinition,\n    successRatePercent: metrics.successRatePercent,\n    tpBeforeSlRatePercent: metrics.tpBeforeSlRatePercent,\n    netProfitableTradeRatePercent: metrics.netProfitableTradeRatePercent,\n    profitFactor: metrics.profitFactor,`,
  ],
  [
    "legacy replay comparison adapter",
    `const actual = compact(result);\nconst comparison = compareReplayMetrics(expected, actual, 1e-8);\nconst proof = Object.freeze({`,
    `const actual = compact(result);\nconst expectedUsesLegacySuccessSemantics = !expected.successRateDefinition;\nconst comparisonActual = expectedUsesLegacySuccessSemantics\n  ? Object.freeze({ ...actual, successRatePercent: actual.netProfitableTradeRatePercent })\n  : actual;\nconst comparison = compareReplayMetrics(expected, comparisonActual, 1e-8);\nconst proof = Object.freeze({`,
  ],
  [
    "proof semantic metadata",
    `  replayOf: "2026-one-shot-final-holdout",\n  status: comparison.passed ? "passed" : "failed",`,
    `  replayOf: "2026-one-shot-final-holdout",\n  status: comparison.passed ? "passed" : "failed",\n  metricSemantics: Object.freeze({\n    currentSuccessRateDefinition: actual.successRateDefinition,\n    storedExpectedUsedLegacyNetPositiveRate: expectedUsesLegacySuccessSemantics,\n    historicalArtifactMutated: false,\n  }),`,
  ],
]);

console.log("research metric semantics hardening applied");
