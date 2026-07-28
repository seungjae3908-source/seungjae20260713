import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import {
  getSearchSuggestions,
  saveSearchHistory,
} from '@/lib/search-autocomplete';
import { cn } from '@/lib/utils';

export function SearchField({
  value,
  onChange,
  onClear,
  className,
  autoFocus,
  ariaLabel = '검색',
  placeholder = '종목명·티커·상품코드 검색',
}: {
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  className?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const [focused, setFocused] = useState(false);
  const suggestions = useMemo(
    () => getSearchSuggestions(ariaLabel, value, 20),
    [ariaLabel, value],
  );

  const clear = () => {
    onChange('');
    onClear?.();
  };

  return (
    <div
      className={cn('relative', className)}
      data-smart-search-field="true"
    >
      <label className="flex h-12 items-center gap-2 rounded-2xl border border-card-border bg-card px-3 text-foreground shadow-sm focus-within:border-primary/70 focus-within:ring-2 focus-within:ring-primary/15">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            window.setTimeout(() => setFocused(false), 120);
            saveSearchHistory(ariaLabel, value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              saveSearchHistory(ariaLabel, value);
              setFocused(false);
            }
            if (event.key === 'Escape') setFocused(false);
          }}
          autoFocus={autoFocus}
          autoComplete="off"
          placeholder={placeholder}
          aria-label={ariaLabel}
          className="min-w-0 flex-1 bg-transparent text-left text-sm font-bold text-foreground outline-none placeholder:text-muted-foreground"
        />
        {value && (
          <button
            type="button"
            onClick={clear}
            aria-label="검색어 지우기"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </label>

      {focused && suggestions.length > 0 && (
        <div className="absolute inset-x-0 top-[calc(100%+6px)] z-[65] max-h-72 overflow-y-auto rounded-2xl border border-card-border bg-card p-1.5 text-foreground shadow-2xl">
          {suggestions.map((suggestion) => (
            <button
              key={`${suggestion.value}:${suggestion.label ?? ''}`}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(suggestion.value);
                saveSearchHistory(ariaLabel, suggestion.value);
                setFocused(false);
              }}
              className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-foreground hover:bg-secondary active:bg-secondary"
            >
              <span className="truncate text-sm font-black">
                {suggestion.label && suggestion.label !== '최근 검색'
                  ? suggestion.label
                  : suggestion.value}
              </span>
              <span className="shrink-0 text-[10px] font-bold text-muted-foreground">
                {suggestion.label === '최근 검색'
                  ? '최근 검색'
                  : suggestion.value}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
