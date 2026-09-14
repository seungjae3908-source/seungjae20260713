import type { Rating, RiskLevel, HealthLevel, SignalTone } from '@/lib/api';

export const RATING_KO: Record<Rating, string> = {
  STRONG_BUY: '적극 매수',
  BUY: '매수',
  HOLD: '보통',
  SELL: '매도',
  STRONG_SELL: '적극 매도',
};

export type Tone = 'positive' | 'warning' | 'destructive' | 'neutral';

export function ratingTone(r: Rating): Tone {
  if (r === 'STRONG_BUY' || r === 'BUY') return 'positive';
  if (r === 'HOLD') return 'warning';
  return 'destructive';
}

export const RISK_KO: Record<RiskLevel, string> = { LOW: '낮음', MEDIUM: '보통', HIGH: '높음' };

export function riskTone(l: RiskLevel): Tone {
  return l === 'HIGH' ? 'destructive' : l === 'MEDIUM' ? 'warning' : 'positive';
}

export const HEALTH_KO: Record<HealthLevel, string> = {
  STRONG: '양호',
  AVERAGE: '보통',
  WEAK: '취약',
};

export function healthTone(l: HealthLevel): Tone {
  return l === 'STRONG' ? 'positive' : l === 'AVERAGE' ? 'warning' : 'destructive';
}

export function signalTone(t: SignalTone): Tone {
  return t === 'positive' ? 'positive' : t === 'negative' ? 'destructive' : 'warning';
}

export const USER_MARKET_KO: Readonly<Record<string, string>> = {
  KR: '국내주식',
  KR_STOCK: '국내주식',
  US: '미국주식',
  US_STOCK: '미국주식',
  CRYPTO_SPOT: '코인현물',
  CRYPTO_FUTURES: '코인선물',
};

export const USER_DIRECTION_KO: Readonly<Record<string, string>> = {
  BUY: '매수',
  SELL: '매도',
  LONG: '롱',
  SHORT: '숏',
  NO_TRADE: '거래 안 함',
};

export const USER_STATUS_KO: Readonly<Record<string, string>> = {
  NOT_STARTED: '시작 전',
  RUNNING: '진행 중',
  IN_PROGRESS: '진행 중',
  PASS: '통과',
  SUCCESS: '정상',
  FAIL: '실패',
  FAILED: '실패',
  FAILURE: '실패',
  BLOCKED: '차단됨',
  BLOCKED_DATA: '데이터 부족으로 차단',
  EVIDENCE_REQUIRED: '근거 필요',
  INSUFFICIENT_SAMPLE: '표본 부족',
  STALE: '오래된 정보',
  INVALIDATED: '무효화',
  MISSING: '미수집',
  UNKNOWN: '확인 불가',
  READY: '준비됨',
  NOT_READY: '준비 안 됨',
  AVAILABLE: '사용 가능',
  UNAVAILABLE: '사용 불가',
  PARTIAL: '일부 수집',
  COMPLETE: '완료',
};

export const PROMOTION_STAGE_KO: Readonly<Record<string, string>> = {
  RESEARCH_DESIGN: '연구 설계',
  HISTORICAL_BACKTEST: '과거검증',
  OUT_OF_SAMPLE: '독립구간 검증',
  PURGED_WALK_FORWARD: '누수 방지 순차검증',
  COST_STRESS: '비용 스트레스 검증',
  REGIME: '시장상태 검증',
  FINAL_HOLDOUT: '최종검증',
  PAPER: '모의자동매매',
  SHADOW: '실시간 추적검증',
  RECOMMENDATION_OUTCOMES: '추천 결과 검증',
};

export const PROMOTION_STATE_KO: Readonly<Record<string, string>> = {
  RESEARCH: '연구 중',
  BLOCKED_DATA: '데이터 부족으로 차단',
  RESEARCH_HOLD: '연구 보류',
  PAPER_CANDIDATE: '모의자동매매 후보',
  PAPER_VALIDATED: '모의자동매매 검증 완료',
  SHADOW_CANDIDATE: '실시간 추적검증 후보',
  SHADOW_VALIDATED: '실시간 추적검증 완료',
  PROMOTION_CANDIDATE: '승격 검토 후보',
  SUSPENDED: '중단',
  KILLED: '종료',
};

export const DRIFT_STATE_KO: Readonly<Record<string, string>> = {
  HEALTHY: '정상',
  WATCH: '관찰',
  DEGRADED: '저하',
  CRITICAL: '심각',
  MEASURED: '측정됨',
  INSUFFICIENT_SAMPLE: '표본 부족',
};

export const KILL_STATE_KO: Readonly<Record<string, string>> = {
  NONE: '없음',
  SUSPEND_RECOMMENDED: '중단 권고',
  KILLED: '종료',
};

export function userFacingCodeLabel(
  value: string | null | undefined,
  labels: Readonly<Record<string, string>>,
  missingLabel = '확인 불가',
): string {
  if (value == null || value.trim() === '') return missingLabel;
  return labels[value] ?? value;
}

// Tailwind classes for the app's semantic colors (Green/Yellow/Red).
export function toneText(t: Tone): string {
  switch (t) {
    case 'positive':
      return 'text-positive';
    case 'destructive':
      return 'text-destructive';
    case 'warning':
      return 'text-warning';
    default:
      return 'text-muted-foreground';
  }
}

export function toneBadge(t: Tone): string {
  switch (t) {
    case 'positive':
      return 'bg-positive/15 text-positive border-positive/30';
    case 'destructive':
      return 'bg-destructive/15 text-destructive border-destructive/30';
    case 'warning':
      return 'bg-warning/15 text-warning border-warning/30';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

export function toneDot(t: Tone): string {
  switch (t) {
    case 'positive':
      return 'bg-positive';
    case 'destructive':
      return 'bg-destructive';
    case 'warning':
      return 'bg-warning';
    default:
      return 'bg-muted-foreground';
  }
}

export function changeTone(pct: number): Tone {
  if (pct > 0) return 'positive';
  if (pct < 0) return 'destructive';
  return 'neutral';
}
