import type { Tone } from '@/lib/labels';

const COLOR: Record<Tone, string> = {
  positive: 'hsl(142 71% 45%)',
  warning: 'hsl(38 92% 50%)',
  destructive: 'hsl(0 84% 60%)',
  neutral: 'hsl(240 5% 65%)',
};

export function ScoreRing({
  score,
  tone,
  size = 64,
  label,
}: {
  score: number;
  tone: Tone;
  size?: number;
  label?: string;
}) {
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, score));
  const offset = c * (1 - clamped / 100);
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(240 6% 18%)" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={COLOR[tone]}
            strokeWidth={stroke}
            strokeDasharray={c}
            strokeDashoffset={offset}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-base font-semibold tabular-nums">{clamped}</span>
        </div>
      </div>
      {label && <span className="text-[11px] text-muted-foreground">{label}</span>}
    </div>
  );
}
