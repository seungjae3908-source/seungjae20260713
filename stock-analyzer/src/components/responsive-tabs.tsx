import { cn } from '@/lib/utils';

export type ResponsiveTabOption<T extends string> = {
  value: T;
  label: string;
  ariaLabel?: string;
  disabled?: boolean;
  disabledReason?: string;
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
      data-ui-role="tabs"
      className={cn(
        'no-scrollbar min-w-0 gap-1 border border-card-border',
        options.length <= 4 ? 'grid overflow-visible' : 'flex overflow-x-auto overscroll-x-contain min-[1200px]:grid min-[1200px]:overflow-visible',
        compact ? 'rounded-xl bg-background p-0.5' : 'rounded-2xl bg-card p-1',
        options.length === 2 && 'grid-cols-2',
        options.length === 3 && 'grid-cols-3',
        options.length === 4 && 'grid-cols-4',
        options.length === 5 && 'min-[1200px]:grid-cols-5',
        options.length === 6 && 'min-[1200px]:grid-cols-6',
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
            aria-disabled={option.disabled || undefined}
            disabled={option.disabled}
            title={option.disabled ? option.disabledReason ?? '이 기능을 사용할 권한이 필요합니다.' : undefined}
            onClick={() => {
              if (!option.disabled) onChange(option.value);
            }}
            className={cn(
              'inline-flex min-h-11 items-center justify-center rounded-xl text-center text-xs font-semibold leading-4 transition-colors',
              options.length <= 4 ? 'min-w-0 px-2' : 'shrink-0 min-[1200px]:min-w-0',
              options.length > 4 && (compact ? 'min-w-[88px] px-3' : 'min-w-[76px] px-3'),
              option.disabled && 'cursor-not-allowed opacity-45',
              selected
                ? 'bg-primary/12 text-primary ring-1 ring-inset ring-primary/35'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <span className="block w-full text-center leading-4">{option.label}{option.disabled ? ' · 잠김' : ''}</span>
          </button>
        );
      })}
    </div>
  );
}
