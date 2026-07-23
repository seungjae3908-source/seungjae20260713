import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export function SearchField({
  value,
  onChange,
  onClear,
  className,
  autoFocus,
  ariaLabel = '검색',
}: {
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  className?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
}) {
  return (
    <label className={cn('flex h-11 items-center gap-2 rounded-2xl border border-card-border bg-card px-3', className)}>
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        className="min-w-0 flex-1 bg-transparent text-left text-sm font-bold outline-none"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange('');
            onClear?.();
          }}
          aria-label="검색어 지우기"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </label>
  );
}
