import assert from "node:assert/strict";
import test from "node:test";
import {
  sha256Canonical,
  validateCompositeDatasetProvenance,
} from "../src/research-cache-provenance.js";
import {
  adaptBacktesterStrategyEvidenceV1,
  BACKTESTER_ADAPTER_SAFETY,
  backtesterLegacyResultDigestV1,
  buildBacktesterCompositeDatasetIdentityV1,
  PR191_BACKTESTER_EVIDENCE_CONTRACT_V1,
  verifyBacktesterStrategyEvidenceAdapterV1,
} from "../src/backtester-strategy-evidence-adapter-v1.js";
import {
  PROVISIONAL_CHAMPION_POLICY_V1,
  selectProvisionalChampion,
} from "../src/provisional-champion-selector-v1.js";

const SOURCE_SHA = "1".repeat(40);
const HARNESS_SHA = "2".repeat(40);
const ARCHIVE_DIGEST = "3".repeat(64);
const CANDLE_DIGEST = "4".repeat(64);
const FUNDING_DIGEST = "5".repeat(64);
const PR191_CANDLE_DIGEST = "475c63b21e726a6d156eb977ac3c5b035c04609d755475f734f5e85d14c965a6";
const PR191_FUNDING_DIGEST = "2e538fba4f16d14499204f7d8b5ef7c156047491b3d604faff57d057c973e432";
const PR191_COMPOSITE_DATASET_DIGEST = "3a0cdb64601b6df069126ef67a81473be069082b57d8e3457e6ed429f8fe0264";

function backtesterFixture() {
  const contract = {
    family: "V3_RVOL_TREND_SCALPING",
    structuralFamily: "EMA_ATR_PLUS_RVOL_TREND",
    timeframeAssumption: "15m_only",
    entryRule: "unchanged fixture entry",
    exitRule: "unchanged fixture exit",
    riskSizing: "existing risk input only",
  };
  const oos = {
    tradeCount: 582,
    expectancy: -1278.8580127612186,
    profitFactor: 0.48186035592462334,
    totalReturn: -0.7442953634270292,
    maximumDrawdown: 0.7483135674086393,
    sharpe: -8.233369619758307,
    winRate: 0.3127147766323024,
    turnover: 311.5843265720859,
    fees: 373682.41805769183,
    spread: 62280.39643054534,
    slippage: 124560.7964167267,
    funding: 5989.897350143476,
    latency: 0,
    concentration: { largestWinnerShare: 0.02 },
    regimePerformance: { regimeCount: 1, profitableRegimeRatio: 0 },
  };
  const stressed = {
    tradeCount: 582,
    expectancy: -1565.228093783652,
    profitFactor: 0.2916323106522941,
    totalReturn: -0.9109627505820854,
    maximumDrawdown: 0.9117562845289202,
    sharpe: -14.489874322232115,
    winRate: 0.28865979381443296,
    turnover: 214.51629748722354,
    fees: 514373.29031739815,
    spread: 85728.85914127293,
    slippage: 171457.72876253029,
    funding: 8403.083649311566,
    latency: 0,
  };
  const statisticalQuality = {
    developmentTradeCount: 2702,
    oosTradeCount: 582,
    wfTradeCount: 861,
    totalIndependentTrades: 582,
    sampleQuality: "uncalibrated_not_a_pass",
    statisticalPass: false,
  };
  const overfitDiagnostics = { flags: ["walk_forward_window_dependency"], wfWindowDispersion: 0.0409 };
  const wfStability = {
    windowCount: 2,
    profitableWindowsRatio: 0,
    medianReturn: -0.25,
    medianProfitFactor: 0.54,
    worstWindowMaximumDrawdown: 0.35,
    performanceDispersion: 0.04,
    stabilityScore: 28.7,
  };
  const executionCostStress = {
    status: "failed",
    scenarioId: "double_configured_execution_costs_v1",
    multiplier: 2,
    baseline: oos,
    stressed,
    positiveAfterStress: false,
    includes: { fee: true, spread: true, slippage: true, funding: true, latency: true },
    selectionAffected: false,
    finalHoldoutUsed: false,
    reasons: ["non_positive_oos_return_or_expectancy_after_execution_cost_stress"],
  };
  const nested = {
    schemaVersion: 1,
    version: "V3",
    strategy: contract.family,
    family: contract.family,
    structuralFamily: contract.structuralFamily,
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    direction: "LONG",
    timeframe: "15m",
    candidateId: "V3:test-only-negative-evidence",
    parameters: { fastPeriod: 5, slowPeriod: 50, stopAtrMultiple: 1.75, targetRiskMultiple: 2 },
    filter: { rvolMin: 1.3, volumeExpansionMin: 1.2, trendStrengthMin: 0.8 },
    development: { tradeCount: 2702 },
    oos,
    walkForward: {
      windows: [
        { window: 1, startTime: 1, endTime: 2, leakFree: true, tradeCount: 430 },
        { window: 2, startTime: 3, endTime: 4, leakFree: true, tradeCount: 431 },
      ],
      stability: wfStability,
    },
    statisticalQuality,
    overfitDiagnostics,
    executionCostStress,
    promotionEligible: false,
    promotionBlockReasons: ["execution_cost_stress_failed"],
    researchStatus: "research_hold",
    finalHoldoutUsed: false,
    orderSubmitted: false,
  };
  const group = "BINANCE_FUTURES_SCALPING_LONG";
  const flat = {
    group,
    family: nested.family,
    structuralFamily: nested.structuralFamily,
    version: nested.version,
    candidateId: nested.candidateId,
    market: nested.market,
    symbol: nested.symbol,
    direction: nested.direction,
    parameters: nested.parameters,
    filter: nested.filter,
    developmentTradeCount: nested.development.tradeCount,
    oosTradeCount: oos.tradeCount,
    wfTradeCount: statisticalQuality.wfTradeCount,
    expectancy: oos.expectancy,
    profitFactor: oos.profitFactor,
    totalReturn: oos.totalReturn,
    MDD: oos.maximumDrawdown,
    sharpe: oos.sharpe,
    winRate: oos.winRate,
    turnover: oos.turnover,
    statisticalQuality,
    concentration: oos.concentration,
    regimePerformance: oos.regimePerformance,
    overfitDiagnostics,
    wfStability,
    executionCostStress,
    promotionEligible: false,
    promotionBlockReasons: nested.promotionBlockReasons,
    researchStatus: "research_hold",
    finalHoldoutUsed: false,
  };
  return {
    schemaVersion: 1,
    mode: "bounded-15m-scalping-family-research",
    researchCodeSha: SOURCE_SHA,
    selectionPeriod: { start: 1577836800000, end: 1767225599999 },
    finalHoldoutPeriod: { start: 1767225600000, status: "LOCKED_NOT_EVALUATED" },
    adapterContracts: { V3: contract },
    results: [{
      group,
      source: {
        datasetKey: "futures-btc-long",
        market: "CRYPTO_FUTURES",
        symbol: "BTCUSDT",
        provider: "binance-vision-usdm-monthly",
        providerVersion: "public-data-archive-checksum-selection-v1",
        sourceDigest: CANDLE_DIGEST,
        fundingDigest: FUNDING_DIGEST,
        providerBoundary: "SAME_VENUE_BINANCE_USDM",
        priceVenue: "BINANCE_USDM",
        fundingVenue: "BINANCE_USDM",
        crossVenueMix: false,
        selectionDataStatus: "DATA_READY",
        costAssumption: PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.costPolicy.costAssumption,
      },
      research: {
        market: nested.market,
        symbol: nested.symbol,
        direction: nested.direction,
        timeframe: nested.timeframe,
        families: [{ version: "V3", contract, candidates: [nested] }],
        privateApiUsed: false,
        orderSubmitted: false,
      },
    }],
    candidates: [flat],
    finalHoldoutUsed: false,
    finalHoldoutRead: false,
    privateApiUsed: false,
    orderSubmitted: false,
  };
}

function strategyIdentity(raw, datasetIdentity) {
  const nested = raw.results[0].research.families[0].candidates[0];
  const formulaIdentity = raw.adapterContracts[nested.version];
  return {
    strategyId: nested.candidateId,
    strategyFamily: nested.family,
    strategyVersion: nested.version,
    market: nested.market,
    direction: nested.direction,
    timeframe: nested.timeframe,
    formulaIdentity,
    formulaHash: sha256Canonical(formulaIdentity),
    parameterHash: sha256Canonical({ parameters: nested.parameters, filter: nested.filter }),
    researchCodeSha: raw.researchCodeSha,
    ...datasetIdentity,
    costPolicyVersion: PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.costPolicyVersion,
    riskPolicyVersion: PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.riskPolicyVersion,
    evidenceSchemaVersion: "strategy-evidence-envelope-v1",
  };
}

function adapterInput(raw = backtesterFixture(), overrides = {}) {
  const datasetIdentity = buildBacktesterCompositeDatasetIdentityV1(raw);
  return {
    artifactPayload: raw,
    artifactId: "TEST_ONLY:V3.raw.json",
    artifactDigest: sha256Canonical(raw),
    legacyResultDigest: backtesterLegacyResultDigestV1(raw),
    artifactArchiveDigest: ARCHIVE_DIGEST,
    sourceSha: raw.researchCodeSha,
    historicalHarnessSha: HARNESS_SHA,
    measuredAt: "2026-08-23T10:55:50.000Z",
    candidateId: raw.candidates[0].candidateId,
    datasetIdentity,
    strategyIdentity: strategyIdentity(raw, datasetIdentity),
    testOnly: true,
    ...overrides,
  };
}

test("Backtester dataset identity is the authoritative #664 composite provenance contract", () => {
  const raw = backtesterFixture();
  const source = raw.results[0].source;
  const datasetIdentity = buildBacktesterCompositeDatasetIdentityV1(raw);
  const validation = validateCompositeDatasetProvenance(datasetIdentity);

  assert.equal(validation.valid, true);
  assert.equal(validation.status, "VALID");
  assert.equal(datasetIdentity.schemaVersion, "ResearchCompositeDatasetProvenanceV1");
  assert.equal(datasetIdentity.componentCount, 2);
  assert.equal(datasetIdentity.components.candles, source.sourceDigest);
  assert.equal(datasetIdentity.components.funding, source.fundingDigest);
  assert.equal(validation.datasetDigest, datasetIdentity.datasetDigest);
  assert.equal(datasetIdentity.datasetStart, "2020-01-01T00:00:00.000Z");
  assert.equal(datasetIdentity.datasetEnd, "2025-12-31T23:59:59.999Z");

  source.datasetKey = "futures-btc-long";
  source.sourceDigest = PR191_CANDLE_DIGEST;
  source.fundingDigest = PR191_FUNDING_DIGEST;
  const pr191Identity = buildBacktesterCompositeDatasetIdentityV1(raw);
  assert.equal(pr191Identity.datasetDigest, PR191_COMPOSITE_DATASET_DIGEST);
  assert.equal(validateCompositeDatasetProvenance(pr191Identity).status, "VALID");
});

test("legacy private dataset shape cannot claim authoritative #664 provenance", () => {
  const authoritative = buildBacktesterCompositeDatasetIdentityV1(backtesterFixture());
  const privateShape = {
    datasetId: authoritative.datasetId,
    datasetDigest: authoritative.datasetDigest,
    datasetStart: authoritative.datasetStart,
    datasetEnd: authoritative.datasetEnd,
  };
  const validation = validateCompositeDatasetProvenance(privateShape);
  assert.equal(validation.valid, false);
  assert.equal(validation.status, "MISSING_EVIDENCE");
  assert.equal(validation.reason, "composite_dataset_schema_missing");

  const input = adapterInput();
  input.datasetIdentity = privateShape;
  const result = adaptBacktesterStrategyEvidenceV1(input);
  assert.equal(result.status, "ADAPTER_REJECTED");
  assert.ok(result.blockers.includes("DATASET_IDENTITY_MISSING_EVIDENCE"));
  assert.ok(result.blockers.includes("DATASET_IDENTITY_MISMATCH"));
});

test("authoritative composite provenance mismatches fail closed", () => {
  const base = buildBacktesterCompositeDatasetIdentityV1(backtesterFixture());
  const malformed = [
    { ...base, schemaVersion: "backtester-composite-dataset-digest-v1" },
    { ...base, componentCount: 1 },
    { ...base, components: { ...base.components, candles: "6".repeat(64) } },
    { ...base, components: { ...base.components, funding: "7".repeat(64) } },
    { ...base, datasetId: "different-dataset" },
    { ...base, datasetDigest: "8".repeat(64) },
    { ...base, components: { funding: base.components.funding } },
    { ...base, components: { candles: base.components.candles } },
    { ...base, components: null },
  ];

  for (const datasetIdentity of malformed) {
    const input = adapterInput();
    input.datasetIdentity = datasetIdentity;
    const result = adaptBacktesterStrategyEvidenceV1(input);
    assert.notEqual(result.status, "ADAPTED");
    assert.ok(result.blockers.includes("DATASET_IDENTITY_MISMATCH")
      || result.blockers.includes("DATASET_IDENTITY_MISSING_EVIDENCE"));
  }

  const circularInput = adapterInput();
  const circularIdentity = { ...base, components: {} };
  circularIdentity.components.candles = circularIdentity.components;
  circularIdentity.components.funding = base.components.funding;
  circularInput.datasetIdentity = circularIdentity;
  const circularResult = adaptBacktesterStrategyEvidenceV1(circularInput);
  assert.equal(circularResult.status, "ADAPTER_REJECTED");
  assert.ok(circularResult.blockers.includes("DATASET_IDENTITY_MALFORMED"));
});

test("exact OOS, Walk Forward, and Cost Stress metrics pass through without input mutation", () => {
  const input = adapterInput();
  const before = structuredClone(input);
  const result = adaptBacktesterStrategyEvidenceV1(input);
  assert.equal(result.status, "ADAPTED");
  assert.deepEqual(input, before);
  assert.deepEqual(result.safety, BACKTESTER_ADAPTER_SAFETY);
  assert.deepEqual(result.candidate.safety, BACKTESTER_ADAPTER_SAFETY);
  assert.ok(result.candidate.evidenceEnvelopes.every((row) => row.safety === BACKTESTER_ADAPTER_SAFETY));

  const nested = input.artifactPayload.results[0].research.families[0].candidates[0];
  const [oos, walkForward, costStress] = result.candidate.evidenceEnvelopes.map((row) => row.envelope);
  assert.equal(oos.sample.tradeN, nested.oos.tradeCount);
  assert.equal(oos.sample.settledN, null);
  assert.equal(oos.metrics.expectancy, nested.oos.expectancy);
  assert.equal(oos.metrics.profitFactor, nested.oos.profitFactor);
  assert.equal(oos.metrics.mdd, nested.oos.maximumDrawdown);
  assert.equal(oos.metrics.netReturn, nested.oos.totalReturn);
  assert.equal(oos.metrics.winRate, nested.oos.winRate);
  assert.equal(walkForward.sample.tradeN, nested.statisticalQuality.wfTradeCount);
  assert.equal(walkForward.metrics.positiveWindowRatio, nested.walkForward.stability.profitableWindowsRatio);
  assert.equal(costStress.validation.costStressSurvived, false);
  assert.equal(costStress.metrics.expectancy, nested.executionCostStress.stressed.expectancy);
  assert.equal(costStress.metrics.profitFactor, nested.executionCostStress.stressed.profitFactor);
  assert.equal(costStress.metrics.mdd, nested.executionCostStress.stressed.maximumDrawdown);
  assert.equal(costStress.metrics.netReturn, nested.executionCostStress.stressed.totalReturn);
  assert.equal(costStress.metrics.costAdjustedReturn, nested.executionCostStress.stressed.totalReturn);
  assert.deepEqual(verifyBacktesterStrategyEvidenceAdapterV1(result.candidate).blockers, []);

  const tampered = structuredClone(result.candidate);
  tampered.canonicalEvidenceAuthority.sourceSha = "9".repeat(40);
  const tamperedVerification = verifyBacktesterStrategyEvidenceAdapterV1(tampered);
  assert.equal(tamperedVerification.verified, false);
  assert.ok(tamperedVerification.blockers.includes("ADAPTER_AUTHORITY_DIGEST_MISMATCH"));
});

test("artifact digest and source SHA mismatches fail closed", () => {
  const digestMismatch = adaptBacktesterStrategyEvidenceV1(adapterInput(undefined, { artifactDigest: "0".repeat(64) }));
  assert.equal(digestMismatch.status, "ADAPTER_REJECTED");
  assert.ok(digestMismatch.blockers.includes("ARTIFACT_DIGEST_MISMATCH"));

  const sourceMismatch = adaptBacktesterStrategyEvidenceV1(adapterInput(undefined, { sourceSha: "9".repeat(40) }));
  assert.equal(sourceMismatch.status, "ADAPTER_REJECTED");
  assert.ok(sourceMismatch.blockers.includes("SOURCE_SHA_MISMATCH"));
});

test("dataset and strategy identity mismatches fail closed", () => {
  const datasetInput = adapterInput();
  datasetInput.datasetIdentity = { ...datasetInput.datasetIdentity, datasetId: "different-dataset" };
  const datasetMismatch = adaptBacktesterStrategyEvidenceV1(datasetInput);
  assert.equal(datasetMismatch.status, "ADAPTER_REJECTED");
  assert.ok(datasetMismatch.blockers.includes("DATASET_IDENTITY_MISMATCH"));

  const strategyInput = adapterInput();
  strategyInput.strategyIdentity = { ...strategyInput.strategyIdentity, direction: "SHORT" };
  const strategyMismatch = adaptBacktesterStrategyEvidenceV1(strategyInput);
  assert.equal(strategyMismatch.status, "ADAPTER_REJECTED");
  assert.ok(strategyMismatch.blockers.includes("STRATEGY_IDENTITY_MISMATCH"));
});

test("Walk Forward leakage and missing measuredAt fail closed", () => {
  const leakingRaw = backtesterFixture();
  leakingRaw.results[0].research.families[0].candidates[0].walkForward.windows[0].leakFree = false;
  const leakage = adaptBacktesterStrategyEvidenceV1(adapterInput(leakingRaw));
  assert.equal(leakage.status, "ADAPTER_REJECTED");
  assert.ok(leakage.blockers.includes("WALK_FORWARD_LEAKAGE_FAIL_CLOSE"));

  const missingMeasuredAt = adaptBacktesterStrategyEvidenceV1(adapterInput(undefined, { measuredAt: null }));
  assert.equal(missingMeasuredAt.status, "MISSING_EVIDENCE");
  assert.deepEqual(missingMeasuredAt.missingEvidence, ["MEASURED_AT"]);
  assert.equal(missingMeasuredAt.candidate, null);
});

test("missing statistical evidence remains missing and never becomes PASS", () => {
  const result = adaptBacktesterStrategyEvidenceV1(adapterInput());
  const [oos, walkForward, , firewall] = result.candidate.evidenceEnvelopes.map((row) => row.envelope);
  assert.equal(oos.validation.mddAcceptable, "UNKNOWN");
  assert.equal(walkForward.validation.parameterStability, "UNKNOWN");
  assert.equal(firewall.metrics.dsr, null);
  assert.equal(firewall.metrics.pbo, null);
  assert.equal(firewall.validation.overfitVerdict, "UNKNOWN");
  assert.ok(firewall.missingEvidence.includes("DSR"));
  assert.ok(firewall.missingEvidence.includes("PBO"));
  assert.ok(result.missingEvidence.includes("SETTLED_N"));
});

test("negative real-shaped evidence remains NONE with no execution authority", () => {
  const adapted = adaptBacktesterStrategyEvidenceV1(adapterInput());
  const testPolicy = Object.freeze({ ...PROVISIONAL_CHAMPION_POLICY_V1, environment: "TEST_ONLY" });
  const verdict = selectProvisionalChampion({ candidates: [adapted.candidate], policy: testPolicy });
  assert.equal(verdict.status, "NONE");
  assert.equal(verdict.currentProvisionalChampion, "NONE");
  assert.equal(verdict.currentValidatedChampion, "NONE");
  assert.equal(verdict.profitabilityProven, false);
  assert.equal(verdict.forwardEvidenceSufficient, false);
  assert.equal(verdict.executionAuthority, "NONE");
  assert.equal(verdict.orderSubmitted, false);
  assert.ok(verdict.blockers.includes("OOS_POSITIVE_EXPECTANCY_REQUIRED"));
  assert.ok(verdict.blockers.includes("OOS_PROFIT_FACTOR_ABOVE_ONE_REQUIRED"));
  assert.ok(verdict.blockers.includes("OOS_POSITIVE_NET_RETURN_REQUIRED"));
  assert.ok(verdict.blockers.includes("WALK_FORWARD_POSITIVE_WINDOW_REQUIRED"));
  assert.ok(verdict.blockers.includes("COST_STRESS_SURVIVAL_REQUIRED"));
  assert.ok(verdict.blockers.includes("STATISTICAL_FIREWALL_METRICS_REQUIRED"));
  assert.ok(verdict.blockers.includes("MISSING_EVIDENCE:STATISTICAL_FIREWALL:DSR"));
  assert.ok(verdict.blockers.includes("MISSING_EVIDENCE:STATISTICAL_FIREWALL:PBO"));
  assert.equal(verdict.safety.LIVE_TRADING, false);
  assert.equal(verdict.safety.AUTO_TRADING, false);
  assert.equal(verdict.safety.REAL_ORDER_ENABLED, false);
  assert.equal(verdict.safety.PRIVATE_TRADING_API_ALLOWED, false);
  assert.equal(verdict.safety.executionAuthority, "NONE");
  assert.equal(verdict.safety.orderSubmitted, false);
});
