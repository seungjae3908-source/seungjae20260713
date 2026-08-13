import { AUTOMATED_RESEARCH_GROUPS } from "./automated-research-orchestrator.js";

const MID_LONG_GROUPS = Object.freeze([
  Object.freeze({ id: "KR_STOCK_MID_LONG", market: "KR_STOCK", strategyType: "MID_LONG", direction: "LONG" }),
  Object.freeze({ id: "US_STOCK_MID_LONG", market: "US_STOCK", strategyType: "MID_LONG", direction: "LONG" }),
  Object.freeze({ id: "CRYPTO_SPOT_MID_LONG", market: "CRYPTO_SPOT", strategyType: "MID_LONG", direction: "LONG" }),
  Object.freeze({ id: "CRYPTO_FUTURES_MID_LONG_LONG", market: "CRYPTO_FUTURES", strategyType: "MID_LONG", direction: "LONG" }),
  Object.freeze({ id: "CRYPTO_FUTURES_MID_LONG_SHORT", market: "CRYPTO_FUTURES", strategyType: "MID_LONG", direction: "SHORT" }),
]);

export const AUTONOMOUS_QUANT_LAB_GROUPS = Object.freeze([
  ...AUTOMATED_RESEARCH_GROUPS,
  ...MID_LONG_GROUPS,
]);

export const AUTONOMOUS_QUANT_LAB_STAGES = Object.freeze([
  "CHALLENGER",
  "HISTORICAL_BACKTEST",
  "OOS",
  "PURGED_WALK_FORWARD",
  "COST_STRESS",
  "REGIME_STRESS",
  "FINAL_HOLDOUT",
  "PAPER",
  "SHADOW",
  "CHAMPION_COMPARISON",
]);

export const CHAMPION_EVIDENCE_REQUIREMENTS = Object.freeze([
  "FINAL_HOLDOUT",
  "PAPER",
  "SHADOW",
]);

export function buildAutonomousQuantLabContract() {
  const ids = new Set(AUTONOMOUS_QUANT_LAB_GROUPS.map((group) => group.id));
  if (ids.size !== AUTONOMOUS_QUANT_LAB_GROUPS.length) throw new Error("DUPLICATE_QUANT_LAB_GROUP");

  const futures = AUTONOMOUS_QUANT_LAB_GROUPS.filter((group) => group.market === "CRYPTO_FUTURES");
  for (const style of ["SCALPING", "SWING", "MID_LONG"]) {
    const directions = new Set(futures.filter((group) => group.strategyType === style).map((group) => group.direction));
    if (!directions.has("LONG") || !directions.has("SHORT")) throw new Error(`FUTURES_DIRECTION_INCOMPLETE:${style}`);
  }

  return Object.freeze({
    schemaVersion: 1,
    groups: AUTONOMOUS_QUANT_LAB_GROUPS,
    stages: AUTONOMOUS_QUANT_LAB_STAGES,
    markets: Object.freeze(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]),
    strategyTypes: Object.freeze(["SCALPING", "SWING", "MID_LONG"]),
    championEvidenceRequirements: CHAMPION_EVIDENCE_REQUIREMENTS,
    currentValidatedChampion: "NONE",
    championRule: "BACKTEST_ONLY_NEVER_PROMOTES",
    liveExecution: false,
    privateAccountRequestAllowed: false,
    orderSubmitted: false,
  });
}
