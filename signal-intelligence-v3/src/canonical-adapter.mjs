function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value) {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function strictFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function immutableSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/iu.test(value);
}

function marketOf(card) {
  const assetClass = String(card?.assetClass ?? '').toLowerCase();
  const market = String(card?.market ?? '').toUpperCase();
  if (assetClass === 'stock' && market === 'KR') return 'KR_STOCK';
  if (assetClass === 'stock' && market === 'US') return 'US_STOCK';
  if (assetClass === 'coin_spot') return 'CRYPTO_SPOT';
  if (assetClass === 'coin_futures') return 'CRYPTO_FUTURES';
  return null;
}

function directionOf(card, market) {
  const action = String(card?.action ?? '').toUpperCase();
  const direction = String(card?.direction ?? '').toUpperCase();
  if (market !== 'CRYPTO_FUTURES') return action === 'BUY' ? 'BUY' : null;
  if (action === 'LONG' || action === 'SHORT') return action;
  return direction === 'LONG' || direction === 'SHORT' ? direction : null;
}

function entryMid(card) {
  const from = positive(card?.pricePlan?.entryZone?.from);
  const to = positive(card?.pricePlan?.entryZone?.to);
  if (from != null && to != null) return (from + to) / 2;
  return positive(card?.price);
}

export function stopDistancePercent(card) {
  const entry = entryMid(card);
  const stop = positive(card?.pricePlan?.stopLoss);
  return entry != null && stop != null ? Math.abs(entry - stop) / entry * 100 : null;
}

function dataReady(card, nowMs) {
  if (String(card?.dataState ?? '').toLowerCase() !== 'complete') return false;
  if (card?.dataQuality?.state === 'DATA_UNTRUSTED') return false;
  if (card?.dataQuality && card.dataQuality.strongSignalAllowed !== true) return false;
  const observed = Date.parse(String(card?.observedAt ?? ''));
  const expires = Date.parse(String(card?.expiresAt ?? ''));
  return Number.isFinite(observed) && observed <= nowMs + 60_000 && Number.isFinite(expires) && expires > nowMs;
}

function quantReady(card) {
  if (card?.strongSignalEligible !== true) return false;
  if (card?.candidateRanking?.hardFilterPassed === false) return false;
  const grade = String(card?.signalGrade ?? '').toUpperCase();
  return !grade || grade === 'S' || grade === 'A';
}

function riskReady(card) {
  if (!['LOW', 'MEDIUM'].includes(String(card?.riskLevel ?? '').toUpperCase())) return false;
  const entry = entryMid(card);
  const stop = positive(card?.pricePlan?.stopLoss);
  const targets = Array.isArray(card?.pricePlan?.targets) ? card.pricePlan.targets.map(positive).filter(Boolean) : [];
  return entry != null && stop != null && stop !== entry && targets.length > 0;
}

function addBlocker(blockers, blocker) {
  if (!blockers.includes(blocker)) blockers.push(blocker);
}

function validatePaperIdentity(identity, { card, market, direction, timeframe }, blockers) {
  if (!identity || typeof identity !== 'object') {
    addBlocker(blockers, 'PAPER_IDENTITY_REQUIRED');
    return null;
  }
  if (!nonEmpty(identity.signalId) || identity.signalId !== card?.signalId) addBlocker(blockers, 'SIGNAL_IDENTITY_MISMATCH');
  if (!nonEmpty(identity.strategyId)) addBlocker(blockers, 'STRATEGY_ID_REQUIRED');
  if (!nonEmpty(identity.strategyVersion)) addBlocker(blockers, 'STRATEGY_VERSION_REQUIRED');
  if (!nonEmpty(identity.parameterHash)) addBlocker(blockers, 'PARAMETER_HASH_REQUIRED');
  if (String(identity.market ?? '').toUpperCase() !== market) addBlocker(blockers, 'IDENTITY_MARKET_MISMATCH');
  if (String(identity.symbol ?? '').toUpperCase() !== String(card?.symbol ?? '').toUpperCase()) addBlocker(blockers, 'IDENTITY_SYMBOL_MISMATCH');
  if (String(identity.timeframe ?? '') !== timeframe) addBlocker(blockers, 'IDENTITY_TIMEFRAME_MISMATCH');
  if (!Number.isInteger(identity.horizon) || identity.horizon <= 0) addBlocker(blockers, 'HORIZON_REQUIRED');
  if (String(identity.direction ?? '').toUpperCase() !== direction) addBlocker(blockers, 'IDENTITY_DIRECTION_MISMATCH');
  if (!nonEmpty(identity.costPolicyVersion)) addBlocker(blockers, 'COST_POLICY_VERSION_REQUIRED');
  if (!immutableSha(identity.researchCodeSha)) addBlocker(blockers, 'RESEARCH_CODE_SHA_REQUIRED');
  if (identity.executionAuthority != null && identity.executionAuthority !== 'NONE') addBlocker(blockers, 'IDENTITY_EXECUTION_AUTHORITY_FORBIDDEN');
  if (blockers.length) return null;
  return Object.freeze({
    signalId: identity.signalId,
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    market,
    symbol: String(card.symbol).toUpperCase(),
    timeframe,
    horizon: identity.horizon,
    direction,
    costPolicyVersion: identity.costPolicyVersion,
    researchCodeSha: identity.researchCodeSha.toLowerCase(),
    executionAuthority: 'NONE',
  });
}

const COST_FIELDS = Object.freeze([
  'commissionPercent',
  'taxPercent',
  'spreadPercent',
  'slippagePercent',
  'fundingPercent',
  'latencyPercent',
  'liquidityImpactPercent',
  'partialFillImpactPercent',
]);

function validateCostPolicy(policy, { market, costPolicyId }, blockers) {
  if (!policy || typeof policy !== 'object') {
    addBlocker(blockers, 'EXPLICIT_COST_POLICY_REQUIRED');
    return false;
  }
  if (!nonEmpty(policy.id) || policy.id !== costPolicyId) addBlocker(blockers, 'COST_POLICY_ID_MISMATCH');
  if (String(policy.market ?? '').toUpperCase() !== market) addBlocker(blockers, 'COST_POLICY_MARKET_MISMATCH');
  if (policy.source !== 'EXPLICIT_RUNTIME_POLICY') addBlocker(blockers, 'EXPLICIT_RUNTIME_COST_POLICY_REQUIRED');
  for (const field of COST_FIELDS) {
    const value = strictFinite(policy[field]);
    if (value == null || value < 0) addBlocker(blockers, `COST_POLICY_${field.toUpperCase()}_INVALID`);
  }
  return blockers.length === 0;
}

function canonicalProfitEvidence(input, card, context) {
  const blockers = [];
  const identity = validatePaperIdentity(input?.paperIdentity, { card, ...context }, blockers);
  const profit = input?.profitEvidence;
  if (!profit || typeof profit !== 'object') {
    addBlocker(blockers, 'CANONICAL_PROFIT_EVIDENCE_REQUIRED');
  } else {
    if (profit.status !== 'READY') addBlocker(blockers, 'PROFIT_EVIDENCE_NOT_READY');
    if (String(profit.market ?? '').toUpperCase() !== context.market) addBlocker(blockers, 'PROFIT_EVIDENCE_MARKET_MISMATCH');
    if (String(profit.timeframe ?? '') !== context.timeframe) addBlocker(blockers, 'PROFIT_EVIDENCE_TIMEFRAME_MISMATCH');
    if (String(profit.direction ?? '').toUpperCase() !== context.direction) addBlocker(blockers, 'PROFIT_EVIDENCE_DIRECTION_MISMATCH');
    if (identity && profit.strategyVersion !== identity.strategyVersion) addBlocker(blockers, 'PROFIT_EVIDENCE_STRATEGY_VERSION_MISMATCH');
    if (!nonEmpty(profit.costPolicyId)) addBlocker(blockers, 'PROFIT_EVIDENCE_COST_POLICY_REQUIRED');
    if (identity && profit.costPolicyId !== identity.costPolicyVersion) addBlocker(blockers, 'PROFIT_EVIDENCE_COST_POLICY_MISMATCH');
    if (strictFinite(profit.expectedNetEdge) == null || profit.expectedNetEdge <= 0) addBlocker(blockers, 'POSITIVE_NET_EDGE_EVIDENCE_REQUIRED');
    if (strictFinite(profit.expectedNetReturn) == null || profit.expectedNetReturn <= 0) addBlocker(blockers, 'POSITIVE_NET_RETURN_EVIDENCE_REQUIRED');
    if (strictFinite(profit.riskRewardRatio) == null || profit.riskRewardRatio < 1) addBlocker(blockers, 'RISK_REWARD_EVIDENCE_REQUIRED');
    if (!Number.isInteger(profit.sampleSize) || profit.sampleSize <= 0) addBlocker(blockers, 'PROFIT_SAMPLE_EVIDENCE_REQUIRED');
    if (profit.executionAuthority !== 'NONE') addBlocker(blockers, 'PROFIT_EVIDENCE_EXECUTION_AUTHORITY_FORBIDDEN');
  }

  const costPolicyId = nonEmpty(profit?.costPolicyId) ? profit.costPolicyId : null;
  validateCostPolicy(input?.costPolicy, { market: context.market, costPolicyId }, blockers);

  const stopPct = stopDistancePercent(card);
  if (stopPct == null || stopPct <= 0) addBlocker(blockers, 'STOP_DISTANCE_REQUIRED_FOR_EDGE_NORMALIZATION');
  if (blockers.length) {
    return Object.freeze({ evidence: null, identity: null, blockers: Object.freeze(blockers) });
  }

  return Object.freeze({
    evidence: Object.freeze({
      expectedNetEdgeR: profit.expectedNetEdge / stopPct,
      source: 'CANONICAL_PROFIT_EVIDENCE_READY',
      expectedNetEdgePercent: profit.expectedNetEdge,
      expectedNetReturnPercent: profit.expectedNetReturn,
      riskRewardRatio: profit.riskRewardRatio,
      sampleSize: profit.sampleSize,
      costPolicyId: profit.costPolicyId,
    }),
    identity,
    blockers: Object.freeze([]),
  });
}

function aiEvidence(card, supplied) {
  if (supplied && typeof supplied === 'object') return supplied;
  const ai = card?.aiValidation;
  if (ai?.status !== 'VETO') return {};
  return {
    riskCritic: { veto: true, reasons: Array.isArray(ai.risks) && ai.risks.length ? ai.risks : ['CANONICAL_AI_VETO'] },
    contradiction: { conflict: Array.isArray(ai.counterEvidence) && ai.counterEvidence.length > 0, reasons: ai.counterEvidence ?? [] },
  };
}

export function adaptCanonicalScannerCard(input, options = {}) {
  const card = input?.card ?? input;
  if (!card || typeof card !== 'object') return null;
  const market = marketOf(card);
  if (!market) return null;
  const direction = directionOf(card, market);
  if (!direction) return null;
  const timeframe = String(input?.timeframe ?? options.timeframe ?? '60m');
  const canonicalProfit = canonicalProfitEvidence(input, card, { market, direction, timeframe });
  const evidence = canonicalProfit.evidence;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  return {
    market,
    symbol: String(card.symbol ?? '').toUpperCase(),
    strategy: String(canonicalProfit.identity?.strategyId ?? card.strategyMode ?? options.strategy ?? 'SWING').toUpperCase(),
    timeframe,
    direction,
    validationTier: String(input?.validationTier ?? 'RESEARCH_CANDIDATE'),
    dataStatus: dataReady(card, nowMs) ? 'READY' : 'BLOCKED',
    quantEligible: quantReady(card),
    profitEligible: Boolean(evidence),
    riskReady: riskReady(card),
    evidence: evidence ?? {},
    ai: aiEvidence(card, input?.ai),
    leverageEvidence: market === 'CRYPTO_FUTURES' ? input?.leverageEvidence : undefined,
    sourceAsOf: card.observedAt ?? null,
    provenance: {
      scannerSignalId: card.signalId ?? null,
      scannerSources: Array.isArray(card.dataSources) ? card.dataSources : [],
      edgeSource: evidence?.source ?? null,
      profitEvidenceStatus: input?.profitEvidence?.status ?? null,
      costPolicyId: input?.profitEvidence?.costPolicyId ?? null,
      paperIdentity: canonicalProfit.identity,
      profitBlockers: canonicalProfit.blockers,
      backtestQualityStatus: card?.backtestQuality?.status ?? null,
    },
  };
}

export function adaptCanonicalScannerCards(inputs, options = {}) {
  return (Array.isArray(inputs) ? inputs : []).map((input) => adaptCanonicalScannerCard(input, options)).filter(Boolean);
}
