import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildAutomatedResearchContract } from "../src/automated-research-orchestrator.js";

const researchCodeSha = process.env.RESEARCH_CODE_SHA;
const mode = process.argv[2] ?? "contract_validation";
if (mode !== "contract_validation") {
  throw new TypeError(`current-main V1 supports contract_validation only; received ${mode}`);
}

const providers = Object.freeze({
  CRYPTO_SPOT: Object.freeze({
    source: "bitget-public-v2 + current-main data-quality/gap layer",
    publicHistoricalOhlcv: true,
    closedCandlesOnly: true,
    coverageRecorded: true,
    duplicatesHandled: true,
    missingIntervalsDetected: true,
  }),
  CRYPTO_FUTURES: Object.freeze({
    source: "bitget-public-v2 + current-main data-quality/gap layer",
    publicHistoricalOhlcv: true,
    closedCandlesOnly: true,
    coverageRecorded: true,
    duplicatesHandled: true,
    missingIntervalsDetected: true,
  }),
  US_STOCK: Object.freeze({}),
  KR_STOCK: Object.freeze({}),
});

const generatedAt = new Date().toISOString();
const contract = buildAutomatedResearchContract({ researchCodeSha, generatedAt, providers });
const groupStrategyTypes = [...new Set(contract.groups.map((group) => group.strategyType))].sort();
const scopeGaps = [];
if (!groupStrategyTypes.includes("MID_LONG")) scopeGaps.push("MID_LONG_AUTOMATED_RESEARCH_GROUP_NOT_IN_CURRENT_CORE");

const artifact = Object.freeze({
  ...contract,
  mode,
  executionStatus: "contract_only",
  schedulePurpose: "daily_fail_closed_research_readiness_audit",
  automaticBacktestExecuted: false,
  automaticOosExecuted: false,
  automaticWalkForwardExecuted: false,
  automaticFinalHoldoutExecuted: false,
  automaticPaperExecuted: false,
  automaticShadowExecuted: false,
  scopeComplete: scopeGaps.length === 0,
  scopeGaps: Object.freeze(scopeGaps),
  ranking: Object.freeze(Object.fromEntries(contract.groups.map((group) => [group.id, Object.freeze([])]))),
  interpretation: Object.freeze({
    cryptoProviderCapability: "contract_ready_only; does_not_claim_this_run_executed_market_history",
    stockProviderCapability: "blocked_provider_until_reproducible_current-main_history_provenance_exists",
    rankingAvailability: "empty_until_real_cost_aware_oos_walk_forward_holdout_evidence_exists",
    profitabilityClaimAllowed: false,
  }),
});

if (artifact.artifactSafety.branchWrite !== false
  || artifact.artifactSafety.liveOrderAllowed !== false
  || artifact.artifactSafety.privateAccountRequestAllowed !== false
  || artifact.artifactSafety.orderSubmitted !== false) {
  throw new Error("automated research safety flags must remain fail-closed");
}
for (const market of ["US_STOCK", "KR_STOCK"]) {
  if (artifact.providerCapabilities[market]?.status !== "blocked_provider") {
    throw new Error(`${market} must remain blocked_provider in current-main contract V1`);
  }
}
for (const market of ["CRYPTO_SPOT", "CRYPTO_FUTURES"]) {
  if (artifact.providerCapabilities[market]?.status !== "ready") {
    throw new Error(`${market} public historical capability contract is unexpectedly unavailable`);
  }
}
if (Object.values(artifact.providerCapabilities).some((value) => value.fakeHistoricalDataAllowed !== false)) {
  throw new Error("fake historical data must remain forbidden");
}
if (artifact.scopeGaps.length === 0) {
  throw new Error("current-main contract V1 must explicitly preserve the known MID_LONG scope gap until the core supports it");
}

const outputDirectory = resolve(process.cwd(), "artifacts", "automated-research");
await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, "contract.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  status: "ok",
  mode,
  researchCodeSha,
  executionStatus: artifact.executionStatus,
  providerStatus: Object.fromEntries(Object.entries(artifact.providerCapabilities).map(([market, value]) => [market, value.status])),
  groupCount: artifact.groups.length,
  strategyTypes: groupStrategyTypes,
  scopeComplete: artifact.scopeComplete,
  scopeGaps: artifact.scopeGaps,
  branchWrite: artifact.artifactSafety.branchWrite,
  liveOrderAllowed: artifact.artifactSafety.liveOrderAllowed,
  privateAccountRequestAllowed: artifact.artifactSafety.privateAccountRequestAllowed,
  orderSubmitted: artifact.artifactSafety.orderSubmitted,
}));
