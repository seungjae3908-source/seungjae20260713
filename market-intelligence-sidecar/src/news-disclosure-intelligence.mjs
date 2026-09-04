import { createHash } from 'node:crypto';

const MARKET_SET = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']);
const SOURCE_TYPE_SET = new Set(['NEWS', 'DISCLOSURE', 'FILING', 'EARNINGS', 'EXCHANGE_NOTICE', 'MACRO', 'REGULATION', 'UNKNOWN']);
const SOURCE_TIER_SET = new Set(['TIER_1_OFFICIAL', 'TIER_2_ISSUER', 'TIER_3_VERIFIED_NEWS', 'TIER_4_OTHER_VERIFIED', 'TIER_5_UNVERIFIED', 'UNKNOWN']);
const EVENT_TYPE_SET = new Set([
  'EARNINGS', 'EARNINGS_GUIDANCE', 'REVENUE_SURPRISE', 'PROFIT_SURPRISE', 'DIVIDEND', 'BUYBACK',
  'CAPITAL_RAISE', 'RIGHTS_OFFERING', 'CB', 'BW', 'STOCK_SPLIT', 'CONTRACT', 'ORDER_WIN', 'M_AND_A',
  'ACQUISITION', 'SALE', 'IPO', 'DELISTING', 'MANAGEMENT_CHANGE', 'INSIDER_TRANSACTION', 'LAWSUIT',
  'INVESTIGATION', 'REGULATORY_ACTION', 'PRODUCT_LAUNCH', 'PRODUCT_FAILURE', 'PATENT', 'SUPPLY_CHAIN',
  'CREDIT_RATING', 'DEFAULT', 'BANKRUPTCY', 'RATE_DECISION', 'CPI', 'PPI', 'EMPLOYMENT', 'GDP', 'FX',
  'COMMODITY', 'LIQUIDITY', 'GEOPOLITICAL', 'REGULATION', 'LISTING', 'TOKEN_UNLOCK', 'TOKEN_BURN',
  'NETWORK_UPGRADE', 'EXPLOIT', 'HACK', 'ETF', 'WHALE_EVENT', 'EXCHANGE_EVENT', 'STABLECOIN_EVENT', 'UNKNOWN',
]);
const CRITICAL_EVENT_TYPES = new Set([
  'DELISTING', 'DEFAULT', 'BANKRUPTCY', 'EXPLOIT', 'HACK', 'REGULATORY_ACTION', 'INVESTIGATION',
  'CAPITAL_RAISE', 'RIGHTS_OFFERING', 'CB', 'BW', 'M_AND_A', 'ACQUISITION', 'LAWSUIT',
]);
const SIGNAL_DIRECTION_SET = new Set(['POSITIVE', 'NEGATIVE', 'NEUTRAL', 'MIXED', 'UNKNOWN']);
const ANALYSIS_SCOPE_SET = new Set(['CORE', 'SCANNER', 'CHART', 'PORTFOLIO', 'ASSISTANT', 'BACKTEST', 'SHADOW', 'PAPER']);
const AI_MODE_SET = new Set(['NO_AI', 'CHEAP_AI', 'DEEP_AI', 'MULTI_EVIDENCE']);

function cleanText(value, max = 4_000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampScore(value) {
  const number = finite(value);
  return number == null ? null : Math.max(0, Math.min(100, number));
}

function safeIso(value) {
  const text = cleanText(value, 100);
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeHttpUrl(value) {
  const text = cleanText(value, 2_048);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function canonicalSymbol(value) {
  return cleanText(value, 80).toUpperCase().replace(/[^A-Z0-9._:-]/g, '');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function uniqueStrings(values, max = 32) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => cleanText(value, 300)).filter(Boolean))].slice(0, max);
}

function normalizeEvidenceSections(input = {}) {
  return {
    facts: uniqueStrings(input.facts, 32),
    inferences: uniqueStrings(input.inferences, 24),
    uncertainty: uniqueStrings(input.uncertainty, 24),
  };
}

function normalizeDirection(value) {
  const normalized = cleanText(value, 30).toUpperCase();
  return SIGNAL_DIRECTION_SET.has(normalized) ? normalized : 'UNKNOWN';
}

function normalizeEventType(value) {
  const normalized = cleanText(value, 60).toUpperCase();
  return EVENT_TYPE_SET.has(normalized) ? normalized : 'UNKNOWN';
}

function normalizeSourceType(value) {
  const normalized = cleanText(value, 40).toUpperCase();
  return SOURCE_TYPE_SET.has(normalized) ? normalized : 'UNKNOWN';
}

function normalizeSourceTier(value) {
  const normalized = cleanText(value, 40).toUpperCase();
  return SOURCE_TIER_SET.has(normalized) ? normalized : 'UNKNOWN';
}

function canonicalRawIdentity(event) {
  return {
    sourceId: event.sourceId,
    sourceType: event.sourceType,
    sourceTier: event.sourceTier,
    sourceUrl: event.sourceUrl,
    sourceName: event.sourceName,
    market: event.market,
    symbol: event.symbol,
    publishedAt: event.publishedAt,
    headline: event.headline,
    originalText: event.originalText,
    eventType: event.eventType,
  };
}

export function canonicalizeMarketIntelEvent(input = {}) {
  const market = cleanText(input.market, 40).toUpperCase();
  const publishedAt = safeIso(input.publishedAt);
  const receivedAt = safeIso(input.receivedAt);
  const sourceUrl = safeHttpUrl(input.sourceUrl);
  const sourceTier = normalizeSourceTier(input.sourceTier);
  const sourceType = normalizeSourceType(input.sourceType);
  const eventType = normalizeEventType(input.eventType);
  const evidence = normalizeEvidenceSections(input.evidence);
  const event = {
    schemaVersion: 'MarketIntelEventV1',
    sourceId: cleanText(input.sourceId, 200) || null,
    sourceType,
    sourceTier,
    sourceUrl,
    sourceName: cleanText(input.sourceName, 160) || null,
    market: MARKET_SET.has(market) ? market : null,
    symbol: canonicalSymbol(input.symbol) || null,
    companyName: cleanText(input.companyName, 200) || null,
    publishedAt,
    receivedAt,
    headline: cleanText(input.headline, 1_000) || null,
    originalText: cleanText(input.originalText, 20_000) || null,
    eventType,
    direction: normalizeDirection(input.direction),
    importanceScore: clampScore(input.importanceScore),
    confidenceScore: clampScore(input.confidenceScore),
    noveltyScore: clampScore(input.noveltyScore),
    evidence,
  };
  const rawHash = sha256(stableJson(canonicalRawIdentity(event)));
  return { ...event, rawHash };
}

export function evaluateFreshness(event, options = {}) {
  const nowMs = finite(options.nowMs);
  const policy = options.freshnessPolicyMs && typeof options.freshnessPolicyMs === 'object'
    ? options.freshnessPolicyMs
    : null;
  const publishedMs = event?.publishedAt ? new Date(event.publishedAt).getTime() : NaN;
  if (nowMs == null || !Number.isFinite(publishedMs) || !policy) {
    return { state: 'UNKNOWN', ageMs: null, reason: 'FRESHNESS_EVIDENCE_MISSING' };
  }
  const futureToleranceMs = Math.max(0, finite(policy.futureToleranceMs) ?? 0);
  const freshMs = finite(policy.freshMs);
  const agingMs = finite(policy.agingMs);
  const staleMs = finite(policy.staleMs);
  if (freshMs == null || agingMs == null || staleMs == null || freshMs < 0 || agingMs < freshMs || staleMs < agingMs) {
    return { state: 'UNKNOWN', ageMs: null, reason: 'FRESHNESS_POLICY_INVALID' };
  }
  const ageMs = nowMs - publishedMs;
  if (ageMs < -futureToleranceMs) return { state: 'UNKNOWN', ageMs, reason: 'FUTURE_PUBLICATION_TIME' };
  if (ageMs <= freshMs) return { state: 'FRESH', ageMs, reason: null };
  if (ageMs <= agingMs) return { state: 'AGING', ageMs, reason: null };
  if (ageMs <= staleMs) return { state: 'STALE', ageMs, reason: null };
  return { state: 'EXPIRED', ageMs, reason: null };
}

export function buildAnalysisKey(event, options = {}) {
  const promptVersion = cleanText(options.promptVersion, 120) || 'market-intel-v1';
  const requestedScope = cleanText(options.analysisScope, 40).toUpperCase();
  const analysisScope = ANALYSIS_SCOPE_SET.has(requestedScope) ? requestedScope : 'CORE';
  const requestedAiMode = cleanText(options.aiMode, 40).toUpperCase();
  const aiMode = AI_MODE_SET.has(requestedAiMode) ? requestedAiMode : 'CHEAP_AI';
  return sha256(stableJson({ schema: 'MarketIntelAnalysisKeyV2', rawHash: event.rawHash, promptVersion, analysisScope, aiMode }));
}

function evidenceStatus(event, freshness) {
  const reasons = [];
  if (!event.market) reasons.push('MARKET_UNRESOLVED');
  if (!event.symbol && !['MACRO', 'REGULATION'].includes(event.sourceType)) reasons.push('ENTITY_UNRESOLVED');
  if (!event.headline && !event.originalText) reasons.push('CONTENT_MISSING');
  if (event.sourceTier === 'UNKNOWN') reasons.push('SOURCE_TIER_UNKNOWN');
  if (event.sourceTier === 'TIER_5_UNVERIFIED') reasons.push('SOURCE_UNVERIFIED');
  if (!event.sourceUrl && !['DISCLOSURE', 'FILING'].includes(event.sourceType)) reasons.push('SOURCE_URL_MISSING');
  if (freshness.reason === 'FUTURE_PUBLICATION_TIME') reasons.push('FUTURE_PUBLICATION_TIME');
  if (freshness.reason === 'FRESHNESS_POLICY_INVALID') reasons.push('FRESHNESS_POLICY_INVALID');
  if (reasons.includes('CONTENT_MISSING') || reasons.includes('FUTURE_PUBLICATION_TIME')) {
    return { status: 'INVALID_EVIDENCE', reasons };
  }
  if (reasons.includes('SOURCE_UNVERIFIED')) return { status: 'NO_EVIDENCE', reasons };
  if (reasons.length > 0) return { status: 'PARTIAL_EVIDENCE', reasons };
  return { status: 'READY', reasons };
}

export function detectEvidenceConflict(events = []) {
  const directions = new Set(
    events
      .map((event) => normalizeDirection(event?.direction))
      .filter((direction) => direction === 'POSITIVE' || direction === 'NEGATIVE'),
  );
  const sourceTiers = new Set(events.map((event) => normalizeSourceTier(event?.sourceTier)).filter((tier) => tier !== 'UNKNOWN'));
  return {
    conflictDetected: directions.has('POSITIVE') && directions.has('NEGATIVE'),
    independentSourceTierCount: sourceTiers.size,
    observedDirections: [...directions].sort(),
  };
}

function deepReason(event, context) {
  const reasons = [];
  if (CRITICAL_EVENT_TYPES.has(event.eventType)) reasons.push('CRITICAL_EVENT_TYPE');
  if (context.portfolioHolding === true) reasons.push('PORTFOLIO_HOLDING');
  if (context.watchlist === true) reasons.push('WATCHLIST_ASSET');
  if (context.scannerCandidate === true) reasons.push('SCANNER_CANDIDATE');
  if (context.abnormalPriceMove === true) reasons.push('ABNORMAL_PRICE_MOVE');
  if (context.abnormalVolume === true) reasons.push('ABNORMAL_VOLUME');
  if (event.confidenceScore != null && event.confidenceScore < 60) reasons.push('LOW_CONFIDENCE');
  return reasons;
}

function plannedAiRoute(event, context, evidence, freshness, conflict, clusterEvents) {
  const reasons = [...evidence.reasons];
  let aiLevel = 1;
  let aiMode = 'CHEAP_AI';
  let realtimeClass = 'REALTIME';

  if (evidence.status === 'NO_EVIDENCE' || evidence.status === 'INVALID_EVIDENCE') {
    aiLevel = 0;
    aiMode = 'NO_AI';
    realtimeClass = 'NONE';
    reasons.push('AI_BLOCKED_BY_EVIDENCE');
  } else if (freshness.state === 'EXPIRED') {
    aiLevel = 0;
    aiMode = 'NO_AI';
    realtimeClass = 'BATCH';
    reasons.push('EXPIRED_EVENT_BATCH_ONLY');
  } else if (conflict.conflictDetected || conflict.independentSourceTierCount >= 3 || clusterEvents.length >= 3) {
    aiLevel = 3;
    aiMode = 'MULTI_EVIDENCE';
    reasons.push(conflict.conflictDetected ? 'CONFLICTING_EVIDENCE' : 'MULTI_SOURCE_FUSION');
  } else {
    const deepReasons = deepReason(event, context);
    if (deepReasons.length > 0) {
      aiLevel = 2;
      aiMode = 'DEEP_AI';
      reasons.push(...deepReasons);
    } else {
      reasons.push('STANDARD_EVENT_CLASSIFICATION');
    }
  }
  return { aiLevel, aiMode, realtimeClass, reasons };
}

export function routeMarketIntelAi(input = {}) {
  const event = canonicalizeMarketIntelEvent(input.event ?? input);
  const context = input.context && typeof input.context === 'object' ? input.context : {};
  const freshness = evaluateFreshness(event, {
    nowMs: input.nowMs,
    freshnessPolicyMs: input.freshnessPolicyMs,
  });
  const evidence = evidenceStatus(event, freshness);
  const seenRawHashes = new Set(Array.isArray(input.seenRawHashes) ? input.seenRawHashes.map(String) : []);
  const cachedAnalysisKeys = new Set(Array.isArray(input.cachedAnalysisKeys) ? input.cachedAnalysisKeys.map(String) : []);
  const exactDuplicate = seenRawHashes.has(event.rawHash);
  const clusterEvents = Array.isArray(input.clusterEvents)
    ? input.clusterEvents.map((entry) => canonicalizeMarketIntelEvent(entry))
    : [];
  const conflict = detectEvidenceConflict([event, ...clusterEvents]);
  const planned = plannedAiRoute(event, context, evidence, freshness, conflict, clusterEvents);
  const analysisKey = buildAnalysisKey(event, {
    promptVersion: input.promptVersion,
    analysisScope: input.analysisScope,
    aiMode: planned.aiMode,
  });
  const cacheHit = cachedAnalysisKeys.has(analysisKey);
  const reasons = [...planned.reasons];
  let aiLevel = planned.aiLevel;
  let aiMode = planned.aiMode;
  let realtimeClass = planned.realtimeClass;
  let cacheReuse = false;

  if (exactDuplicate || cacheHit) {
    aiLevel = 0;
    aiMode = 'NO_AI';
    realtimeClass = 'NONE';
    cacheReuse = true;
    reasons.push(exactDuplicate ? 'EXACT_DUPLICATE' : 'ANALYSIS_CACHE_HIT');
  }

  const status = conflict.conflictDetected
    ? 'CONFLICTING_EVIDENCE'
    : evidence.status;

  return {
    contract: 'MarketIntelAiRouteV1',
    status,
    event,
    freshness,
    conflict,
    ai: {
      level: aiLevel,
      mode: aiMode,
      modelTier: aiLevel >= 2 ? 'DEEP' : aiLevel === 1 ? 'CHEAP' : 'NONE',
      realtimeClass,
      analysisKey,
      cacheEligible: evidence.status !== 'INVALID_EVIDENCE' && evidence.status !== 'NO_EVIDENCE',
      cacheReuse,
      batchEligible: freshness.state === 'EXPIRED' || context.historicalAnalysis === true,
      maxOutputClass: aiLevel >= 2 ? 'DETAILED_STRUCTURED' : aiLevel === 1 ? 'COMPACT_STRUCTURED' : 'NONE',
    },
    reasons: uniqueStrings(reasons, 48),
    evidence: event.evidence,
    safety: {
      executionAuthority: 'NONE',
      orderAllowed: false,
      candidateDeletionAllowed: false,
      sentimentIsPriceDirection: false,
      fabricatedEvidenceAllowed: false,
    },
  };
}

export function clusterMarketIntelEvents(events = []) {
  const normalized = events.map((event) => canonicalizeMarketIntelEvent(event));
  const unique = [];
  const seen = new Set();
  for (const event of normalized) {
    if (seen.has(event.rawHash)) continue;
    seen.add(event.rawHash);
    unique.push(event);
  }
  const conflict = detectEvidenceConflict(unique);
  return {
    contract: 'MarketIntelEventClusterV1',
    events: unique,
    exactDuplicateCount: normalized.length - unique.length,
    conflict,
    clusterHash: sha256(stableJson(unique.map((event) => event.rawHash).sort())),
    safety: { executionAuthority: 'NONE', orderAllowed: false },
  };
}
