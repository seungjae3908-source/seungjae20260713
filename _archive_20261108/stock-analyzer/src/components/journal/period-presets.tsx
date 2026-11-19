import {
  startOfDay, endOfDay, startOfWeek, endOfWeek,
  startOfMonth, endOfMonth, startOfYear, endOfYear,
} from 'date-fns';

export type PeriodPreset = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export function resolvePeriod(preset: PeriodPreset, base = new Date()): { start: string; end: string } {
  switch (preset) {
    case 'DAILY':   return { start: startOfDay(base).toISOString(),   end: endOfDay(base).toISOString() };
    case 'WEEKLY':  return { start: startOfWeek(base).toISOString(),  end: endOfWeek(base).toISOString() };
    case 'MONTHLY': return { start: startOfMonth(base).toISOString(), end: endOfMonth(base).toISOString() };
    case 'YEARLY':  return { start: startOfYear(base).toISOString(),  end: endOfYear(base).toISOString() };
  }
}

const LABELS: Record<PeriodPreset, string> = {
  DAILY: '일별', WEEKLY: '주별', MONTHLY: '월별', YEARLY: '연도별',
};

export function JournalPeriodPresets({
  value, onChange,
}: { value: PeriodPreset | null; onChange: (p: PeriodPreset) => void }) {
  return (
    <div className="flex gap-1">
      {(Object.keys(LABELS) as PeriodPreset[]).map(p => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`rounded px-3 py-1.5 text-sm ${value === p ? 'bg-blue-600 text-white' : 'border'}`}
        >
          {LABELS[p]}
        </button>
      ))}
    </div>
  );
}
