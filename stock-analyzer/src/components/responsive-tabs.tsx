import { cn } from '@/lib/utils';

export type ResponsiveTabOption<T extends string> = {
  value: T;
  label: string;
};

export function ResponsiveTabs<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  testId,
  className,
}: {
  value: T;
  options: readonly ResponsiveTabOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        'no-scrollbar flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain rounded-2xl border border-card-border bg-card p-1 lg:grid lg:overflow-visible',
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
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'min-h-11 min-w-[76px] shrink-0 rounded-xl px-3 text-xs font-black transition-colors lg:min-w-0',
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
