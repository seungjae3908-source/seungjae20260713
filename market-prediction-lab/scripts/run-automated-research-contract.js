import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildAutomatedResearchContract } from "../src/automated-research-orchestrator.js";

const researchCodeSha = process.env.RESEARCH_CODE_SHA;
const mode = process.argv[2] ?? "contract_validation";
if (!new Set(["contract_validation", "long_history", "recent_oos_regime"]).has(mode)) {
  throw new TypeError(`unsupported automated research mode: ${mode}`);
}

// These capabilities are backed by the existing public Bitget collector plus
// the existing gap/data-quality layer. Stock adapters are deliberately blocked
// until a real long-history provider with corporate-action provenance exists.
const providers = {
  CRYPTO_SPOT: {
    source: "bitget-public-v2 + existing data-quality/gap layer",
    publicHistoricalOhlcv: true,
    closedCandlesOnly: true,
    coverageRecorded: true,
    duplicatesHandled: true,
    missingIntervalsDetected: true,
  },
  CRYPTO_FUTURES: {
    source: "bitget-public-v2 + existing data-quality/gap layer",
    publicHistoricalOhlcv: true,
    closedCandlesOnly: true,
    coverageRecorded: true,
    duplicatesHandled: true,
    missingIntervalsDetected: true,
  },
  US_STOCK: {
    source: null,
    publicHistoricalOhlcv: false,
    closedCandlesOnly: false,
    coverageRecorded: false,
    duplicatesHandled: false,
    missingIntervalsDetected: false,
    corporateActions: "not_verified",
  },
  KR_STOCK: {
    source: null,
    publicHistoricalOhlcv: false,
    closedCandlesOnly: false,
    coverageRecorded: false,
    duplicatesHandled: false,
    missingIntervalsDetected: false,
    corporateActions: "not_verified",
  },
};

const generatedAt = new Date().toISOString();
const contract = buildAutomatedResearchContract({ researchCodeSha, generatedAt, providers });
const artifact = Object.freeze({
  ...contract,
  mode,
  execution: Object.freeze({
    historicalDataPolicy: "real_public_data_only",
    fakeHistoricalDataAllowed: false,
    developmentBacktest: mode === "long_history" ? "enabled_when_provider_and_gate_config_ready" : "not_executed_in_contract_validation",
    oos: mode === "recent_oos_regime" || mode === "long_history" ? "enabled_when_provider_and_gate_config_ready" : "not_executed_in_contract_validation",
    walkForward: mode === "long_history" ? "enabled_when_provider_and_gate_config_ready" : "not_executed_in_contract_validation",
    finalHoldout: "never_auto_tuned; frozen_candidate_only",
    rankingArtifact: "empty_until_real_metrics_pass_final_holdout",
  }),
  incrementalResearch: Object.freeze({
    rawHistoricalCache: "planned_with_provenance_validation",
    strategyResultCache: "planned_with_parameter_and_code_sha_key",
    unchangedParameterReuse: true,
    recentDataIncrementalUpdate: true,
  }),
  ranking: Object.freeze(Object.fromEntries(contract.groups.map((group) => [group.id, Object.freeze([])]))),
});

const outputDirectory = resolve(process.cwd(), "artifacts", "automated-research");
await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, "contract.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  status: "ok",
  mode,
  researchCodeSha,
  providerStatus: Object.fromEntries(Object.entries(artifact.providerCapabilities).map(([market, value]) => [market, value.status])),
  branchWrite: artifact.artifactSafety.branchWrite,
  liveOrderAllowed: artifact.artifactSafety.liveOrderAllowed,
  privateAccountRequestAllowed: artifact.artifactSafety.privateAccountRequestAllowed,
  orderSubmitted: artifact.artifactSafety.orderSubmitted,
}));
