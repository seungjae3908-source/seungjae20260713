// Pure, read-only throughput/deadline admission forecast. Never an activation.
// Provider documentation is contextual: shared-IP quotas and host disk/inodes
// require independent operator evidence before changing a collector's pace.
import { assessMinuteManifestCapacity, assessMinuteArchiveCapacity } from './four-market-minute-roster-capacity-v1.mjs';
import { QUEUE_LIMITS, validateBackfillScope } from './four-market-minute-backfill-queue-v1.mjs';
import { MINUTE_ARCHIVE_LIMITS } from './four-market-minute-archive-intake-v1.mjs';

export const MINUTE_PACING_PREFLIGHT_CONTRACT_V1 =
  'research-minute-collector-pace-preflight/v1';
const bounded = (x, min, max) =>
  Number.isSafeInteger(x) && x >= min && x <= max;
const fail = reason => { throw new TypeError(reason); };
const frozen = x => Object.freeze(x);

/** Pessimistic SEQUENTIAL worker budget, never an operator quota approval. */
export function assessMinuteCollectorPacingPreflightV1({
  manifest,
  proposedActionsPerCycle = QUEUE_LIMITS.maxActionsPerCycle,
  cycleMinutes = 5,
  headroomPercent = 20,
  worstCaseRequestMs = MINUTE_ARCHIVE_LIMITS.networkTimeoutMs,
  requestSpacingMs = MINUTE_ARCHIVE_LIMITS.minRequestIntervalMs,
  lockChildTimeoutMs = 210_000,
  serviceTimeoutMs = 240_000,
  safeShutdownReserveMs = 15_000,
} = {}) {
  if (!bounded(proposedActionsPerCycle, 0, 1024)
    || !bounded(cycleMinutes, 1, 1440) || 1440 % cycleMinutes !== 0
    || !bounded(headroomPercent, 0, 200)
    || !bounded(worstCaseRequestMs, 100, 60_000)
    || !bounded(requestSpacingMs, 0, 60_000)
    || !bounded(lockChildTimeoutMs, 1_000, 600_000)
    || !bounded(serviceTimeoutMs, 1_000, 600_000)
    || !bounded(safeShutdownReserveMs, 0, 120_000))
    fail('MINUTE_PACING_PREFLIGHT_INPUT_INVALID');
  const limit = Math.min(lockChildTimeoutMs,
    serviceTimeoutMs, cycleMinutes * 60_000);
  if (safeShutdownReserveMs >= limit)
    fail('MINUTE_PACING_PREFLIGHT_TIME_RESERVE_INVALID');
  // Reject malformed/duplicate Backfill and Continuous tasks before they
  // influence an operator-facing forecast. This reads no queue state.
  const scope = validateBackfillScope(manifest);
  const declaredBackfill = scope.ranges.filter(r => r.mode === 'BACKFILL');
  const backfillPagesFromOrigin = windowMinutes => {
    const pages = declaredBackfill.reduce((sum, r) =>
      sum + Math.ceil((r.endMs - r.startMs) / (windowMinutes * 60_000)), 0);
    if (!Number.isSafeInteger(pages))
      fail('MINUTE_PACING_PREFLIGHT_BACKFILL_ESTIMATE_OVERFLOW');
    return pages;
  };
  const capacity = assessMinuteManifestCapacity(manifest, {
    actionsPerCycle: proposedActionsPerCycle,
    cycleMinutes, headroomPercent,
  });
  const usableMs = limit - safeShutdownReserveMs;
  const predictedRequestWorstCaseMs = proposedActionsPerCycle * worstCaseRequestMs
    + Math.max(0, proposedActionsPerCycle - 1) * requestSpacingMs;
  const maxSequentialActionsWithReserve = Math.max(0,
    Math.floor((usableMs + requestSpacingMs)
      / (worstCaseRequestMs + requestSpacingMs)));
  const actionsWithHeadroom = capacity.minActionsPerCycleWithHeadroom;
  const requiredWorstCaseMs = actionsWithHeadroom * worstCaseRequestMs
    + Math.max(0, actionsWithHeadroom - 1) * requestSpacingMs;
  // Merely a lower mathematical concurrency estimate. Real scheduling
  // needs IP quota, lock ordering, network and disk benchmarks first.
  const theoreticalConcurrentSlots = requiredWorstCaseMs === 0
    ? 0 : Math.ceil(requiredWorstCaseMs / usableMs);

  // Both public REST endpoints document up to 200 returned 1m candles, but
  // our immutable page writer / cursor / replay consumer accept only 120m.
  // This is an OFFLINE alternative estimate, never a runtime-cap change.
  const alternatePageMinutes = 200;
  const alternateCapacity = assessMinuteManifestCapacity(manifest, {
    actionsPerCycle: QUEUE_LIMITS.maxActionsPerCycle, cycleMinutes,
    headroomPercent, windowMinutes: alternatePageMinutes,
  });
  const alternateActions = alternateCapacity.minActionsPerCycleWithHeadroom;
  const alternateWorstMs = alternateActions * worstCaseRequestMs
    + Math.max(0, alternateActions - 1) * requestSpacingMs;
  const alternatePage200Scenario = frozen({
    contract: 'research-minute-collector-alternate-page-size/v1',
    status: 'HYPOTHETICAL_NOT_EXECUTABLE',
    pageMinutes: alternatePageMinutes,
    apiMaximumCandlesPerPage: 200,
    activeArchivePageMinutes: scope.pageWindowMinutes,
    maxOptionalArchivePageMinutes: MINUTE_ARCHIVE_LIMITS.maxWindowMinutes,
    requiresArchiveCursorRollupAndNativeReplayContractRevision: true,
    dailyRequiredPages: alternateCapacity.dailyRequired,
    dailyRequiredWithHeadroom: alternateCapacity.requiredWithHeadroom,
    minActionsPerCycleWithHeadroom: alternateActions,
    currentHardCapActionsPerCycle: QUEUE_LIMITS.maxActionsPerCycle,
    sequentialWorstCaseRequiredMs: alternateWorstMs,
    usableSequentialWorkerMs: usableMs,
    minTheoreticalConcurrentSlots: alternateWorstMs === 0
      ? 0 : Math.ceil(alternateWorstMs / usableMs),
    hardCapWouldBlock: alternateActions > QUEUE_LIMITS.maxActionsPerCycle,
    worstCaseDeadlineWouldBlock: alternateWorstMs > usableMs,
    stockExchangeSessionsAndRightsUnverified: alternateCapacity.stockSymbols > 0,
    declaredBackfillPagesFromOrigin: backfillPagesFromOrigin(alternatePageMinutes),
    providerRateBudgetVerified: false, hostCapacityVerified: false,
    continuityAndGapSemanticsVerified: false, enabled: false,
    operatorApproved: false, providerCalls: 0, filesWritten: 0,
    executionAuthority: 'NONE',
  });
  const reasons = [];
  if (capacity.stockSymbols > 0)
    reasons.push('STOCK_EXCHANGE_SESSION_AND_LICENSE_BUDGET_NOT_MODELLED');
  if (!capacity.cryptoSpotSymbols && !capacity.cryptoFuturesSymbols)
    reasons.push('NO_CONTINUOUS_CRYPTO_SOURCE');
  if (capacity.status === 'CAPACITY_MODEL_INSUFFICIENT')
    reasons.push('CONTINUOUS_DAY_CAPTURE_RATE_INSUFFICIENT');
  if (predictedRequestWorstCaseMs > usableMs)
    reasons.push('SEQUENTIAL_WORKER_DEADLINE_EXCEEDED');
  // Runtime still uses the old 16-action max: a proposal != configuration.
  if (proposedActionsPerCycle > QUEUE_LIMITS.maxActionsPerCycle)
    reasons.push('EXISTING_WORKER_HARD_CAP_NOT_CHANGED');
  reasons.push('PUBLIC_PROVIDER_SHARED_IP_BUDGET_NOT_ATTESTED');
  reasons.push('HOST_STORAGE_CPU_NETWORK_AND_BACKUP_NOT_ATTESTED');
  return frozen({
    contract: MINUTE_PACING_PREFLIGHT_CONTRACT_V1,
    status: 'OPERATOR_REVIEW_REQUIRED',
    actionable: false,
    reasons: frozen(reasons),
    proposedActionsPerCycle,
    actualRuntimeMaximumActionsPerCycle: QUEUE_LIMITS.maxActionsPerCycle,
    cycleMinutes, headroomPercent,
    observedRateOrHostMeasurementsProvided: false,
    capacity, usableSequentialWorkerMs: usableMs,
    conservativeWorstCaseRequestMs: worstCaseRequestMs,
    requestSpacingMs,
    proposedSequentialWorstCaseMs: predictedRequestWorstCaseMs,
    maxSequentialActionsWithReserve,
    minimumActionsPerCycleWithHeadroom: actionsWithHeadroom,
    requiredSequentialWorstCaseMs: requiredWorstCaseMs,
    theoreticalConcurrentSlots,
    declaredBackfillRanges: declaredBackfill.length,
    activeManifestPageMinutes:scope.pageWindowMinutes,
    declaredBackfillPagesFromOrigin: backfillPagesFromOrigin(
      scope.pageWindowMinutes),
    backfillQueueCursorAndCurrentOutstandingPagesNotInspected: true,
    alternatePage200Scenario,
    currentTimerActivated: false,
    providerRateBudgetVerified: false,
    sharedIpBudgetVerified: false,
    hostCapacityVerified: false,
    licensedStockSourceVerified: false,
    continuous24hProven: false,
    fourMarketCoverageProven: false,
    profitabilityProven: false,
    liveTrading: false, autoTrading: false,
    realOrders: false, privateAccountApiCalls: 0,
    providerCalls: 0, filesWritten: 0,
    executionAuthority: 'NONE',
  });
}

// DORMANT dual-venue plan: one bounded sequential lane per independent
// public provider, with the two lanes hypothetically overlapping in time.
// This is not a real host/API budget measurement or an enabled worker.
export function assessMinuteDualVenuePacingPreflightV1({
  manifest,
  perVenueActionsPerCycle = QUEUE_LIMITS.maxActionsPerCycle,
  cycleMinutes = 5,
  headroomPercent = 20,
  worstCaseRequestMs = MINUTE_ARCHIVE_LIMITS.networkTimeoutMs,
  requestSpacingMs = MINUTE_ARCHIVE_LIMITS.minRequestIntervalMs,
  lockChildTimeoutMs = 210_000,
  serviceTimeoutMs = 240_000,
  safeShutdownReserveMs = 15_000,
} = {}) {
  const entries = [
    ['perVenueActionsPerCycle',perVenueActionsPerCycle,1,QUEUE_LIMITS.maxActionsPerCycle],
    ['cycleMinutes',cycleMinutes,1,1440],
    ['headroomPercent',headroomPercent,0,200],
    ['worstCaseRequestMs',worstCaseRequestMs,100,60_000],
    ['requestSpacingMs',requestSpacingMs,0,60_000],
    ['lockChildTimeoutMs',lockChildTimeoutMs,1_000,600_000],
    ['serviceTimeoutMs',serviceTimeoutMs,1_000,600_000],
    ['safeShutdownReserveMs',safeShutdownReserveMs,0,120_000],
  ];
  if(entries.some(([,v,min,max])=>!bounded(v,min,max))||1440%cycleMinutes!==0)
    fail('MINUTE_DUAL_VENUE_PREFLIGHT_INPUT_INVALID');
  const scope=validateBackfillScope(manifest);
  const limit=Math.min(lockChildTimeoutMs,serviceTimeoutMs,cycleMinutes*60_000);
  if(safeShutdownReserveMs>=limit)
    fail('MINUTE_DUAL_VENUE_PREFLIGHT_RESERVE_INVALID');
  const usableMs=limit-safeShutdownReserveMs;
  const perLaneWorstCaseMs=perVenueActionsPerCycle*worstCaseRequestMs
    +Math.max(0,perVenueActionsPerCycle-1)*requestSpacingMs;
  const lanes=['CRYPTO_SPOT','CRYPTO_FUTURES'].map(market=>{
    const continuousCount=scope.ranges.filter(r=>r.market===market
      &&r.mode==='CONTINUOUS').length;
    const capacity=assessMinuteArchiveCapacity({
      cryptoSpotSymbols:market==='CRYPTO_SPOT'?continuousCount:0,
      cryptoFuturesSymbols:market==='CRYPTO_FUTURES'?continuousCount:0,
      actionsPerCycle:perVenueActionsPerCycle,cycleMinutes,
      windowMinutes:scope.pageWindowMinutes,headroomPercent,
    });
    return frozen({
      market,source:market==='CRYPTO_SPOT'?'UPBIT_PUBLIC_1M'
        :'BITGET_PUBLIC_FUTURES_1M',
      continuousSymbols:continuousCount,
      dailyRequired:capacity.dailyRequired,
      dailyRequiredWithHeadroom:capacity.requiredWithHeadroom,
      dailyAvailable:capacity.dailyAvailable,
      minimumActionsPerCycleWithHeadroom:capacity.minActionsPerCycleWithHeadroom,
      modeledLaneRateSufficient:continuousCount>0
        && capacity.status==='CAPACITY_MODEL_POSSIBLE',
      perVenueActionsPerCycle,perLaneWorstCaseMs,
      fitsConservativeDeadline:perLaneWorstCaseMs<=usableMs,
      actualSharedIpQuotaVerified:false,
      actualHostLatencyAndIOVerified:false,
    });
  });
  const stockRanges=scope.ranges.filter(r=>
    r.market==='KR_STOCK'||r.market==='US_STOCK').length;
  const modeledCapacityPossible=stockRanges===0
    && lanes.every(l=>l.modeledLaneRateSufficient
      &&l.fitsConservativeDeadline);
  const reasons=[];
  if(stockRanges)reasons.push('STOCK_SOURCE_SESSIONS_AND_LICENSE_NOT_MODELLED');
  if(lanes.some(l=>!l.continuousSymbols))
    reasons.push('BOTH_INDEPENDENT_CRYPTO_PROVIDERS_REQUIRED');
  if(lanes.some(l=>!l.modeledLaneRateSufficient))
    reasons.push('SINGLE_VENUE_RATE_CAPACITY_INSUFFICIENT');
  if(perLaneWorstCaseMs>usableMs)
    reasons.push('SINGLE_VENUE_DEADLINE_EXCEEDED');
  reasons.push('SHARED_IP_REMAINING_QUOTA_UNVERIFIED');
  reasons.push('VULTR_HOST_CPU_STORAGE_INODES_BACKUP_UNVERIFIED');
  reasons.push('LIVE_WORKER_DUAL_LANE_NOT_ENABLED');
  return frozen({
    contract:'research-minute-dual-venue-pacing-preflight/v1',
    status:'DRAFT_THEORETICAL_ONLY',actionable:false,
    modeledCapacityPossible,
    pageWindowMinutes:scope.pageWindowMinutes,
    cycleMinutes,headroomPercent,perVenueActionsPerCycle,
    maxConcurrentIndependentProviders:2,
    modeledTotalActionsPerCycle:perVenueActionsPerCycle*2,
    conservativeUsableWorkerMs:usableMs,
    modeledWallClockWorstCaseMs:perLaneWorstCaseMs,
    stockRanges,lanes:frozen(lanes),reasons:frozen(reasons),
    automaticActivation:false,workerEnabled:false,
    providerCalls:0,filesWritten:0,hostAttested:false,
    independentOosProven:false,profitabilityProven:false,
    executionAuthority:'NONE',
  });
}
