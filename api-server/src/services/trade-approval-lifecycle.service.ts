import type { TradingOrder, TradingPlan } from './trade-automation.types';

export const APPROVAL_ORDER_LIFECYCLE_STATES = [
  'signal_received',
  'risk_review',
  'plan_created',
  'awaiting_user_approval',
  'approved',
  'rejected',
  'expired',
  'submitting',
  'partially_filled',
  'filled',
  'cancel_requested',
  'cancelled',
  'failed',
  'condition_invalidated',
  'exit_planned',
  'closed',
] as const;

export type ApprovalOrderLifecycleState = typeof APPROVAL_ORDER_LIFECYCLE_STATES[number];

const TRANSITIONS: Record<ApprovalOrderLifecycleState, readonly ApprovalOrderLifecycleState[]> = {
  signal_received: ['risk_review', 'condition_invalidated', 'rejected', 'expired'],
  risk_review: ['plan_created', 'condition_invalidated', 'rejected', 'expired'],
  plan_created: ['awaiting_user_approval', 'condition_invalidated', 'rejected', 'expired'],
  awaiting_user_approval: ['approved', 'condition_invalidated', 'rejected', 'expired'],
  approved: ['submitting', 'condition_invalidated', 'expired'],
  rejected: [],
  expired: [],
  submitting: ['partially_filled', 'filled', 'cancel_requested', 'condition_invalidated', 'failed'],
  partially_filled: ['partially_filled', 'filled', 'cancel_requested', 'condition_invalidated', 'failed'],
  filled: ['exit_planned', 'closed'],
  cancel_requested: ['cancelled', 'partially_filled', 'filled', 'failed'],
  cancelled: ['closed'],
  failed: [],
  condition_invalidated: ['cancel_requested', 'exit_planned', 'closed'],
  exit_planned: ['awaiting_user_approval', 'closed'],
  closed: [],
};

export function canTransitionApprovalOrderLifecycle(
  from: ApprovalOrderLifecycleState,
  to: ApprovalOrderLifecycleState,
) {
  return TRANSITIONS[from].includes(to);
}

export function assertApprovalOrderLifecycleTransition(
  from: ApprovalOrderLifecycleState,
  to: ApprovalOrderLifecycleState,
) {
  if (!canTransitionApprovalOrderLifecycle(from, to)) {
    throw new Error(`INVALID_APPROVAL_ORDER_LIFECYCLE_TRANSITION:${from}:${to}`);
  }
}

export function deriveApprovalOrderLifecycleState(
  plan: TradingPlan,
  order: TradingOrder | null = null,
): ApprovalOrderLifecycleState {
  if (order) {
    if (order.state === 'CANCELED') return 'cancelled';
    if (order.state === 'CANCEL_REQUESTED') return 'cancel_requested';
    if (order.state === 'FILLED') return 'filled';
    if (order.state === 'PARTIALLY_FILLED') return 'partially_filled';
    if (order.state === 'REJECTED' || order.state === 'RECOVERY_REQUIRED') return 'failed';
    if (order.state === 'SUBMITTED' || order.state === 'ACCEPTED') return 'submitting';
  }
  if (plan.signalState === 'INVALIDATED') return 'condition_invalidated';
  if (plan.state === 'EXPIRED' || plan.signalState === 'EXPIRED') return 'expired';
  if (plan.state === 'REJECTED') return 'rejected';
  if (plan.state === 'APPROVAL_PENDING') return 'awaiting_user_approval';
  if (plan.approvedAt) return 'approved';
  return 'plan_created';
}
