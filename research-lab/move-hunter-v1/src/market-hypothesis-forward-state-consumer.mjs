import {
  KR_NO_STRUCTURE_60M_FORWARD_HYPOTHESIS_V1,
  buildMarketHypothesisForwardRecord,
  summarizeMarketHypothesisForwardRecords,
} from './market-hypothesis-forward.mjs';
import {
  buildMarketHypothesisForwardFeatureSnapshot,
} from './market-hypothesis-forward-features.mjs';

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
function relevantObservation(observation, hypothesis) {
  const identity = observation?.identity;
  const signal = observation?.snapshot;
  if (!identity || !signal) return false;
  if (identity.market !== hypothesis.market) return false;
  if (!hypothesis.symbols.includes(identity.symbol)) return false;
  const timeframe = String(identity.timeframe ?? '').trim().toUpperCase();
  if (!['60M', '1H'].includes(timeframe)) return false;
  const direction = String(identity.direction ?? '').trim().toUpperCase();
  if (!['BUY', 'LONG'].includes(direction)) return false;
  const signalTime = Date.parse(signal.timestamp);
  const frozenAt = Date.parse(hypothesis.frozenAt);
  return Number.isFinite(signalTime) && Number.isFinite(frozenAt) && signalTime > frozenAt;
}

export async function consumeMarketHypothesisForwardState({
  state,
  loadCandles,
  hypothesis = KR_NO_STRUCTURE_60M_FORWARD_HYPOTHESIS_V1,
  maxHistoryBars = 300,
} = {}) {
  if (!safeState(state)) {
    return freeze({
      schemaVersion: 'move-hunter-market-hypothesis-state-consumer/v1',
      status: 'BLOCKED_DATA',
      reason: 'CANONICAL_FORWARD_STATE_SAFETY_INVALID',
      records: freeze([]),
      summary: null,
      sourceStateMutated: false,
      economicSampleCredit: 0,
      profitabilityClaimAllowed: false,
      executionAuthority: 'NONE',
    });
  }
  if (typeof loadCandles !== 'function') throw new TypeError('loadCandles is required');
  if (!hypothesis || hypothesis.executionAuthority !== 'NONE') {
    throw new TypeError('safe frozen hypothesis is required');
  }

  const sourceObservationCount = state.observations.length;
  const candidates = state.observations.filter((row) => relevantObservation(row, hypothesis));
  const records = [];
  const cache = new Map();

  for (const observation of candidates) {
    const symbol = observation.identity.symbol;
    let candles = cache.get(symbol);
    if (!candles) {
      try {
        candles = await loadCandles({
          market: hypothesis.market,
          symbol,
          timeframe: '60m',
          frozenAt: hypothesis.frozenAt,
        });
        if (!Array.isArray(candles)) throw new TypeError('loaded candles must be an array');
        cache.set(symbol, candles);
      } catch (error) {
        records.push(freeze({
          schemaVersion: 'move-hunter-market-hypothesis-forward-record/v1',
          status: 'BLOCKED_DATA',
          reason: 'FORWARD_FEATURE_CANDLE_LOAD_FAILED',
          details: freeze({
            symbol,
            message: error instanceof Error ? error.message : String(error),
          }),
          prospectiveOnly: true,
          observedHistoryMayCountAsOos: false,
          observedHistoryMayCountAsForward: false,
          economicSampleCredit: 0,
          profitabilityClaimAllowed: false,
          automaticPromotionAuthority: false,
          executionAuthority: 'NONE',
        }));
        continue;
      }
    }

    const feature = buildMarketHypothesisForwardFeatureSnapshot({
      observation,
      candles,
      maxHistoryBars,
    });
    if (feature.status !== 'READY' || !feature.snapshot) {
      records.push(freeze({
        schemaVersion: 'move-hunter-market-hypothesis-forward-record/v1',
        status: 'BLOCKED_DATA',
        reason: 'FORWARD_FEATURE_BUILD_BLOCKED',
        details: freeze({
          observationId: observation.observationId ?? null,
          symbol,
          featureReason: feature.reason ?? null,
          acceptedClosedCandleCount: feature.acceptedClosedCandleCount ?? null,
        }),
        prospectiveOnly: true,
        observedHistoryMayCountAsOos: false,
        observedHistoryMayCountAsForward: false,
        economicSampleCredit: 0,
        profitabilityClaimAllowed: false,
        automaticPromotionAuthority: false,
        executionAuthority: 'NONE',
      }));
      continue;
    }

    records.push(buildMarketHypothesisForwardRecord({
      observation,
      featureSnapshot: feature.snapshot,
      hypothesis,
    }));
  }

  const summary = summarizeMarketHypothesisForwardRecords(records);
  return freeze({
    schemaVersion: 'move-hunter-market-hypothesis-state-consumer/v1',
    status: 'READY',
    hypothesisId: hypothesis.hypothesisId,
    sourceResearchCodeSha: state.researchCodeSha,
    sourceObservationCount,
    candidateObservationCount: candidates.length,
    untouchedObservationCount: sourceObservationCount - candidates.length,
    records: freeze(records),
    summary,
    sourceStateMutated: false,
    canonicalStateWriteAllowed: false,
    publicDataOnly: true,
    artifactOnly: true,
    observedHistoryMayCountAsOos: false,
    observedHistoryMayCountAsForward: false,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAuthority: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}
