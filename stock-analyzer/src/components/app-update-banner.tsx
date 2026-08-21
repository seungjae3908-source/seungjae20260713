import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { APP_UPDATE_AVAILABLE_EVENT, isAppUpdateAvailable } from '@/lib/app-update';

export function AppUpdateBanner() {
  const [available, setAvailable] = useState(() => isAppUpdateAvailable());

  useEffect(() => {
    const onUpdateAvailable = () => setAvailable(true);
    window.addEventListener(APP_UPDATE_AVAILABLE_EVENT, onUpdateAvailable);
    return () => window.removeEventListener(APP_UPDATE_AVAILABLE_EVENT, onUpdateAvailable);
  }, []);

  if (!available) return null;

  return (
    <div
      aria-live="polite"
      className="fixed left-1/2 top-3 z-[100] w-[calc(100%-1.5rem)] max-w-md -translate-x-1/2"
      data-testid="app-update-banner"
      role="status"
    >
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/95 px-3 py-2 text-sm shadow-lg backdrop-blur">
        <div className="min-w-0">
          <p className="font-semibold text-foreground">새 버전이 준비되었습니다.</p>
          <p className="truncate text-xs text-muted-foreground">최신 기능과 수정사항을 적용하려면 새로고침하세요.</p>
        </div>
        <button
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="refresh-app-update"
          onClick={() => window.location.reload()}
          type="button"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          새로고침
        </button>
      </div>
    </div>
  );
}
