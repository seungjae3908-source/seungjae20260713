import { useState } from 'react';
import { cn } from '@/lib/utils';

// Source logo via Google's favicon service, with a lettered fallback when the
// logo is unavailable.
export function SourceLogo({ domain, name, className }: { domain: string; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const base = cn('h-6 w-6 shrink-0 overflow-hidden rounded-md', className);

  if (failed || !domain) {
    return (
      <div className={cn(base, 'flex items-center justify-center bg-secondary text-[10px] font-semibold text-muted-foreground')}>
        {name.slice(0, 1)}
      </div>
    );
  }

  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
      alt={name}
      loading="lazy"
      className={cn(base, 'bg-white object-contain')}
      onError={() => setFailed(true)}
    />
  );
}
