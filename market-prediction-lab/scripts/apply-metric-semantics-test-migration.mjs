import { readFile, writeFile } from "node:fs/promises";

const path = "tests/multi-market-backtest-engine.test.js";
let text = await readFile(path, "utf8");

function replaceRequired(label, before, after) {
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(`${label} expected exactly once, found ${count}`);
  text = text.replace(before, after);
}

replaceRequired(
  "success semantics test",
  `test("fees, spread and slippage lower realized performance and success is based on net PnL", () => {\n  const input = baseInput({});\n  const free = runV1Backtest(input);\n  const costly = runV1Backtest({\n    ...input,\n    costModel: {\n      entryFeeRate: 0.002,\n      exitFeeRate: 0.002,\n      taxRate: 0.001,\n      slippageRate: 0.002,\n      spreadRate: 0.002,\n      latencyBars: 1,\n      latencyDriftRate: 0.001,\n    },\n  });\n  assert.ok(costly.netPnl < free.netPnl);\n  assert.ok(costly.totalExecutionCost > free.totalExecutionCost);\n  assert.equal(costly.successRatePercent, costly.trades.filter((trade) => trade.netPnl > 0).length / costly.totalTrades * 100);\n});`,
  `test("fees, spread and slippage lower realized performance while TP success stays separate from net-profitable rate", () => {\n  const input = baseInput({});\n  const free = runV1Backtest(input);\n  const costly = runV1Backtest({\n    ...input,\n    costModel: {\n      entryFeeRate: 0.002,\n      exitFeeRate: 0.002,\n      taxRate: 0.001,\n      slippageRate: 0.002,\n      spreadRate: 0.002,\n      latencyBars: 1,\n      latencyDriftRate: 0.001,\n    },\n  });\n  assert.ok(costly.netPnl < free.netPnl);\n  assert.ok(costly.totalExecutionCost > free.totalExecutionCost);\n  const resolved = costly.trades.filter((trade) => ["take_profit", "take_profit_gap", "stop_loss", "stop_loss_gap", "stop_loss_same_bar"].includes(trade.exitReason));\n  const tpHits = resolved.filter((trade) => ["take_profit", "take_profit_gap"].includes(trade.exitReason));\n  assert.equal(costly.successRateDefinition, "tp_before_sl_resolved_barriers");\n  assert.equal(costly.successRatePercent, resolved.length ? tpHits.length / resolved.length * 100 : 0);\n  assert.equal(costly.netProfitableTradeRatePercent, costly.trades.filter((trade) => trade.netPnl > 0).length / costly.totalTrades * 100);\n});`,
);

replaceRequired(
  "table columns",
  `    "netReturnPercent",\n    "successRatePercent",\n    "profitFactor",`,
  `    "netReturnPercent",\n    "successRateDefinition",\n    "successRatePercent",\n    "tpBeforeSlRatePercent",\n    "netProfitableTradeRatePercent",\n    "profitFactor",`,
);

await writeFile(path, text, "utf8");
console.log("legacy success-rate assertions migrated");
