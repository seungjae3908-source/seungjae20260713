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
  fluid = false,
}: {
  value: T;
  options: readonly ResponsiveTabOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  testId?: string;
  className?: string;
  compact?: boolean;
  fluid?: boolean;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      data-testid={testId}
      data-ui-role="tabs"
      className={cn(
        fluid
          ? 'no-scrollbar grid min-w-0 gap-1 overflow-visible border border-card-border'
          : 'no-scrollbar flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain border border-card-border min-[1200px]:grid min-[1200px]:overflow-visible',
        compact ? 'rounded-xl bg-background p-0.5' : 'rounded-2xl bg-card p-1',
        options.length === 2 && 'min-[1200px]:grid-cols-2',
        options.length === 3 && 'min-[1200px]:grid-cols-3',
        options.length === 4 && 'min-[1200px]:grid-cols-4',
        options.length === 5 && 'min-[1200px]:grid-cols-5',
        options.length === 6 && 'min-[1200px]:grid-cols-6',
        fluid && options.length === 2 && 'grid grid-cols-2 overflow-visible',
        fluid && options.length === 3 && 'grid grid-cols-3 overflow-visible',
        fluid && options.length === 4 && 'grid grid-cols-4 overflow-visible',
        fluid && options.length === 5 && 'grid grid-cols-5 overflow-visible',
        fluid && options.length === 6 && 'grid grid-cols-6 overflow-visible',
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
              'inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl text-center text-xs font-semibold leading-4 transition-colors min-[1200px]:min-w-0',
              fluid
                ? 'min-w-0 w-full px-1.5'
                : compact ? 'min-w-[88px] px-3' : 'min-w-[76px] px-3',
              option.disabled && 'cursor-not-allowed opacity-45',
              selected
                ? 'bg-primary text-primary-foreground shadow-sm'
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
