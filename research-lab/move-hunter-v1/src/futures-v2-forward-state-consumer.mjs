import { FUTURES_V2_PREREGISTRATION_V1 } from './futures-v2-preregistration.mjs';
import { FUTURES_V2_COST_RISK_DECLARATION_V1 } from './futures-v2-cost-risk-preregistration.mjs';
import { buildFuturesV2ForwardFeatureSnapshot } from './futures-v2-forward-features.mjs';
import { buildFuturesV2ProspectiveDecisionMatrix } from './futures-v2-forward-matrix.mjs';

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function safeState(state) {
  const s = state?.safety;
  return state?.schemaVersion === 1
    && typeof state?.researchCodeSha === 'string'
    && Array.isArray(state?.observations)
    && s?.publicDataOnly === true
    && s?.artifactOnly === true
    && s?.executionAuthority === 'NONE'
    && s?.financialMutationAllowed === false
    && s?.liveOrderAllowed === false
    && s?.privateTradingApiAllowed === false
    && s?.profitabilityClaimAllowed === false;
}
function tf(value) {
  const x = String(value ?? '').trim().toUpperCase();
  return x === '1H' ? '60M' : x;
}
function dir(value) {
  const x = String(value ?? '').trim().toUpperCase();
  if (x === 'LONG' || x === 'BUY') return 'LONG';
  if (x === 'SHORT' || x === 'SELL') return 'SHORT';
  return null;
}
function freezeBoundaryMs() {
  const a = Date.parse(FUTURES_V2_PREREGISTRATION_V1.preregisteredAt);
  const b = Date.parse(FUTURES_V2_COST_RISK_DECLARATION_V1.freezeBoundary.preregisteredAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('FUTURES_V2_FREEZE_BOUNDARY_INVALID');
  return Math.max(a, b);
}
function relevantObservation(observation) {
  const i = observation?.identity;
  const s = observation?.snapshot;
  if (!i || !s) return false;
  if (i.market !== 'CRYPTO_FUTURES') return false;
  if (!FUTURES_V2_PREREGISTRATION_V1.symbols.includes(i.symbol)) return false;
  if (tf(i.timeframe) !== '60M') return false;
  if (!dir(i.direction)) return false;
  const t = Date.parse(s.timestamp);
  return Number.isFinite(t) && t > freezeBoundaryMs();
}
function validCostModel(model) {
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
  const candidateIds = Object.keys(FUTURES_V2_PREREGISTRATION_V1.candidates);
  const byCandidate = Object.fromEntries(candidateIds.map((candidateId) => {
    const decisions = accepted.map((row) => row.matrix?.preregisteredDecisions?.[candidateId]).filter(Boolean);
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
    blockedN: records.filter((row) => row.status === 'BLOCKED_DATA').length,
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
  if (!validCostModel(costModel)) {
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
      outcome: observation.status === 'SETTLED' && observation.outcome ? freeze({ ...observation.outcome }) : null,
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
