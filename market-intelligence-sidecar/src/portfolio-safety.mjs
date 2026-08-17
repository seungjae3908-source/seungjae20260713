const ENFORCEMENT_MODES = new Set(['OBSERVE_ONLY', 'REQUIRED_FOR_PARENT_GATE']);

export const DEFAULT_PORTFOLIO_SAFETY_POLICY = Object.freeze({
  version: 'MIS_PORTFOLIO_SAFETY_V1',
  enforcement: 'OBSERVE_ONLY',
  maxGrossExposurePct: 100,
  maxSinglePositionPct: 20,
  maxVerifiedClusterExposurePct: 35,
  expectedShortfallAlpha: 0.975,
  minExpectedShortfallSamples: 250,
  maxExpectedShortfallPct: 5,
  maxDailyDrawdownPct: 4,
  maxRollingDrawdownPct: 10,
  maxConsecutiveExecutionErrors: 3,
  defaultSignalTtlMs: 15 * 60 * 1000,
  maxRevalidationAgeMs: 2 * 60 * 1000,
  reentryCooldownMs: 15 * 60 * 1000,
  maxSameDirectionEntriesInWindow: 3,
  churnWindowMs: 60 * 60 * 1000,
});

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resolvePolicy(policy = {}) {
  const merged = { ...DEFAULT_PORTFOLIO_SAFETY_POLICY, ...(policy ?? {}) };
  if (typeof merged.version !== 'string' || !merged.version.trim()) throw new Error('PORTFOLIO_SAFETY_POLICY_VERSION_REQUIRED');
  merged.enforcement = String(merged.enforcement ?? '').toUpperCase();
  if (!ENFORCEMENT_MODES.has(merged.enforcement)) throw new Error('PORTFOLIO_SAFETY_ENFORCEMENT_INVALID');
  for (const key of Object.keys(DEFAULT_PORTFOLIO_SAFETY_POLICY).filter((key) => key !== 'version' && key !== 'enforcement')) {
    const value = Number(merged[key]);
    if (!Number.isFinite(value)) throw new Error(`PORTFOLIO_SAFETY_POLICY_FIELD_INVALID:${key}`);
    merged[key] = value;
  }
  if (!(merged.expectedShortfallAlpha > 0.5 && merged.expectedShortfallAlpha < 1)) throw new Error('EXPECTED_SHORTFALL_ALPHA_INVALID');
  return merged;
}

function normalizePositions(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      symbol: String(row?.symbol ?? '').trim().toUpperCase(),
      market: String(row?.market ?? '').trim().toUpperCase(),
      notionalKrw: Math.max(0, finite(row?.notionalKrw, 0)),
      cluster: String(row?.cluster ?? '').trim().toUpperCase() || null,
    }))
    .filter((row) => row.symbol && row.notionalKrw >= 0);
}

export function evaluateExpectedShortfall(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const samples = (Array.isArray(raw.lossSamplesPct) ? raw.lossSamplesPct : [])
    .map((value) => finite(value))
    .filter((value) => value != null && value >= 0)
    .sort((a, b) => a - b);
  if (samples.length < policy.minExpectedShortfallSamples) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'EXPECTED_SHORTFALL_SAMPLE_INSUFFICIENT',
      sampleSize: samples.length,
      minimumSamples: policy.minExpectedShortfallSamples,
    };
  }
  const alpha = finite(raw.alpha, policy.expectedShortfallAlpha);
  if (!(alpha > 0.5 && alpha < 1)) return { status: 'NOT_AVAILABLE', reason: 'EXPECTED_SHORTFALL_ALPHA_INVALID' };
  const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * alpha) - 1));
  const varPct = samples[index];
  const tail = samples.slice(index);
  const expectedShortfallPct = tail.reduce((sum, value) => sum + value, 0) / tail.length;
  return {
    status: expectedShortfallPct > policy.maxExpectedShortfallPct ? 'VETO' : 'PASS',
    reason: expectedShortfallPct > policy.maxExpectedShortfallPct ? 'EXPECTED_SHORTFALL_LIMIT_EXCEEDED' : null,
    alpha,
    sampleSize: samples.length,
    varPct,
    expectedShortfallPct,
    tailSampleSize: tail.length,
    empiricalOnly: true,
  };
}

export function evaluatePortfolioRisk(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const equityKrw = finite(raw.equityKrw);
  if (!(equityKrw > 0)) return { status: 'NOT_AVAILABLE', reason: 'PORTFOLIO_EQUITY_REQUIRED' };
  const positions = normalizePositions(raw.positions);
  const proposedNotionalKrw = Math.max(0, finite(raw.proposedNotionalKrw, 0));
  const proposedSymbol = String(raw.proposedSymbol ?? '').trim().toUpperCase();
  const proposedCluster = String(raw.proposedCluster ?? '').trim().toUpperCase() || null;

  const currentGrossKrw = positions.reduce((sum, row) => sum + row.notionalKrw, 0);
  const grossAfterKrw = currentGrossKrw + proposedNotionalKrw;
  const grossExposurePct = grossAfterKrw / equityKrw * 100;
  const currentSymbolKrw = positions.filter((row) => proposedSymbol && row.symbol === proposedSymbol).reduce((sum, row) => sum + row.notionalKrw, 0);
  const singlePositionPct = (currentSymbolKrw + proposedNotionalKrw) / equityKrw * 100;

  let clusterExposurePct = null;
  let clusterEvidenceStatus = 'NOT_AVAILABLE';
  if (raw.correlationEvidenceVerified === true && proposedCluster) {
    const clusterKrw = positions.filter((row) => row.cluster === proposedCluster).reduce((sum, row) => sum + row.notionalKrw, 0) + proposedNotionalKrw;
    clusterExposurePct = clusterKrw / equityKrw * 100;
    clusterEvidenceStatus = 'VERIFIED';
  }

  const reasons = [];
  if (grossExposurePct > policy.maxGrossExposurePct) reasons.push('GROSS_EXPOSURE_LIMIT_EXCEEDED');
  if (singlePositionPct > policy.maxSinglePositionPct) reasons.push('SINGLE_POSITION_LIMIT_EXCEEDED');
  if (clusterExposurePct != null && clusterExposurePct > policy.maxVerifiedClusterExposurePct) reasons.push('CORRELATION_CLUSTER_LIMIT_EXCEEDED');

  return {
    status: reasons.length ? 'VETO' : 'PASS',
    reasons,
    equityKrw,
    positionCount: positions.length,
    currentGrossKrw,
    proposedNotionalKrw,
    grossAfterKrw,
    grossExposurePct,
    proposedSymbol: proposedSymbol || null,
    singlePositionPct,
    proposedCluster,
    clusterExposurePct,
    clusterEvidenceStatus,
    correlationInvented: false,
  };
}

export function evaluateSignalFreshness(raw = {}, policyInput = {}, nowInput = Date.now()) {
  const policy = resolvePolicy(policyInput);
  const now = finite(nowInput, Date.now());
  const generatedAt = finite(raw.generatedAt);
  if (generatedAt == null) return { status: 'NOT_AVAILABLE', reason: 'SIGNAL_GENERATED_AT_REQUIRED' };
  const ttlMs = Math.max(1, finite(raw.ttlMs, policy.defaultSignalTtlMs));
  const ageMs = Math.max(0, now - generatedAt);
  if (ageMs > ttlMs) {
    return { status: 'VETO', reason: 'SIGNAL_TTL_EXPIRED', generatedAt, ageMs, ttlMs };
  }
  const revalidatedAt = finite(raw.revalidatedAt);
  if (revalidatedAt == null) {
    return { status: 'NOT_AVAILABLE', reason: 'SIGNAL_REVALIDATION_REQUIRED', generatedAt, ageMs, ttlMs };
  }
  const revalidationAgeMs = Math.max(0, now - revalidatedAt);
  if (revalidationAgeMs > policy.maxRevalidationAgeMs) {
    return { status: 'VETO', reason: 'SIGNAL_REVALIDATION_STALE', generatedAt, ageMs, ttlMs, revalidatedAt, revalidationAgeMs };
  }
  return { status: 'PASS', reason: null, generatedAt, ageMs, ttlMs, revalidatedAt, revalidationAgeMs };
}

export function evaluateAntiChurn(raw = {}, policyInput = {}, nowInput = Date.now()) {
  const policy = resolvePolicy(policyInput);
  const now = finite(nowInput, Date.now());
  const lastExitAt = finite(raw.lastExitAt);
  const recentEntries = (Array.isArray(raw.recentEntries) ? raw.recentEntries : [])
    .map((row) => ({ at: finite(row?.at), direction: String(row?.direction ?? '').toUpperCase() }))
    .filter((row) => row.at != null && now - row.at >= 0 && now - row.at <= policy.churnWindowMs);
  const requestedDirection = String(raw.direction ?? '').toUpperCase();
  const sameDirectionEntries = recentEntries.filter((row) => row.direction === requestedDirection).length;

  const reasons = [];
  if (lastExitAt != null && now - lastExitAt < policy.reentryCooldownMs) reasons.push('REENTRY_COOLDOWN_ACTIVE');
  if (requestedDirection && sameDirectionEntries >= policy.maxSameDirectionEntriesInWindow) reasons.push('SAME_DIRECTION_CHURN_LIMIT_EXCEEDED');
  return {
    status: reasons.length ? 'VETO' : 'PASS',
    reasons,
    requestedDirection: requestedDirection || null,
    sameDirectionEntries,
    windowMs: policy.churnWindowMs,
    lastExitAt,
    cooldownRemainingMs: lastExitAt == null ? 0 : Math.max(0, policy.reentryCooldownMs - (now - lastExitAt)),
  };
}

export function evaluateGlobalKillSwitch(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const dailyDrawdownPct = Math.abs(finite(raw.dailyDrawdownPct, 0));
  const rollingDrawdownPct = Math.abs(finite(raw.rollingDrawdownPct, 0));
  const consecutiveExecutionErrors = Math.max(0, finite(raw.consecutiveExecutionErrors, 0));
  const reasons = [];
  if (dailyDrawdownPct >= policy.maxDailyDrawdownPct) reasons.push('DAILY_DRAWDOWN_KILL');
  if (rollingDrawdownPct >= policy.maxRollingDrawdownPct) reasons.push('ROLLING_DRAWDOWN_KILL');
  if (consecutiveExecutionErrors >= policy.maxConsecutiveExecutionErrors) reasons.push('EXECUTION_ERROR_KILL');
  if (raw.dataIntegrityCritical === true) reasons.push('DATA_INTEGRITY_KILL');
  if (raw.providerConsensusCritical === true) reasons.push('PROVIDER_CONSENSUS_KILL');
  if (raw.settlementMismatchCritical === true) reasons.push('SETTLEMENT_MISMATCH_KILL');
  if (raw.manualKill === true) reasons.push('MANUAL_KILL');
  if (raw.latchedKill === true) reasons.push('LATCHED_KILL_REQUIRES_EXPLICIT_RESET');

  return {
    state: reasons.length ? 'BLOCK_NEW_ENTRIES' : 'NORMAL',
    reasons: [...new Set(reasons)],
    dailyDrawdownPct,
    rollingDrawdownPct,
    consecutiveExecutionErrors,
    forcedLiquidationAuthority: false,
    cancelAuthority: false,
    orderAuthority: false,
    executionAuthority: 'NONE',
  };
}

export function evaluatePortfolioSafety(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const now = finite(raw.now, Date.now());
  const portfolio = evaluatePortfolioRisk(raw.portfolio ?? {}, policy);
  const expectedShortfall = evaluateExpectedShortfall(raw.expectedShortfall ?? {}, policy);
  const signalFreshness = evaluateSignalFreshness(raw.signal ?? {}, policy, now);
  const antiChurn = evaluateAntiChurn(raw.churn ?? {}, policy, now);
  const killSwitch = evaluateGlobalKillSwitch(raw.killSwitch ?? {}, policy);

  const vetoReasons = [];
  if (portfolio.status === 'VETO') vetoReasons.push(...portfolio.reasons);
  if (expectedShortfall.status === 'VETO') vetoReasons.push(expectedShortfall.reason);
  if (signalFreshness.status === 'VETO') vetoReasons.push(signalFreshness.reason);
  if (antiChurn.status === 'VETO') vetoReasons.push(...antiChurn.reasons);
  if (killSwitch.state === 'BLOCK_NEW_ENTRIES') vetoReasons.push(...killSwitch.reasons);

  const required = [portfolio.status, expectedShortfall.status, signalFreshness.status];
  const insufficientEvidence = policy.enforcement === 'REQUIRED_FOR_PARENT_GATE'
    && required.some((status) => status === 'NOT_AVAILABLE');
  const state = vetoReasons.length ? 'VETO' : insufficientEvidence ? 'INSUFFICIENT_EVIDENCE' : 'PASS';

  return {
    contract: 'market-intelligence-portfolio-safety/v1',
    policy,
    portfolio,
    expectedShortfall,
    signalFreshness,
    antiChurn,
    killSwitch,
    scanner: {
      mode: 'OBSERVE_ONLY',
      candidateDeletionAllowed: false,
    },
    autoTrading: {
      state,
      reasons: [...new Set(vetoReasons)],
      insufficientEvidence,
      newEntryAllowedByThisLayer: state === 'PASS' && killSwitch.state === 'NORMAL',
      parentGateStillRequired: true,
      orderAllowed: false,
      executionAuthority: 'NONE',
    },
    safety: {
      executionAuthority: 'NONE',
      privateTradingApiAllowed: false,
      realOrderAllowed: false,
      orderSubmissionAllowed: false,
      forcedLiquidationAllowed: false,
    },
  };
}
