export const AUTO_TRADING_LIVE_SAFETY_RELEASE = Object.freeze({
  releaseMode: 'PREPARATION_ONLY' as const,
  liveActivationIncluded: false,
  liveTrading: false,
  realOrderCount: 0,
  realCancelCount: 0,
  privateTradingApiCount: 0,
  credentialsAcceptedByRuntime: false,
  signedPrivateRequestsAllowed: false,
  activationRequiresSeparateRelease: true,
});

export type LiveSafetyGateName =
  | 'operatorManualApproval'
  | 'exchangePermissionAudit'
  | 'protectiveStopPlan'
  | 'liquidationGuard'
  | 'orderReconciliation'
  | 'cancelReconciliation'
  | 'positionReconciliation'
  | 'killSwitchPersistence'
  | 'restartRecovery'
  | 'idempotency'
  | 'mockCanary'
  | 'exactHeadCi';

export type LiveSafetyGateInput = Record<LiveSafetyGateName, boolean>;

export interface LiveSafetyReadiness {
  releaseMode: 'PREPARATION_ONLY';
  preparationComplete: boolean;
  liveActivationAllowed: false;
  liveTrading: false;
  realOrderCount: 0;
  realCancelCount: 0;
  privateTradingApiCount: 0;
  activationRequiresSeparateRelease: true;
  unmetGates: LiveSafetyGateName[];
}

const LIVE_SAFETY_GATES: readonly LiveSafetyGateName[] = [
  'operatorManualApproval',
  'exchangePermissionAudit',
  'protectiveStopPlan',
  'liquidationGuard',
  'orderReconciliation',
  'cancelReconciliation',
  'positionReconciliation',
  'killSwitchPersistence',
  'restartRecovery',
  'idempotency',
  'mockCanary',
  'exactHeadCi',
];

export function evaluateLiveSafetyReadiness(input: LiveSafetyGateInput): LiveSafetyReadiness {
  const unmetGates = LIVE_SAFETY_GATES.filter((gate) => input[gate] !== true);
  return {
    releaseMode: 'PREPARATION_ONLY',
    preparationComplete: unmetGates.length === 0,
    liveActivationAllowed: false,
    liveTrading: false,
    realOrderCount: 0,
    realCancelCount: 0,
    privateTradingApiCount: 0,
    activationRequiresSeparateRelease: true,
    unmetGates,
  };
}

export function assertLiveActivationBlocked(): never {
  throw new Error('AUTO_TRADING_LIVE_ACTIVATION_NOT_INCLUDED');
}

export interface ProtectiveStopPlanInput {
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  stopPrice: number;
  markPrice: number;
}

export type ProtectiveStopPlan =
  | {
      status: 'READY_FOR_MOCK_VALIDATION';
      source: 'PLANNING_ONLY';
      triggerDirection: 'BELOW_MARK' | 'ABOVE_MARK';
      stopDistancePercent: number;
      stopBeforeAdverseMove: boolean;
    }
  | {
      status: 'UNAVAILABLE';
      source: 'PLANNING_ONLY';
      reason: string;
    };

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function buildProtectiveStopPlan(input: ProtectiveStopPlanInput): ProtectiveStopPlan {
  if (![input.entryPrice, input.stopPrice, input.markPrice].every(finitePositive)) {
    return { status: 'UNAVAILABLE', source: 'PLANNING_ONLY', reason: 'INVALID_PRICE_INPUT' };
  }

  const long = input.direction === 'LONG';
  const stopBeforeAdverseMove = long
    ? input.stopPrice < input.entryPrice && input.stopPrice < input.markPrice
    : input.stopPrice > input.entryPrice && input.stopPrice > input.markPrice;

  if (!stopBeforeAdverseMove) {
    return { status: 'UNAVAILABLE', source: 'PLANNING_ONLY', reason: 'STOP_NOT_PROTECTIVE' };
  }

  return {
    status: 'READY_FOR_MOCK_VALIDATION',
    source: 'PLANNING_ONLY',
    triggerDirection: long ? 'BELOW_MARK' : 'ABOVE_MARK',
    stopDistancePercent: Math.abs((input.stopPrice - input.entryPrice) / input.entryPrice) * 100,
    stopBeforeAdverseMove: true,
  };
}

export interface MockExecutionRecord {
  signalId: string;
  executionId: string;
  idempotencyKey: string;
  state: string;
}

export interface MockReconciliationResult {
  status: 'MATCH' | 'SAFE_HALT';
  duplicateSignal: boolean;
  duplicateExecution: boolean;
  duplicateIdempotencyKey: boolean;
  reason: string | null;
}

export function reconcileMockExecution(
  candidate: MockExecutionRecord,
  persisted: readonly MockExecutionRecord[],
): MockReconciliationResult {
  const duplicateSignal = persisted.some((row) => row.signalId === candidate.signalId);
  const duplicateExecution = persisted.some((row) => row.executionId === candidate.executionId);
  const duplicateIdempotencyKey = persisted.some((row) => row.idempotencyKey === candidate.idempotencyKey);
  const duplicate = duplicateSignal || duplicateExecution || duplicateIdempotencyKey;

  return {
    status: duplicate ? 'SAFE_HALT' : 'MATCH',
    duplicateSignal,
    duplicateExecution,
    duplicateIdempotencyKey,
    reason: duplicate ? 'DUPLICATE_EXECUTION_IDENTITY' : null,
  };
}

export interface RestartSafetyInput {
  persistedSafeHalt: boolean;
  persistedKillSwitch: boolean;
  reconciliationHealthy: boolean;
  idempotencyStateRestored: boolean;
}

export interface RestartSafetyResult {
  workerMayEvaluatePaperShadow: boolean;
  safeHalt: boolean;
  killSwitch: boolean;
  liveActivationAllowed: false;
  reason: string | null;
}

export function evaluateRestartSafety(input: RestartSafetyInput): RestartSafetyResult {
  const safeHalt = input.persistedSafeHalt
    || input.persistedKillSwitch
    || !input.reconciliationHealthy
    || !input.idempotencyStateRestored;

  return {
    workerMayEvaluatePaperShadow: !safeHalt,
    safeHalt,
    killSwitch: input.persistedKillSwitch,
    liveActivationAllowed: false,
    reason: safeHalt ? 'RESTART_REQUIRES_SAFE_STATE' : null,
  };
}
