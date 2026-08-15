import { cn } from '@/lib/utils';
import { toneText, toneDot, type Tone } from '@/lib/labels';

export function Panel({
  title,
  right,
  children,
  className,
}: {
  title?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('min-w-0 overflow-hidden rounded-2xl border border-card-border bg-card p-3 sm:rounded-xl sm:p-4', className)}>
      {(title || right) && (
        <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
          {title && <h3 className="min-w-0 break-words text-sm font-semibold">{title}</h3>}
          {right && <div className="min-w-0 shrink-0">{right}</div>}
        </div>
      )}
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: Tone }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="break-words text-xs text-muted-foreground">{label}</span>
      <span className={cn('break-words font-mono text-sm font-medium tabular-nums', tone && toneText(tone))}>{value}</span>
    </div>
  );
}

export function Bar({ value, tone = 'neutral' }: { value: number; tone?: Tone }) {
  const dot: Record<Tone, string> = {
    positive: 'bg-positive',
    warning: 'bg-warning',
    destructive: 'bg-destructive',
    neutral: 'bg-muted-foreground',
  };
  return (
    <div className="h-1.5 w-full min-w-0 overflow-hidden rounded-full bg-muted">
      <div className={cn('h-full rounded-full', dot[tone])} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function ReasonList({ items, tone }: { items: string[]; tone: Tone }) {
  return (
    <ul className="min-w-0 space-y-2">
      {items.map((text, i) => (
        <li key={i} className="flex min-w-0 gap-2.5 text-sm leading-relaxed">
          <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', toneDot(tone))} />
          <span className="min-w-0 break-words">{text}</span>
        </li>
      ))}
    </ul>
  );
}
