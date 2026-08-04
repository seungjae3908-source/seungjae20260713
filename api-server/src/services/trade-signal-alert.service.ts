import { approvalStatus } from './trade-signal-lifecycle.service';
import type {
  TradingApprovalStatus,
  TradingPlan,
  TradingSignalState,
  TradingSignalStateEvent,
} from './trade-automation.types';

export type TradeSignalAlertKind =
  | 'CONDITION_MET'
  | 'CONDITION_MAINTAINED'
  | 'CONDITION_RELEASED'
  | 'SIGNAL_EXPIRED';

export type TradeSignalAlert = {
  id: string;
  planId: string;
  signalId: string;
  symbol: string;
  market: string;
  exchange: string;
  kind: TradeSignalAlertKind;
  cycle: number;
  title: string;
  message: string;
  eventState: TradingSignalState;
  currentSignalState: TradingSignalState;
  approvalEnabled: boolean;
  approvalReasonCode: string | null;
  approvalExpiresAt: string | null;
  score: number;
  confidence: number;
  reasonCode: string;
  createdAt: string;
};

function releasedState(state: TradingSignalState) {
  return state === 'WEAKENED' || state === 'INVALIDATED' || state === 'EXPIRED';
}

function scoreText(event: TradingSignalStateEvent) {
  return `점수 ${Math.round(event.score)} · 신뢰도 ${Math.round(event.confidence)}%`;
}

function safeHistory(plan: TradingPlan) {
  return [...(plan.signalStateHistory ?? [])]
    .filter((event) => Number.isFinite(Date.parse(event.createdAt)))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function alertBase(
  plan: TradingPlan,
  event: TradingSignalStateEvent,
  approval: TradingApprovalStatus,
  kind: TradeSignalAlertKind,
  cycle: number,
  title: string,
  message: string,
  suffix: string,
): TradeSignalAlert {
  return {
    id: `${plan.id}:${cycle}:${suffix}`,
    planId: plan.id,
    signalId: plan.signalId,
    symbol: plan.symbol,
    market: plan.market,
    exchange: plan.exchange,
    kind,
    cycle,
    title,
    message,
    eventState: event.toState,
    currentSignalState: plan.signalState,
    approvalEnabled: approval.approvalEnabled,
    approvalReasonCode: approval.reasonCode,
    approvalExpiresAt: approval.expiresAt,
    score: event.score,
    confidence: event.confidence,
    reasonCode: event.reason,
    createdAt: event.createdAt,
  };
}

export function deriveTradeSignalAlerts(plan: TradingPlan, now = new Date()): TradeSignalAlert[] {
  const approval = approvalStatus(plan, now);
  const history = safeHistory(plan);
  const alerts: TradeSignalAlert[] = [];
  let cycle = 0;
  let ready = false;
  let maintainedSent = false;

  for (const event of history) {
    if (event.toState === 'READY_FOR_APPROVAL') {
      if (!ready) {
        cycle += 1;
        ready = true;
        maintainedSent = false;
        alerts.push(alertBase(
          plan,
          event,
          approval,
          'CONDITION_MET',
          cycle,
          `${plan.symbol} 조건 최초 충족`,
          `${scoreText(event)} · 승인 전 서버 최종검증 필요`,
          'met',
        ));
      } else if (!maintainedSent) {
        maintainedSent = true;
        alerts.push(alertBase(
          plan,
          event,
          approval,
          'CONDITION_MAINTAINED',
          cycle,
          `${plan.symbol} 조건 유지 확인`,
          `${scoreText(event)} · 현재 조건 유지 중`,
          'maintained',
        ));
      }
      continue;
    }

    if (ready && releasedState(event.toState)) {
      const expired = event.toState === 'EXPIRED';
      alerts.push(alertBase(
        plan,
        event,
        approval,
        expired ? 'SIGNAL_EXPIRED' : 'CONDITION_RELEASED',
        cycle,
        expired ? `${plan.symbol} 신호 만료` : `${plan.symbol} 조건 해제`,
        `${event.reason} · 주문 승인 불가`,
        expired ? 'expired' : 'released',
      ));
      ready = false;
      maintainedSent = false;
    }
  }

  // A plan may expire by wall clock before a monitor writes an EXPIRED event.
  // Surface exactly one deterministic expiry alert and keep approval disabled.
  const signalExpired = Number.isFinite(Date.parse(plan.signalExpiresAt))
    && Date.parse(plan.signalExpiresAt) <= now.getTime();
  const hasExpiryAlert = alerts.some((alert) => alert.kind === 'SIGNAL_EXPIRED');
  if (signalExpired && !hasExpiryAlert) {
    const event: TradingSignalStateEvent = {
      fromState: plan.signalState,
      toState: 'EXPIRED',
      reason: 'SIGNAL_EXPIRED',
      score: plan.signalScore,
      confidence: plan.signalConfidence,
      coreConditionsMaintained: false,
      riskReward: plan.signalRiskReward,
      dataTimestamp: plan.lastSignalValidatedAt,
      createdAt: plan.signalExpiresAt,
    };
    alerts.push(alertBase(
      plan,
      event,
      { ...approval, approvalEnabled: false, reasonCode: 'SIGNAL_EXPIRED' },
      'SIGNAL_EXPIRED',
      Math.max(1, cycle),
      `${plan.symbol} 신호 만료`,
      '승인 가능 시간이 지나 주문 승인 불가',
      'expired',
    ));
  }

  return alerts.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function listTradeSignalAlerts(plans: TradingPlan[], now = new Date(), limit = 100) {
  return plans
    .flatMap((plan) => deriveTradeSignalAlerts(plan, now))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, Math.max(1, Math.min(500, limit)));
}
