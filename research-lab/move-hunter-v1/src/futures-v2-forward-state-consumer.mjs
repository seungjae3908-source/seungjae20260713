import {
  FUTURES_V2_PREREGISTRATION_V1,
} from './futures-v2-preregistration.mjs';
import {
  FUTURES_V2_COST_RISK_DECLARATION_V1,
} from './futures-v2-cost-risk-preregistration.mjs';
import {
  buildFuturesV2ForwardFeatureSnapshot,
} from './futures-v2-forward-features.mjs';
import {
  buildFuturesV2ProspectiveDecisionMatrix,
} from './futures-v2-forward-matrix.mjs';

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function safeState(state) {
  const safety = state?.safety;
  return state?.schemaVersion === 1
    && typeof state?.researchCodeSha === 'string'
    && Array.isArray(state?.observations)
    && safety?.publicDataOnly === true
    && safety?.artifactOnly === true
    && safety?.executionAuthority === 'NONE'
    && safety?.financialMutationAllowed === false
    && safety?.liveOrderAllowed === false
    && safety?.privateTradingApiAllowed === false
    && safety?.profitabilityClaimAllowed === false;
}
function timeframe(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return normalized === '1H' ? '60M' : normalized;
}
function direction(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'LONG' || normalized === 'BUY') return 'LONG';
  if (normalized === 'SHORT' || normalized === 'SELL') return 'SHORT';
  return null;
}
function freezeBoundaryMs() {
  const regime = Date.parse(FUTURES_V2_PREREGISTRATION_V1.preregisteredAt);
  const cost = Date.parse(FUTURES_V2_COST_RISK_DECLARATION_V1.freezeBoundary.preregisteredAt);
  if (!Number.isFinite(regime) || !Number.isFinite(cost)) throw new Error('FUTURES_V2_FREEZE_BOUNDARY_INVALID');
  return Math.max(regime, cost);
}
function relevantObservation(observation) {
  const identity = observation?.identity;
  const signal = observation?.snapshot;
  if (!identity || !signal) return false;
  if (identity.market !== 'CRYPTO_FUTURES') return false;
  if (!FUTURES_V2_PREREGISTRATION_V1.symbols.includes(identity.symbol)) return false;
  if (timeframe(identity.timeframe) !== '60M') return false;
  if (!direction(identity.direction)) return false;
  const signalTime = Date.parse(signal.timestamp);
  return Number.isFinite(signalTime) && signalTime > freezeBoundaryMs();
}
function explicitCostModel(model) {
  return model
    && typeof model === 'object'
    && String(model.modelId ?? '').trim().length > 0
    && [model.feeBps, model.slippageBps, model.spreadBps]
      .every((value) => Number.isFinite(Number(value)) && Number(value) >= 0);
}
function blockedRecord(reason, details = {}) {
  return freeze({
    schemaVersion: 'move-hunter-futures-v2-forward-shadow-record/v1',
    status: 'BLOCKED_DATA',
    reason,
    details: freeze(details),
    prospectiveOnly: true,
    observedHistoryMayCountAsOos: false,
    observedHistoryMayCountAsForward: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAllowed: false,
    executionAuthority: 'NONE',
  });
}
function summarize(records) {
  const accepted = records.filter((row) => row.status === 'PENDING' || row.status === 'SETTLED');
  const blocked = records.filter((row) => row.status === 'BLOCKED_DATA');
  const candidateIds = Object.keys(FUTURES_V2_PREREGISTRATION_V1.candidates);
  const byCandidate = Object.fromEntries(candidateIds.map((candidateId) => {
    const decisions = accepted
      .map((row) => row.matrix?.preregisteredDecisions?.[candidateId])
      .filter(Boolean);
    return [candidateId, freeze({
      n: decisions.length,
      eligibleN: decisions.filter((row) => row.status === 'RESEARCH_EVIDENCE_ONLY' && row.eligible).length,
      ineligibleN: decisions.filter((row) => row.status === 'RESEARCH_EVIDENCE_ONLY' && !row.eligible).length,
      blockedDataN: decisions.filter((row) => row.status === 'BLOCKED_DATA').length,
    })];
  }));
  const costDecisions = accepted.map((row) => row.matrix?.costRiskDecision).filter(Boolean);
  return freeze({
    schemaVersion: 'move-hunter-futures-v2-forward-shadow-summary/v1',
    acceptedN: accepted.length,
    pendingN: accepted.filter((row) => row.status === 'PENDING').length,
    settledN: accepted.filter((row) => row.status === 'SETTLED').length,
    blockedN: blocked.length,
    byCandidate: freeze(byCandidate),
    costRisk: freeze({
      n: costDecisions.length,
      eligibleN: costDecisions.filter((row) => row.status === 'RESEARCH_EVIDENCE_ONLY' && row.eligible).length,
      ineligibleN: costDecisions.filter((row) => row.status === 'RESEARCH_EVIDENCE_ONLY' && !row.eligible).length,
      blockedDataN: costDecisions.filter((row) => row.status === 'BLOCKED_DATA').length,
    }),
    performanceWinner: null,
    winnerSelectionAllowed: false,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAllowed: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}

export async function consumeFuturesV2ForwardState({
  state,
  loadCandles,
  costModel,
  maxHistoryBars = 300,
} = {}) {
  if (!safeState(state)) {
    return freeze({
      schemaVersion: 'move-hunter-futures-v2-forward-state-consumer/v1',
      status: 'BLOCKED_DATA',
      reason: 'CANONICAL_FORWARD_STATE_SAFETY_INVALID',
      records: freeze([]),
      summary: null,
      sourceStateMutated: false,
      canonicalStateWriteAllowed: false,
      economicSampleCredit: 0,
      profitabilityClaimAllowed: false,
      executionAuthority: 'NONE',
    });
  }
  if (typeof loadCandles !== 'function') throw new TypeError('loadCandles is required');
  if (!explicitCostModel(costModel)) {
    return freeze({
      schemaVersion: 'move-hunter-futures-v2-forward-state-consumer/v1',
      status: 'BLOCKED_DATA',
      reason: 'EXPLICIT_COST_MODEL_REQUIRED',
      records: freeze([]),
      summary: null,
      sourceStateMutated: false,
      canonicalStateWriteAllowed: false,
      economicSampleCredit: 0,
      profitabilityClaimAllowed: false,
      executionAuthority: 'NONE',
    });
  }

  const sourceObservationCount = state.observations.length;
  const candidates = state.observations.filter(relevantObservation);
  const records = [];
  const cache = new Map();

  for (const observation of candidates) {
    const symbol = observation.identity.symbol;
    let candles = cache.get(symbol);
    if (!candles) {
      try {
        candles = await loadCandles({
          market: 'CRYPTO_FUTURES',
          symbol,
          timeframe: '60m',
          frozenAt: new Date(freezeBoundaryMs()).toISOString(),
        });
        if (!Array.isArray(candles)) throw new TypeError('loaded candles must be an array');
        cache.set(symbol, candles);
      } catch (error) {
        records.push(blockedRecord('FORWARD_FEATURE_CANDLE_LOAD_FAILED', {
          observationId: observation.observationId ?? null,
          symbol,
          message: error instanceof Error ? error.message : String(error),
        }));
        continue;
      }
    }

    const feature = buildFuturesV2ForwardFeatureSnapshot({ observation, candles, maxHistoryBars });
    if (feature.status !== 'READY' || !feature.snapshot) {
      records.push(blockedRecord('FORWARD_FEATURE_BUILD_BLOCKED', {
        observationId: observation.observationId ?? null,
        symbol,
        featureReason: feature.reason ?? null,
        acceptedClosedCandleCount: feature.acceptedClosedCandleCount ?? null,
      }));
      continue;
    }

    const matrix = buildFuturesV2ProspectiveDecisionMatrix({
      observation,
      featureSnapshot: feature.snapshot,
      costModel,
    });
    if (matrix.status === 'BLOCKED_DATA') {
      records.push(blockedRecord('FUTURES_V2_MATRIX_BLOCKED', {
        observationId: observation.observationId ?? null,
        symbol,
        matrixReason: matrix.reason ?? null,
        matrixDetails: matrix.details ?? null,
      }));
      continue;
    }

    records.push(freeze({
      schemaVersion: 'move-hunter-futures-v2-forward-shadow-record/v1',
      status: observation.status === 'SETTLED' ? 'SETTLED' : 'PENDING',
      observationId: observation.observationId,
      identity: freeze({ ...observation.identity }),
      signalTimestamp: observation.snapshot.timestamp,
      settledAt: observation.settledAt ?? null,
      outcome: observation.status === 'SETTLED' && observation.outcome
        ? freeze({ ...observation.outcome })
        : null,
      matrix,
      prospectiveOnly: true,
      observedHistoryMayCountAsOos: false,
      observedHistoryMayCountAsForward: false,
      economicSampleCredit: 0,
      profitabilityClaimAllowed: false,
      automaticScannerAdoptionAllowed: false,
      automaticPromotionAllowed: false,
      executionAuthority: 'NONE',
    }));
  }

  const summary = summarize(records);
  return freeze({
    schemaVersion: 'move-hunter-futures-v2-forward-state-consumer/v1',
    status: 'READY',
    sourceResearchCodeSha: state.researchCodeSha,
    sourceObservationCount,
    candidateObservationCount: candidates.length,
    untouchedObservationCount: sourceObservationCount - candidates.length,
    freezeBoundary: new Date(freezeBoundaryMs()).toISOString(),
    costModel: freeze({ ...costModel, canonicalFullCostProven: costModel.canonicalFullCostProven === true }),
    records: freeze(records),
    summary,
    sourceStateMutated: false,
    canonicalStateWriteAllowed: false,
    publicDataOnly: true,
    artifactOnly: true,
    historicalBackfillAllowed: false,
    observedHistoryMayCountAsOos: false,
    observedHistoryMayCountAsForward: false,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAllowed: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}
