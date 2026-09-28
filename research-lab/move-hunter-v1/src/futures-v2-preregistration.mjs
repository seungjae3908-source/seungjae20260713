import {
  ADAPTIVE_MULTI_EVIDENCE_REGIME_ROUTER_V2_VERSION,
} from '../../../market-prediction-lab/src/adaptive-multi-evidence-regime-router-v2.js';
import {
  ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
} from '../../../market-prediction-lab/src/adaptive-multi-evidence-point-in-time-v2.js';

export const FUTURES_V2_PREREGISTRATION_V1 = Object.freeze({
  schemaVersion: 'move-hunter-futures-v2-preregistration/v1',
  preregistrationId: 'MOVE_HUNTER_FUTURES_60M_V2_20260928',
  market: 'CRYPTO_FUTURES',
  timeframe: '60M',
  symbols: Object.freeze(['BTCUSDT', 'ETHUSDT']),
  preregisteredAt: '2026-09-28T07:22:09.000Z',
  sourceDiagnosticWindow: Object.freeze({
    startTime: '2025-09-28T00:00:00.000Z',
    endTime: '2026-09-27T23:59:59.999Z',
    observedHistoryOnly: true,
    mayCountAsOos: false,
    mayCountAsForward: false,
    economicSampleCredit: 0,
  }),
  sourceEvidence: Object.freeze({
    researchHead: 'e7c45047159b5619a30d981512887a350895ec35',
    benchmarkRunId: 36390727346,
    applicationFastCiRunId: 36390727386,
    artifactId: 10956621369,
    artifactZipSha256: '35d79e76348d0965ae54cb20f7c8d92d162fc2d3b47f2c695ae1100bc8b113e3',
  }),
  diagnosis: Object.freeze({
    statement: 'Observed-history losses recur across both directions and both symbols, especially HIGH_VOLATILITY, directional TREND regimes, and UNKNOWN.',
    postHocHypothesisGenerationAcknowledged: true,
    sameWindowCandidateSelectionForbidden: true,
  }),
  candidates: Object.freeze({
    FUTURES_V2_CONTROL: Object.freeze({
      id: 'FUTURES_V2_CONTROL',
      description: 'No additional V2 regime gate; prospective comparator only.',
      riskRegimePause: false,
      directionalStructureConfirm: false,
    }),
    FUTURES_V2_RISK_REGIME_PAUSE: Object.freeze({
      id: 'FUTURES_V2_RISK_REGIME_PAUSE',
      description: 'Pause new research candidates in HIGH_VOLATILITY or UNKNOWN regimes.',
      riskRegimePause: true,
      directionalStructureConfirm: false,
    }),
    FUTURES_V2_TREND_STRUCTURE_CONFIRM: Object.freeze({
      id: 'FUTURES_V2_TREND_STRUCTURE_CONFIRM',
      description: 'In directional trend regimes, require side-regime alignment and aligned latest swing without opposite structure transition.',
      riskRegimePause: false,
      directionalStructureConfirm: true,
    }),
    FUTURES_V2_COMBINED: Object.freeze({
      id: 'FUTURES_V2_COMBINED',
      description: 'Apply both preregistered risk-regime pause and trend-structure confirmation.',
      riskRegimePause: true,
      directionalStructureConfirm: true,
    }),
  }),
  validation: Object.freeze({
    allowedEvidence: 'POST_PREREGISTRATION_UNUSED_OOS_OR_PROSPECTIVE_FORWARD_ONLY',
    historicalReplayMaySelectWinner: false,
    minimumPromotionSampleInvented: false,
    automaticWinnerSelectionAllowed: false,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAllowed: false,
    profitabilityClaimAllowed: false,
    economicSampleCredit: 0,
    executionAuthority: 'NONE',
  }),
});

const TREND_UP = new Set(['TREND_UP', 'STRONG_TREND_UP']);
const TREND_DOWN = new Set(['TREND_DOWN', 'STRONG_TREND_DOWN']);
const RISK_PAUSE = new Set(['HIGH_VOLATILITY', 'UNKNOWN']);
const OPPOSITE_LONG = /(?:BOS|CHOCH|BREAK)_DOWN/u;
const OPPOSITE_SHORT = /(?:BOS|CHOCH|BREAK)_UP/u;

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function sideGroup(value) {
  const side = String(value ?? '').trim().toUpperCase();
  if (side === 'LONG' || side === 'BUY') return 'LONG';
  if (side === 'SHORT' || side === 'SELL') return 'SHORT';
  return null;
}
function safeRouter(router) {
  return router?.schemaVersion === ADAPTIVE_MULTI_EVIDENCE_REGIME_ROUTER_V2_VERSION
    && router?.lineageId === ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
    && router?.status === 'READY_FOR_STRATEGY_ROUTING_RESEARCH_ONLY'
    && router?.routeAuthority === 'RESEARCH_FAMILY_ELIGIBILITY_ONLY'
    && router?.economicSampleCredit === 0
    && router?.profitabilityProven === false
    && router?.executionAuthority === 'NONE';
}
function blocked(reason, candidateId = null, details = {}) {
  return freeze({
    schemaVersion: 'move-hunter-futures-v2-preregistered-decision/v1',
    status: 'BLOCKED_DATA',
    candidateId,
    eligible: false,
    reasons: freeze([reason]),
    details: freeze(details),
    postPreregistrationOnly: true,
    automaticWinnerSelectionAllowed: false,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAllowed: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}
function trendStructureReasons(router, side) {
  const regime = router.regime;
  const context = router.priceActionContext;
  const trendUp = TREND_UP.has(regime);
  const trendDown = TREND_DOWN.has(regime);
  if (!trendUp && !trendDown) return [];
  const expected = side === 'LONG' ? 'UP' : 'DOWN';
  const regimeAligned = side === 'LONG' ? trendUp : trendDown;
  const reasons = [];
  if (!regimeAligned) reasons.push('DIRECTIONAL_REGIME_NOT_ALIGNED');
  if (context?.status !== 'AVAILABLE') {
    reasons.push('PRICE_ACTION_CONTEXT_REQUIRED_IN_TREND');
    return reasons;
  }
  if (context.latestSwingLegDirection !== expected) reasons.push('LATEST_SWING_NOT_ALIGNED');
  const transition = String(context.structureTransition ?? 'NONE');
  if (side === 'LONG' && OPPOSITE_LONG.test(transition)) reasons.push('OPPOSITE_STRUCTURE_TRANSITION');
  if (side === 'SHORT' && OPPOSITE_SHORT.test(transition)) reasons.push('OPPOSITE_STRUCTURE_TRANSITION');
  return reasons;
}

export function evaluateFuturesV2PreregisteredCandidate({
  candidateId,
  regimeRouter,
  side,
  decisionTime,
  preregistration = FUTURES_V2_PREREGISTRATION_V1,
} = {}) {
  const candidate = preregistration?.candidates?.[candidateId];
  if (!candidate) return blocked('PREREGISTERED_CANDIDATE_REQUIRED', candidateId);
  const tradeSide = sideGroup(side);
  if (!tradeSide) return blocked('DIRECTION_REQUIRED', candidate.id);
  const decisionMs = Date.parse(decisionTime);
  const freezeMs = Date.parse(preregistration.preregisteredAt);
  if (!Number.isFinite(decisionMs) || !Number.isFinite(freezeMs)) {
    return blocked('PREREGISTRATION_TIME_IDENTITY_INVALID', candidate.id);
  }
  if (!(decisionMs > freezeMs)) {
    return blocked('DECISION_NOT_POST_PREREGISTRATION', candidate.id, {
      decisionTime,
      preregisteredAt: preregistration.preregisteredAt,
    });
  }
  if (!safeRouter(regimeRouter)) return blocked('CANONICAL_REGIME_ROUTER_REQUIRED', candidate.id);

  const reasons = [];
  if (candidate.riskRegimePause && RISK_PAUSE.has(regimeRouter.regime)) {
    reasons.push('PREREGISTERED_RISK_REGIME_PAUSE');
  }
  if (candidate.directionalStructureConfirm) {
    reasons.push(...trendStructureReasons(regimeRouter, tradeSide));
  }
  const uniqueReasons = [...new Set(reasons)].sort();

  return freeze({
    schemaVersion: 'move-hunter-futures-v2-preregistered-decision/v1',
    status: 'RESEARCH_EVIDENCE_ONLY',
    preregistrationId: preregistration.preregistrationId,
    candidateId: candidate.id,
    side: tradeSide,
    decisionTime: new Date(decisionMs).toISOString(),
    regime: regimeRouter.regime,
    directionalRegime: regimeRouter.directionalRegime,
    volatilityRegime: regimeRouter.volatilityRegime,
    eligible: uniqueReasons.length === 0,
    reasons: freeze(uniqueReasons),
    postPreregistrationOnly: true,
    observedDiagnosticWindowMayCountAsOos: false,
    observedDiagnosticWindowMayCountAsForward: false,
    historicalReplayMaySelectWinner: false,
    automaticWinnerSelectionAllowed: false,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAllowed: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}

export function summarizeFuturesV2PreregisteredDecisions(rows = []) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const accepted = rows.filter((row) =>
    row?.schemaVersion === 'move-hunter-futures-v2-preregistered-decision/v1'
    && row.status === 'RESEARCH_EVIDENCE_ONLY');
  const byCandidate = {};
  for (const candidateId of Object.keys(FUTURES_V2_PREREGISTRATION_V1.candidates)) {
    const candidateRows = accepted.filter((row) => row.candidateId === candidateId);
    byCandidate[candidateId] = freeze({
      n: candidateRows.length,
      eligibleN: candidateRows.filter((row) => row.eligible).length,
      blockedByGateN: candidateRows.filter((row) => !row.eligible).length,
    });
  }
  return freeze({
    schemaVersion: 'move-hunter-futures-v2-preregistered-summary/v1',
    preregistrationId: FUTURES_V2_PREREGISTRATION_V1.preregistrationId,
    acceptedN: accepted.length,
    blockedDataN: rows.length - accepted.length,
    byCandidate: freeze(byCandidate),
    performanceWinner: null,
    winnerSelectionAllowed: false,
    minimumPromotionSampleInvented: false,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAllowed: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}
