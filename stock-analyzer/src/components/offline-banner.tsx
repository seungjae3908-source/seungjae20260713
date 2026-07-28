import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { isClient } from '@/lib/platform';
import UiLayoutRuntime from '@/components/ui-layout-runtime';

// Slim banner shown when the device goes offline. The app keeps working from
// React Query's cache (last-seen data); this just tells the user why numbers
// may be stale instead of failing silently. The same shell also mounts the
// published visual-layout runtime for authenticated app pages.
export function OfflineBanner() {
  const [offline, setOffline] = useState(isClient ? !navigator.onLine : false);

  useEffect(() => {
    if (!isClient) return;
    document.body.setAttribute('data-app-shell', 'true');
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      document.body.removeAttribute('data-app-shell');
    };
  }, []);

  return (
    <>
      <UiLayoutRuntime />
      {offline ? (
        <div className="flex items-center justify-center gap-2 bg-warning/15 px-3 py-1.5 text-center text-xs font-medium text-warning">
          <WifiOff className="h-3.5 w-3.5" />
          오프라인 상태입니다 · 마지막으로 불러온 데이터를 표시합니다
        </div>
      ) : null}
    </>
  );
}
