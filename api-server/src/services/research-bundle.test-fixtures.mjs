import { buildResearchDatasetIdentity, sha256Canonical as hash } from '../../../market-prediction-lab/src/research-cache-provenance.js';
import { createHash } from 'node:crypto';
import { resolveCanonicalStrategyIdentity } from '../../../market-prediction-lab/src/canonical-strategy-identity-v1.js';
// TEST_ONLY #769 sizing fixture. No Paper orders; economic credit: 0.
import { compiledMomentumFormula } from '../../../market-prediction-lab/tests/research-bundle-formula-fixture.js';
import { createPaperTradingState } from './paper-trading-core.service.ts';
import { createImmutablePaperTradingStateSnapshot } from './paper-trading-state-snapshot.service.ts';
const AUTHORITATIVE_NOW_MS = Date.parse('2026-08-28T04:30:00.000Z');
const AUTHORITATIVE_RESEARCH_SHA = 'a'.repeat(40);
const AUTHORITATIVE_PAPER_SHA = 'b'.repeat(40);
const AUTHORITATIVE_ACCOUNT_BINDING = 'c'.repeat(64);

function authoritativeSnapshot(
  market,
  observedAtMs = AUTHORITATIVE_NOW_MS - 1_000,
  maximumAgeMs = 30_000,
) {
  const state = createPaperTradingState(10_000, new Date(observedAtMs));
  return createImmutablePaperTradingStateSnapshot({
    state,
    sourceOwner: 'authoritative-paper-risk-sizing-test',
    sourceSha: AUTHORITATIVE_PAPER_SHA,
    market,
    currency: market === 'US_STOCK' ? 'USD' : market === 'CRYPTO_FUTURES' ? 'USDT' : 'KRW',
    provenance: ['TEST_AUTHORITATIVE_PAPER_STATE'],
    publisherAccountIdSha256: AUTHORITATIVE_ACCOUNT_BINDING,
    observedAtMs,
    maximumAgeMs,
  });
}

function authoritativeSizingInput(
  market = 'CRYPTO_FUTURES',
  symbol = 'BTCUSDT',
) {
  const observedAtMs = AUTHORITATIVE_NOW_MS - 1_000;
  const snapshot = authoritativeSnapshot(market, observedAtMs);
  const isFutures = market === 'CRYPTO_FUTURES';
  const isStock = market === 'KR_STOCK' || market === 'US_STOCK';
  const quantityStep = isStock ? 1 : 0.001;
  const quantityPrecision = isStock ? 0 : 3;
  return {
    market,
    symbol,
    strategyScope: 'swing',
    side: 'LONG',
    researchCodeSha: AUTHORITATIVE_RESEARCH_SHA,
    paperStateSourceSha: AUTHORITATIVE_PAPER_SHA,
    paperAccountId: snapshot.accountId,
    riskPolicy: {
      schemaVersion: 'authoritative-paper-generic-risk-policy-evidence-v1',
      policyId: 'TEST_EXPLICIT_POLICY',
      policyVersion: 'v1',
      source: 'TEST_EXPLICIT_RISK_POLICY_SOURCE',
      provenance: ['TEST_POLICY_PROVENANCE'],
      observedAtMs,
      maximumAgeMs: 30_000,
      researchCodeSha: AUTHORITATIVE_RESEARCH_SHA,
      marketScopes: [market],
      strategyScopes: ['swing'],
      symbolScopes: [symbol],
      riskPercent: 0.5,
      requestedLeverage: isFutures ? 2 : 1,
      maximumLeverage: isFutures ? 5 : null,
      marginMode: isFutures ? 'isolated' : 'cash',
    },
    paperStateSnapshot: snapshot,
    contractRulesEvidence: {
      schemaVersion: 'authoritative-paper-contract-rules-evidence-v1',
      ruleVersion: 'TEST_RULES_V1',
      market,
      symbol,
      source: 'TEST_CANONICAL_CONTRACT_RULES',
      provenance: ['TEST_CONTRACT_RULES_PROVENANCE'],
      observedAtMs,
      maximumAgeMs: 30_000,
      rules: {
        symbol,
        quantityStep,
        quantityPrecision,
        minimumQuantity: quantityStep,
        minimumNotional: 1,
        maximumLeverage: isFutures ? 50 : null,
        maintenanceMarginRate: isFutures ? 0.005 : null,
        status: 'live',
        updatedAt: new Date(observedAtMs).toISOString(),
        warnings: [],
      },
    },
    marketEvidence: {
      schemaVersion: 'authoritative-paper-market-risk-evidence-v1',
      market,
      symbol,
      entryPrice: 100,
      stopLossPrice: 99,
      source: 'TEST_PUBLIC_MARKET_EVIDENCE',
      provenance: ['TEST_MARKET_PROVENANCE'],
      observedAtMs,
      maximumAgeMs: 30_000,
      status: 'live',
    },
    costEvidence: {
      schemaVersion: 'authoritative-paper-risk-cost-evidence-v1',
      market,
      symbol,
      source: 'TEST_EXECUTION_COST_EVIDENCE',
      provenance: ['TEST_COST_PROVENANCE'],
      observedAtMs,
      maximumAgeMs: 30_000,
      entryFeeRate: 0.0006,
      exitFeeRate: 0.0006,
      slippageRate: 0.0005,
      estimatedFundingRate: isFutures ? 0.0001 : 0,
    },
  };
}


export { compiledMomentumFormula, authoritativeSizingInput, AUTHORITATIVE_NOW_MS };
const NOW = AUTHORITATIVE_NOW_MS;
const START = Date.UTC(2020, 0, 2), STEP = 900_000;
const seal = (id, payload) => ({ id, payload, digest: hash(payload) });
function fixture() {
  const { formula, generated } = compiledMomentumFormula();
  const dsl = { market: formula.market, timeframe: formula.timeframe, direction: formula.direction,
    availableDataFields: formula.availableDataFields, entryDsl: formula.entryDsl, exitDsl: formula.exitDsl,
    parameterSpace: formula.parameterSpace, limits: formula.dslLimits };
  const rows = Array.from({ length: 30 }, (_, i) => ({ timestamp: START + i * STEP,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 100 + i }));
  const assignments = { TRAIN: rows.slice(0, 10).map(r => r.timestamp), VALIDATION: rows.slice(10, 20).map(r => r.timestamp), OOS: rows.slice(20).map(r => r.timestamp) };
  const identity = buildResearchDatasetIdentity({ market: 'US_STOCK', symbol: 'AAPL', timeframe: '15m', rows,
    provider: 'TEST_ONLY', providerVersion: 'v1', sourceType: 'TEST_ONLY', requestedStart: START, requestedEnd: rows.at(-1).timestamp,
    actualStart: START, actualEnd: rows.at(-1).timestamp, adjustmentMode: 'TEST_ONLY_PIT', corporateActionMode: 'TEST_ONLY_PIT',
    timezone: 'UTC', splitContract: assignments, sourceDigest: hash(rows), researchCodeSha: 'a'.repeat(40),
    loaderVersion: 'TEST_ONLY', missingIntervalCount: 0, duplicateRowCount: 0, dataQualityStatus: 'VERIFIED', generatedAt: new Date(NOW).toISOString() });
  const scope = { datasetId: 'dataset:train:evaluator-v1', datasetDigest: identity.datasetDigest,
    market: 'US_STOCK', symbol: 'AAPL', timeframe: '15m', researchCodeSha: 'a'.repeat(40) };
  const frozenAtMs = START - STEP;
  const splitPolicy = seal('TEST_ONLY_SPLIT', { ...scope, frozenAtMs, firstOutcomeObservedAtMs: START, assignments });
  const splitReceipt = seal('TEST_ONLY_SPLIT_RECEIPT', { ...scope, policyDigest: splitPolicy.digest, assignments, observedAtMs: NOW - 1000, untouchedOos: true });
  const sizing = authoritativeSizingInput('US_STOCK', 'AAPL');
  const riskPolicy = { ...sizing.riskPolicy, schemaVersion: 'authoritative-paper-generic-risk-policy-record-v1',
    recordId: 'TEST_ONLY_RISK', recordVersion: 'v1', policyId: formula.riskPolicyIdentity };
  const values = { commission: { entryFeeRate: 0.0006, exitFeeRate: 0.0006 }, tax: 0.001, spread: 0.0001,
    slippage: 0.0005, funding: [], latency: { bars: 0, driftRate: 0 }, liquidityImpact: 0, partialFillImpact: 0 };
  const components = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
    ...scope, value, source: 'TEST_ONLY', provenance: ['TEST_ONLY_OBSERVED_VALUE'], bucket: 'TEST_ONLY_BUCKET',
    observedAtMs: NOW - 1000, maximumAgeMs: 30_000 }]));
  const bundle = { schemaVersion: 'research-bundle-source-v1', evidenceClass: 'TEST_ONLY', dsl,
    formulaCandidate: formula, generatedCandidate: generated,
    strategy: { strategyId: 'swing', strategyFamily: formula.strategyFamily, strategyVersion: 'v1',
      market: scope.market, direction: 'LONG', timeframe: scope.timeframe, formulaHash: formula.formulaHash,
      parameterHash: generated.parameterIdentity, researchCodeSha: scope.researchCodeSha,
      datasetId: scope.datasetId, datasetDigest: scope.datasetDigest, datasetStart: new Date(START).toISOString(),
      datasetEnd: new Date(rows.at(-1).timestamp).toISOString(), costPolicyVersion: formula.costPolicyIdentity,
      riskPolicyVersion: riskPolicy.policyVersion, evidenceSchemaVersion: 'research-bundle-source-v1' },
    dataset: { id: scope.datasetId, identity, rows, observationIntervalMs: STEP, purpose: 'STRATEGY_OHLCV', immutable: true, pointInTimeSafe: true,
      leakageStatus: 'CLEAR', observedAtMs: NOW - 1000,
      receipt: seal('TEST_ONLY_DATASET_RECEIPT', { ...scope, datasetIdentityId: identity.datasetIdentityId, rowCount: rows.length }) },
    splitPolicy, splitReceipt, riskPolicy, riskSizingInput: sizing,
    costPolicy: seal(formula.costPolicyIdentity, { ...scope, bucket: 'TEST_ONLY_BUCKET', components }),
    oosPolicy: seal('TEST_ONLY_OOS', { ...scope, frozenAtMs, splitReceiptDigest: splitReceipt.digest,
      startTime: assignments.OOS[0], endTime: assignments.OOS.at(-1), untouched: true }),
    wfPolicy: seal('TEST_ONLY_WF', { ...scope, frozenAtMs, windows: [{ train: assignments.TRAIN, validation: assignments.VALIDATION }] }),
    holdoutPolicy: seal('TEST_ONLY_HOLDOUT', { ...scope, frozenAtMs, firewallIdentity: 'TEST_ONLY_FIREWALL',
      datasetId: 'TEST_ONLY_LOCKED_HOLDOUT', assignments: [START + 40 * STEP, START + 41 * STEP],
      startTime: START + 40 * STEP, endTime: START + 41 * STEP, locked: true }),
    backtest: { initialCapital: 10000, maximumCapitalFraction: 1, quantityStep: 1 },
  };
  const exactModelJson = JSON.stringify({ modelSchemaVersion: 'TEST_ONLY_MODEL', featureOrder: ['TEST_ONLY_momentum'],
    normalization: { mean: [0], scale: [1] } });
  const strategy = resolveCanonicalStrategyIdentity(bundle.strategy);
  bundle.modelReference = { exactModelJson, producerManifest: {
    status: 'VALID', referenceProvenanceStatus: 'VALID',
    strategyIdentity: strategy.identity, strategyIdentityDigest: strategy.strategyIdentityDigest,
    datasetId: scope.datasetId, datasetDigest: scope.datasetDigest, researchCodeSha: scope.researchCodeSha,
    modelSha: createHash('sha256').update(exactModelJson).digest('hex'),
    modelArtifactCanonicalDigest: hash(JSON.parse(exactModelJson)), featureOrderDigest: hash(['TEST_ONLY_momentum']),
    preprocessingVersion: 'TEST_ONLY_PREPROCESSING', rawArtifactDigest: hash('TEST_ONLY_RAW'), trainingCodeSha: scope.researchCodeSha,
    measuredAt: new Date(NOW - 1000).toISOString(), artifactReceipt: { artifactId: 'TEST_ONLY', artifactReference: 'TEST_ONLY',
      outerArtifactDigest: hash('TEST_ONLY_OUTER'), expiresAt: new Date(NOW + 30_000).toISOString() },
    sourceAttestation: { sourceKind: 'TEST_ONLY', reconstructed: false, synthetic: true, shadowDerived: false, finalHoldoutIncluded: false },
  } };
  return { dsl, bundle };
}

export { fixture as researchBundleFixture };
