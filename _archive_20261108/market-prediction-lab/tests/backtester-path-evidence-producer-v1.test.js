import test from "node:test";
import assert from "node:assert/strict";

import {
  BACKTESTER_PATH_EVIDENCE_SAFETY,
  BACKTESTER_PATH_EVIDENCE_TRUTH_FLAGS,
  FIXED_V1_PATH_EVIDENCE_CASE_V1,
  produceBacktesterPathEvidenceV1,
  verifyBacktesterPathEvidenceV1,
} from "../src/backtester-path-evidence-producer-v1.js";
import { runV1Backtest } from "../src/multi-market-backtest-engine.js";

const SOURCE_SHA = "a".repeat(40);
const PRODUCED_AT = "2026-08-28T14:00:00.000Z";
const PUBLIC_CANDLE_CSV = `open_time,open,high,low,close,volume
1704067200000,42314.00,42535.00,42289.60,42532.50,3617.988
1704068100000,42532.40,42603.20,42449.10,42458.50,2322.028
1704069000000,42458.40,42485.70,42386.20,42474.50,1684.217
1704069900000,42474.50,42527.20,42449.10,42503.50,835.244
1704070800000,42503.50,42510.40,42462.00,42497.60,850.274
1704071700000,42497.60,42554.90,42497.50,42524.80,826.420
1704072600000,42524.90,42832.00,42524.80,42734.30,5389.021
1704073500000,42734.20,42750.00,42642.50,42647.90,1977.696
1704074400000,42647.90,42676.90,42578.00,42593.70,1580.528
1704075300000,42593.60,42610.00,42562.30,42575.60,804.454
1704076200000,42575.60,42647.60,42567.50,42576.20,1131.877
1704077100000,42576.20,42630.00,42530.00,42620.40,1136.208
1704078000000,42620.50,42630.00,42534.80,42544.20,1056.847
1704078900000,42544.20,42544.30,42449.00,42466.90,1683.632
1704079800000,42466.90,42493.00,42270.00,42331.90,3199.838
1704080700000,42331.90,42391.50,42275.00,42369.80,2179.563
1704081600000,42369.80,42414.20,42307.80,42324.60,1803.761
1704082500000,42324.60,42353.30,42235.20,42342.90,2449.938
1704083400000,42342.90,42381.00,42316.50,42347.30,1053.926
1704084300000,42347.40,42439.80,42335.20,42436.60,1048.911
1704085200000,42436.60,42440.00,42351.90,42389.30,1075.088
1704086100000,42389.40,42398.50,42325.40,42326.30,771.946
1704087000000,42326.20,42358.10,42304.00,42335.70,780.152
1704087900000,42335.80,42335.80,42207.90,42272.60,1512.371
1704088800000,42272.60,42337.80,42239.10,42308.20,1126.979
1704089700000,42308.30,42382.30,42298.10,42349.60,964.646
1704090600000,42349.10,42418.70,42337.60,42405.90,840.082
1704091500000,42405.90,42461.30,42397.90,42423.30,1001.312
1704092400000,42423.40,42517.00,42421.70,42482.20,1937.956
1704093300000,42482.20,42536.00,42463.10,42524.90,992.859
1704094200000,42524.90,42535.90,42475.40,42475.40,837.558
1704095100000,42475.40,42532.00,42461.30,42527.00,686.677
1704096000000,42527.10,42570.00,42489.40,42551.90,1305.613
1704096900000,42551.90,42577.00,42509.00,42519.90,648.355
1704097800000,42520.00,42543.30,42492.80,42530.40,663.664
1704098700000,42530.50,42597.30,42522.00,42588.20,1056.114`;
const PUBLIC_FUNDING_CSV = `calc_time,funding_interval_hours,last_funding_rate
1704067200000,8,0.00037409
1704096000000,8,0.00027213`;

function publicCandles() {
  return PUBLIC_CANDLE_CSV.trim().split(/\r?\n/u).slice(1).map((line) => {
    const [timestamp, open, high, low, close, volume] = line.split(",");
    return {
      timestamp: Number(timestamp),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
      isClosed: true,
    };
  });
}

function publicFunding() {
  return PUBLIC_FUNDING_CSV.trim().split(/\r?\n/u).slice(1).map((line) => {
    const [timestamp, , rate] = line.split(",");
    return { timestamp: Number(timestamp), rate: Number(rate) };
  });
}

function genuineV1Result(candles = publicCandles(), fundingRates = publicFunding()) {
  const fixed = FIXED_V1_PATH_EVIDENCE_CASE_V1.backtestInput;
  return runV1Backtest({ ...fixed, candles, fundingRates });
}

function producerInput(overrides = {}) {
  const candles = overrides.candles ?? publicCandles();
  const fundingRates = overrides.fundingRates ?? publicFunding();
  return {
    caseId: FIXED_V1_PATH_EVIDENCE_CASE_V1.caseId,
    caseContractDigest: FIXED_V1_PATH_EVIDENCE_CASE_V1.caseContractDigest,
    source: FIXED_V1_PATH_EVIDENCE_CASE_V1.source,
    sourceSha: SOURCE_SHA,
    expectedSourceSha: SOURCE_SHA,
    candles,
    fundingRates,
    result: genuineV1Result(candles, fundingRates),
    producedAt: PRODUCED_AT,
    testOnly: false,
    replay: false,
    synthetic: false,
    finalHoldoutUsed: false,
    ...overrides,
  };
}

function mutable(value) {
  return structuredClone(value);
}

test("fixed public V1 result produces immutable, provenance-bound trade path evidence", () => {
  const output = produceBacktesterPathEvidenceV1(producerInput());
  assert.equal(output.status, "PRODUCED");
  assert.deepEqual(output.blockers, []);
  assert.deepEqual(output.truthFlags, BACKTESTER_PATH_EVIDENCE_TRUTH_FLAGS);
  assert.deepEqual(output.safety, BACKTESTER_PATH_EVIDENCE_SAFETY);
  assert.equal(output.evidenceSet.sourceSha, SOURCE_SHA);
  assert.equal(output.evidenceSet.datasetDigest, FIXED_V1_PATH_EVIDENCE_CASE_V1.dataset.datasetDigest);
  assert.equal(output.evidenceSet.fundingDigest, FIXED_V1_PATH_EVIDENCE_CASE_V1.funding.fundingDigest);
  assert.equal(output.evidenceSet.resultDigest, FIXED_V1_PATH_EVIDENCE_CASE_V1.expected.resultDigest);
  assert.equal(output.evidenceSet.tradeSetDigest, FIXED_V1_PATH_EVIDENCE_CASE_V1.expected.tradeSetDigest);
  assert.equal(output.evidenceSet.strategyIdentityDigest, FIXED_V1_PATH_EVIDENCE_CASE_V1.expected.strategyIdentityDigest);
  assert.equal(output.evidenceSet.rows.length, 2);
  assert.equal(new Set(output.evidenceSet.rows.map((row) => row.tradeId)).size, 2);
  for (const row of output.evidenceSet.rows) {
    assert.equal(row.settled, true);
    assert.ok(Number.isFinite(row.maximumAdverseExcursion));
    assert.ok(Number.isFinite(row.maximumFavorableExcursion));
    assert.deepEqual(row.entryContribution, { status: "MISSING_EVIDENCE", value: null });
    assert.deepEqual(row.exitContribution, { status: "MISSING_EVIDENCE", value: null });
    assert.equal(row.datasetDigest, output.evidenceSet.datasetDigest);
    assert.equal(row.strategyIdentityDigest, output.evidenceSet.strategyIdentityDigest);
  }
  assert.deepEqual(output.scalarMetrics, {
    mae: null,
    maeStatus: "POLICY_MISSING",
    mfe: null,
    mfeStatus: "POLICY_MISSING",
  });
  assert.equal(output.evidenceSet.adapterDependency.access, "READ_ONLY");
  assert.equal(output.receipt.status, "IMMUTABLE");
  assert.equal(output.receipt.immutable, true);
  assert.equal(output.receipt.evidenceSetDigest, output.evidenceSet.evidenceSetDigest);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.evidenceSet), true);
  assert.equal(Object.isFrozen(output.evidenceSet.rows), true);
  assert.equal(Object.isFrozen(output.receipt), true);
  assert.deepEqual(verifyBacktesterPathEvidenceV1(output, { expectedSourceSha: SOURCE_SHA }).blockers, []);
});

test("fixed case production and receipt digests are deterministic for the same exact inputs", () => {
  const first = produceBacktesterPathEvidenceV1(producerInput());
  const second = produceBacktesterPathEvidenceV1(producerInput());
  assert.equal(first.evidenceSet.evidenceSetDigest, second.evidenceSet.evidenceSetDigest);
  assert.equal(first.receipt.receiptDigest, second.receipt.receiptDigest);
});

test("wrong SHA, dataset, funding, result, and missing rows fail closed", () => {
  const wrongSha = produceBacktesterPathEvidenceV1(producerInput({ sourceSha: "b".repeat(40) }));
  assert.ok(wrongSha.blockers.includes("SOURCE_SHA_MISMATCH"));

  const missingCandles = publicCandles().slice(0, -1);
  const missingRows = produceBacktesterPathEvidenceV1(producerInput({ candles: missingCandles }));
  assert.ok(missingRows.blockers.includes("DATASET_ROW_COUNT_MISMATCH"));
  assert.ok(missingRows.blockers.includes("DATASET_DIGEST_MISMATCH"));

  const wrongFunding = publicFunding();
  wrongFunding[1].rate += 0.000001;
  const fundingMismatch = produceBacktesterPathEvidenceV1(producerInput({ fundingRates: wrongFunding }));
  assert.ok(fundingMismatch.blockers.includes("FUNDING_DIGEST_MISMATCH"));

  const result = mutable(genuineV1Result());
  result.netPnl += 1;
  const resultMismatch = produceBacktesterPathEvidenceV1(producerInput({ result }));
  assert.ok(resultMismatch.blockers.includes("RESULT_DIGEST_MISMATCH"));
});

test("duplicate trade IDs, non-finite paths, and mixed strategy scope fail closed", () => {
  const duplicate = mutable(genuineV1Result());
  duplicate.trades = [duplicate.trades[0], { ...duplicate.trades[0] }];
  duplicate.totalTrades = duplicate.trades.length;
  const duplicateResult = produceBacktesterPathEvidenceV1(producerInput({ result: duplicate }));
  assert.ok(duplicateResult.blockers.includes("DUPLICATE_SETTLED_TRADE_ID"));

  const nonFinite = mutable(genuineV1Result());
  nonFinite.trades[0].maximumAdverseExcursion = Number.NaN;
  const nonFiniteResult = produceBacktesterPathEvidenceV1(producerInput({ result: nonFinite }));
  assert.ok(nonFiniteResult.blockers.includes("NON_FINITE_MAXIMUM_ADVERSE_EXCURSION"));
  assert.ok(nonFiniteResult.blockers.includes("RESULT_DIGEST_MISMATCH"));

  const mixed = mutable(genuineV1Result());
  mixed.trades[0].symbol = "ETHUSDT";
  const mixedResult = produceBacktesterPathEvidenceV1(producerInput({ result: mixed }));
  assert.ok(mixedResult.blockers.includes("MIXED_STRATEGY_TRADE_SET"));
});

test("TEST_ONLY, replay, synthetic, and Final Holdout claims are forbidden", () => {
  for (const field of ["testOnly", "replay", "synthetic", "finalHoldoutUsed"]) {
    const result = produceBacktesterPathEvidenceV1(producerInput({ [field]: true }));
    const expected = field === "testOnly"
      ? "TEST_ONLY_EVIDENCE_FORBIDDEN"
      : field === "replay"
        ? "REPLAY_EVIDENCE_FORBIDDEN"
        : field === "synthetic"
          ? "SYNTHETIC_EVIDENCE_FORBIDDEN"
          : "FINAL_HOLDOUT_FORBIDDEN";
    assert.ok(result.blockers.includes(expected), `${field} must fail closed`);
  }

  for (const [field, expected] of [
    ["testOnly", "TEST_ONLY_EVIDENCE_FORBIDDEN"],
    ["replay", "REPLAY_EVIDENCE_FORBIDDEN"],
    ["synthetic", "SYNTHETIC_EVIDENCE_FORBIDDEN"],
    ["finalHoldout", "FINAL_HOLDOUT_FORBIDDEN"],
  ]) {
    const source = { ...FIXED_V1_PATH_EVIDENCE_CASE_V1.source, [field]: true };
    const result = produceBacktesterPathEvidenceV1(producerInput({ source }));
    assert.ok(result.blockers.includes(expected), `source.${field} must fail closed`);
  }
});

test("verification rejects tampering, fabricated scalar aggregation, and contribution claims", () => {
  const produced = produceBacktesterPathEvidenceV1(producerInput());

  const mixedDataset = mutable(produced);
  mixedDataset.evidenceSet.rows[0].datasetDigest = "f".repeat(64);
  const mixedVerdict = verifyBacktesterPathEvidenceV1(mixedDataset, { expectedSourceSha: SOURCE_SHA });
  assert.ok(mixedVerdict.blockers.includes("MIXED_PATH_EVIDENCE:DATASETDIGEST"));
  assert.ok(mixedVerdict.blockers.includes("EVIDENCE_SET_DIGEST_MISMATCH"));

  const scalar = mutable(produced);
  scalar.evidenceSet.scalarMetrics.mae = -0.01;
  scalar.evidenceSet.scalarMetrics.maeStatus = "MEASURED";
  const scalarVerdict = verifyBacktesterPathEvidenceV1(scalar, { expectedSourceSha: SOURCE_SHA });
  assert.ok(scalarVerdict.blockers.includes("SCALAR_MAE_POLICY_MISSING_REQUIRED"));

  const contribution = mutable(produced);
  contribution.evidenceSet.rows[0].entryContribution = { status: "MEASURED", value: 0.5 };
  const contributionVerdict = verifyBacktesterPathEvidenceV1(contribution, { expectedSourceSha: SOURCE_SHA });
  assert.ok(contributionVerdict.blockers.includes("ENTRY_CONTRIBUTION_MUST_REMAIN_MISSING_EVIDENCE"));

  const nonFinite = mutable(produced);
  nonFinite.evidenceSet.rows[0].maximumFavorableExcursion = Number.POSITIVE_INFINITY;
  const nonFiniteVerdict = verifyBacktesterPathEvidenceV1(nonFinite, { expectedSourceSha: SOURCE_SHA });
  assert.ok(nonFiniteVerdict.blockers.includes("NON_FINITE_MAXIMUM_FAVORABLE_EXCURSION"));
  assert.ok(nonFiniteVerdict.blockers.includes("EVIDENCE_SET_DIGEST_MISMATCH"));

  const receipt = mutable(produced);
  receipt.receipt.receiptDigest = "0".repeat(64);
  const receiptVerdict = verifyBacktesterPathEvidenceV1(receipt, { expectedSourceSha: SOURCE_SHA });
  assert.ok(receiptVerdict.blockers.includes("RECEIPT_DIGEST_MISMATCH"));
});
