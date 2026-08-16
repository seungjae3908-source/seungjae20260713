import { cn } from '@/lib/utils';

export type ResponsiveTabOption<T extends string> = {
  value: T;
  label: string;
  ariaLabel?: string;
};

export function ResponsiveTabs<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  testId,
  className,
  compact = false,
}: {
  value: T;
  options: readonly ResponsiveTabOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  testId?: string;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        'no-scrollbar flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain border border-card-border lg:grid lg:overflow-visible',
        compact ? 'rounded-xl bg-background p-0.5' : 'rounded-2xl bg-card p-1',
        options.length === 2 && 'lg:grid-cols-2',
        options.length === 3 && 'lg:grid-cols-3',
        options.length === 4 && 'lg:grid-cols-4',
        options.length === 5 && 'lg:grid-cols-5',
        options.length === 6 && 'lg:grid-cols-6',
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        const accessibleLabel = option.ariaLabel ?? (option.label === 'AI 차트' ? 'AI 차트 분석기' : undefined);
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-label={accessibleLabel}
            aria-selected={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'min-h-11 shrink-0 rounded-xl text-xs font-black transition-colors lg:min-w-0',
              compact ? 'min-w-[88px] px-3' : 'min-w-[76px] px-3',
              selected
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
