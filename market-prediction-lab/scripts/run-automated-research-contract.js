import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildAutomatedResearchContract } from "../src/automated-research-orchestrator.js";
import {
  buildStockAutomatedResearchProviderCapability,
  buildStockHistoryProviderCapability,
} from "../src/stock-history-provider.js";

const researchCodeSha = process.env.RESEARCH_CODE_SHA;
const mode = process.argv[2] ?? "contract_validation";
if (!new Set(["contract_validation", "long_history", "recent_oos_regime"]).has(mode)) {
  throw new TypeError(`unsupported automated research mode: ${mode}`);
}

const stockProviderStates = Object.freeze({
  US_STOCK: buildStockHistoryProviderCapability({ market: "US_STOCK", env: process.env }),
  KR_STOCK: buildStockHistoryProviderCapability({ market: "KR_STOCK", env: process.env }),
});

// Crypto capabilities keep the existing Bitget public/data-quality path.
// Stock capabilities are now derived from the real stock-history provider
// implementation. No stock network request is made by contract validation;
// missing credentials therefore remain fail-closed as blocked_provider.
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
  US_STOCK: buildStockAutomatedResearchProviderCapability({ market: "US_STOCK", env: process.env }),
  KR_STOCK: buildStockAutomatedResearchProviderCapability({ market: "KR_STOCK", env: process.env }),
};

const generatedAt = new Date().toISOString();
const contract = buildAutomatedResearchContract({ researchCodeSha, generatedAt, providers });
const artifact = Object.freeze({
  ...contract,
  mode,
  stockProviderStates,
  execution: Object.freeze({
    historicalDataPolicy: "real_public_data_only",
    fakeHistoricalDataAllowed: false,
    developmentBacktest: mode === "long_history" ? "enabled_when_provider_and_gate_config_ready" : "not_executed_in_contract_validation",
    oos: mode === "recent_oos_regime" || mode === "long_history" ? "enabled_when_provider_and_gate_config_ready" : "not_executed_in_contract_validation",
    walkForward: mode === "long_history" ? "enabled_when_provider_and_gate_config_ready" : "not_executed_in_contract_validation",
    finalHoldout: "never_auto_tuned; frozen_candidate_only; stock_requires_verified_corporate_action_and_survivorship_provenance",
    rankingArtifact: "empty_until_real_metrics_pass_final_holdout",
  }),
  incrementalResearch: Object.freeze({
    rawHistoricalCache: "provider-version-adjustment-dataset-digest-and-research-sha-keyed",
    strategyResultCache: "parameter-cost-split-and-code-sha-keyed",
    unchangedParameterReuse: true,
    recentDataIncrementalUpdate: true,
    stockCryptoNamespaceIsolation: true,
  }),
  ranking: Object.freeze(Object.fromEntries(contract.groups.map((group) => [group.id, Object.freeze([])]))),
});

const serializedArtifact = JSON.stringify(artifact, null, 2);
for (const state of Object.values(stockProviderStates)) {
  const credentialName = state.credentialEnvironmentVariable;
  const credentialValue = credentialName ? process.env[credentialName] : null;
  if (credentialValue && serializedArtifact.includes(credentialValue)) {
    throw new Error(`provider credential value leaked into contract artifact: ${credentialName}`);
  }
}
if (Object.values(stockProviderStates).some((state) => state.finalHoldoutReady !== false)) {
  throw new Error("stock final holdout must remain blocked until provenance requirements are verified");
}

const outputDirectory = resolve(process.cwd(), "artifacts", "automated-research");
await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, "contract.json"), `${serializedArtifact}\n`, "utf8");
console.log(JSON.stringify({
  status: "ok",
  mode,
  researchCodeSha,
  providerStatus: Object.fromEntries(Object.entries(artifact.providerCapabilities).map(([market, value]) => [market, value.status])),
  stockFinalHoldoutReady: Object.fromEntries(Object.entries(stockProviderStates).map(([market, value]) => [market, value.finalHoldoutReady])),
  branchWrite: artifact.artifactSafety.branchWrite,
  liveOrderAllowed: artifact.artifactSafety.liveOrderAllowed,
  privateAccountRequestAllowed: artifact.artifactSafety.privateAccountRequestAllowed,
  orderSubmitted: artifact.artifactSafety.orderSubmitted,
}));
