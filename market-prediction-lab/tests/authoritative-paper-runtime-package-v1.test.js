import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AUTHORITATIVE_PAPER_EVIDENCE_SOURCE_OWNERSHIP } from "../src/authoritative-paper-evidence-source-ownership-v1.js";
import {
  createLosslessPaperStateSnapshotFileOwner,
  createPaperStateSourceFromLosslessSnapshotFile,
  loadValidatedAuthoritativePaperRuntimePackage,
} from "../src/authoritative-paper-runtime-package-v1.js";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const PUBLISHER_ACCOUNT_ID = "paper-publisher-account-fixture";
const PUBLISHER_ACCOUNT_ID_SHA256 = createHash("sha256").update(PUBLISHER_ACCOUNT_ID).digest("hex");

function paperState(nowMs) {
  const at = new Date(nowMs - 1_000).toISOString();
  return {
    schemaVersion: 1,
    account: {
      id: "paper_account_contract_fixture",
      initialBalance: 10_000,
      cashBalance: 10_000,
      realizedPnl: 0,
      unrealizedPnl: 0,
      equity: 10_000,
      usedMargin: 0,
      availableMargin: 10_000,
      createdAt: at,
      updatedAt: at,
    },
    orders: [],
    positions: [],
    fills: [],
    journal: [],
    riskState: {
      dayKey: at.slice(0, 10),
      weekKey: "2026-W34",
      dailyRealizedPnl: 0,
      weeklyRealizedPnl: 0,
      consecutiveLosses: 0,
    },
    processedEventIds: [],
    createdAt: at,
    updatedAt: at,
  };
}

function missingEvidenceSources() {
  const missing = async () => null;
  return {
    paperCandidateSource: missing,
    learningSnapshotSource: missing,
    paperStateSource: missing,
    contractRulesSource: missing,
    publicEvidenceSource: missing,
    executionObservationSource: missing,
    supplementalCostEvidenceSource: missing,
  };
}

test("validated package loads exact #546 producer bundle and executes fail-closed without evidence", async () => {
  const runtimePackage = await loadValidatedAuthoritativePaperRuntimePackage();
  assert.equal(runtimePackage.sourceSha, "3f85003368830fb570c05b3b2060da39f515696d");
  assert.match(runtimePackage.sourceGraphSha256, /^[0-9a-f]{64}$/u);
  assert.match(runtimePackage.bundleSha256, /^[0-9a-f]{64}$/u);
  assert.equal(runtimePackage.admissionBundleSchemaVersion, "scanner-paper-admission-evidence-bundle-v1");
  assert.equal(runtimePackage.manifest.paperStateSnapshotSchemaVersion, "paper-trading-state-snapshot-v2");
  assert.equal(runtimePackage.callbackOwnerContractSchemaVersion, "authoritative-paper-callback-owner-contract-v1");
  assert.equal(runtimePackage.blockedDataSourceContractSchemaVersion, "authoritative-paper-blocked-data-source-contract-v1");
  assert.equal(runtimePackage.simulatedExecutionEvidenceSchemaVersion, "paper-simulated-execution-evidence-v1");
  assert.match(runtimePackage.manifest.sourceFileSha256["api-server/src/services/paper-simulated-execution-evidence.service.ts"], /^[0-9a-f]{64}$/u);
  assert.match(runtimePackage.manifest.sourceFileSha256["market-intelligence-sidecar/src/execution-quality.mjs"], /^[0-9a-f]{64}$/u);
  assert.match(runtimePackage.manifest.sourceFileSha256["market-prediction-lab/src/bitget-position-tier-v1.js"], /^[0-9a-f]{64}$/u);
  assert.equal(runtimePackage.costPolicyVersion, null);
  assert.equal(runtimePackage.costPolicyVersionBinding.status, "RUNTIME_EXACT_REQUIRED");
  assert.equal(runtimePackage.executionAuthority, "NONE");
  assert.equal(runtimePackage.privateApiAllowed, false);
  assert.equal(runtimePackage.liveTrading, false);
  assert.equal(runtimePackage.scheduleActivationAuthority, false);
  assert.equal(runtimePackage.financialMutationAllowed, false);
  assert.equal(typeof runtimePackage.createAuthoritativePaperEvidenceSourceWiring, "function");
  assert.equal(typeof runtimePackage.buildPaperSimulatedExecutionEvidence, "function");
  assert.equal(typeof runtimePackage.buildAuthoritativeSizedContractRules, "function");
  assert.equal(typeof runtimePackage.buildAuthoritativePaperExecutionObservation, "function");
  assert.equal(typeof runtimePackage.buildAuthoritativeSupplementalCostEvidence, "function");

  const producer = runtimePackage.createPaperAdmissionEvidenceProducer(missingEvidenceSources());
  const result = await producer({ card: {}, market: "CRYPTO_FUTURES" });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.blockers, ["P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING"]);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.productionMutationAllowed, false);
});

test("validated package reuses the sidecar book walk only as labeled simulated execution", async () => {
  const runtimePackage = await loadValidatedAuthoritativePaperRuntimePackage();
  const evidence = runtimePackage.buildPaperSimulatedExecutionEvidence({
    source: "BITGET_PUBLIC_DEPTH_CONTRACT_FIXTURE",
    market: "CRYPTO_FUTURES",
    symbol: "ETHUSDT",
    direction: "LONG",
    targetQuantity: 2,
    bids: [[99, 3]],
    asks: [[100, 1], [101, 1]],
    observedAtMs: 2_000,
    requestStartedAtMs: 1_990,
    requestCompletedAtMs: 2_000,
    maximumAgeMs: 1_000,
    provenance: ["contract-fixture-public-depth"],
    nowMs: 2_001,
  });

  assert.equal(evidence.modelStatus, "SIMULATION_AVAILABLE");
  assert.equal(evidence.status, "BLOCKED_DATA");
  assert.equal(evidence.executionMode, "SIMULATED_EXECUTION_ONLY");
  assert.equal(evidence.safety.executionAuthority, "NONE");
  assert.equal(evidence.safety.privateApiAllowed, false);
  assert.equal(evidence.realFillClaim, false);
  assert.equal(evidence.publicDepthIsFillProof, false);
  assert.equal(evidence.currentPriceIsFillPrice, false);
  assert.equal(evidence.estimated.slippageEstimate.model, "VISIBLE_L2_BOOK_WALK_ONLY");
  assert.equal(evidence.estimated.slippageEstimate.quality, "ESTIMATED");
  assert.equal(evidence.observed.latencyEvidence.quality, "OBSERVED_DURATION_ONLY");
  assert.equal(evidence.observed.latencyEvidence.costPercent, null);
  assert.equal(evidence.estimated.partialFillEstimate.quality, "UNCALIBRATED_MODEL_ONLY");
  assert.equal(evidence.confidence.numericConfidence, null);
  assert.equal(evidence.costEvidenceReady, false);
  assert.equal(evidence.blockers.includes("CALIBRATED_FILL_MODEL_EVIDENCE_MISSING"), true);
  assert.equal(evidence.blockers.includes("LATENCY_COST_EVIDENCE_UNAVAILABLE"), true);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.estimated), true);
});

test("callback owners require sized tiers, calibrated execution, and complete non-zero-filled costs", async () => {
  const runtimePackage = await loadValidatedAuthoritativePaperRuntimePackage();
  const nowMs = 2_000_000;
  const publicEvidence = {
    provider: "bitget",
    dataQuality: "ready",
    symbol: "ETHUSDT",
    sizeMultiplier: 0.01,
    minTradeNum: 0.01,
    minTradeUsdt: 5,
    maxLeverage: 125,
  };
  const riskPolicy = {
    schemaVersion: "authoritative-paper-risk-policy-evidence-v1",
    leverage: 1,
    riskPercent: 1,
    marginMode: "isolated",
    source: "IMMUTABLE_RESEARCH_PAPER_POLICY",
    observedAtMs: nowMs - 100,
    maximumAgeMs: 30_000,
  };
  const contract = runtimePackage.buildAuthoritativeSizedContractRules({
    publicEvidence,
    positionTiers: [
      { startUnit: "0", endUnit: "999", keepMarginRate: "0.004" },
      { startUnit: "1000", endUnit: "100000", keepMarginRate: "0.01" },
    ],
    sizedNotional: 1_500,
    quantityPrecision: 2,
    riskPolicy,
    observedAtMs: nowMs - 100,
    nowMs,
  });
  assert.equal(contract.contractRules.maintenanceMarginRate, 0.01);
  assert.equal(contract.selectedTier.sizedNotional, 1_500);
  assert.equal(runtimePackage.buildAuthoritativeSizedContractRules({
    publicEvidence,
    positionTiers: [
      { startUnit: "0", endUnit: "999", keepMarginRate: "0.004" },
      { startUnit: "1000", endUnit: "1001", keepMarginRate: "0.01" },
    ],
    sizedNotional: 1_500,
    quantityPrecision: 3,
    riskPolicy,
    observedAtMs: nowMs,
    nowMs,
  }).contractRules.maintenanceMarginRate, 0.01);
  assert.equal(contract.executionAuthority, "NONE");

  const execution = runtimePackage.buildAuthoritativePaperExecutionObservation({
    executionEvidenceInput: {
      source: "BITGET_PUBLIC_DEPTH",
      market: "CRYPTO_FUTURES",
      symbol: "ETHUSDT",
      direction: "LONG",
      targetQuantity: 2,
      bids: [[99, 5]],
      asks: [[100, 1], [101, 2]],
      observedAtMs: nowMs - 100,
      requestStartedAtMs: nowMs - 120,
      requestCompletedAtMs: nowMs - 100,
      maximumAgeMs: 30_000,
      provenance: ["bitget-public-v2-merge-depth"],
      calibratedFillModel: {
        modelId: "PAPER_FILL_CALIBRATION_V1",
        fillProbability: 0.9,
        evaluationSamples: 500,
        brierScore: 0.1,
        calibrationError: 0.05,
        evaluatedAt: nowMs - 1_000,
      },
    },
    riskPolicy,
    nowMs,
  });
  assert.equal(execution.partialFill.model, "ORDER_BOOK");
  assert.equal(execution.slippage.quality, "ESTIMATED");
  assert.equal(execution.leverage, 1);

  const component = (valuePercent, quality, source) => ({
    valuePercent,
    quality,
    source,
    observedAtMs: nowMs - 100,
  });
  const costs = runtimePackage.buildAuthoritativeSupplementalCostEvidence({
    costPolicyId: "SCANNER_COST_POLICY_V1",
    observedAtMs: nowMs - 100,
    latency: component(0.01, "ESTIMATED", "CALIBRATED_LATENCY_COST_MODEL"),
    liquidityImpact: component(0.02, "ESTIMATED", "CALIBRATED_LIQUIDITY_IMPACT_MODEL"),
    partialFillImpact: component(0.03, "ESTIMATED", "CALIBRATED_PARTIAL_FILL_COST_MODEL"),
    funding: component(0.01, "OBSERVED", "BITGET_PUBLIC_FUNDING"),
    nowMs,
  });
  assert.equal(costs.latency.valuePercent, 0.01);
  assert.equal(costs.partialFillImpact.quality, "ESTIMATED");
  assert.throws(() => runtimePackage.buildAuthoritativeSupplementalCostEvidence({
    costPolicyId: "SCANNER_COST_POLICY_V1",
    observedAtMs: nowMs - 100,
    liquidityImpact: costs.liquidityImpact,
    partialFillImpact: costs.partialFillImpact,
    funding: costs.funding,
    nowMs,
  }), /AUTHORITATIVE_LATENCY_COST_EVIDENCE_REQUIRED/u);
  assert.throws(() => runtimePackage.buildAuthoritativeSupplementalCostEvidence({
    costPolicyId: "SCANNER_COST_POLICY_V1",
    observedAtMs: nowMs - 100,
    latency: component(0.01, "NOT_APPLICABLE", "INVALID_ZERO_FILL"),
    liquidityImpact: costs.liquidityImpact,
    partialFillImpact: costs.partialFillImpact,
    funding: costs.funding,
    nowMs,
  }), /AUTHORITATIVE_LATENCY_COST_EVIDENCE_REQUIRED/u);
});

test("validated package rejects source-graph or bundle digest tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "authoritative-paper-package-tamper-"));
  const packageRoot = join(root, "package");
  const manifestPath = join(packageRoot, "authoritative-paper-runtime-v1.manifest.json");
  const bundlePath = join(packageRoot, "authoritative-paper-runtime-v1.mjs");
  try {
    await cp(new URL("../runtime/authoritative-paper-runtime-v1/", import.meta.url), packageRoot, { recursive: true });
    const originalManifestText = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(originalManifestText);
    manifest.sourceFileSha256["market-intelligence-sidecar/src/execution-quality.mjs"] = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      loadValidatedAuthoritativePaperRuntimePackage({ packageRoot }),
      /AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_MANIFEST_INVALID/u,
    );

    await writeFile(manifestPath, originalManifestText);
    const bundle = await readFile(bundlePath);
    await writeFile(bundlePath, Buffer.concat([bundle, Buffer.from("\n// tampered\n")]));
    await assert.rejects(
      loadValidatedAuthoritativePaperRuntimePackage({ packageRoot }),
      /AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_MANIFEST_INVALID/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validated package connects existing Scanner and public Bitget owners without adding execution authority", async () => {
  const runtimePackage = await loadValidatedAuthoritativePaperRuntimePackage();
  const requests = [];
  const card = { signalId: "signal-1", symbol: "ETHUSDT", direction: "LONG", signalGrade: "A" };
  const response = {
    cards: [card],
    market: "BITGET_USDT_FUTURES",
    universe: { totalCount: 1, nextCursor: null },
    execution: {},
  };
  const wiring = runtimePackage.createAuthoritativePaperEvidenceSourceWiring({
    researchCodeSha: "a".repeat(40),
    dependencies: {
      scan: async (request) => {
        requests.push(request);
        return response;
      },
      align: async (_market, value) => value,
      rank: ({ cards }) => ({
        cards,
        diagnostics: {
          hardFilterPassCount: 1,
          hardFilterRejectedCount: 0,
          softCandidateCount: 1,
          backtestMissingCount: 0,
        },
      }),
      withCanonicalActions: (value) => value,
      attachCanonicalIdentity: ({ response: value }) => value,
      buildPublicRequests: () => ({
        ticker: { method: "GET", path: "/api/v2/mix/market/ticker", query: "symbol=ETHUSDT" },
      }),
      fetchPublicJson: async (url) => ({ url: String(url) }),
      buildPublicEvidence: (input) => ({
        provider: "bitget",
        symbol: input.symbol,
        observedAtMs: input.nowMs,
        dataQuality: "ready",
      }),
      now: () => 2_000,
    },
  });

  const scanBatch = await wiring.scanBatchForMarket({ market: "CRYPTO_FUTURES" });
  const scanned = await scanBatch({ market: "CRYPTO_FUTURES", cursor: 0 });
  assert.equal(scanned.cards[0].symbol, "ETHUSDT");
  assert.equal(requests[0].market, "futures");
  assert.equal(requests[0].strategyMode, "swing");
  assert.equal(requests[0].timeframe, "60m");
  assert.equal(requests[0].condition, "trend");
  assert.equal(requests[0].batchSize, 20);

  const evidence = await wiring.publicEvidenceForCard({ card, market: "CRYPTO_FUTURES" });
  assert.equal(evidence.provider, "bitget");
  assert.equal(evidence.symbol, "ETHUSDT");
  assert.equal(evidence.observedAtMs, 2_000);
  assert.equal(wiring.paperCandidateForCard({ card: {}, market: "CRYPTO_FUTURES" }), null);
  for (const callback of [
    "paperStateForCard",
    "contractRulesForCard",
    "executionObservationForCard",
    "supplementalCostEvidenceForCard",
  ]) {
    assert.equal(typeof wiring[callback], "function");
    assert.equal(await wiring[callback]({ card, market: "CRYPTO_FUTURES" }), null);
    assert.equal(wiring[callback].authoritativeOwner.callback, callback);
    assert.equal(wiring[callback].authoritativeOwner.ownerStatus, "OWNER_EXISTS");
    assert.equal(wiring[callback].authoritativeOwner.dataReadiness, "RUNTIME_VALIDATED_BLOCKED_DATA");
    assert.equal(wiring[callback].authoritativeOwner.missingDataBehavior, "BLOCKED_DATA");
    assert.equal(wiring[callback].authoritativeOwner.unknownIsZero, false);
  }
});

test("lossless Paper state snapshot preserves the complete state and never supplies a default balance", async () => {
  const nowMs = Date.now();
  const runtimePackage = await loadValidatedAuthoritativePaperRuntimePackage();
  const state = paperState(nowMs);
  const snapshot = runtimePackage.createImmutablePaperTradingStateSnapshot({
    state,
    sourceOwner: "CONTRACT_FIXTURE_ONLY",
    sourceSha: SOURCE_SHA,
    market: "CRYPTO_FUTURES",
    currency: "USDT",
    provenance: ["paper-trading-state-snapshot-contract-test"],
    publisherAccountIdSha256: PUBLISHER_ACCOUNT_ID_SHA256,
    observedAtMs: nowMs,
    maximumAgeMs: 30_000,
  });
  assert.deepEqual(snapshot.state, state);
  assert.equal(snapshot.equity, state.account.equity);
  assert.equal(snapshot.schemaVersion, "paper-trading-state-snapshot-v2");
  assert.equal(snapshot.market, "CRYPTO_FUTURES");
  assert.equal(snapshot.currency, "USDT");
  assert.equal(snapshot.sourceSha, SOURCE_SHA);
  assert.equal(snapshot.publisherAccountIdSha256, PUBLISHER_ACCOUNT_ID_SHA256);
  assert.equal(snapshot.stateDigestSha256.length, 64);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.state.account), true);
  assert.throws(() => runtimePackage.createImmutablePaperTradingStateSnapshot({
    state: { ...state, account: { ...state.account, equity: null } },
    sourceOwner: "CONTRACT_FIXTURE_ONLY",
    sourceSha: SOURCE_SHA,
    market: "CRYPTO_FUTURES",
    currency: "USDT",
    provenance: ["paper-trading-state-snapshot-contract-test"],
    publisherAccountIdSha256: PUBLISHER_ACCOUNT_ID_SHA256,
    observedAtMs: nowMs,
  }), /PAPER_STATE|모의계좌/u);
  assert.throws(() => runtimePackage.createImmutablePaperTradingStateSnapshot({
    state,
    sourceOwner: "CONTRACT_FIXTURE_ONLY",
    sourceSha: SOURCE_SHA,
    market: "",
    currency: "USDT",
    provenance: ["paper-trading-state-snapshot-contract-test"],
    publisherAccountIdSha256: PUBLISHER_ACCOUNT_ID_SHA256,
    observedAtMs: nowMs,
  }), /PAPER_STATE_MARKET_REQUIRED/u);

  const root = await mkdtemp(join(tmpdir(), "paper-state-snapshot-contract-"));
  try {
    const path = join(root, "snapshot.json");
    const owner = createLosslessPaperStateSnapshotFileOwner({
      snapshotPath: path,
      runtimePackage,
      expectedPublisherAccountIdSha256: PUBLISHER_ACCOUNT_ID_SHA256,
      now: () => nowMs + 1,
    });
    const written = await owner.writePaperStateSnapshot({
      state,
      sourceOwner: "CONTRACT_FIXTURE_ONLY",
      sourceSha: SOURCE_SHA,
      market: "CRYPTO_FUTURES",
      currency: "USDT",
      provenance: ["paper-trading-state-snapshot-contract-test"],
      publisherAccountIdSha256: PUBLISHER_ACCOUNT_ID_SHA256,
      observedAtMs: nowMs,
      maximumAgeMs: 30_000,
    });
    assert.equal(written.stateDigestSha256, snapshot.stateDigestSha256);
    assert.deepEqual(await owner.paperStateForCard(), state);
    assert.equal(owner.initializesPaperState, false);
    assert.equal(owner.recurringLedgerDerivationAllowed, false);
    assert.equal(owner.authenticatedPublisherRequired, true);
    assert.equal(owner.exactAccountBindingRequired, true);
    assert.equal(owner.unknownIsZero, false);
    const source = createPaperStateSourceFromLosslessSnapshotFile({
      snapshotPath: path,
      runtimePackage,
      expectedPublisherAccountIdSha256: PUBLISHER_ACCOUNT_ID_SHA256,
      now: () => nowMs + 1,
    });
    assert.deepEqual(await source(), state);
    const wrongAccountSource = createPaperStateSourceFromLosslessSnapshotFile({
      snapshotPath: path,
      runtimePackage,
      expectedPublisherAccountIdSha256: createHash("sha256")
        .update("different-publisher-account")
        .digest("hex"),
      now: () => nowMs + 1,
    });
    await assert.rejects(wrongAccountSource(), /PAPER_STATE_PUBLISHER_ACCOUNT_BINDING_MISMATCH/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence ownership map connects seven owners while preserving four runtime data blockers", () => {
  const contract = AUTHORITATIVE_PAPER_EVIDENCE_SOURCE_OWNERSHIP;
  assert.deepEqual(contract.callbacks.map((row) => row.callback), [
    "scanBatchForMarket",
    "paperCandidateForCard",
    "learningSnapshotForCard",
    "paperStateForCard",
    "contractRulesForCard",
    "publicEvidenceForCard",
    "executionObservationForCard",
    "supplementalCostEvidenceForCard",
  ]);
  const evidenceRows = contract.callbacks.slice(1);
  assert.equal(contract.callbacks.every((row) => typeof row.dataProvenance === "string" && row.dataProvenance.length > 0), true);
  assert.equal(evidenceRows.filter((row) => row.ownerStatus === "OWNER_EXISTS").length, 7);
  assert.equal(evidenceRows.filter((row) => row.ownerStatus === "OWNER_MISSING").length, 0);
  assert.equal(contract.sevenEvidenceOwnerSummary.callbacksWired, 7);
  assert.equal(contract.sevenEvidenceOwnerSummary.authoritativeOwnersConnected, 7);
  assert.equal(contract.sevenEvidenceOwnerSummary.runtimeBlockedDataOwners, 4);
  assert.equal(contract.sevenEvidenceOwnerSummary.scannerCallbackWired, true);
  assert.equal(contract.sevenEvidenceOwnerSummary.scheduledCanonicalWriter, "AUTHENTICATED_EXACT_ACCOUNT_PUBLISHER_CONNECTED");
  assert.equal(contract.sevenEvidenceOwnerSummary.allOwnersReady, false);
  assert.equal(contract.sevenEvidenceOwnerSummary.firstZeroStage, "UNKNOWN");
  assert.equal(contract.sevenEvidenceOwnerSummary.firstBlocker, "AUTHORITATIVE_EVIDENCE_DATA_UNAVAILABLE");
  assert.equal(contract.sevenEvidenceOwnerSummary.unknownIsZero, false);
  assert.equal(contract.executionAuthority, "NONE");
  assert.equal(contract.privateApiAllowed, false);
  assert.equal(contract.liveTrading, false);
  assert.equal(contract.scheduleActivationAuthority, false);
  assert.equal(contract.financialMutationAllowed, false);
});

test("owner data contracts preserve UNKNOWN and separate public observations from execution estimates", () => {
  const contracts = AUTHORITATIVE_PAPER_EVIDENCE_SOURCE_OWNERSHIP.blockedOwnerEvidenceContracts;

  assert.equal(contracts.paperStateForCard.status, "OWNER_EXISTS_BLOCKED_DATA");
  assert.equal(contracts.paperStateForCard.requiredAvailableFields.includes("state.riskState"), true);
  assert.equal(contracts.paperStateForCard.requiredAvailableFields.includes("state.processedEventIds"), true);
  assert.equal(contracts.paperStateForCard.inadmissibleDerivations.includes("paper-forward-observation-ledger-v1"), true);
  assert.equal(contracts.paperStateForCard.unknownIsZero, false);

  assert.equal(contracts.contractRulesForCard.status, "OWNER_EXISTS_BLOCKED_DATA");
  assert.equal(contracts.contractRulesForCard.requiredFields.includes("maintenanceMarginTier"), true);
  assert.equal(contracts.contractRulesForCard.missingCanonicalInputs.includes("sizedNotional"), true);
  assert.equal(contracts.contractRulesForCard.scalarMaintenanceMarginDefaultAllowed, false);

  assert.deepEqual(contracts.executionObservationForCard.observablePublicFields, [
    "timestamp", "market", "symbol", "bid", "ask", "spread", "depth", "liquidity",
  ]);
  assert.deepEqual(contracts.executionObservationForCard.estimatedModelFields, [
    "estimatedSlippage", "latencyEvidence", "partialFillEvidence", "confidence",
  ]);
  assert.equal(contracts.executionObservationForCard.publicDepthIsFillProof, false);
  assert.equal(contracts.executionObservationForCard.currentPriceIsFillPrice, false);
  assert.equal(contracts.executionObservationForCard.fixedSlippageAllowed, false);
  assert.equal(contracts.executionObservationForCard.fixedLatencyAllowed, false);
  assert.equal(contracts.executionObservationForCard.simulatedModelStatus, "EXECUTABLE_BLOCKED_DATA");
  assert.equal(contracts.executionObservationForCard.executionMode, "SIMULATED_EXECUTION_ONLY");
  assert.equal(contracts.executionObservationForCard.realFillClaimAllowed, false);
  assert.equal(contracts.executionObservationForCard.costEvidenceReady, false);

  assert.deepEqual(contracts.supplementalCostEvidenceForCard.partiallyOwnedComponents, [
    "fees", "funding", "spread",
  ]);
  assert.deepEqual(contracts.supplementalCostEvidenceForCard.missingOwnedComponents, [
    "slippage", "liquidityImpact", "latencyImpact", "partialFillImpact",
  ]);
  assert.equal(contracts.supplementalCostEvidenceForCard.profitFactorAllowed, false);
  assert.equal(contracts.supplementalCostEvidenceForCard.expectedValueAllowed, false);
  assert.equal(contracts.supplementalCostEvidenceForCard.unknownIsZero, false);
});
