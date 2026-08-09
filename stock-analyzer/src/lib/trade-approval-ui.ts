export type TradeApprovalAccountMode = 'paper' | 'mock' | 'live';
export type TradeApprovalSide = 'buy' | 'sell' | 'long' | 'short';

const APPROVAL_MESSAGES: Record<string, string> = {
  PLAN_NOT_APPROVAL_PENDING: '이미 처리됐거나 승인 대기 상태가 아닙니다.',
  SIGNAL_WATCHING: '아직 진입 조건을 확인 중입니다.',
  SIGNAL_WEAKENED: '신호가 약해져 최신 조건 확인 전까지 승인할 수 없습니다.',
  SIGNAL_INVALIDATED: '핵심 진입 조건이 깨져 승인이 차단됐습니다.',
  SIGNAL_EXPIRED: '신호 유효시간이 지났습니다.',
  APPROVAL_EXPIRED: '승인 가능 시간이 지났습니다.',
  SIGNAL_REVALIDATION_REQUIRED: '최신 시장 데이터 재검증이 필요합니다.',
  SIGNAL_CORE_CONDITION_BROKEN: '핵심 진입 조건이 더 이상 유지되지 않습니다.',
  SIGNAL_DATA_STALE: '시장 데이터가 오래되어 다시 확인해야 합니다.',
  SIGNAL_DATA_TIMESTAMP_INVALID: '시장 데이터 시각을 확인하지 못했습니다.',
  SIGNAL_DATA_FROM_FUTURE: '시장 데이터 시각이 비정상이라 승인을 차단했습니다.',
  SIGNAL_RISK_REWARD_BELOW_MINIMUM: '예상 손익비가 허용 기준보다 낮습니다.',
  SIGNAL_SCORE_BELOW_MINIMUM: 'AI 점수가 승인 기준보다 낮아졌습니다.',
  SIGNAL_CONFIDENCE_BELOW_MINIMUM: '신뢰도가 승인 기준보다 낮아졌습니다.',
  TRADE_PLAN_EXPIRED: '승인 가능 시간이 지나 계획이 만료됐습니다.',
  TRADE_PLAN_NOT_APPROVAL_PENDING: '이미 처리됐거나 승인 대기 상태가 아닙니다.',
  TRADE_PLAN_RISK_RECHECK_FAILED: '서버 최종 위험검사에서 주문이 차단됐습니다.',
  EXPLICIT_APPROVAL_REQUIRED: '명시적인 주문 승인이 필요합니다.',
  LOGIN_REQUIRED: '로그인이 만료됐습니다. 다시 로그인해 주세요.',
  ADMIN_REQUIRED: '이 기능을 사용할 권한이 없습니다.',
  SIGNAL_MONITOR_UNAUTHORIZED: '신호 상태를 확인할 권한이 없습니다.',
  TRADE_AUTOMATION_STORAGE_UNAVAILABLE: '승인 정보를 불러오는 저장소에 연결할 수 없습니다.',
  EXCHANGE_TIMEOUT: '거래소 응답 시간이 초과되어 주문 상태를 다시 확인해야 합니다.',
  EXCHANGE_NETWORK_ERROR: '거래소 통신 상태를 확인하지 못했습니다.',
  LIVE_EXECUTION_DISABLED: '실전 주문은 현재 비활성화되어 있습니다.',
  EMERGENCY_STOP_ACTIVE: '긴급정지가 활성화되어 신규 주문이 차단됐습니다.',
};

const ORDER_STATE_LABELS: Record<string, string> = {
  PLANNED: '계획 검토 중',
  APPROVAL_PENDING: '승인 대기',
  SUBMITTED: '주문 접수 확인 중',
  ACCEPTED: '거래소 접수',
  PARTIALLY_FILLED: '일부 체결',
  FILLED: '체결 완료',
  CANCEL_REQUESTED: '취소 요청 확인 중',
  CANCELED: '취소 완료',
  REJECTED: '주문 거절',
  EXPIRED: '만료',
  RECOVERY_REQUIRED: '주문 상태 재확인 필요',
};

export function approvalMessage(code: string | null | undefined, fallback?: string | null) {
  if (code && APPROVAL_MESSAGES[code]) return APPROVAL_MESSAGES[code];
  if (fallback && APPROVAL_MESSAGES[fallback]) return APPROVAL_MESSAGES[fallback];
  if (!code && !fallback) return '조건 유지가 확인돼 승인할 수 있습니다.';
  return '현재 상태를 확인하지 못했습니다. 새로고침 후 다시 확인해 주세요.';
}

export function safeTradeErrorMessage(code: string | null | undefined, fallback: string) {
  if (!code) return fallback;
  return APPROVAL_MESSAGES[code] ?? '요청을 처리하지 못했습니다. 최신 상태를 다시 확인해 주세요.';
}

export function orderStateLabel(state: string | null | undefined) {
  if (!state) return '확인 중';
  return ORDER_STATE_LABELS[state] ?? '상태 재확인 필요';
}

export function sideLabel(side: TradeApprovalSide) {
  if (side === 'buy') return '매수';
  if (side === 'sell') return '매도';
  if (side === 'long') return '롱';
  return '숏';
}

export function accountModeLabel(mode: TradeApprovalAccountMode) {
  if (mode === 'paper') return 'Paper 모의';
  if (mode === 'mock') return '증권사 모의';
  return '실전 차단';
}

export function orderTypeLabel(type: 'market' | 'limit') {
  return type === 'market' ? '시장가' : '지정가';
}

export function approvalCountdown(expiresAt: string | null | undefined, now = Date.now()) {
  const parsed = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return { label: '남은 시간 확인 불가', seconds: 0, expired: true, warning: true };
  }
  const seconds = Math.max(0, Math.ceil((parsed - now) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return {
    label: seconds <= 0
      ? '승인 만료'
      : `남은 시간 ${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`,
    seconds,
    expired: seconds <= 0,
    warning: seconds <= 60,
  };
}
