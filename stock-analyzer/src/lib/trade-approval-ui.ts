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
  EXPLICIT_CANCEL_CONFIRMATION_REQUIRED: '주문 취소는 사용자 확인 후에만 처리할 수 있습니다.',
  EXPLICIT_AMEND_CONFIRMATION_REQUIRED: '주문 정정은 사용자 확인 후에만 처리할 수 있습니다.',
  CANCEL_EXECUTION_DISABLED: '실주문 서버게이트가 꺼져 있어 Provider 취소를 보내지 않았습니다.',
  CANCEL_CONNECTION_UNAVAILABLE: '실전 거래 연결을 확인할 수 없어 취소를 보내지 않았습니다.',
  LIVE_ACCOUNT_REQUIRED_FOR_PROVIDER_AMEND: '실전 계좌 주문만 Provider 정정을 사용할 수 있습니다.',
  AMEND_CONNECTION_UNAVAILABLE: '실전 거래 연결을 확인할 수 없어 정정을 보내지 않았습니다.',
  PARTIAL_FILL_AMEND_REQUIRES_CANCEL_AND_REPLAN: '부분체결 주문은 잔량 취소 후 새 계획으로 다시 검증해야 합니다.',
  ORDER_NOT_AMENDABLE: '현재 주문 상태에서는 정정할 수 없습니다.',
  ORDER_NOT_CANCELABLE: '현재 주문 상태에서는 취소할 수 없습니다.',
  AMEND_PRICE_EXCEEDS_APPROVED_RISK_ENVELOPE: '정정 가격이 승인된 위험범위를 벗어나 차단됐습니다.',
  AMEND_QUANTITY_INCREASE_NOT_ALLOWED: '정정으로 주문 수량을 늘릴 수 없습니다.',
  US_STOCK_AMEND_QUANTITY_NOT_SUPPORTED: '미국주식 주문은 가격만 정정할 수 있습니다.',
  TRADE_ORDER_NOT_FOUND: '주문을 찾지 못했습니다. 주문상태를 다시 불러와 주세요.',
  CAPABILITY_REQUIRED: '실전 주문 준비 권한이 필요합니다.',
  LIVE_DRAFT_APPROVAL_ENVELOPE_REQUIRED: '실전 진입초안 요청 형식이 올바르지 않습니다.',
  CLIENT_LIVE_DRAFT_AUTHORITY_FORBIDDEN: '브라우저가 수량·레버리지·Risk 같은 실행권한 값을 지정할 수 없습니다.',
  SCANNER_SOURCE_NOT_EXECUTION_ELIGIBLE: '현재 Scanner 신호가 실전 초안 검토 조건을 충족하지 못했습니다.',
  SCANNER_LIVE_PRICE_PLAN_REQUIRED: '진입구간·손절·목표가 근거가 완전하지 않아 실전 초안을 만들지 않았습니다.',
  SCANNER_AND_CONDITIONS_NOT_MAINTAINED: '선택했던 Scanner 조건이 더 이상 유지되지 않습니다.',
  PAPER_SOURCE_NOT_RESOLVABLE: '원본 Scanner 신호가 만료됐거나 현재 서버에서 확인되지 않습니다.',
  PAPER_SOURCE_STALE: '원본 Scanner 신호가 오래되어 다시 검색해야 합니다.',
  PAPER_SOURCE_CODE_SHA_MISMATCH: 'Scanner 신호가 현재 앱 버전과 달라 다시 검색해야 합니다.',
  EXPLICIT_EXIT_APPROVAL_REQUIRED: '종료 승인은 사용자가 직접 확인해야 합니다.',
  EXIT_APPROVAL_BLOCKED: '실전 거래 연결 또는 서버게이트가 준비되지 않아 종료 승인을 진행할 수 없습니다.',
  EXIT_APPROVAL_PLAN_EXPIRED: '종료 승인계획이 만료됐습니다. 실계좌를 다시 확인해 새 계획을 만들어 주세요.',
  EXIT_APPROVAL_PLAN_ID_MISMATCH: '종료 승인계획 식별자가 일치하지 않아 다시 검증해야 합니다.',
  EXIT_APPROVAL_PLAN_STALE_OR_POSITION_CHANGED: '보유수량이나 방향이 변경되어 종료계획을 다시 만들어야 합니다.',
  EXIT_APPROVAL_ACCOUNT_SNAPSHOT_NOT_FRESH: '실계좌 최신 상태를 확인하지 못해 종료 승인을 잠갔습니다.',
  EXPLICIT_EXIT_RISK_RECHECK_REQUIRED: '주문시점 위험 재검증은 사용자가 직접 확인해야 합니다.',
  EXIT_RISK_APPROVAL_INTENT_EXPIRED: '종료 승인 유효시간이 지나 다시 승인해야 합니다.',
  EXIT_RISK_APPROVAL_STALE_OR_POSITION_CHANGED: '보유수량이나 방향이 바뀌어 종료 승인을 다시 검증해야 합니다.',
  EXIT_RISK_PROVIDER_OPEN_ORDERS_UNAVAILABLE: 'Provider 미체결 주문을 확인하지 못해 종료를 잠갔습니다.',
  EXIT_RISK_PROVIDER_OPEN_ORDER_PRESENT: '같은 종목의 미체결 주문이 있어 종료 실행 준비를 잠갔습니다.',
  EXIT_RISK_EMERGENCY_STOP_ACTIVE: '긴급정지가 활성화되어 종료 실행 준비가 차단됐습니다.',
  EXIT_RISK_ACCOUNT_EVIDENCE_STALE: '실계좌 근거가 오래되어 주문시점 위험을 다시 확인해야 합니다.',
  EXPLICIT_EXIT_PREFLIGHT_REQUIRED: '실행 직전 Preflight는 사용자가 직접 확인해야 합니다.',
  EXIT_PREFLIGHT_RISK_INTENT_EXPIRED: '주문시점 위험검증 유효시간이 지나 다시 검증해야 합니다.',
  EXIT_PREFLIGHT_PRIOR_RISK_NOT_PASSED: '주문시점 위험검증을 통과하지 않아 실행 직전 검사를 진행할 수 없습니다.',
  EXIT_PREFLIGHT_RISK_INTENT_ID_MISMATCH: '주문시점 위험검증 식별자가 일치하지 않아 다시 검증해야 합니다.',
  EXIT_PREFLIGHT_ACCOUNT_SNAPSHOT_NOT_FRESH: '실행 직전 실계좌 상태를 최신으로 확인하지 못했습니다.',
  EXIT_PREFLIGHT_POSITION_CHANGED: '실행 직전에 보유수량이나 방향이 바뀌어 종료계획을 다시 만들어야 합니다.',
  EXIT_PREFLIGHT_CURRENT_PRICE_UNAVAILABLE: '실행 직전 현재가격을 확인하지 못해 주문을 준비하지 않았습니다.',
  EXIT_PREFLIGHT_PROVIDER_OPEN_ORDERS_UNAVAILABLE: '실행 직전 Provider 미체결 주문을 확인하지 못했습니다.',
  EXIT_PREFLIGHT_PROVIDER_OPEN_ORDER_PRESENT: '같은 종목의 미체결 주문이 있어 실행 직전 검사를 차단했습니다.',
  EXIT_PREFLIGHT_EMERGENCY_STOP_ACTIVE: '긴급정지가 활성화되어 실행 직전 검사가 차단됐습니다.',
  EXIT_PREFLIGHT_ACCOUNT_EVIDENCE_STALE: '실행 직전 실계좌 근거가 오래되어 다시 조회해야 합니다.',
  EXPLICIT_EXIT_SUBMISSION_GATE_CONFIRMATION_REQUIRED: '최종 제출 게이트 확인은 사용자가 직접 눌러야 합니다.',
  EXIT_SUBMISSION_GATE_PACKAGE_EXPIRED: '최종 실행 패키지가 만료되어 Preflight부터 다시 확인해야 합니다.',
  EXIT_SUBMISSION_GATE_PACKAGE_NOT_READY: '최종 실행 패키지가 준비되지 않아 제출 게이트를 열지 않았습니다.',
  EXIT_SUBMISSION_GATE_PACKAGE_ID_MISMATCH: '최종 실행 패키지 식별자가 일치하지 않아 제출을 잠갔습니다.',
  EXIT_SUBMISSION_GATE_EMERGENCY_STOP_ACTIVE: '긴급정지가 활성화되어 제출 게이트가 잠겼습니다.',
  DRAFT_PROVIDER_SUBMISSION_NOT_AUTHORIZED: '현재는 Draft 검증 범위라 실제 Provider 주문 제출이 허용되지 않습니다.',
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
