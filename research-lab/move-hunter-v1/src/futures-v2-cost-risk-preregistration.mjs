export const FUTURES_V2_COST_RISK_DECLARATION_V1 = Object.freeze({
  schemaVersion: 'move-hunter-futures-v2-cost-risk-declaration/v1',
  declarationId: 'MOVE_HUNTER_FUTURES_60M_COST_RISK_GUARD_V1',
  market: 'CRYPTO_FUTURES',
  timeframe: '60M',
  symbols: Object.freeze(['BTCUSDT', 'ETHUSDT']),
  diagnosisSource: Object.freeze({
    observedHistoryOnly: true,
    sourceHead: '0c5abffa6a1f8d41113603b1197bbab87f8aad9c',
    benchmarkRunId: 36391774325,
    applicationFastCiRunId: 36391774321,
    artifactId: 10956781808,
    artifactZipSha256: '6a04f7b58cc7beeb4d9b7b6f90de4546a0e33ca1895b46ed0136484927ab0273',
    finding: 'Round-trip friction dominates gross edge across both symbols and both directions; funding is negligible.',
    mayCountAsOos: false,
    mayCountAsForward: false,
    economicSampleCredit: 0,
  }),
  candidate: Object.freeze({
    id: 'FUTURES_V2_COST_RISK_GUARD',
    description: 'Require round-trip modeled cost to consume no more than 25% of planned initial price risk.',
    maximumCostToInitialRiskRatio: 0.25,
    thresholdSource: 'PREREGISTERED_ENGINEERING_RISK_BUDGET_NOT_SAME_WINDOW_OPTIMIZED',
    positionSizeOrLeverageOverrideAllowed: false,
    executionOverrideAllowed: false,
  }),
  freezeBoundary: Object.freeze({
    active: true,
    declarationCommitSha: '37b3ffacdaa2c8d8611917b79c66e923241cc5a6',
    preregisteredAt: '2026-09-28T07:37:20Z',
    note: 'This later binding activates the exact candidate semantics that already existed in the declaration commit.',
  }),
  validation: Object.freeze({
    allowedEvidence: 'POST_DECLARATION_COMMIT_UNUSED_OOS_OR_PROSPECTIVE_FORWARD_ONLY',
    historicalReplayMaySelectWinner: false,
    sameDiagnosticWindowMayValidateCandidate: false,
    automaticWinnerSelectionAllowed: false,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAllowed: false,
    profitabilityClaimAllowed: false,
    economicSampleCredit: 0,
    executionAuthority: 'NONE',
  }),
});

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function blocked(reason, details = {}) {
  return freeze({
    schemaVersion: 'move-hunter-futures-v2-cost-risk-decision/v1',
    status: 'BLOCKED_DATA',
    candidateId: FUTURES_V2_COST_RISK_DECLARATION_V1.candidate.id,
    eligible: false,
    reason,
    details: freeze(details),
    historicalReplayMaySelectWinner: false,
    automaticWinnerSelectionAllowed: false,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAllowed: false,
    profitabilityClaimAllowed: false,
    economicSampleCredit: 0,
    executionAuthority: 'NONE',
  });
}

export function evaluateFuturesV2CostRiskGuard({
  initialRiskPct,
  roundTripCostRate,
  decisionTime,
  declaration = FUTURES_V2_COST_RISK_DECLARATION_V1,
} = {}) {
  const boundary = declaration?.freezeBoundary;
  if (boundary?.active !== true
      || !/^[0-9a-f]{40}$/u.test(String(boundary?.declarationCommitSha ?? ''))
      || !Number.isFinite(Date.parse(boundary?.preregisteredAt))) {
    return blocked('COST_RISK_DECLARATION_NOT_FROZEN');
  }
  const decisionMs = Date.parse(decisionTime);
  const freezeMs = Date.parse(boundary.preregisteredAt);
  if (!Number.isFinite(decisionMs) || !(decisionMs > freezeMs)) {
    return blocked('DECISION_NOT_POST_COST_RISK_PREREGISTRATION', {
      decisionTime,
      preregisteredAt: boundary.preregisteredAt,
    });
  }
  const risk = Number(initialRiskPct);
  const cost = Number(roundTripCostRate);
  if (!(Number.isFinite(risk) && risk > 0)) return blocked('INITIAL_RISK_PCT_REQUIRED');
  if (!(Number.isFinite(cost) && cost >= 0)) return blocked('ROUND_TRIP_COST_RATE_REQUIRED');
  const ratio = cost / risk;
  const threshold = Number(declaration.candidate.maximumCostToInitialRiskRatio);
  if (!(Number.isFinite(threshold) && threshold > 0 && threshold < 1)) {
    return blocked('COST_RISK_THRESHOLD_INVALID');
  }
  return freeze({
    schemaVersion: 'move-hunter-futures-v2-cost-risk-decision/v1',
    status: 'RESEARCH_EVIDENCE_ONLY',
    declarationId: declaration.declarationId,
    declarationCommitSha: boundary.declarationCommitSha,
    preregisteredAt: boundary.preregisteredAt,
    candidateId: declaration.candidate.id,
    decisionTime: new Date(decisionMs).toISOString(),
    initialRiskPct: risk,
    roundTripCostRate: cost,
    costToInitialRiskRatio: ratio,
    maximumCostToInitialRiskRatio: threshold,
    eligible: ratio <= threshold,
    reason: ratio <= threshold ? null : 'COST_CONSUMES_TOO_MUCH_INITIAL_RISK',
    thresholdSource: declaration.candidate.thresholdSource,
    positionSizeOrLeverageOverrideAllowed: false,
    historicalReplayMaySelectWinner: false,
    automaticWinnerSelectionAllowed: false,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAllowed: false,
    profitabilityClaimAllowed: false,
    economicSampleCredit: 0,
    executionAuthority: 'NONE',
  });
}
