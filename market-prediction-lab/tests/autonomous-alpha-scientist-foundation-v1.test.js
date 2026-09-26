import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTONOMOUS_ALPHA_SCIENTIST_FOUNDATION_V1,
  buildAlphaGenomeV1,
  buildAutonomousAlphaEvidenceGraphV1,
} from "../src/autonomous-alpha-scientist-foundation-v1.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const HEX_D = "d".repeat(64);

function source(overrides = {}) {
  return {
    sourceId: "paper-1",
    sourceType: "ACADEMIC_PAPER",
    title: "Order flow and short-horizon price formation",
    canonicalUrl: "https://example.org/paper/1",
    retrievedAt: "2026-09-20T00:00:00.000Z",
    provenanceDigest: HEX_A,
    integrityState: "OK",
    contentPolicy: {
      mode: "METADATA_ONLY",
      fullTextStorageAllowed: false,
      derivedSummaryAllowed: true,
      redistributionAllowed: false,
      attributionRequired: true,
    },
    ...overrides,
  };
}

function claim(overrides = {}) {
  return {
    claimId: "claim-1",
    sourceId: "paper-1",
    derivedSummary: "Persistent order-flow imbalance may contain short-horizon directional information.",
    mechanism: "Aggressive flow consumes visible liquidity faster on one side of the book.",
    markets: ["CRYPTO_FUTURES"],
    horizons: ["5m", "15m"],
    features: ["order_flow_imbalance", "spread_bps"],
    falsifiers: ["edge disappears after full costs", "effect reverses out of sample"],
    independenceGroupId: "academic-order-flow",
    evidenceDigest: HEX_B,
    locator: "abstract/results",
    ...overrides,
  };
}

function validGraph() {
  return buildAutonomousAlphaEvidenceGraphV1({
    sources: [
      source(),
      source({
        sourceId: "video-1",
        sourceType: "VIDEO",
        title: "VWAP execution discussion",
        canonicalUrl: "https://www.youtube.com/watch?v=example123",
        provenanceDigest: HEX_C,
      }),
      source({
        sourceId: "book-1",
        sourceType: "PUBLIC_BOOK",
        title: "Public-domain market microstructure notes",
        canonicalUrl: "https://example.org/books/microstructure",
        provenanceDigest: HEX_D,
        contentPolicy: {
          mode: "PUBLIC_DOMAIN",
          fullTextStorageAllowed: true,
          derivedSummaryAllowed: true,
          redistributionAllowed: true,
          attributionRequired: false,
        },
      }),
    ],
    claims: [
      claim(),
      claim({
        claimId: "claim-2",
        sourceId: "video-1",
        derivedSummary: "VWAP reclaim is proposed as confirmation rather than a standalone entry.",
        mechanism: "Price reclaim with renewed participation may distinguish continuation from weak bounce.",
        features: ["vwap_distance", "relative_volume"],
        falsifiers: ["confirmation adds no OOS value", "slippage removes incremental edge"],
        independenceGroupId: "video-vwap",
        evidenceDigest: HEX_C,
      }),
      claim({
        claimId: "claim-3",
        sourceId: "book-1",
        derivedSummary: "Position risk should be derived from invalidation distance before quantity.",
        mechanism: "Sizing from a fixed risk budget prevents notional size from defining the stop.",
        horizons: ["all"],
        features: ["stop_distance", "risk_budget"],
        falsifiers: ["risk-normalized outcomes deteriorate", "drawdown constraint is not improved"],
        independenceGroupId: "book-risk",
        evidenceDigest: HEX_D,
      }),
    ],
    edges: [
      { fromClaimId: "claim-2", toClaimId: "claim-1", type: "EXTENDS" },
      { fromClaimId: "claim-3", toClaimId: "claim-1", type: "SUPPORTS" },
    ],
  });
}

test("builds a rights-aware evidence graph without persisting raw source text", () => {
  const graph = validGraph();

  assert.equal(graph.schemaVersion, AUTONOMOUS_ALPHA_SCIENTIST_FOUNDATION_V1);
  assert.equal(graph.status, "EVIDENCE_GRAPH_READY");
  assert.equal(graph.blockers.length, 0);
  assert.equal(graph.sources.length, 3);
  assert.equal(graph.claims.length, 3);
  assert.equal(graph.admissibleClaimIds.length, 3);
  assert.equal(graph.executionAuthority, "NONE");
  assert.equal(graph.mayPlaceOrder, false);
  assert.equal(graph.profitabilityProven, false);
  assert.match(graph.graphDigest, /^[0-9a-f]{64}$/u);
  assert.equal(graph.sources[0].contentPolicy.rawContentPersisted, false);
  assert.equal(graph.claims[0].rawSourceTextPersisted, false);
  assert.equal("rawContent" in graph.sources[0], false);
});

test("fails closed when metadata-only evidence attempts to persist raw content", () => {
  const graph = buildAutonomousAlphaEvidenceGraphV1({
    sources: [source({ rawContent: "not permitted in the canonical graph" })],
    claims: [claim()],
  });

  assert.equal(graph.status, "BLOCKED_DATA");
  assert.ok(graph.blockers.includes("NO_ADMISSIBLE_EVIDENCE_CLAIM"));
  assert.deepEqual(graph.excludedSourceIds, ["paper-1"]);
  assert.deepEqual(graph.excludedClaimIds, ["claim-1"]);
  assert.equal(graph.sources[0].contentPolicy, null);
});

test("keeps retracted evidence out while preserving admissible independent evidence", () => {
  const graph = buildAutonomousAlphaEvidenceGraphV1({
    sources: [
      source({ integrityState: "RETRACTED" }),
      source({
        sourceId: "official-1",
        sourceType: "OFFICIAL",
        title: "Official market specification",
        canonicalUrl: "https://example.org/official/spec",
        provenanceDigest: HEX_C,
      }),
    ],
    claims: [
      claim(),
      claim({
        claimId: "claim-official",
        sourceId: "official-1",
        derivedSummary: "The market specification defines the observable execution constraint.",
        mechanism: "Venue rules constrain executable quantity and order behavior.",
        features: ["lot_size", "tick_size"],
        falsifiers: ["specification provenance mismatch"],
        independenceGroupId: "official-spec",
        evidenceDigest: HEX_D,
      }),
    ],
  });

  assert.equal(graph.status, "EVIDENCE_GRAPH_PARTIAL");
  assert.deepEqual(graph.admissibleClaimIds, ["claim-official"]);
  assert.deepEqual(graph.excludedSourceIds, ["paper-1"]);
  assert.deepEqual(graph.excludedClaimIds, ["claim-1"]);
});

test("builds an alpha genome only as a falsifiable research candidate", () => {
  const graph = validGraph();
  const genome = buildAlphaGenomeV1({
    candidateId: "alpha-genome-001",
    hypothesis: "Order-flow imbalance plus VWAP confirmation may retain a net edge after costs.",
    evidenceGraph: graph,
    genes: [
      {
        geneId: "signal-order-flow",
        type: "SIGNAL",
        claimIds: ["claim-1", "claim-2"],
        logic: {
          all: [
            { feature: "order_flow_imbalance", op: ">", parameter: "ofi_threshold" },
            { feature: "vwap_distance", op: ">=", value: 0 },
          ],
        },
      },
      {
        geneId: "risk-stop-first",
        type: "RISK",
        claimIds: ["claim-3"],
        logic: {
          sizingOrder: ["invalidation", "stop_distance", "risk_budget", "quantity"],
          lossAveragingAllowed: false,
        },
      },
    ],
    trialAccounting: {
      priorEvaluatedCandidateCount: 40,
      declaredCandidateFamilySize: 128,
      candidateOrdinal: 41,
    },
  });

  assert.equal(genome.status, "ALPHA_GENOME_READY_FOR_FALSIFICATION");
  assert.equal(genome.requiredNextStage, "ALPHA_RED_TEAM");
  assert.equal(genome.blockers.length, 0);
  assert.deepEqual(genome.independentEvidenceGroups, [
    "academic-order-flow",
    "book-risk",
    "video-vwap",
  ]);
  assert.equal(genome.multipleTestingAccountingRequired, true);
  assert.equal(genome.finalHoldoutMaySelectCandidate, false);
  assert.equal(genome.promotionEligible, false);
  assert.equal(genome.executionAuthority, "NONE");
  assert.equal(genome.economicSampleCredit, 0);
  assert.equal(genome.profitabilityProven, false);
  assert.match(genome.genomeDigest, /^[0-9a-f]{64}$/u);
});

test("blocks a genome that only recycles one independence group", () => {
  const graph = validGraph();
  const genome = buildAlphaGenomeV1({
    candidateId: "alpha-genome-overfit",
    hypothesis: "A single-source family should not masquerade as independent evidence.",
    evidenceGraph: graph,
    genes: [
      {
        geneId: "signal-only",
        type: "SIGNAL",
        claimIds: ["claim-1"],
        logic: { feature: "order_flow_imbalance", op: ">", value: 0.6 },
      },
      {
        geneId: "risk-same-source",
        type: "RISK",
        claimIds: ["claim-1"],
        logic: { maxRiskPct: 0.0025 },
      },
    ],
    trialAccounting: {
      priorEvaluatedCandidateCount: 0,
      declaredCandidateFamilySize: 4,
      candidateOrdinal: 1,
    },
  });

  assert.equal(genome.status, "BLOCKED_DATA");
  assert.ok(genome.blockers.includes("ALPHA_INDEPENDENT_EVIDENCE_INSUFFICIENT"));
  assert.equal(genome.requiredNextStage, null);
});

test("execution authority cannot enter the research foundation", () => {
  const graph = buildAutonomousAlphaEvidenceGraphV1({
    sources: [source()],
    claims: [claim()],
    executionAuthority: "LIVE",
  });

  assert.equal(graph.status, "BLOCKED_DATA");
  assert.ok(graph.blockers.includes("EVIDENCE_EXECUTION_AUTHORITY_FORBIDDEN"));
  assert.equal(graph.executionAuthority, "NONE");
});
