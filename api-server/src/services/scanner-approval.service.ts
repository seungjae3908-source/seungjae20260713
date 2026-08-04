import { randomUUID } from 'node:crypto';
import type { TradingPlanInput } from './trade-automation.types';
import type {
  ScannerApprovalGuard,
  ScannerApprovalPolicy,
  ScannerEntryLeg,
  ScannerRiskLevel,
  ScannerScoreBreakdown,
  ScannerSignalCandidate,
  ScannerSignalState,
  ScannerTradingSignal,
} from './scanner-approval.types';

const DEFAULT_POLICY: ScannerApprovalPolicy = {
  minimumScore: 60,
  minimumConfidence: 55,
  maximumRiskScore: 65,
  maximumOrderKrw: 1_000_000,
  accountValueKrw: 1_000_000,
  maximumDataAgeMs: 30_000,
  maximumDataDelayMs: 5_000,
  maximumSpreadPercent: 1,
  maximumOneMinuteDropPercent: 5,
  minimumRiskReward: 1.2,
};
const SCORE_KEYS: Array<keyof ScannerScoreBreakdown> = [
  'trend', 'volume', 'liquidity', 'technical', 'market', 'news', 'financial', 'riskPenalty',
];

function clamp(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function positive(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function uniqueText(value: unknown, maximum = 30) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, maximum);
}

function roundPrice(value: number, market: ScannerSignalCandidate['market']) {
  return market === 'KR' ? Math.max(1, Math.round(value)) : Math.max(0.01, Math.round(value * 100) / 100);
}

function safeTimestamp(value: unknown, fallback: string) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function normalizeBreakdown(candidate: ScannerSignalCandidate): ScannerScoreBreakdown {
  const source = candidate.scoreBreakdown ?? {};
  const fallbackScore = clamp(candidate.score, 0, 100, 50);
  const defaults: ScannerScoreBreakdown = {
    trend: fallbackScore * 0.2,
    volume: fallbackScore * 0.15,
    liquidity: fallbackScore * 0.1,
    technical: fallbackScore * 0.2,
    market: fallbackScore * 0.1,
    news: fallbackScore * 0.1,
    financial: fallbackScore * 0.15,
    riskPenalty: -clamp(candidate.riskScore, 0, 100, 35) * 0.2,
  };
  const output = { ...defaults };
  for (const key of SCORE_KEYS) {
    const raw = Number(source[key]);
    if (Number.isFinite(raw)) output[key] = clamp(raw, key === 'riskPenalty' ? -100 : 0, 100, defaults[key]);
  }
  return output;
}

function deriveRisk(candidate: ScannerSignalCandidate, policy: ScannerApprovalPolicy): ScannerRiskLevel {
  const explicit = String(candidate.riskLevel ?? '').toUpperCase();
  const riskScore = clamp(candidate.riskScore, 0, 100, explicit === 'HIGH' ? 75 : 35);
  if (explicit === 'BLOCKED' || riskScore > policy.maximumRiskScore) return 'BLOCKED';
  if (explicit === 'HIGH' || riskScore >= 60) return 'HIGH';
  if (explicit === 'MEDIUM' || riskScore >= 35) return 'MEDIUM';
  return 'LOW';
}

function buildLegs(candidate: ScannerSignalCandidate, price: number): ScannerEntryLeg[] {
  const supplied = Array.isArray(candidate.entryPrices) ? candidate.entryPrices.filter((value) => Number.isFinite(value) && value > 0) : [];
  const prices = [
    supplied[0] ?? price,
    supplied[1] ?? price * 0.985,
    supplied[2] ?? price * 0.97,
  ];
  const allocations = [40, 35, 25] as const;
  return prices.map((value, index) => ({
    sequence: (index + 1) as 1 | 2 | 3,
    price: roundPrice(value, candidate.market),
    allocationRate: allocations[index],
    status: 'PLANNED' as const,
  }));
}

function riskReward(price: number, stop: number, target: number) {
  const risk = price - stop;
  const reward = target - price;
  if (!(risk > 0) || !(reward > 0)) return null;
  return Math.round((reward / risk) * 100) / 100;
}

function signalId(candidate: ScannerSignalCandidate, generatedAt: string) {
  const compactTime = generatedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
  const symbol = String(candidate.symbol ?? '').trim().toUpperCase().replace(/[^A-Z0-9._-]/g, '').slice(0, 20);
  return `scanner-${candidate.market}-${symbol}-${compactTime}`;
}

export function normalizeScannerApprovalPolicy(value: Partial<ScannerApprovalPolicy> = {}): ScannerApprovalPolicy {
  return {
    minimumScore: clamp(value.minimumScore, 0, 100, DEFAULT_POLICY.minimumScore),
    minimumConfidence: clamp(value.minimumConfidence, 0, 100, DEFAULT_POLICY.minimumConfidence),
    maximumRiskScore: clamp(value.maximumRiskScore, 0, 100, DEFAULT_POLICY.maximumRiskScore),
    maximumOrderKrw: clamp(value.maximumOrderKrw, 5_000, 1_000_000_000, DEFAULT_POLICY.maximumOrderKrw),
    accountValueKrw: clamp(value.accountValueKrw, 10_000, 10_000_000_000, DEFAULT_POLICY.accountValueKrw),
    maximumDataAgeMs: clamp(value.maximumDataAgeMs, 1_000, 300_000, DEFAULT_POLICY.maximumDataAgeMs),
    maximumDataDelayMs: clamp(value.maximumDataDelayMs, 0, 60_000, DEFAULT_POLICY.maximumDataDelayMs),
    maximumSpreadPercent: clamp(value.maximumSpreadPercent, 0.01, 10, DEFAULT_POLICY.maximumSpreadPercent),
    maximumOneMinuteDropPercent: clamp(value.maximumOneMinuteDropPercent, 0.5, 30, DEFAULT_POLICY.maximumOneMinuteDropPercent),
    minimumRiskReward: clamp(value.minimumRiskReward, 0.1, 10, DEFAULT_POLICY.minimumRiskReward),
  };
}

function guardForStates(
  signal: ScannerTradingSignal,
  allowedStates: ScannerSignalState[],
  policyInput: Partial<ScannerApprovalPolicy> = {},
): ScannerApprovalGuard {
  const policy = normalizeScannerApprovalPolicy(policyInput);
  const reasons: string[] = [];
  const now = Date.now();
  const dataTime = Date.parse(signal.dataTimestamp);
  if (!allowedStates.includes(signal.state)) reasons.push(`SIGNAL_STATE_${signal.state}`);
  if (signal.score < policy.minimumScore) reasons.push('SCORE_BELOW_MINIMUM');
  if (signal.confidence < policy.minimumConfidence) reasons.push('CONFIDENCE_BELOW_MINIMUM');
  if (signal.riskLevel === 'HIGH' || signal.riskLevel === 'BLOCKED') reasons.push('RISK_LEVEL_BLOCKED');
  if (!Number.isFinite(dataTime) || now - dataTime > policy.maximumDataAgeMs) reasons.push('MARKET_DATA_STALE');
  if (Date.parse(signal.expiresAt) <= now) reasons.push('SIGNAL_EXPIRED');
  if (signal.expectedRiskReward == null || signal.expectedRiskReward < policy.minimumRiskReward) reasons.push('RISK_REWARD_BELOW_MINIMUM');
  const missing = signal.selectedConditions.filter((condition) => !signal.matchedSignals.includes(condition));
  if (missing.length) reasons.push('SELECTED_CONDITION_MISSING');
  return { enabled: reasons.length === 0, reasons, checkedAt: new Date().toISOString() };
}

export function approvalGuard(signal: ScannerTradingSignal, policyInput: Partial<ScannerApprovalPolicy> = {}): ScannerApprovalGuard {
  return guardForStates(signal, ['READY_FOR_APPROVAL', 'APPROVAL_SENT'], policyInput);
}

export function continuationGuard(signal: ScannerTradingSignal, policyInput: Partial<ScannerApprovalPolicy> = {}): ScannerApprovalGuard {
  return guardForStates(signal, ['APPROVED'], policyInput);
}

export function createScannerSignal(
  candidate: ScannerSignalCandidate,
  policyInput: Partial<ScannerApprovalPolicy> = {},
  nowInput = new Date(),
): ScannerTradingSignal {
  const policy = normalizeScannerApprovalPolicy(policyInput);
  const now = new Date(nowInput);
  const generatedAt = now.toISOString();
  const symbol = String(candidate.symbol ?? '').trim().toUpperCase();
  if (!symbol) throw new Error('SCANNER_SYMBOL_REQUIRED');
  const price = positive(candidate.currentPrice, 0);
  if (!(price > 0)) throw new Error('SCANNER_PRICE_REQUIRED');
  const score = clamp(candidate.score, 0, 100, 50);
  const confidence = clamp(candidate.confidence, 0, 100, Math.min(95, Math.max(20, score)));
  const selectedConditions = uniqueText(candidate.selectedConditions);
  const matchedSignals = uniqueText(candidate.matchedSignals);
  const dataTimestamp = safeTimestamp(candidate.dataTimestamp ?? candidate.marketSnapshot?.observedAt, generatedAt);
  const expiresAt = safeTimestamp(candidate.expiresAt, new Date(now.getTime() + 10 * 60_000).toISOString());
  const stopLoss = roundPrice(positive(candidate.stopLoss, price * 0.96), candidate.market);
  const suppliedTargets = Array.isArray(candidate.targetPrices)
    ? candidate.targetPrices.filter((value) => Number.isFinite(value) && value > price)
    : [];
  const targets = [
    suppliedTargets[0] ?? price * 1.06,
    suppliedTargets[1] ?? price * 1.1,
  ].map((target, index) => ({ price: roundPrice(target, candidate.market), exitRate: index === 0 ? 50 : 50 }));
  const expectedRiskReward = Number.isFinite(Number(candidate.expectedRiskReward))
    ? clamp(candidate.expectedRiskReward, 0, 100, 0)
    : riskReward(price, stopLoss, targets[0].price);
  const riskLevel = deriveRisk(candidate, policy);
  const missingConditions = selectedConditions.filter((condition) => !matchedSignals.includes(condition));
  let state: ScannerSignalState = 'READY_FOR_APPROVAL';
  const warnings = uniqueText(candidate.warnings);
  if (score < policy.minimumScore || confidence < policy.minimumConfidence || missingConditions.length) state = 'WATCHING';
  if (riskLevel === 'HIGH' || riskLevel === 'BLOCKED') state = 'INVALIDATED';
  if (expectedRiskReward == null || expectedRiskReward < policy.minimumRiskReward) state = 'WATCHING';
  const snapshot = candidate.marketSnapshot ?? {};
  if (snapshot.halted === true
    || clamp(snapshot.dataDelayMs, 0, 1_000_000, 0) > policy.maximumDataDelayMs
    || clamp(snapshot.spreadPercent, 0, 100, 0) > policy.maximumSpreadPercent
    || clamp(snapshot.oneMinuteMovePercent, -100, 100, 0) <= -policy.maximumOneMinuteDropPercent) {
    state = 'INVALIDATED';
  }
  const changedConditions = [...missingConditions];
  const transitionReason = state === 'READY_FOR_APPROVAL'
    ? 'ALL_APPROVAL_CONDITIONS_MET'
    : state === 'INVALIDATED'
      ? 'RISK_OR_MARKET_GUARD_BLOCKED'
      : 'WAITING_FOR_SCORE_CONFIDENCE_OR_CONDITIONS';
  const signal: ScannerTradingSignal = {
    id: signalId(candidate, generatedAt),
    assetType: 'stock',
    market: candidate.market,
    symbol,
    displayName: String(candidate.displayName ?? symbol).trim() || symbol,
    direction: state === 'INVALIDATED' ? 'WATCH' : 'LONG',
    timeframe: String(candidate.timeframe ?? '1D').trim() || '1D',
    score,
    confidence,
    riskLevel,
    scoreBreakdown: normalizeBreakdown(candidate),
    selectedConditions,
    matchedSignals,
    reasons: uniqueText(candidate.reasons),
    warnings,
    currentPrice: roundPrice(price, candidate.market),
    entryPlan: { legs: buildLegs(candidate, price) },
    targets,
    stopLoss,
    expectedRiskReward,
    estimatedMaxLoss: Number.isFinite(Number(candidate.estimatedMaxLoss))
      ? clamp(candidate.estimatedMaxLoss, 0, policy.maximumOrderKrw, 0)
      : Math.round(policy.maximumOrderKrw * Math.max(0, (price - stopLoss) / price)),
    state,
    transitions: [{
      from: null,
      to: state,
      changedAt: generatedAt,
      currentPrice: roundPrice(price, candidate.market),
      previousScore: null,
      currentScore: score,
      reason: transitionReason,
      changedConditions,
      dataTimestamp,
    }],
    generatedAt,
    expiresAt,
    dataTimestamp,
  };
  return signal;
}

export function revalidateScannerSignal(
  previous: ScannerTradingSignal,
  candidate: ScannerSignalCandidate,
  policyInput: Partial<ScannerApprovalPolicy> = {},
  nowInput = new Date(),
) {
  const policy = normalizeScannerApprovalPolicy(policyInput);
  const nextBase = createScannerSignal({
    ...candidate,
    market: previous.market === 'US' ? 'US' : 'KR',
    symbol: previous.symbol,
    displayName: previous.displayName,
    selectedConditions: previous.selectedConditions,
    expiresAt: previous.expiresAt,
  }, policy, nowInput);
  let nextState = nextBase.state;
  const changedConditions = previous.matchedSignals.filter((condition) => !nextBase.matchedSignals.includes(condition));
  const scoreDrop = previous.score - nextBase.score;
  if (Date.parse(previous.expiresAt) <= new Date(nowInput).getTime()) nextState = 'EXPIRED';
  else if (nextBase.state === 'INVALIDATED'
    || nextBase.score < policy.minimumScore - 10
    || scoreDrop >= 20
    || changedConditions.length >= Math.max(2, Math.ceil(previous.selectedConditions.length / 2))) nextState = 'INVALIDATED';
  else if (nextBase.state !== 'READY_FOR_APPROVAL' || scoreDrop >= 8 || changedConditions.length > 0) nextState = 'WEAKENED';
  else if (previous.state === 'APPROVED') nextState = 'APPROVED';
  else if (previous.state === 'APPROVAL_SENT') nextState = 'APPROVAL_SENT';
  else nextState = 'READY_FOR_APPROVAL';
  const reason = nextState === 'READY_FOR_APPROVAL' ? 'SIGNAL_CONDITIONS_MAINTAINED'
    : nextState === 'WEAKENED' ? 'SIGNAL_CONDITIONS_WEAKENED'
      : nextState === 'EXPIRED' ? 'SIGNAL_EXPIRED'
        : 'SIGNAL_INVALIDATED';
  const legs = nextBase.entryPlan.legs.map((leg, index) => ({
    ...leg,
    status: previous.entryPlan.legs[index]?.status ?? leg.status,
  }));
  if (nextState === 'INVALIDATED' || nextState === 'EXPIRED') {
    for (const leg of legs) if (leg.status !== 'FILLED') leg.status = 'CANCELLED';
  }
  const next: ScannerTradingSignal = {
    ...nextBase,
    id: previous.id,
    generatedAt: previous.generatedAt,
    state: nextState,
    entryPlan: { legs },
    transitions: [...previous.transitions, {
      from: previous.state,
      to: nextState,
      changedAt: new Date(nowInput).toISOString(),
      currentPrice: nextBase.currentPrice,
      previousScore: previous.score,
      currentScore: nextBase.score,
      reason,
      changedConditions,
      dataTimestamp: nextBase.dataTimestamp,
    }],
  };
  return { signal: next, guard: approvalGuard(next, policy) };
}

export function updateScannerEntryLeg(
  signal: ScannerTradingSignal,
  sequence: 1 | 2 | 3,
  status: ScannerEntryLeg['status'],
  reason: string,
  nowInput = new Date(),
): ScannerTradingSignal {
  const current = signal.entryPlan.legs.find((leg) => leg.sequence === sequence);
  if (!current || current.status === status) return signal;
  const changedAt = nowInput.toISOString();
  return {
    ...signal,
    entryPlan: {
      legs: signal.entryPlan.legs.map((leg) => leg.sequence === sequence ? { ...leg, status } : leg),
    },
    transitions: [...signal.transitions, {
      from: signal.state,
      to: signal.state,
      changedAt,
      currentPrice: signal.currentPrice,
      previousScore: signal.score,
      currentScore: signal.score,
      reason,
      changedConditions: [`ENTRY_LEG_${sequence}_${status}`],
      dataTimestamp: signal.dataTimestamp,
    }],
  };
}

export function cancelPendingScannerEntries(
  signal: ScannerTradingSignal,
  reason = 'SIGNAL_INVALIDATED_CANCEL_REMAINING_ENTRIES',
  nowInput = new Date(),
): ScannerTradingSignal {
  let next = signal;
  for (const leg of signal.entryPlan.legs) {
    if (leg.status !== 'FILLED' && leg.status !== 'CANCELLED') {
      next = updateScannerEntryLeg(next, leg.sequence, 'CANCELLED', reason, nowInput);
    }
  }
  return next;
}

export function scannerSignalToPaperPlan(
  signal: ScannerTradingSignal,
  policyInput: Partial<ScannerApprovalPolicy> = {},
  marketSnapshot: ScannerSignalCandidate['marketSnapshot'] = {},
  entrySequence: 1 | 2 | 3 = 1,
  parentPlanId: string | null = null,
): TradingPlanInput {
  const policy = normalizeScannerApprovalPolicy(policyInput);
  const guard = entrySequence === 1 ? approvalGuard(signal, policy) : continuationGuard(signal, policy);
  if (!guard.enabled) throw new Error(`SCANNER_SIGNAL_NOT_APPROVABLE:${guard.reasons.join(',')}`);
  const leg = signal.entryPlan.legs.find((item) => item.sequence === entrySequence);
  if (!leg || leg.status === 'FILLED' || leg.status === 'CANCELLED') throw new Error('SCANNER_ENTRY_LEG_NOT_AVAILABLE');
  const approvedTotalKrw = policy.maximumOrderKrw;
  const legAmountKrw = Math.max(1, Math.floor(approvedTotalKrw * leg.allocationRate / 100));
  const quantity = Math.max(1, Math.floor(legAmountKrw / Math.max(1, leg.price)));
  const observedAt = safeTimestamp(marketSnapshot?.observedAt ?? signal.dataTimestamp, signal.dataTimestamp);
  const previousAllocationRate = signal.entryPlan.legs
    .filter((item) => item.sequence < entrySequence && item.status === 'FILLED')
    .reduce((sum, item) => sum + item.allocationRate, 0);
  const accountValueKrw = Math.max(approvedTotalKrw, policy.accountValueKrw);
  const existingExposurePercent = approvedTotalKrw * previousAllocationRate / 100 / accountValueKrw * 100;
  return {
    exchange: 'kiwoom',
    accountMode: 'paper',
    strategyId: 'scanner-approval-v1',
    signalId: entrySequence === 1 ? signal.id : `${signal.id}:leg:${entrySequence}`,
    symbol: signal.symbol,
    market: signal.market,
    side: 'buy',
    orderType: 'limit',
    quantity,
    quoteAmount: legAmountKrw,
    limitPrice: leg.price,
    estimatedKrw: legAmountKrw,
    stopPrice: signal.stopLoss ?? signal.currentPrice * 0.96,
    targetPrices: signal.targets.map((target) => target.price),
    splitRatios: [100],
    leverage: null,
    marginMode: null,
    reduceOnly: false,
    invalidateAction: 'hold',
    signalReasons: signal.reasons.length ? signal.reasons : signal.matchedSignals,
    marketSnapshot: {
      observedAt,
      dataDelayMs: clamp(marketSnapshot?.dataDelayMs, 0, 1_000_000, 0),
      oneMinuteMovePercent: clamp(marketSnapshot?.oneMinuteMovePercent, -100, 100, 0),
      spreadPercent: clamp(marketSnapshot?.spreadPercent, 0, 100, 0.1),
      orderbookGapPercent: clamp(marketSnapshot?.orderbookGapPercent, 0, 100, 0.2),
      halted: marketSnapshot?.halted === true,
      availableBalance: approvedTotalKrw,
      accountValueKrw,
      dailyPnlPercent: 0,
      assetExposurePercent: existingExposurePercent,
      openPositionCount: entrySequence === 1 ? 0 : 1,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
    },
    scannerSignal: signal,
    scannerApprovedTotalKrw: approvedTotalKrw,
    scannerEntryLegSequence: entrySequence,
    scannerParentPlanId: parentPlanId,
    approvalNonce: randomUUID(),
  };
}
