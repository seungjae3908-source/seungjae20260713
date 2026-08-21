import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_CONTRACT = Object.freeze({
  schemaVersion: "authoritative-paper-runtime-package-loader-v1",
  manifestSchemaVersion: "authoritative-paper-runtime-package-manifest-v1",
  canonicalProducerVersion: "scanner-crypto-futures-paper-admission-evidence-producer-v1",
  canonicalProducerSourceCommitSha: "3f85003368830fb570c05b3b2060da39f515696d",
  admissionBundleSchemaVersion: "scanner-paper-admission-evidence-bundle-v1",
  paperStateSnapshotSchemaVersion: "paper-trading-state-snapshot-v1",
  blockedDataSourceContractSchemaVersion: "authoritative-paper-blocked-data-source-contract-v1",
  simulatedExecutionEvidenceSchemaVersion: "paper-simulated-execution-evidence-v1",
  executionAuthority: "NONE",
  privateApiAllowed: false,
  liveTrading: false,
  scheduleActivationAuthority: false,
  financialMutationAllowed: false,
});

const DEFAULT_PACKAGE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "runtime",
  "authoritative-paper-runtime-v1",
);
const MANIFEST_FILE = "authoritative-paper-runtime-v1.manifest.json";
const EXPECTED_SOURCE_FILES = Object.freeze([
  "api-server/src/data/asset-type.ts",
  "api-server/src/lib/bounded-work-pool.ts",
  "api-server/src/services/authoritative-paper-evidence-sources.service.ts",
  "api-server/src/services/authoritative-paper-runtime-package.entry.ts",
  "api-server/src/services/bitget-futures-public-evidence.service.ts",
  "api-server/src/services/crypto-signal-scanner.service.ts",
  "api-server/src/services/forward-recommendation-observer-runtime.service.ts",
  "api-server/src/services/forward-recommendation-observer.service.ts",
  "api-server/src/services/market-price-precision.service.ts",
  "api-server/src/services/paper-simulated-execution-evidence.service.ts",
  "api-server/src/services/paper-trading-core.service.ts",
  "api-server/src/services/paper-trading-state-snapshot.service.ts",
  "api-server/src/services/public-market-http.ts",
  "api-server/src/services/scanner-candidate-ranking.service.ts",
  "api-server/src/services/scanner-canonical-paper-identity.service.ts",
  "api-server/src/services/scanner-crypto-futures-paper-admission-composer.service.ts",
  "api-server/src/services/scanner-crypto-futures-paper-admission-evidence-producer.service.ts",
  "api-server/src/services/scanner-crypto-price-precision.service.ts",
  "api-server/src/services/scanner-data-quality.service.ts",
  "api-server/src/services/scanner-indicator-library.service.ts",
  "api-server/src/services/scanner-market-action.service.ts",
  "api-server/src/services/scanner-market-profile-overlay.service.ts",
  "api-server/src/services/scanner-paper-admission-evidence-bundle.service.ts",
  "api-server/src/services/scanner-profit-cost-evidence-adapter.service.ts",
  "api-server/src/services/scanner-quant-hardening.service.ts",
  "api-server/src/services/scanner-quant-strategy.service.ts",
  "api-server/src/services/scanner-signal-lifecycle.service.ts",
  "api-server/src/services/scanner-strategy-profile.service.ts",
  "api-server/src/services/signal-performance-learning.service.ts",
  "api-server/src/services/strategy-promotion.service.ts",
  "api-server/src/services/trade-paper-market-contract.service.ts",
  "api-server/src/services/trading-risk-engine.service.ts",
  "market-intelligence-sidecar/src/execution-quality.mjs",
]);
const SOURCE_KEYS = Object.freeze([
  ["paperCandidateSource", "paperCandidate"],
  ["learningSnapshotSource", "learningSnapshot"],
  ["paperStateSource", "paperState"],
  ["contractRulesSource", "contractRules"],
  ["publicEvidenceSource", "publicEvidence"],
  ["executionObservationSource", "executionObservation"],
  ["supplementalCostEvidenceSource", "supplementalCostEvidence"],
]);

function freeze(value) {
  return Object.freeze(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function digest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertManifest(manifest, bundleDigest) {
  const contract = AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_CONTRACT;
  const sourceFilesValid = Array.isArray(manifest?.sourceFiles)
    && JSON.stringify(manifest.sourceFiles) === JSON.stringify(EXPECTED_SOURCE_FILES);
  const sourceDigestsValid = sourceFilesValid
    && isRecord(manifest?.sourceFileSha256)
    && JSON.stringify(Object.keys(manifest.sourceFileSha256)) === JSON.stringify(EXPECTED_SOURCE_FILES)
    && EXPECTED_SOURCE_FILES.every((path) => digest(manifest.sourceFileSha256[path]));
  const sourceGraphDigest = sourceDigestsValid
    ? sha256(EXPECTED_SOURCE_FILES.map((path) => `${path}\0${manifest.sourceFileSha256[path]}\n`).join(""))
    : null;
  if (!isRecord(manifest)
    || manifest.schemaVersion !== contract.manifestSchemaVersion
    || manifest.artifactFile !== "authoritative-paper-runtime-v1.mjs"
    || manifest.canonicalProducer?.version !== contract.canonicalProducerVersion
    || manifest.canonicalProducer?.sourceCommitSha !== contract.canonicalProducerSourceCommitSha
    || !immutableSha(manifest.canonicalProducer?.sourceCommitSha)
    || !digest(manifest.canonicalProducer?.sourceSha256)
    || !digest(manifest.sourceGraphSha256)
    || !digest(manifest.bundleSha256)
    || manifest.bundleSha256 !== bundleDigest
    || manifest.admissionBundleSchemaVersion !== contract.admissionBundleSchemaVersion
    || manifest.paperStateSnapshotSchemaVersion !== contract.paperStateSnapshotSchemaVersion
    || manifest.blockedDataSourceContractSchemaVersion !== contract.blockedDataSourceContractSchemaVersion
    || manifest.simulatedExecutionEvidenceSchemaVersion !== contract.simulatedExecutionEvidenceSchemaVersion
    || manifest.costPolicyVersion !== null
    || manifest.costPolicyVersionBinding?.status !== "RUNTIME_EXACT_REQUIRED"
    || manifest.costPolicyVersionBinding?.unknownIsZero !== false
    || !sourceDigestsValid
    || manifest.sourceGraphSha256 !== sourceGraphDigest
    || manifest.safety?.executionAuthority !== "NONE"
    || manifest.safety?.privateApiAllowed !== false
    || manifest.safety?.liveTrading !== false
    || manifest.safety?.scheduleActivationAuthority !== false
    || manifest.safety?.financialMutationAllowed !== false) {
    throw new Error("AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_MANIFEST_INVALID");
  }
  if (manifest.sourceFiles.some((path) => /(private|credential|secret|order-execution|account-readonly|supabase)/iu.test(path))) {
    throw new Error("AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_PRIVATE_AUTHORITY_INCLUDED");
  }
}

function assertExports(runtime) {
  const safety = runtime?.AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_SAFETY;
  const evidenceSafety = runtime?.AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_SAFETY;
  if (runtime?.SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION
      !== AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_CONTRACT.canonicalProducerVersion
    || runtime?.PAPER_TRADING_STATE_SNAPSHOT_VERSION
      !== AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_CONTRACT.paperStateSnapshotSchemaVersion
    || runtime?.AUTHORITATIVE_PAPER_BLOCKED_DATA_SOURCE_CONTRACT_VERSION
      !== AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_CONTRACT.blockedDataSourceContractSchemaVersion
    || typeof runtime?.createScannerCryptoFuturesPaperAdmissionEvidenceProducer !== "function"
    || typeof runtime?.createAuthoritativePaperEvidenceSourceWiring !== "function"
    || typeof runtime?.createImmutablePaperTradingStateSnapshot !== "function"
    || typeof runtime?.buildPaperSimulatedExecutionEvidence !== "function"
    || typeof runtime?.validateImmutablePaperTradingStateSnapshot !== "function"
    || runtime?.PAPER_SIMULATED_EXECUTION_EVIDENCE_VERSION !== "paper-simulated-execution-evidence-v1"
    || runtime?.PAPER_SIMULATED_EXECUTION_EVIDENCE_SAFETY?.executionMode !== "SIMULATED_EXECUTION_ONLY"
    || runtime?.PAPER_SIMULATED_EXECUTION_EVIDENCE_SAFETY?.executionAuthority !== "NONE"
    || evidenceSafety?.executionAuthority !== "NONE"
    || evidenceSafety?.privateApiAllowed !== false
    || evidenceSafety?.liveTrading !== false
    || evidenceSafety?.scheduleActivationAuthority !== false
    || evidenceSafety?.financialMutationAllowed !== false
    || safety?.executionAuthority !== "NONE"
    || safety?.privateApiAllowed !== false
    || safety?.liveTrading !== false
    || safety?.scheduleActivationAuthority !== false
    || safety?.financialMutationAllowed !== false) {
    throw new Error("AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_EXPORT_INVALID");
  }
}

function producerFactory(runtime) {
  return function createPaperAdmissionEvidenceProducer(options = {}) {
    const sources = {};
    for (const [external, canonical] of SOURCE_KEYS) {
      if (typeof options[external] !== "function") {
        throw new TypeError(`authoritative source callback is required: ${external}`);
      }
      sources[canonical] = options[external];
    }
    return runtime.createScannerCryptoFuturesPaperAdmissionEvidenceProducer({ sources });
  };
}

export async function loadValidatedAuthoritativePaperRuntimePackage({
  packageRoot = DEFAULT_PACKAGE_ROOT,
} = {}) {
  const manifestPath = join(packageRoot, MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const bundlePath = join(packageRoot, String(manifest?.artifactFile ?? ""));
  const bundleBytes = await readFile(bundlePath);
  const bundleDigest = sha256(bundleBytes);
  assertManifest(manifest, bundleDigest);
  const runtime = await import(`${pathToFileURL(bundlePath).href}?sha256=${bundleDigest}`);
  assertExports(runtime);
  return freeze({
    schemaVersion: "authoritative-paper-runtime-package-loaded-v1",
    manifest: freeze(manifest),
    sourceSha: manifest.canonicalProducer.sourceCommitSha,
    sourceGraphSha256: manifest.sourceGraphSha256,
    bundleSha256: bundleDigest,
    admissionBundleSchemaVersion: manifest.admissionBundleSchemaVersion,
    blockedDataSourceContractSchemaVersion: manifest.blockedDataSourceContractSchemaVersion,
    simulatedExecutionEvidenceSchemaVersion: manifest.simulatedExecutionEvidenceSchemaVersion,
    costPolicyVersion: null,
    costPolicyVersionBinding: freeze(manifest.costPolicyVersionBinding),
    createPaperAdmissionEvidenceProducer: producerFactory(runtime),
    createAuthoritativePaperEvidenceSourceWiring: runtime.createAuthoritativePaperEvidenceSourceWiring,
    createImmutablePaperTradingStateSnapshot: runtime.createImmutablePaperTradingStateSnapshot,
    buildPaperSimulatedExecutionEvidence: runtime.buildPaperSimulatedExecutionEvidence,
    validateImmutablePaperTradingStateSnapshot: runtime.validateImmutablePaperTradingStateSnapshot,
    executionAuthority: "NONE",
    privateApiAllowed: false,
    liveTrading: false,
    scheduleActivationAuthority: false,
    financialMutationAllowed: false,
  });
}

export function createPaperStateSourceFromLosslessSnapshotFile({
  snapshotPath,
  runtimePackage,
  now = () => Date.now(),
} = {}) {
  if (typeof snapshotPath !== "string" || snapshotPath.trim().length === 0) {
    throw new TypeError("lossless Paper state snapshot path is required");
  }
  if (typeof runtimePackage?.validateImmutablePaperTradingStateSnapshot !== "function") {
    throw new TypeError("validated authoritative Paper runtime package is required");
  }
  if (typeof now !== "function") throw new TypeError("Paper state snapshot clock is required");
  return async function paperStateForCard() {
    const value = JSON.parse(await readFile(snapshotPath, "utf8"));
    return runtimePackage.validateImmutablePaperTradingStateSnapshot(value, now()).state;
  };
}
