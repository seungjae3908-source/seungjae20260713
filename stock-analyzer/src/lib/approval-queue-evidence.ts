import type { ApprovalStatus, ApprovalStatusResponse, TradeApprovalQueueItem } from '../components/trade-approval-queue';
import { evidenceInstant, evidenceNumber, evidenceRecord } from './server-evidence';

const member = (value: unknown, allowed: string[]) => typeof value === 'string' && allowed.includes(value);
const signalStates = ['WATCHING', 'READY_FOR_APPROVAL', 'WEAKENED', 'INVALIDATED', 'EXPIRED'];
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const nullableText = (value: unknown) => value === null || typeof value === 'string';
const nullableNumber = (value: unknown) => value === null || evidenceNumber(value);
const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const numbers = (value: unknown) => Array.isArray(value) && value.every(evidenceNumber);
const nullableTime = (value: unknown) => value === null || evidenceInstant(value);

function validApproval(value: unknown, now: number): value is ApprovalStatus {
  if (!evidenceRecord(value)) return false;
  return typeof value.approvalEnabled === 'boolean'
    && member(value.signalState, signalStates) && nonempty(value.planState)
    && nullableText(value.reasonCode) && nullableTime(value.expiresAt)
    && evidenceInstant(value.lastValidatedAt, now)
    && (!value.approvalEnabled || (value.signalState === 'READY_FOR_APPROVAL'
      && value.planState === 'APPROVAL_PENDING' && evidenceInstant(value.expiresAt)));
}

function validItem(value: unknown, now: number): value is TradeApprovalQueueItem {
  if (!evidenceRecord(value) || !validApproval(value.approval, now)) return false;
  if (!['id', 'strategyId', 'signalId', 'symbol', 'market', 'state'].every((key) => nonempty(value[key]))
    || !member(value.exchange, ['bitget', 'upbit', 'kiwoom'])
    || !member(value.accountMode, ['paper', 'mock', 'live'])
    || !member(value.side, ['buy', 'sell', 'long', 'short'])
    || !member(value.orderType, ['market', 'limit'])
    || !evidenceNumber(value.estimatedKrw) || value.estimatedKrw < 0
    || !evidenceNumber(value.stopPrice) || value.stopPrice <= 0
    || !['quantity', 'limitPrice', 'leverage', 'signalScore', 'signalConfidence', 'signalRiskReward'].every((key) => nullableNumber(value[key]))
    || !numbers(value.targetPrices) || !numbers(value.splitRatios)
    || !strings(value.signalReasons) || !strings(value.signalWarnings)
    || !member(value.signalState, signalStates)
    || !nullableText(value.signalInvalidationReason)
    || !nullableTime(value.approvalExpiresAt) || !evidenceInstant(value.updatedAt, now)) return false;
  if (value.approval.approvalEnabled && (value.state !== value.approval.planState
    || value.signalState !== value.approval.signalState || value.approvalExpiresAt !== value.approval.expiresAt)) return false;
  if (value.order === null) return true;
  return evidenceRecord(value.order) && nonempty(value.order.state)
    && evidenceNumber(value.order.filledQuantity) && value.order.filledQuantity >= 0
    && evidenceInstant(value.order.updatedAt, now) && nullableText(value.order.lastErrorCode);
}

export function parseApprovalQueue(value: unknown, now = Date.now()): { items: TradeApprovalQueueItem[]; updatedAt: string } {
  if (!evidenceRecord(value) || value.ok !== true || !Array.isArray(value.items)
    || value.count !== value.items.length || !evidenceInstant(value.updatedAt, now)
    || now - Date.parse(value.updatedAt) > 30_000
    || !value.items.every((item) => validItem(item, now))
    || new Set(value.items.map((item) => item.id)).size !== value.items.length) {
    throw new Error('APPROVAL_QUEUE_INVALID_EVIDENCE');
  }
  return { items: value.items, updatedAt: value.updatedAt };
}

export function parseApprovalStatus(value: unknown, now = Date.now()): ApprovalStatusResponse {
  if (!evidenceRecord(value) || value.ok !== true || !validApproval(value.approval, now)
    || now - Date.parse(value.approval.lastValidatedAt) > 30_000) {
    throw new Error('SIGNAL_REVALIDATION_REQUIRED');
  }
  const plan = value.plan;
  if (plan !== undefined && (!evidenceRecord(plan) || !nonempty(plan.state)
    || !member(plan.signalState, signalStates) || !nullableText(plan.signalInvalidationReason)
    || !nullableTime(plan.approvalExpiresAt) || !evidenceInstant(plan.updatedAt, now)
    || plan.state !== value.approval.planState || plan.signalState !== value.approval.signalState
    || plan.approvalExpiresAt !== value.approval.expiresAt)) throw new Error('SIGNAL_REVALIDATION_REQUIRED');
  return value as ApprovalStatusResponse;
}
