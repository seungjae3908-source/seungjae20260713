import { createHash } from "node:crypto";

export const KR_MOMENTUM_SIGNAL_CANDIDATE = Object.freeze({
  id: "kr-cross-sectional-momentum-v1-risk-hold",
  market: "KR_STOCK",
  strategy: "cross_sectional_relative_strength",
  frozenSignalParams: Object.freeze({
    momentumLookback: 120,
    trendMaPeriod: 100,
    topCount: 2,
    rebalanceBars: 40,
    stopAtrMultiple: 2.5,
    minMomentum: 0,
  }),
  sourceResearchSha: "0ab2962a1b1cf8b8103ffdba8b494953f0c7426c",
  sourceRunId: 31637344348,
  sourceArtifactId: 9157476436,
  sourceArtifactDigest: "sha256:dc69740f0caa41c580b0d5c0e04f6b0053a4f328160cd0ca531952db92b1e181",
  sourceResultSha256: "159f463c9ae24e7318fbf4a99ece864adeec01f30cad2f9d4efbeb9e239e9cd6",
  sourceStatus: "research_hold",
  sourceGates: Object.freeze({
    validationPassed: true,
    designTestPassed: false,
    stressPassed: false,
    holdoutPassed: false,
    holdoutStressPassed: false,
    rollingPassed: false,
  }),
  sourceRiskEvidence: Object.freeze({
    designTestMaxDrawdown: 0.4243558384762524,
    holdoutMaxDrawdown: 0.47810233037319605,
    stressedHoldoutMaxDrawdown: 0.47810233037319616,
  }),
  priorResearchSymbols: Object.freeze([
    "005930", "000660", "035420", "005380", "000270", "051910", "068270", "105560", "055550", "035720",
    "005490", "012330", "066570", "028260", "032830", "086790", "017670", "096770",
    "009150", "018260", "030200", "034730", "010950", "011170", "024110", "033780",
  ]),
  overlayDesignSymbols: Object.freeze([
    "207940", "012450", "015760", "034020", "011200", "086280", "090430", "003490",
  ]),
  overlayHoldoutSymbols: Object.freeze([
    "010140", "003670", "036570", "097950", "000810", "005830", "047810", "000100",
  ]),
  overlaySearch: Object.freeze({
    grossExposureFraction: Object.freeze([0.4, 0.5, 0.6, 0.7]),
    signalParametersRetuned: false,
    sourceHoldoutUsedForOverlaySelection: false,
    overlayHoldoutUsedForSelection: false,
  }),
  safeguards: Object.freeze({
    researchOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    actualOrders: 0,
  }),
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const KR_MOMENTUM_SIGNAL_CANDIDATE_SHA256 = createHash("sha256")
  .update(canonical(KR_MOMENTUM_SIGNAL_CANDIDATE))
  .digest("hex");
