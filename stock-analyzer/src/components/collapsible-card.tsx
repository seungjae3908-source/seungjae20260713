// 접기/펼치기 공용 카드 — 모든 상세 영역은 기본적으로 접힌 상태로 표시된다.
import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export function CollapsibleCard({
  title,
  summary,
  defaultOpen = false,
  children,
  className,
}: {
  title: ReactNode;
  /** 접힌 상태에서 제목 아래 보여줄 짧은 상태 텍스트 */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cn('rounded-3xl border border-card-border bg-card shadow-sm', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 p-4 text-center"
      >
        <span className="flex-1 text-center">
          <span className="block text-sm font-black">{title}</span>
          {!open && summary != null && <span className="mt-1 block break-keep text-[10px] font-bold text-muted-foreground">{summary}</span>}
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}
