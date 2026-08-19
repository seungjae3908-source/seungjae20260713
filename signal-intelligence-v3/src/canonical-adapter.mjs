function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value) {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? parsed : null;
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

function edgeEvidence(input, card) {
  const direct = input?.edgeEvidence;
  const directEdge = finite(direct?.expectedNetEdgeR);
  if (direct?.ready === true && directEdge != null && directEdge > 0) {
    const result = { expectedNetEdgeR: directEdge, source: String(direct.source ?? 'EXPLICIT_EDGE_EVIDENCE') };
    for (const key of ['tailLossPenaltyR', 'uncertaintyPenaltyR', 'executionPenaltyR']) {
      if (Object.prototype.hasOwnProperty.call(direct, key)) result[key] = direct[key];
    }
    return result;
  }

  const b = card?.backtestQuality;
  if (!b || b.status !== 'verified') return null;
  if (b.costsIncluded !== true || b.slippageIncluded !== true || b.lookaheadGuarded !== true || b.survivorshipGuarded !== true) return null;
  if (b.oos !== true || b.walkForward !== true) return null;
  const expectancy = finite(b.expectancyPercent);
  const pf = finite(b.profitFactor);
  const trades = finite(b.tradeCount);
  const minimum = finite(b.minimumTradeCount);
  const stopPct = stopDistancePercent(card);
  if (expectancy == null || expectancy <= 0 || pf == null || pf <= 1 || trades == null || minimum == null || trades < minimum || stopPct == null || stopPct <= 0) return null;
  return {
    expectedNetEdgeR: expectancy / stopPct,
    source: 'VERIFIED_BACKTEST_EXPECTANCY_TO_STOP_R',
    expectancyPercent: expectancy,
    profitFactor: pf,
    tradeCount: trades,
    maxDrawdownPercent: finite(b.maxDrawdownPercent),
  };
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
  const evidence = edgeEvidence(input, card);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  return {
    market,
    symbol: String(card.symbol ?? '').toUpperCase(),
    strategy: String(card.strategyMode ?? options.strategy ?? 'SWING').toUpperCase(),
    timeframe: String(input?.timeframe ?? options.timeframe ?? '60m'),
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
    },
  };
}

export function adaptCanonicalScannerCards(inputs, options = {}) {
  return (Array.isArray(inputs) ? inputs : []).map((input) => adaptCanonicalScannerCard(input, options)).filter(Boolean);
}
