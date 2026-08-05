import type { TradingOrderState } from './trade-automation.types';

const TRANSITIONS: Record<TradingOrderState, readonly TradingOrderState[]> = {
  PLANNED: ['APPROVAL_PENDING', 'SUBMITTED', 'REJECTED', 'EXPIRED'],
  APPROVAL_PENDING: ['SUBMITTED', 'REJECTED', 'EXPIRED'],
  SUBMITTED: ['ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'REJECTED', 'RECOVERY_REQUIRED'],
  ACCEPTED: ['PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'REJECTED', 'RECOVERY_REQUIRED'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'RECOVERY_REQUIRED'],
  FILLED: [],
  CANCEL_REQUESTED: ['CANCEL_REQUESTED', 'CANCELED', 'PARTIALLY_FILLED', 'FILLED', 'RECOVERY_REQUIRED'],
  CANCELED: [],
  REJECTED: [],
  EXPIRED: [],
  RECOVERY_REQUIRED: ['RECOVERY_REQUIRED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'CANCELED', 'REJECTED'],
};

export function canTransitionOrder(from: TradingOrderState, to: TradingOrderState) {
  return TRANSITIONS[from].includes(to);
}

export function assertOrderTransition(from: TradingOrderState, to: TradingOrderState) {
  if (!canTransitionOrder(from, to)) {
    throw new Error(`INVALID_ORDER_STATE_TRANSITION:${from}:${to}`);
  }
}

export function isTerminalOrderState(state: TradingOrderState) {
  return ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(state);
}
