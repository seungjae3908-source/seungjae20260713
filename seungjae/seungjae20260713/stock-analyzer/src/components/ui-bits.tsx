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
    <section className={cn('rounded-xl border border-card-border bg-card p-4', className)}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between">
          {title && <h3 className="text-sm font-semibold">{title}</h3>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: Tone }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('font-mono text-sm font-medium tabular-nums', tone && toneText(tone))}>{value}</span>
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
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn('h-full rounded-full', dot[tone])} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function ReasonList({ items, tone }: { items: string[]; tone: Tone }) {
  return (
    <ul className="space-y-2">
      {items.map((text, i) => (
        <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
          <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', toneDot(tone))} />
          <span>{text}</span>
        </li>
      ))}
    </ul>
  );
}
