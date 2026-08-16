import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

type CenteredPageHeaderProps = {
  title: string;
  eyebrow?: string;
  leading?: ReactNode;
  action?: ReactNode;
  infoTitle?: string;
  infoItems?: string[];
  className?: string;
  testId?: string;
};

export function CenteredPageHeader({
  title,
  eyebrow,
  leading,
  action,
  infoTitle = '안내',
  infoItems = [],
  className,
  testId,
}: CenteredPageHeaderProps) {
  const infoAction = infoItems.length ? (
    <details className="group relative">
      <summary
        aria-label={`${title} 안내 보기`}
        className="flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-xl border border-card-border bg-card text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
      >
        <Info className="h-5 w-5" />
      </summary>
      <div className="absolute right-0 z-40 mt-2 w-[min(82vw,320px)] rounded-2xl border border-card-border bg-card p-4 text-left shadow-xl">
        <p className="text-sm font-black text-foreground">{infoTitle}</p>
        <ul className="mt-2 space-y-1.5 text-xs font-medium leading-5 text-muted-foreground">
          {infoItems.map((item) => <li key={item}>• {item}</li>)}
        </ul>
      </div>
    </details>
  ) : null;

  return (
    <header
      data-testid={testId}
      className={cn('shrink-0 border-b border-card-border bg-background/95 px-3 py-3 backdrop-blur sm:px-4', className)}
    >
      <div className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2">
        <div className="flex min-w-0 justify-start">{leading ?? <span aria-hidden className="h-11 w-11" />}</div>
        <div className="min-w-0 text-center">
          {eyebrow ? <p className="truncate text-[10px] font-black text-primary">{eyebrow}</p> : null}
          <h1 className="truncate text-lg font-black sm:text-xl">{title}</h1>
        </div>
        <div className="flex min-w-0 justify-end">{action ?? infoAction ?? <span aria-hidden className="h-11 w-11" />}</div>
      </div>
    </header>
  );
}
