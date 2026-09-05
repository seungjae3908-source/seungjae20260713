const MARKETS = Object.freeze([
  'KR_STOCK',
  'US_STOCK',
  'CRYPTO_SPOT',
  'CRYPTO_FUTURES',
]);

const CASH_MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT']);
const CASH_DIRECTION = 'BUY';
const FUTURES_DIRECTIONS = new Set(['LONG', 'SHORT']);
const TERMINAL_STATES = new Set(['CANDIDATE', 'ABSTAIN', 'NO_TRADE', 'BLOCKED_DATA']);
const VALIDATION_TIERS = new Set(['RESEARCH_CANDIDATE', 'FORWARD_VALIDATED', 'CHAMPION']);
const PENALTY_FIELDS = ['tailLossPenaltyR', 'uncertaintyPenaltyR', 'executionPenaltyR'];

export const SIGNAL_INTELLIGENCE_V3_POLICY = Object.freeze({
  version: 'signal-intelligence-v3.1',
  maxCandidatesPerList: 10,
  futuresDirectionSeparationMinR: 0.20,
  leverage: Object.freeze({
    baseBufferMultiplier: 2.0,
    uncertaintyBuffer: Object.freeze({ LOW: 0, MEDIUM: 0.5, HIGH: 1.0 }),
    volatilityBuffer: Object.freeze({ LOW: 0, NORMAL: 0.25, HIGH: 0.75, EXTREME: 1.5 }),
    liquidityBuffer: Object.freeze({ HIGH: 0, NORMAL: 0.25, LOW: 0.75 }),
  }),
  safety: Object.freeze({
    executionAuthority: 'NONE',
    privateTradingApiAllowed: false,
    realOrderAllowed: false,
    aiCanPromoteCandidate: false,
    aiCanIncreaseLeverage: false,
  }),
});

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegative(value) {
  const parsed = finite(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function requiredString(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function normalizeMarket(value) {
  const market = requiredString(value, 'market').toUpperCase();
  if (!MARKETS.includes(market)) throw new TypeError(`unsupported market: ${market}`);
  return market;
}

function normalizeDirection(market, value) {
  const direction = requiredString(value, 'direction').toUpperCase();
  if (CASH_MARKETS.has(market)) {
    if (direction !== CASH_DIRECTION) return null;
    return CASH_DIRECTION;
  }
  if (!FUTURES_DIRECTIONS.has(direction)) return null;
  return direction;
}

function normalizeValidationTier(value) {
  const tier = String(value ?? 'RESEARCH_CANDIDATE').trim().toUpperCase();
  return VALIDATION_TIERS.has(tier) ? tier : 'RESEARCH_CANDIDATE';
}

function identity(candidate) {
  return [
    candidate.market,
    candidate.symbol,
    candidate.strategy,
    candidate.timeframe,
    candidate.direction,
  ].join('|');
}

function directionalIdentity(candidate) {
  return [candidate.market, candidate.symbol, candidate.strategy, candidate.timeframe].join('|');
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(array(values).map((value) => String(value).trim()).filter(Boolean))];
}

export function evaluateAiCommittee(raw = {}) {
  const catalyst = raw?.catalyst ?? {};
  const technical = raw?.technical ?? {};
  const riskCritic = raw?.riskCritic ?? {};
  const contradiction = raw?.contradiction ?? {};

  const reasons = [];
  const riskVeto = riskCritic.veto === true;
  const evidenceConflict = contradiction.conflict === true;
  const catalystRescan = catalyst.rescanRequested === true
    || ['POSITIVE', 'NEGATIVE', 'MIXED'].includes(String(catalyst.signal ?? '').toUpperCase())
      && String(catalyst.impact ?? '').toUpperCase() === 'HIGH';
  const technicalRescan = technical.rescanRequested === true
    || ['BREAKOUT', 'BREAKDOWN', 'FAILED_BREAKOUT', 'VOLATILITY_EXPANSION', 'VOLUME_ANOMALY']
      .includes(String(technical.change ?? '').toUpperCase());

  if (riskVeto) reasons.push(...uniqueStrings(riskCritic.reasons).map((reason) => `AI_RISK_CRITIC:${reason}`));
  if (evidenceConflict) reasons.push(...uniqueStrings(contradiction.reasons).map((reason) => `AI_CONTRADICTION:${reason}`));

  return Object.freeze({
    riskVeto,
    evidenceConflict,
    forceAbstain: riskVeto || evidenceConflict,
    rescanRequested: catalystRescan || technicalRescan || raw?.rescanRequested === true,
    reasons: Object.freeze(reasons),
    promotionAuthority: false,
    leverageAuthority: false,
    executionAuthority: 'NONE',
  });
}

export function utilityFromEvidence(evidence = {}) {
  const expectedNetEdgeR = finite(evidence.expectedNetEdgeR);
  if (expectedNetEdgeR == null) {
    return Object.freeze({ value: null, mode: 'INCOMPLETE_EXPECTED_EDGE' });
  }

  const present = PENALTY_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(evidence, field));
  if (present.length === 0) {
    return Object.freeze({
      value: expectedNetEdgeR,
      mode: 'NET_EDGE_ONLY_RISK_SEPARATE',
    });
  }
  if (present.length !== PENALTY_FIELDS.length) {
    return Object.freeze({ value: null, mode: 'PARTIAL_PENALTY_EVIDENCE_REJECTED' });
  }

  const tailLossPenaltyR = nonNegative(evidence.tailLossPenaltyR);
  const uncertaintyPenaltyR = nonNegative(evidence.uncertaintyPenaltyR);
  const executionPenaltyR = nonNegative(evidence.executionPenaltyR);
  if ([tailLossPenaltyR, uncertaintyPenaltyR, executionPenaltyR].some((value) => value == null)) {
    return Object.freeze({ value: null, mode: 'INVALID_PENALTY_EVIDENCE' });
  }
  return Object.freeze({
    value: expectedNetEdgeR - tailLossPenaltyR - uncertaintyPenaltyR - executionPenaltyR,
    mode: 'FULL_EXPECTED_UTILITY',
  });
}

export function recommendConservativeLeverage(raw = {}, policy = SIGNAL_INTELLIGENCE_V3_POLICY.leverage) {
  const stopDistancePct = nonNegative(raw.stopDistancePct);
  const maeQ95Pct = nonNegative(raw.maeQ95Pct);
  const downsideIntervalPct = nonNegative(raw.downsideIntervalPct);
  const spreadPct = nonNegative(raw.spreadPct);
  const slippagePct = nonNegative(raw.slippagePct);

  if ([stopDistancePct, maeQ95Pct, downsideIntervalPct, spreadPct, slippagePct].some((value) => value == null)) {
    return Object.freeze({ status: 'NOT_AVAILABLE', reason: 'MISSING_RISK_DISTANCE_EVIDENCE' });
  }

  const tiers = array(raw.tiers)
    .map((tier) => ({
      leverage: finite(tier?.leverage),
      liquidationDistancePct: nonNegative(tier?.liquidationDistancePct),
      maintenanceMarginRatePct: nonNegative(tier?.maintenanceMarginRatePct),
      verified: tier?.verified === true,
    }))
    .filter((tier) => tier.verified && tier.leverage != null && tier.leverage > 0 && tier.liquidationDistancePct != null)
    .sort((a, b) => a.leverage - b.leverage);

  if (!tiers.length) {
    return Object.freeze({ status: 'NOT_AVAILABLE', reason: 'NO_VERIFIED_EXCHANGE_TIER_EVIDENCE' });
  }

  const uncertainty = String(raw.uncertainty ?? 'HIGH').toUpperCase();
  const volatility = String(raw.volatility ?? 'EXTREME').toUpperCase();
  const liquidity = String(raw.liquidity ?? 'LOW').toUpperCase();
  const uncertaintyBuffer = policy.uncertaintyBuffer[uncertainty];
  const volatilityBuffer = policy.volatilityBuffer[volatility];
  const liquidityBuffer = policy.liquidityBuffer[liquidity];
  if ([uncertaintyBuffer, volatilityBuffer, liquidityBuffer].some((value) => value == null)) {
    return Object.freeze({ status: 'NOT_AVAILABLE', reason: 'UNKNOWN_RISK_CLASSIFICATION' });
  }

  const stressDistancePct = Math.max(stopDistancePct, maeQ95Pct, downsideIntervalPct) + spreadPct + slippagePct;
  const bufferMultiplier = policy.baseBufferMultiplier + uncertaintyBuffer + volatilityBuffer + liquidityBuffer;
  const minimumLiquidationDistancePct = stressDistancePct * bufferMultiplier;
  const surviving = tiers.filter((tier) => tier.liquidationDistancePct >= minimumLiquidationDistancePct);

  if (!surviving.length) {
    return Object.freeze({
      status: 'BLOCKED',
      reason: 'LIQUIDATION_BUFFER_INSUFFICIENT',
      stressDistancePct,
      bufferMultiplier,
      minimumLiquidationDistancePct,
    });
  }

  const hardMaximum = surviving.at(-1).leverage;
  const recommendedUpperIndex = Math.max(0, Math.floor((surviving.length - 1) * 0.75));
  return Object.freeze({
    status: 'INDICATIVE_ONLY',
    recommendedRange: Object.freeze({ min: surviving[0].leverage, max: surviving[recommendedUpperIndex].leverage }),
    hardMaximum,
    stressDistancePct,
    bufferMultiplier,
    minimumLiquidationDistancePct,
    verifiedTierCount: surviving.length,
    executionAuthority: 'NONE',
  });
}

function normalizeCandidate(raw) {
  const market = normalizeMarket(raw?.market);
  const direction = normalizeDirection(market, raw?.direction);
  const base = {
    market,
    symbol: requiredString(raw?.symbol, 'symbol').toUpperCase(),
    strategy: requiredString(raw?.strategy, 'strategy').toUpperCase(),
    timeframe: requiredString(raw?.timeframe, 'timeframe'),
    direction,
    validationTier: normalizeValidationTier(raw?.validationTier),
    dataStatus: String(raw?.dataStatus ?? 'BLOCKED').toUpperCase(),
    quantEligible: raw?.quantEligible === true,
    profitEligible: raw?.profitEligible === true,
    riskReady: raw?.riskReady === true,
    evidence: raw?.evidence ?? {},
    ai: evaluateAiCommittee(raw?.ai),
    sourceAsOf: raw?.sourceAsOf ?? null,
    provenance: raw?.provenance ?? null,
  };
  const utility = utilityFromEvidence(base.evidence);
  const leverage = market === 'CRYPTO_FUTURES'
    ? recommendConservativeLeverage(raw?.leverageEvidence ?? {})
    : null;
  return Object.freeze({
    ...base,
    utilityR: utility.value,
    utilityMode: utility.mode,
    leverage,
    id: identity(base),
  });
}

function initialDecision(candidate) {
  const reasons = [];
  if (!candidate.direction) return { state: 'NO_TRADE', reasons: ['DIRECTION_NOT_RECOMMENDABLE'] };
  if (candidate.dataStatus !== 'READY') return { state: 'BLOCKED_DATA', reasons: ['DATA_NOT_READY'] };
  if (!candidate.quantEligible) reasons.push('QUANT_NOT_ELIGIBLE');
  if (!candidate.profitEligible) reasons.push('PROFIT_GATE_REJECTED');
  if (!candidate.riskReady) reasons.push('RISK_NOT_READY');
  if (candidate.utilityR == null) reasons.push(`UTILITY_EVIDENCE_INCOMPLETE:${candidate.utilityMode}`);
  else if (candidate.utilityR <= 0) reasons.push('NON_POSITIVE_NET_UTILITY');
  if (reasons.length) return { state: 'NO_TRADE', reasons };
  if (candidate.ai.forceAbstain) {
    return { state: 'ABSTAIN', reasons: candidate.ai.reasons.length ? candidate.ai.reasons : ['AI_EVIDENCE_CONFLICT'] };
  }
  if (candidate.market === 'CRYPTO_FUTURES' && candidate.leverage?.status === 'BLOCKED') {
    return { state: 'ABSTAIN', reasons: [candidate.leverage.reason] };
  }
  return { state: 'CANDIDATE', reasons: [] };
}

function compareRank(a, b) {
  if (b.utilityR !== a.utilityR) return b.utilityR - a.utilityR;
  return a.symbol.localeCompare(b.symbol);
}

function applyFuturesDirectionAuction(rows, separationMinR) {
  const groups = new Map();
  for (const row of rows) {
    const key = directionalIdentity(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const output = [];
  for (const group of groups.values()) {
    const candidates = group.filter((row) => row.state === 'CANDIDATE');
    const long = candidates.find((row) => row.direction === 'LONG');
    const short = candidates.find((row) => row.direction === 'SHORT');
    if (!long || !short) {
      output.push(...group);
      continue;
    }

    const separation = Math.abs(long.utilityR - short.utilityR);
    if (separation < separationMinR) {
      for (const row of group) {
        if (row === long || row === short) {
          output.push(Object.freeze({ ...row, state: 'ABSTAIN', reasons: Object.freeze(['DIRECTIONAL_EDGE_TOO_CLOSE']) }));
        } else output.push(row);
      }
      continue;
    }

    const winner = long.utilityR > short.utilityR ? long : short;
    const loser = winner === long ? short : long;
    for (const row of group) {
      if (row === loser) {
        output.push(Object.freeze({ ...row, state: 'NO_TRADE', reasons: Object.freeze(['DIRECTION_LOST_AUCTION']) }));
      } else output.push(row);
    }
  }
  return output;
}

function list(rows, market, direction, limit) {
  return rows
    .filter((row) => row.market === market && row.direction === direction && row.state === 'CANDIDATE')
    .sort(compareRank)
    .slice(0, limit);
}

function candidateStateMap(rows) {
  return Object.fromEntries(rows.map((row) => [row.id, row.state]));
}

export function buildSignalEvents(snapshot, previousSnapshot = null) {
  const events = [];
  const previousStates = previousSnapshot?.stateById ?? {};
  for (const row of snapshot.rows) {
    const before = previousStates[row.id] ?? null;
    if (row.ai.rescanRequested) {
      events.push(Object.freeze({
        type: 'RESCAN_REQUESTED',
        id: row.id,
        market: row.market,
        symbol: row.symbol,
        strategy: row.strategy,
        timeframe: row.timeframe,
        direction: row.direction,
        state: row.state,
        validationTier: row.validationTier,
      }));
    }
    if (row.state === 'CANDIDATE' && before !== 'CANDIDATE') {
      events.push(Object.freeze({
        type: 'NEW_CANDIDATE',
        id: row.id,
        market: row.market,
        symbol: row.symbol,
        strategy: row.strategy,
        timeframe: row.timeframe,
        direction: row.direction,
        state: row.state,
        validationTier: row.validationTier,
        utilityR: row.utilityR,
        utilityMode: row.utilityMode,
        leverage: row.leverage,
      }));
    } else if (before && before !== row.state) {
      events.push(Object.freeze({
        type: 'STATE_CHANGED',
        id: row.id,
        market: row.market,
        symbol: row.symbol,
        strategy: row.strategy,
        timeframe: row.timeframe,
        direction: row.direction,
        validationTier: row.validationTier,
        previousState: before,
        state: row.state,
        reasons: row.reasons,
      }));
    }
  }
  return Object.freeze(events);
}

export function runSignalIntelligenceV3(rawCandidates, options = {}) {
  const policy = {
    maxCandidatesPerList: Number.isInteger(options.maxCandidatesPerList) && options.maxCandidatesPerList > 0
      ? options.maxCandidatesPerList
      : SIGNAL_INTELLIGENCE_V3_POLICY.maxCandidatesPerList,
    futuresDirectionSeparationMinR: finite(options.futuresDirectionSeparationMinR)
      ?? SIGNAL_INTELLIGENCE_V3_POLICY.futuresDirectionSeparationMinR,
  };

  let rows = array(rawCandidates).map((raw) => {
    const candidate = normalizeCandidate(raw);
    const decision = initialDecision(candidate);
    return Object.freeze({ ...candidate, state: decision.state, reasons: Object.freeze(decision.reasons) });
  });

  rows = applyFuturesDirectionAuction(rows, policy.futuresDirectionSeparationMinR);

  const snapshot = {
    schemaVersion: 1,
    policyVersion: SIGNAL_INTELLIGENCE_V3_POLICY.version,
    generatedAt: new Date().toISOString(),
    lists: Object.freeze({
      krBuy: Object.freeze(list(rows, 'KR_STOCK', 'BUY', policy.maxCandidatesPerList)),
      usBuy: Object.freeze(list(rows, 'US_STOCK', 'BUY', policy.maxCandidatesPerList)),
      spotBuy: Object.freeze(list(rows, 'CRYPTO_SPOT', 'BUY', policy.maxCandidatesPerList)),
      futuresLong: Object.freeze(list(rows, 'CRYPTO_FUTURES', 'LONG', policy.maxCandidatesPerList)),
      futuresShort: Object.freeze(list(rows, 'CRYPTO_FUTURES', 'SHORT', policy.maxCandidatesPerList)),
    }),
    rows: Object.freeze(rows),
    stateById: Object.freeze(candidateStateMap(rows)),
    safety: SIGNAL_INTELLIGENCE_V3_POLICY.safety,
  };

  snapshot.events = buildSignalEvents(snapshot, options.previousSnapshot ?? null);
  return Object.freeze(snapshot);
}

export function assertSignalIntelligenceV3Snapshot(snapshot) {
  if (!snapshot || snapshot.policyVersion !== SIGNAL_INTELLIGENCE_V3_POLICY.version) throw new TypeError('invalid policy version');
  if (snapshot.safety?.executionAuthority !== 'NONE') throw new Error('execution authority must remain NONE');
  if (snapshot.safety?.privateTradingApiAllowed !== false) throw new Error('private trading API must remain disabled');
  if (snapshot.safety?.realOrderAllowed !== false) throw new Error('real orders must remain disabled');
  for (const row of snapshot.lists.krBuy) if (row.direction !== 'BUY') throw new Error('KR list must be BUY only');
  for (const row of snapshot.lists.usBuy) if (row.direction !== 'BUY') throw new Error('US list must be BUY only');
  for (const row of snapshot.lists.spotBuy) if (row.direction !== 'BUY') throw new Error('Spot list must be BUY only');
  for (const row of snapshot.lists.futuresLong) if (row.direction !== 'LONG') throw new Error('Futures long list invalid');
  for (const row of snapshot.lists.futuresShort) if (row.direction !== 'SHORT') throw new Error('Futures short list invalid');
  for (const row of snapshot.rows) {
    if (!TERMINAL_STATES.has(row.state)) throw new Error(`invalid state ${row.state}`);
    if (!VALIDATION_TIERS.has(row.validationTier)) throw new Error(`invalid validation tier ${row.validationTier}`);
  }
  return true;
}
