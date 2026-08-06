import { SCANNER_MARKET_APPROVAL_PROFILES } from './scanner-market-action.service';
import type {
  ScannerChaseRisk,
  ScannerSignalCard,
} from './scanner-signal.types';

export const SCANNER_APPROVAL_POLICY_VERSION = 'market-approval-initial-v1';
export const SCANNER_APPROVAL_POLICY_STATUS = 'UNVALIDATED_INITIAL_POLICY' as const;
const FUTURE_CLOCK_SKEW_MS = 60_000;

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function chaseRisk(card: ScannerSignalCard): ScannerChaseRisk {
  if (!card.marketClass || !card.action || card.action === 'NONE') return 'UNAVAILABLE';
  const ceiling = SCANNER_MARKET_APPROVAL_PROFILES[card.marketClass].maxVolatilityPercent;
  if (card.changePercent == null || ceiling == null) return 'UNAVAILABLE';
  const directionalMove = card.action === 'BUY' || card.action === 'LONG'
    ? Math.max(0, card.changePercent)
    : Math.max(0, -card.changePercent);
  return directionalMove > ceiling ? 'ELEVATED' : 'LOW';
}

function requiredEvidenceFresh(card: ScannerSignalCard, key: string, now: number): boolean {
  const evidence = card.evidence.find((item) => item.key === key && item.status === 'matched');
  const observedAt = timestamp(evidence?.observedAt);
  const expiresAt = timestamp(card.expiresAt);
  return observedAt != null
    && observedAt <= now + FUTURE_CLOCK_SKEW_MS
    && expiresAt != null
    && observedAt < expiresAt;
}

export function applyScannerApprovalSafety(
  card: ScannerSignalCard,
  now = Date.now(),
): ScannerSignalCard {
  const failures: string[] = [];
  const observedAt = timestamp(card.observedAt);
  const expiresAt = timestamp(card.expiresAt);
  const risk = chaseRisk(card);
  const requiresExistingPosition = card.action === 'SELL';

  if (!card.marketClass || !card.action || card.action === 'NONE') failures.push('시장 행동 계약 미확정');
  if (card.dataState !== 'complete') failures.push(`데이터 상태 ${card.dataState} 승인 불가`);
  if (observedAt == null) failures.push('관측 시각 누락 또는 형식 오류');
  else if (observedAt > now + FUTURE_CLOCK_SKEW_MS) failures.push('관측 시각이 서버 시각보다 미래입니다.');
  if (expiresAt == null) failures.push('만료 시각 누락 또는 형식 오류');
  else if (expiresAt <= now) failures.push('신호가 만료되었습니다.');

  if (card.marketClass) {
    const profile = SCANNER_MARKET_APPROVAL_PROFILES[card.marketClass];
    if (profile.maxVolatilityPercent != null && card.volatilityPercent == null) failures.push('ATR 변동성 미확인');
    for (const key of profile.requiredEvidenceKeys) {
      if (!requiredEvidenceFresh(card, key, now)) failures.push(`필수 근거 ${key} 관측 시각 미확인`);
    }
  }
  if (risk === 'UNAVAILABLE') failures.push('급등·급락 추격 위험 미확인');
  else if (risk === 'ELEVATED') failures.push('급등·급락 추격 위험 상승');

  const warnings = [
    ...card.warnings,
    '승인 기준은 백테스트 검증 전 초기 보수 정책이며 수익률·승률을 보장하지 않습니다.',
    ...failures.map((failure) => `승인 안전 차단: ${failure}`),
  ];
  if (requiresExistingPosition) {
    warnings.push('SELL은 기존 보유 수량 축소·청산 전용이며 승인 직전 서버에서 보유 수량을 재검증해야 합니다.');
  }

  return {
    ...card,
    approvalPolicyVersion: SCANNER_APPROVAL_POLICY_VERSION,
    approvalPolicyStatus: SCANNER_APPROVAL_POLICY_STATUS,
    chaseRisk: risk,
    requiresExistingPosition,
    marketApprovalEligible: card.marketApprovalEligible === true && failures.length === 0,
    warnings: [...new Set(warnings)],
  };
}
