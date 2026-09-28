import {
  buildAdaptiveMultiEvidenceRegimeRouterV2,
} from '../../../market-prediction-lab/src/adaptive-multi-evidence-regime-router-v2.js';
import {
  FUTURES_V2_PREREGISTRATION_V1,
  evaluateFuturesV2PreregisteredCandidate,
} from './futures-v2-preregistration.mjs';
import {
  FUTURES_V2_COST_RISK_DECLARATION_V1,
  evaluateFuturesV2CostRiskGuard,
} from './futures-v2-cost-risk-preregistration.mjs';

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function blocked(reason, details = {}) {
  return freeze({
    schemaVersion: 'move-hunter-futures-v2-forward-matrix/v1',
    status: 'BLOCKED_DATA',
    reason,
    details: freeze(details),
    performanceWinner: null,
    winnerSelectionAllowed: false,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAllowed: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}
function sideGroup(value) {
  const side = String(value ?? '').trim().toUpperCase();
  if (side === 'LONG' || side === 'BUY') return 'LONG';
  if (side === 'SHORT' || side === 'SELL') return 'SHORT';
  return null;
}
function timeframe(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return normalized === '1H' ? '60M' : normalized;
}
function observationSafe(observation) {
  return observation?.schemaVersion === 'forward-recommendation-observation-v2'
    && observation?.source === 'LIVE_RECOMMENDATION'
    && observation?.publicDataOnly === true
    && observation?.simulatedOnly === true
    && observation?.executionAuthority === 'NONE'
    && observation?.financialMutationAllowed === false
    && observation?.liveOrderAllowed === false
    && observation?.privateTradingApiAllowed === false
    && observation?.orderSubmitted === false
    && observation?.exchangeRequestSent === false
    && observation?.profitabilityClaimAllowed === false;
}
function evidenceIdentity(snapshot) {
  for (const family of ['trend', 'momentum', 'volume', 'volatility']) {
    const identity = snapshot?.evidence?.[family]?.evidence?.identity;
    if (identity && typeof identity === 'object') return identity;
  }
  return null;
}
function normalizeCostModel(model) {
  if (!model || typeof model !== 'object') return null;
  const feeBps = Number(model.feeBps);
  const slippageBps = Number(model.slippageBps);
  const spreadBps = Number(model.spreadBps);
  if (![feeBps, slippageBps, spreadBps].every((value) => Number.isFinite(value) && value >= 0)) return null;
  const modelId = String(model.modelId ?? '').trim();
  if (!modelId) return null;
  return freeze({
    modelId,
    feeBps,
    slippageBps,
    spreadBps,
    roundTripCostRate: ((feeBps * 2) + (slippageBps * 2) + spreadBps) / 10_000,
    canonicalFullCostProven: model.canonicalFullCostProven === true,
  });
}

export function buildFuturesV2ProspectiveDecisionMatrix({
  observation,
  featureSnapshot,
  costModel,
} = {}) {
  if (!observationSafe(observation)) return blocked('FORWARD_OBSERVATION_SAFETY_INVALID');
  const identity = observation.identity;
  const signal = observation.snapshot;
  if (!identity || !signal) return blocked('FORWARD_IDENTITY_OR_SNAPSHOT_REQUIRED');
  if (identity.market !== 'CRYPTO_FUTURES') return blocked('FUTURES_MARKET_REQUIRED');
  if (!FUTURES_V2_PREREGISTRATION_V1.symbols.includes(identity.symbol)) {
    return blocked('FUTURES_SYMBOL_OUT_OF_PREREGISTERED_SCOPE', { symbol: identity.symbol });
  }
  if (timeframe(identity.timeframe) !== '60M') return blocked('FUTURES_60M_TIMEFRAME_REQUIRED');
  const side = sideGroup(identity.direction);
  if (!side) return blocked('FUTURES_DIRECTION_REQUIRED');
  const decisionTime = String(signal.timestamp ?? '');
  if (!Number.isFinite(Date.parse(decisionTime))) return blocked('FUTURES_DECISION_TIME_REQUIRED');

  const featureIdentity = evidenceIdentity(featureSnapshot);
  if (!featureIdentity) return blocked('CANONICAL_MARKET_FEATURE_IDENTITY_REQUIRED');
  if (featureSnapshot?.decisionAuthority !== 'EVIDENCE_ONLY'
      || featureSnapshot?.executionAuthority !== 'NONE') {
    return blocked('CANONICAL_MARKET_FEATURE_AUTHORITY_INVALID');
  }
  const mismatches = [];
  if (featureIdentity.market !== identity.market) mismatches.push('MARKET');
  if (featureIdentity.symbol !== identity.symbol) mismatches.push('SYMBOL');
  if (timeframe(featureIdentity.timeframe) !== timeframe(identity.timeframe)) mismatches.push('TIMEFRAME');
  if (sideGroup(featureIdentity.side) !== side) mismatches.push('DIRECTION');
  if (featureIdentity.temporal?.decisionTime !== decisionTime) mismatches.push('DECISION_TIME');
  if (mismatches.length) return blocked('FORWARD_FEATURE_IDENTITY_MISMATCH', { mismatches: freeze(mismatches) });

  const entry = Number(signal.entryPrice);
  const stop = Number(signal.stopLoss);
  if (!(Number.isFinite(entry) && entry > 0 && Number.isFinite(stop) && stop > 0)) {
    return blocked('ENTRY_AND_STOP_REQUIRED_FOR_COST_RISK');
  }
  const initialRiskPct = Math.abs(entry - stop) / entry;
  if (!(initialRiskPct > 0)) return blocked('INITIAL_RISK_PCT_INVALID');

  const costs = normalizeCostModel(costModel);
  if (!costs) return blocked('EXPLICIT_COST_MODEL_REQUIRED');

  const regimeRouter = buildAdaptiveMultiEvidenceRegimeRouterV2({ marketFeatures: featureSnapshot });
  if (regimeRouter.status !== 'READY_FOR_STRATEGY_ROUTING_RESEARCH_ONLY'
      || regimeRouter.executionAuthority !== 'NONE') {
    return blocked('CANONICAL_REGIME_ROUTER_NOT_READY', {
      status: regimeRouter.status,
      blockers: freeze([...(regimeRouter.blockers ?? [])]),
    });
  }

  const preregisteredDecisions = Object.fromEntries(
    Object.keys(FUTURES_V2_PREREGISTRATION_V1.candidates).map((candidateId) => [
      candidateId,
      evaluateFuturesV2PreregisteredCandidate({
        candidateId,
        regimeRouter,
        side,
        decisionTime,
      }),
    ]),
  );
  const costRiskDecision = evaluateFuturesV2CostRiskGuard({
    initialRiskPct,
    roundTripCostRate: costs.roundTripCostRate,
    decisionTime,
  });

  return freeze({
    schemaVersion: 'move-hunter-futures-v2-forward-matrix/v1',
    status: 'RESEARCH_EVIDENCE_ONLY',
    observationId: observation.observationId,
    identity: freeze({
      market: identity.market,
      symbol: identity.symbol,
      timeframe: identity.timeframe,
      direction: identity.direction,
      researchCodeSha: identity.researchCodeSha,
    }),
    decisionTime,
    initialRiskPct,
    costModel: costs,
    regime: freeze({
      regime: regimeRouter.regime,
      directionalRegime: regimeRouter.directionalRegime,
      volatilityRegime: regimeRouter.volatilityRegime,
      regimeDigest: regimeRouter.regimeDigest,
    }),
    preregisteredDecisions: freeze(preregisteredDecisions),
    costRiskDecision,
    performanceWinner: null,
    winnerSelectionAllowed: false,
    historicalReplayMaySelectWinner: false,
    modeledCostOnly: costs.canonicalFullCostProven !== true,
    canonicalFullCostProven: costs.canonicalFullCostProven,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAllowed: false,
    positionSizeOrLeverageOverrideAllowed: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}
