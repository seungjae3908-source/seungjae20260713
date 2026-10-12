import type { TradingPlanInput, TradingPlan, TradingPolicy } from './trade-automation.types';

const serverReason = (reason: string) => {
  const value = reason.trim();
  return value === 'CANONICAL_LIVE_AUTO_HANDOFF'
    || value.startsWith('AUTO_EXIT_ENTRY_PLAN:') || value.startsWith('PILOT_DYNAMIC_CAP_V1:');
};

/** Browser-supplied data cannot confer canonical AUTO ownership or a worker
 * identity. Trusted background producers use the internal service, not HTTP. */
export function assertPublicLivePlanOrigin(input: TradingPlanInput & { executionMode?: unknown }) {
  if (input.accountMode !== 'live') return;
  if (input.executionMode !== undefined && input.executionMode !== 'manual'
    || !Array.isArray(input.signalReasons)
    || input.signalReasons.some((reason) => typeof reason !== 'string' || serverReason(reason))) {
    throw new Error('PUBLIC_AUTOMATIC_LIVE_ORIGIN_FORBIDDEN');
  }
}

/** An AUTO-enabled saved policy must not automatically execute an HTTP-created
 * Live plan. This request-local copy does not turn AUTO off or change any cap,
 * stop, credential, member permission or durable account policy. */
export function publicPlanPolicy(input: TradingPlanInput, policy: TradingPolicy): TradingPolicy {
  assertPublicLivePlanOrigin(input);
  return input.accountMode === 'live' ? { ...policy, mode: 'approval', automaticEnabled: false } : policy;
}

export function assertPublicPlanApprovalOrigin(plan: TradingPlan) {
  if (plan.accountMode === 'live' && (plan.executionMode === 'automatic'
    || plan.signalReasons.some(serverReason))) throw new Error('AUTOMATIC_LIVE_BACKGROUND_EXECUTION_REQUIRED');
}
