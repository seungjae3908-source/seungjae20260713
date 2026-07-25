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
