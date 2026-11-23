import { authorizedFetch } from '@/lib/auth-fetch';

export type ExecutionTruthPhase = 'STABLE' | 'RECONCILING' | 'MANUAL_REVIEW' | 'TERMINAL';
export type ExecutionSubmissionOutcome = 'NOT_ATTEMPTED' | 'UNKNOWN' | 'PROVIDER_IDENTIFIED' | 'TERMINAL_CONFIRMED';

export type TradeExecutionLedgerEntry = {
  orderId:string;
  planId:string;
  exchange:'upbit'|'bitget'|'kiwoom'|'toss';
  market:string|null;
  symbol:string|null;
  clientOrderId:string;
  exchangeOrderId:string|null;
  orderState:string;
  truthPhase:ExecutionTruthPhase;
  submissionOutcome:ExecutionSubmissionOutcome;
  requestedQuantity:number|null;
  filledQuantity:number;
  remainingQuantity:number|null;
  averageFillPrice:number|null;
  partialFillPreserved:boolean;
  providerStatusCode:string|null;
  lastReconciledAt:string|null;
  manualReviewRequired:boolean;
  safeToResubmit:boolean;
  cancellationIntent:boolean;
  submissionAttemptId:string|null;
  submissionStartedAt:string|null;
  orderedAt:string;
  updatedAt:string;
  latestEventAt:string|null;
  latestEventReason:string|null;
  latestEventState:string|null;
  lastErrorCode:string|null;
  retryCount:number;
  nextRetryAt:string|null;
  protectionStatus:string;
  protectionErrorCode:string|null;
  eventCount:number;
  integrityBlockers:string[];
  canonicalSource:'trade_orders+trade_order_events+trade_order_plans';
  readOnly:true;
  providerMutationAllowed:false;
};

export type TradeExecutionLedgerSnapshot = {
  ok:true;
  generatedAt:string;
  summary:{
    total:number;
    stable:number;
    reconciling:number;
    manualReview:number;
    terminal:number;
    integrityBlocked:number;
    unknownSubmission:number;
  };
  entries:TradeExecutionLedgerEntry[];
  canonicalSource:'trade_orders+trade_order_events+trade_order_plans';
  readOnly:true;
  providerMutationAllowed:false;
  orderSubmitted:false;
  orderCanceled:false;
  orderAmended:false;
  privateTradingRequestSent:false;
};

function safeError(body: unknown) {
  if (body && typeof body === 'object') {
    const value = body as { message?:unknown; code?:unknown };
    if (typeof value.message === 'string' && value.message.length <= 240) return value.message;
    if (typeof value.code === 'string' && value.code.length <= 80) return value.code;
  }
  return '주문 실행 원장을 불러오지 못했습니다.';
}

export function executionLedgerAttentionEntries(snapshot: TradeExecutionLedgerSnapshot) {
  return snapshot.entries
    .filter((entry) => entry.orderState !== 'FILLED' || entry.filledQuantity <= 0)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export async function getTradeExecutionLedger(signal?: AbortSignal) {
  const response = await authorizedFetch('/api/trade-automation/execution-ledger', { signal });
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok
    || !raw
    || typeof raw !== 'object'
    || !('ok' in raw)
    || raw.ok !== true) {
    throw new Error(safeError(raw));
  }

  const body = raw as TradeExecutionLedgerSnapshot;
  if (body.readOnly !== true
    || body.providerMutationAllowed !== false
    || body.orderSubmitted !== false
    || body.orderCanceled !== false
    || body.orderAmended !== false
    || body.privateTradingRequestSent !== false
    || body.canonicalSource !== 'trade_orders+trade_order_events+trade_order_plans'
    || !Array.isArray(body.entries)) {
    throw new Error('주문 실행 원장의 안전 계약을 확인하지 못했습니다.');
  }
  for (const entry of body.entries) {
    if (entry.readOnly !== true
      || entry.providerMutationAllowed !== false
      || entry.canonicalSource !== 'trade_orders+trade_order_events+trade_order_plans') {
      throw new Error('주문 실행 원장 항목의 안전 계약을 확인하지 못했습니다.');
    }
  }
  return body;
}
