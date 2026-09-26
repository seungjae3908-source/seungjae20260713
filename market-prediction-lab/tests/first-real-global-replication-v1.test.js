import assert from "node:assert/strict";
import test from "node:test";

import {
  parseKenFrenchDevelopedMomentumCsv,
  parseKenFrenchDevelopedSixPortfolioCsv,
  runFirstRealGlobalReplication,
} from "../src/first-real-global-replication-v1.js";
import { globalStrategyEconomicRealityRequirements } from "../src/global-strategy-statistical-firewall-v1.js";

function months(start, end) {
  const result = [];
  let current = start;
  while (current <= end) {
    result.push(current);
    const year = Number(current.slice(0, 4));
    const month = Number(current.slice(4, 6));
    current = month === 12 ? `${year + 1}01` : `${year}${String(month + 1).padStart(2, "0")}`;
  }
  return result;
}

function fixtureData() {
  const periods = months("199011", "202112");
  const rows = periods.map((period, index) => {
    const smallLoser = -0.4 + (0.6 * Math.sin(index / 7));
    const smallWinner = smallLoser + 0.9 + (0.25 * Math.cos(index / 5));
    const bigLoser = -0.2 + (0.4 * Math.cos(index / 11));
    const bigWinner = bigLoser + 0.45 + (0.2 * Math.sin(index / 9));
    const wml = 0.5 * ((smallWinner - smallLoser) + (bigWinner - bigLoser));
    return { period, smallLoser, smallWinner, bigLoser, bigWinner, wml };
  });
  const momentum = [
    "This file was created using the 202606 Bloomberg database.",
    "",
    ",WML",
    ...rows.map((row) => `${row.period},${row.wml.toFixed(4)}`),
  ].join("\n");
  const six = [
    "This file was created using the 202606 Bloomberg database.",
    "",
    "Average Value Weighted Returns -- Monthly",
    ",SMALL LoPRIOR,ME1 PRIOR2,SMALL HiPRIOR,BIG LoPRIOR,ME2 PRIOR2,BIG HiPRIOR",
    ...rows.map((row) => [
      row.period,
      row.smallLoser.toFixed(4),
      "0.0000",
      row.smallWinner.toFixed(4),
      row.bigLoser.toFixed(4),
      "0.0000",
      row.bigWinner.toFixed(4),
    ].join(",")),
    "Average Equal Weighted Returns -- Monthly",
  ].join("\n");
  return { momentum, six };
}

test("parses the official monthly layouts and rejects date gaps", () => {
  const fixture = fixtureData();
  const momentum = parseKenFrenchDevelopedMomentumCsv(fixture.momentum);
  const six = parseKenFrenchDevelopedSixPortfolioCsv(fixture.six);
  assert.equal(momentum.length, six.length);
  assert.equal(momentum[0].period, "199011");
  assert.equal(six[0].derivedWmlPct.toFixed(3), momentum[0].returnPct.toFixed(3));
  assert.throws(
    () => parseKenFrenchDevelopedMomentumCsv(fixture.momentum.replace(/\n199012,[^\n]+/, "")),
    /MOMENTUM_MONTH_GAP/,
  );
});

test("completes one partial E2 replication and preserves two real data blockers", () => {
  const fixture = fixtureData();
  const result = runFirstRealGlobalReplication({
    momentumCsvText: fixture.momentum,
    sixPortfolioCsvText: fixture.six,
    researchCodeSha: "0123456789abcdef0123456789abcdef01234567",
  });
  assert.equal(result.firstRealE2ReplicationCompleted, true);
  assert.equal(result.replicationClassification, "PARTIALLY_REPLICATED");
  assert.deepEqual(result.replicationAssessments.map((assessment) => assessment.status), [
    "PARTIALLY_REPLICATED",
    "BLOCKED_DATA",
    "BLOCKED_DATA",
  ]);
  assert.equal(result.exactReplication.originalSample.sampleN, 245);
  assert.equal(result.oos.sampleN, 99);
  assert.ok(result.walkForward.windowCount >= 1);
  assert.equal(result.statisticalFirewall.dsr.status, "EVIDENCE_READY");
  assert.equal(result.statisticalFirewall.pbo.status, "EVIDENCE_READY");
  assert.equal(result.statisticalFirewall.realityCheckAndSpa.status, "EVIDENCE_READY");
  assert.equal(result.costs.afterCostStatus, "BLOCKED_DATA");
  assert.equal(result.tierCounts.externalPaperN, 245);
  assert.equal(result.tierCounts.externalDatasetN, 245);
  assert.equal(result.tierCounts.ourReplicationN, 245);
  assert.equal(result.tierCounts.ourOosN, 99);
  assert.equal(result.tierCounts.ourWalkForwardN, 99);
  assert.equal(result.tierCounts.ourHoldoutN, 0);
  assert.equal(result.tierCounts.ourShadowN, 0);
  assert.equal(result.tierCounts.ourPaperN, 0);
  assert.equal(result.tierCounts.ourSettledN, 0);
  assert.equal(result.datasetAudit.reservedFinalHoldout.status, "RESERVED_NOT_EVALUATED");
  assert.equal(result.datasetAudit.reservedFinalHoldout.evaluatedSampleN, 0);
  assert.equal(result.evidenceFactoryMetrics.duplicateSourcesPrevented, 1);
  assert.equal(result.scanner.eligibleForScannerResearchConsideration, false);
  assert.equal(result.frozenCandidate, null);
  assert.equal(result.champion, null);
  assert.equal(result.safety.executionAuthority, "NONE");
});

test("requires every developed-stock long-short economic dimension including borrow", () => {
  assert.deepEqual(globalStrategyEconomicRealityRequirements().DEVELOPED_STOCK, [
    "commission",
    "spread",
    "slippage",
    "tax",
    "fx",
    "liquidityImpact",
  ]);
  const result = runFirstRealGlobalReplication({
    ...Object.fromEntries(Object.entries(fixtureData()).map(([key, value]) => [key === "momentum" ? "momentumCsvText" : "sixPortfolioCsvText", value])),
    researchCodeSha: "0123456789abcdef0123456789abcdef01234567",
  });
  assert.ok(result.costs.economicReality.requiredDimensions.includes("borrow"));
  assert.ok(result.costs.economicReality.blockers.includes("MISSING_BORROW_EVIDENCE"));
});

