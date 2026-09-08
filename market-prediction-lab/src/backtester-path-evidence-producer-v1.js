import {
  BACKTESTER_STRATEGY_EVIDENCE_ADAPTER_SCHEMA_VERSION,
  BACKTESTER_STRATEGY_EVIDENCE_AUTHORITY,
} from "./backtester-strategy-evidence-adapter-v1.js";
import { V1_STRATEGY_ID } from "./multi-market-backtest-engine.js";
import { sha256Canonical } from "./research-cache-provenance.js";

export const BACKTESTER_PATH_EVIDENCE_PRODUCER_SCHEMA_VERSION = "backtester-path-evidence-producer-v1";
export const BACKTESTER_PATH_EVIDENCE_SET_SCHEMA_VERSION = "backtester-trade-path-evidence-set-v1";
export const BACKTESTER_PATH_EVIDENCE_RECEIPT_SCHEMA_VERSION = "backtester-trade-path-evidence-receipt-v1";

const SHA_40 = /^[0-9a-f]{40}$/u;
const SHA_64 = /^[0-9a-f]{64}$/u;
const FINAL_HOLDOUT_START_TIME = Date.UTC(2026, 0, 1);
const REQUIRED_MISSING_EVIDENCE = Object.freeze([
  "ENTRY_CONTRIBUTION",
  "EXIT_CONTRIBUTION",
  "SCALAR_MAE_AGGREGATION_POLICY",
  "SCALAR_MFE_AGGREGATION_POLICY",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function unique(values) {
  return [...new Set(values)].sort();
}

function digestOrNull(value) {
  try {
    return sha256Canonical(value);
  } catch {
    return null;
  }
}

function exactSha(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return SHA_40.test(normalized) ? normalized : null;
}

function iso(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export const BACKTESTER_PATH_EVIDENCE_TRUTH_FLAGS = deepFreeze({
  LIVE_TRADING: false,
  PRIVATE_TRADING_API_ALLOWED: false,
  executionAuthority: "NONE",
  REAL_ORDER_COUNT: 0,
  PROFITABILITY_PROVEN: false,
  CURRENT_VALIDATED_CHAMPION: "NONE",
});

export const BACKTESTER_PATH_EVIDENCE_SAFETY = deepFreeze({
  ...BACKTESTER_PATH_EVIDENCE_TRUTH_FLAGS,
  publicDataOnly: true,
  fixedV1ValidationCasesOnly: true,
  finalHoldoutAllowed: false,
  testOnlyEvidenceAllowed: false,
  replayEvidenceAllowed: false,
  syntheticEvidenceAllowed: false,
  branchWriteAllowed: false,
  scheduleAllowed: false,
});

const FIXED_CASE_BASE = {
  schemaVersion: "fixed-public-v1-path-evidence-case-v1",
  caseId: "BINANCE_USDM_BTCUSDT_15M_2024_01_FIRST_36_V1_SHORT",
  evidenceClass: "FIXED_PUBLIC_V1_VALIDATION",
  source: {
    sourceType: "PUBLIC_HISTORICAL_SNAPSHOT",
    provider: "BINANCE_VISION_USDM",
    publicOnly: true,
    testOnly: false,
    replay: false,
    synthetic: false,
    finalHoldout: false,
    candleArchiveUrl: "https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/15m/BTCUSDT-15m-2024-01.zip",
    candleArchiveDigest: "76953983fcd4cc35ac181c4a1c69d28cbb4ef8b983021aac84a111ea4e82ef69",
    fundingArchiveUrl: "https://data.binance.vision/data/futures/um/monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-2024-01.zip",
    fundingArchiveDigest: "3e0d30870672aa8f0f937881056e3cfd55913ae5c780cd50b33f2763aa0ba58e",
  },
  dataset: {
    rowCount: 36,
    firstTimestamp: 1704067200000,
    lastTimestamp: 1704098700000,
    datasetDigest: "e53e4666a85d83ab5f80f5737e40d4968291e98069d001c2e933dcdc077ae55f",
  },
  funding: {
    rowCount: 2,
    fundingDigest: "89dd05ac8f9c1ee7da4c8ce75dfabe0541b0fa019fe369a58bd6f8f6e2e4d0a4",
  },
  backtestInput: {
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    side: "short",
    timeframe: "15m",
    initialCapital: 1_000_000,
    parameters: {
      fastPeriod: 2,
      slowPeriod: 4,
      atrPeriod: 2,
      pullbackTolerancePct: 1,
      stopAtrMultiple: 1,
      targetRiskMultiple: 1.5,
    },
    riskModel: {
      riskPerTrade: 0.01,
      maximumCapitalFraction: 0.7,
      leverage: 3,
      quantityStep: 0.001,
    },
    costModel: {
      entryFeeRate: 0.0004,
      exitFeeRate: 0.0004,
      taxRate: 0,
      slippageRate: 0.00025,
      spreadRate: 0.00015,
      latencyBars: 1,
      latencyDriftRate: 0.00005,
    },
    period: {
      startTime: 1704072600000,
      endTime: 1704098700000,
      includeFinalHoldout: false,
    },
  },
  expected: {
    resultDigest: "b7c4eca8dfe823926aa8932496255365e4d49c77d9bc57b6d510d96ebd355779",
    tradeSetDigest: "d6f0d43734994927bf6e6cfb8172f176d799584a897fad1b76b63ae4f5cdae5e",
    tradeCount: 2,
    strategyIdentityDigest: "10bcb6dba32ef93d249b53e1916402964dedd635dbd1bc70fd9b013b11b3d6eb",
    parameterDigest: "a2d78607943dfa3b7a69e8d2fde84fa842d4354aac10dcbadbe062d6a71ddedb",
    riskModelDigest: "21cdd8b85ed3a6f7d8aeef064ddda7fc6f690977c830be2f603112659abc1fd8",
    costModelDigest: "3aad1d7a525883e40d7414b154a792e8de370186873e0f94fb1fc1140c0193f9",
  },
};

export const FIXED_V1_PATH_EVIDENCE_CASE_V1 = deepFreeze({
  ...FIXED_CASE_BASE,
  caseContractDigest: sha256Canonical(FIXED_CASE_BASE),
});

function strategyIdentityFromResult(result) {
  return deepFreeze({
    schemaVersion: "backtester-path-strategy-identity-v1",
    strategyId: result?.strategy,
    strategyVersion: result?.strategyVersion,
    market: result?.market,
    symbol: result?.symbol,
    direction: typeof result?.side === "string" ? result.side.toUpperCase() : null,
    timeframe: result?.timeframe,
    parameterDigest: digestOrNull(result?.parameters),
    riskModelDigest: digestOrNull(result?.riskModel),
    costModelDigest: digestOrNull(result?.costModel),
  });
}

function failure(blockers) {
  return deepFreeze({
    schemaVersion: BACKTESTER_PATH_EVIDENCE_PRODUCER_SCHEMA_VERSION,
    status: "REJECTED",
    evidenceSet: null,
    receipt: null,
    blockers: unique(blockers),
    missingEvidence: REQUIRED_MISSING_EVIDENCE,
    scalarMetrics: {
      mae: null,
      maeStatus: "POLICY_MISSING",
      mfe: null,
      mfeStatus: "POLICY_MISSING",
    },
    truthFlags: BACKTESTER_PATH_EVIDENCE_TRUTH_FLAGS,
    safety: BACKTESTER_PATH_EVIDENCE_SAFETY,
  });
}

function sameCanonical(left, right) {
  const leftDigest = digestOrNull(left);
  return leftDigest !== null && leftDigest === digestOrNull(right);
}

function validateFixedSource(source, blockers) {
  if (!sameCanonical(source, FIXED_V1_PATH_EVIDENCE_CASE_V1.source)) blockers.push("PUBLIC_SOURCE_PROVENANCE_MISMATCH");
  if (source?.publicOnly !== true) blockers.push("PUBLIC_DATA_REQUIRED");
  if (source?.testOnly !== false) blockers.push("TEST_ONLY_EVIDENCE_FORBIDDEN");
  if (source?.replay !== false) blockers.push("REPLAY_EVIDENCE_FORBIDDEN");
  if (source?.synthetic !== false) blockers.push("SYNTHETIC_EVIDENCE_FORBIDDEN");
  if (source?.finalHoldout !== false) blockers.push("FINAL_HOLDOUT_FORBIDDEN");
}

function validateTruthBoundary(input, blockers) {
  if (input.testOnly !== false) blockers.push("TEST_ONLY_EVIDENCE_FORBIDDEN");
  if (input.replay !== false) blockers.push("REPLAY_EVIDENCE_FORBIDDEN");
  if (input.synthetic !== false) blockers.push("SYNTHETIC_EVIDENCE_FORBIDDEN");
  if (input.finalHoldoutUsed !== false) blockers.push("FINAL_HOLDOUT_FORBIDDEN");
}

function validateResultScope(result, blockers) {
  const fixed = FIXED_V1_PATH_EVIDENCE_CASE_V1.backtestInput;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    blockers.push("V1_RESULT_REQUIRED");
    return;
  }
  if (result.ok !== true || result.mode !== "backtest-only") blockers.push("V1_BACKTEST_RESULT_REQUIRED");
  if (result.strategy !== V1_STRATEGY_ID || result.strategyVersion !== "V1") blockers.push("FIXED_V1_STRATEGY_REQUIRED");
  for (const field of ["market", "symbol", "side", "timeframe"]) {
    if (result[field] !== fixed[field]) blockers.push(`RESULT_SCOPE_MISMATCH:${field.toUpperCase()}`);
  }
  if (result.orderSubmitted !== false || result.privateAccountRequestAllowed !== false
    || result.safeguards?.liveOrderAllowed !== false) blockers.push("BACKTEST_SAFETY_FLAG_MISMATCH");
  if (result.period?.includeFinalHoldout !== false
    || !Number.isSafeInteger(result.period?.effectiveEndTime)
    || result.period.effectiveEndTime >= FINAL_HOLDOUT_START_TIME
    || result.byPhase?.final_holdout?.sampleCount !== 0) blockers.push("FINAL_HOLDOUT_FORBIDDEN");
  if (!sameCanonical(result.parameters, fixed.parameters)) blockers.push("FIXED_PARAMETER_IDENTITY_MISMATCH");
  if (!sameCanonical(result.riskModel, { ...fixed.riskModel })) blockers.push("FIXED_RISK_IDENTITY_MISMATCH");
  const expectedCost = { ...fixed.costModel, schedule: [] };
  if (!sameCanonical(result.costModel, expectedCost)) blockers.push("FIXED_COST_IDENTITY_MISMATCH");
}

function validateTrades(trades, blockers) {
  const fixed = FIXED_V1_PATH_EVIDENCE_CASE_V1;
  if (!Array.isArray(trades) || trades.length !== fixed.expected.tradeCount) {
    blockers.push("SETTLED_TRADE_COUNT_MISMATCH");
    return;
  }
  const ids = trades.map((trade) => trade?.id);
  if (ids.some((id) => typeof id !== "string" || id.length === 0)) blockers.push("SETTLED_TRADE_ID_MISSING");
  if (new Set(ids).size !== ids.length) blockers.push("DUPLICATE_SETTLED_TRADE_ID");
  for (const trade of trades) {
    if (!Number.isFinite(trade?.maximumAdverseExcursion)) blockers.push("NON_FINITE_MAXIMUM_ADVERSE_EXCURSION");
    if (!Number.isFinite(trade?.maximumFavorableExcursion)) blockers.push("NON_FINITE_MAXIMUM_FAVORABLE_EXCURSION");
    if (trade?.strategy !== V1_STRATEGY_ID || trade?.strategyVersion !== "V1"
      || trade?.market !== fixed.backtestInput.market || trade?.symbol !== fixed.backtestInput.symbol
      || trade?.side !== fixed.backtestInput.side || trade?.timeframe !== fixed.backtestInput.timeframe) {
      blockers.push("MIXED_STRATEGY_TRADE_SET");
    }
    if (trade?.phase === "final_holdout") blockers.push("FINAL_HOLDOUT_FORBIDDEN");
    if (!Number.isSafeInteger(trade?.entryTime) || !Number.isSafeInteger(trade?.exitTime)
      || trade.entryTime > trade.exitTime) blockers.push("SETTLED_TRADE_TIME_INVALID");
  }
}

function evidenceRow(trade, identity, digests) {
  return deepFreeze({
    schemaVersion: "backtester-settled-trade-path-evidence-v1",
    tradeId: trade.id,
    settled: true,
    strategyIdentityDigest: identity.strategyIdentityDigest,
    datasetDigest: digests.datasetDigest,
    fundingDigest: digests.fundingDigest,
    resultDigest: digests.resultDigest,
    tradeSetDigest: digests.tradeSetDigest,
    settledTradeDigest: sha256Canonical(trade),
    maximumAdverseExcursion: trade.maximumAdverseExcursion,
    maximumFavorableExcursion: trade.maximumFavorableExcursion,
    entryContribution: { status: "MISSING_EVIDENCE", value: null },
    exitContribution: { status: "MISSING_EVIDENCE", value: null },
  });
}

export function produceBacktesterPathEvidenceV1(input = {}) {
  const blockers = [];
  const fixed = FIXED_V1_PATH_EVIDENCE_CASE_V1;
  if (input.caseId !== fixed.caseId) blockers.push("FIXED_V1_CASE_NOT_ALLOWED");
  if (input.caseContractDigest !== fixed.caseContractDigest) blockers.push("FIXED_CASE_CONTRACT_DIGEST_MISMATCH");
  validateFixedSource(input.source, blockers);
  validateTruthBoundary(input, blockers);

  const sourceSha = exactSha(input.sourceSha);
  const expectedSourceSha = exactSha(input.expectedSourceSha);
  if (!sourceSha || !expectedSourceSha || sourceSha !== expectedSourceSha) blockers.push("SOURCE_SHA_MISMATCH");

  const candles = input.candles;
  const fundingRates = input.fundingRates;
  if (!Array.isArray(candles) || candles.length !== fixed.dataset.rowCount) blockers.push("DATASET_ROW_COUNT_MISMATCH");
  if (!Array.isArray(fundingRates) || fundingRates.length !== fixed.funding.rowCount) blockers.push("FUNDING_ROW_COUNT_MISMATCH");
  if (Array.isArray(candles) && (candles[0]?.timestamp !== fixed.dataset.firstTimestamp
    || candles.at(-1)?.timestamp !== fixed.dataset.lastTimestamp)) blockers.push("DATASET_TIME_BOUND_MISMATCH");

  const datasetDigest = digestOrNull(candles);
  const fundingDigest = digestOrNull(fundingRates);
  if (!datasetDigest || datasetDigest !== fixed.dataset.datasetDigest) blockers.push("DATASET_DIGEST_MISMATCH");
  if (!fundingDigest || fundingDigest !== fixed.funding.fundingDigest) blockers.push("FUNDING_DIGEST_MISMATCH");

  const result = input.result;
  validateResultScope(result, blockers);
  const resultDigest = digestOrNull(result);
  if (!resultDigest || resultDigest !== fixed.expected.resultDigest) blockers.push("RESULT_DIGEST_MISMATCH");

  const trades = result?.trades;
  validateTrades(trades, blockers);
  const tradeSetDigest = digestOrNull(trades);
  if (!tradeSetDigest || tradeSetDigest !== fixed.expected.tradeSetDigest) blockers.push("TRADE_SET_DIGEST_MISMATCH");
  if (result?.totalTrades !== fixed.expected.tradeCount || result?.totalTrades !== trades?.length) {
    blockers.push("RESULT_TRADE_COUNT_MISMATCH");
  }

  const strategyIdentity = strategyIdentityFromResult(result);
  const strategyIdentityDigest = digestOrNull(strategyIdentity);
  if (!strategyIdentityDigest || strategyIdentityDigest !== fixed.expected.strategyIdentityDigest
    || strategyIdentity.parameterDigest !== fixed.expected.parameterDigest
    || strategyIdentity.riskModelDigest !== fixed.expected.riskModelDigest
    || strategyIdentity.costModelDigest !== fixed.expected.costModelDigest) {
    blockers.push("FIXED_STRATEGY_IDENTITY_MISMATCH");
  }

  const producedAt = iso(input.producedAt);
  if (!producedAt) blockers.push("PRODUCED_AT_REQUIRED");
  if (blockers.length > 0) return failure(blockers);

  const identity = deepFreeze({ strategyIdentity, strategyIdentityDigest });
  const digests = deepFreeze({ datasetDigest, fundingDigest, resultDigest, tradeSetDigest });
  const rows = deepFreeze(trades.map((trade) => evidenceRow(trade, identity, digests)));
  const evidenceCore = deepFreeze({
    schemaVersion: BACKTESTER_PATH_EVIDENCE_SET_SCHEMA_VERSION,
    status: "PRODUCED",
    evidenceClass: fixed.evidenceClass,
    caseId: fixed.caseId,
    caseContractDigest: fixed.caseContractDigest,
    sourceSha,
    source: fixed.source,
    strategyIdentity,
    strategyIdentityDigest,
    datasetDigest,
    fundingDigest,
    resultDigest,
    tradeSetDigest,
    settledTradeCount: rows.length,
    rows,
    scalarMetrics: {
      mae: null,
      maeStatus: "POLICY_MISSING",
      mfe: null,
      mfeStatus: "POLICY_MISSING",
    },
    missingEvidence: REQUIRED_MISSING_EVIDENCE,
    adapterDependency: {
      schemaVersion: BACKTESTER_STRATEGY_EVIDENCE_ADAPTER_SCHEMA_VERSION,
      authority: BACKTESTER_STRATEGY_EVIDENCE_AUTHORITY,
      access: "READ_ONLY",
    },
    truthFlags: BACKTESTER_PATH_EVIDENCE_TRUTH_FLAGS,
    safety: BACKTESTER_PATH_EVIDENCE_SAFETY,
  });
  const evidenceSet = deepFreeze({ ...evidenceCore, evidenceSetDigest: sha256Canonical(evidenceCore) });
  const receiptCore = deepFreeze({
    schemaVersion: BACKTESTER_PATH_EVIDENCE_RECEIPT_SCHEMA_VERSION,
    status: "IMMUTABLE",
    immutable: true,
    producedAt,
    caseId: fixed.caseId,
    caseContractDigest: fixed.caseContractDigest,
    sourceSha,
    strategyIdentityDigest,
    datasetDigest,
    fundingDigest,
    resultDigest,
    tradeSetDigest,
    evidenceSetDigest: evidenceSet.evidenceSetDigest,
    settledTradeCount: rows.length,
    truthFlags: BACKTESTER_PATH_EVIDENCE_TRUTH_FLAGS,
    safety: BACKTESTER_PATH_EVIDENCE_SAFETY,
  });
  const receipt = deepFreeze({ ...receiptCore, receiptDigest: sha256Canonical(receiptCore) });
  return deepFreeze({
    schemaVersion: BACKTESTER_PATH_EVIDENCE_PRODUCER_SCHEMA_VERSION,
    status: "PRODUCED",
    evidenceSet,
    receipt,
    blockers: [],
    missingEvidence: REQUIRED_MISSING_EVIDENCE,
    scalarMetrics: evidenceSet.scalarMetrics,
    truthFlags: BACKTESTER_PATH_EVIDENCE_TRUTH_FLAGS,
    safety: BACKTESTER_PATH_EVIDENCE_SAFETY,
  });
}

function validatePathRow(row, evidenceSet, blockers) {
  if (row?.settled !== true || typeof row?.tradeId !== "string" || row.tradeId.length === 0) blockers.push("SETTLED_TRADE_ROW_INVALID");
  if (!Number.isFinite(row?.maximumAdverseExcursion)) blockers.push("NON_FINITE_MAXIMUM_ADVERSE_EXCURSION");
  if (!Number.isFinite(row?.maximumFavorableExcursion)) blockers.push("NON_FINITE_MAXIMUM_FAVORABLE_EXCURSION");
  if (!SHA_64.test(row?.settledTradeDigest ?? "")) blockers.push("SETTLED_TRADE_DIGEST_INVALID");
  for (const field of ["strategyIdentityDigest", "datasetDigest", "fundingDigest", "resultDigest", "tradeSetDigest"]) {
    if (row?.[field] !== evidenceSet?.[field]) blockers.push(`MIXED_PATH_EVIDENCE:${field.toUpperCase()}`);
  }
  if (row?.entryContribution?.status !== "MISSING_EVIDENCE" || row?.entryContribution?.value !== null) {
    blockers.push("ENTRY_CONTRIBUTION_MUST_REMAIN_MISSING_EVIDENCE");
  }
  if (row?.exitContribution?.status !== "MISSING_EVIDENCE" || row?.exitContribution?.value !== null) {
    blockers.push("EXIT_CONTRIBUTION_MUST_REMAIN_MISSING_EVIDENCE");
  }
}

export function verifyBacktesterPathEvidenceV1(candidate = {}, { expectedSourceSha } = {}) {
  const blockers = [];
  const fixed = FIXED_V1_PATH_EVIDENCE_CASE_V1;
  const evidenceSet = candidate?.evidenceSet;
  const receipt = candidate?.receipt;
  if (candidate?.schemaVersion !== BACKTESTER_PATH_EVIDENCE_PRODUCER_SCHEMA_VERSION || candidate?.status !== "PRODUCED") {
    blockers.push("PRODUCER_STATUS_INVALID");
  }
  if (!evidenceSet || evidenceSet.schemaVersion !== BACKTESTER_PATH_EVIDENCE_SET_SCHEMA_VERSION
    || evidenceSet.status !== "PRODUCED") blockers.push("EVIDENCE_SET_INVALID");
  if (!receipt || receipt.schemaVersion !== BACKTESTER_PATH_EVIDENCE_RECEIPT_SCHEMA_VERSION
    || receipt.status !== "IMMUTABLE" || receipt.immutable !== true) blockers.push("IMMUTABLE_RECEIPT_INVALID");

  if (evidenceSet) {
    const { evidenceSetDigest, ...evidenceCore } = evidenceSet;
    if (!SHA_64.test(evidenceSetDigest ?? "") || digestOrNull(evidenceCore) !== evidenceSetDigest) {
      blockers.push("EVIDENCE_SET_DIGEST_MISMATCH");
    }
  }
  if (receipt) {
    const { receiptDigest, ...receiptCore } = receipt;
    if (!SHA_64.test(receiptDigest ?? "") || digestOrNull(receiptCore) !== receiptDigest) blockers.push("RECEIPT_DIGEST_MISMATCH");
  }

  const expectedSha = exactSha(expectedSourceSha);
  if (!expectedSha || evidenceSet?.sourceSha !== expectedSha || receipt?.sourceSha !== expectedSha) blockers.push("SOURCE_SHA_MISMATCH");
  if (evidenceSet?.caseId !== fixed.caseId || receipt?.caseId !== fixed.caseId
    || evidenceSet?.caseContractDigest !== fixed.caseContractDigest
    || receipt?.caseContractDigest !== fixed.caseContractDigest) blockers.push("FIXED_CASE_IDENTITY_MISMATCH");
  if (!sameCanonical(evidenceSet?.source, fixed.source)) blockers.push("PUBLIC_SOURCE_PROVENANCE_MISMATCH");

  const exactDigests = {
    strategyIdentityDigest: fixed.expected.strategyIdentityDigest,
    datasetDigest: fixed.dataset.datasetDigest,
    fundingDigest: fixed.funding.fundingDigest,
    resultDigest: fixed.expected.resultDigest,
    tradeSetDigest: fixed.expected.tradeSetDigest,
  };
  for (const [field, expected] of Object.entries(exactDigests)) {
    if (evidenceSet?.[field] !== expected || receipt?.[field] !== expected) blockers.push(`${field.toUpperCase()}_MISMATCH`);
  }
  if (digestOrNull(evidenceSet?.strategyIdentity) !== fixed.expected.strategyIdentityDigest) blockers.push("FIXED_STRATEGY_IDENTITY_MISMATCH");

  const rows = evidenceSet?.rows;
  if (!Array.isArray(rows) || rows.length !== fixed.expected.tradeCount
    || evidenceSet?.settledTradeCount !== fixed.expected.tradeCount
    || receipt?.settledTradeCount !== fixed.expected.tradeCount) blockers.push("SETTLED_TRADE_COUNT_MISMATCH");
  if (Array.isArray(rows)) {
    for (const row of rows) validatePathRow(row, evidenceSet, blockers);
    const ids = rows.map((row) => row?.tradeId);
    if (new Set(ids).size !== ids.length) blockers.push("DUPLICATE_SETTLED_TRADE_ID");
  }

  if (evidenceSet?.scalarMetrics?.mae !== null || evidenceSet?.scalarMetrics?.maeStatus !== "POLICY_MISSING") {
    blockers.push("SCALAR_MAE_POLICY_MISSING_REQUIRED");
  }
  if (evidenceSet?.scalarMetrics?.mfe !== null || evidenceSet?.scalarMetrics?.mfeStatus !== "POLICY_MISSING") {
    blockers.push("SCALAR_MFE_POLICY_MISSING_REQUIRED");
  }
  if (!sameCanonical(evidenceSet?.missingEvidence, REQUIRED_MISSING_EVIDENCE)
    || !sameCanonical(candidate?.missingEvidence, REQUIRED_MISSING_EVIDENCE)) blockers.push("MISSING_EVIDENCE_CONTRACT_MISMATCH");
  if (!sameCanonical(evidenceSet?.truthFlags, BACKTESTER_PATH_EVIDENCE_TRUTH_FLAGS)
    || !sameCanonical(receipt?.truthFlags, BACKTESTER_PATH_EVIDENCE_TRUTH_FLAGS)
    || !sameCanonical(candidate?.truthFlags, BACKTESTER_PATH_EVIDENCE_TRUTH_FLAGS)) blockers.push("TRUTH_FLAGS_INVALID");
  if (!sameCanonical(evidenceSet?.safety, BACKTESTER_PATH_EVIDENCE_SAFETY)
    || !sameCanonical(receipt?.safety, BACKTESTER_PATH_EVIDENCE_SAFETY)
    || !sameCanonical(candidate?.safety, BACKTESTER_PATH_EVIDENCE_SAFETY)) blockers.push("SAFETY_CONTRACT_INVALID");
  if (evidenceSet?.adapterDependency?.schemaVersion !== BACKTESTER_STRATEGY_EVIDENCE_ADAPTER_SCHEMA_VERSION
    || evidenceSet?.adapterDependency?.authority !== BACKTESTER_STRATEGY_EVIDENCE_AUTHORITY
    || evidenceSet?.adapterDependency?.access !== "READ_ONLY") blockers.push("READ_ONLY_ADAPTER_DEPENDENCY_INVALID");
  if (!iso(receipt?.producedAt)) blockers.push("RECEIPT_TIMESTAMP_INVALID");
  if (receipt?.evidenceSetDigest !== evidenceSet?.evidenceSetDigest) blockers.push("RECEIPT_EVIDENCE_SET_DIGEST_MISMATCH");

  return deepFreeze({
    schemaVersion: BACKTESTER_PATH_EVIDENCE_PRODUCER_SCHEMA_VERSION,
    status: blockers.length === 0 ? "VERIFIED" : "REJECTED",
    verified: blockers.length === 0,
    blockers: unique(blockers),
    truthFlags: BACKTESTER_PATH_EVIDENCE_TRUTH_FLAGS,
    safety: BACKTESTER_PATH_EVIDENCE_SAFETY,
  });
}
