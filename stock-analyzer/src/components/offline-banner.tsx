import { useEffect, useRef, useState } from 'react';
import { RefreshCw, WifiOff } from 'lucide-react';
import { isClient } from '@/lib/platform';

type RecoveryState = 'fresh' | 'retrying' | 'stale';

// 네트워크 단절뿐 아니라 일시적인 API 장애도 사용자에게 투명하게 알립니다.
// 재시도 중에는 기존 화면을 유지하고, 실패 시에는 직전 정상 데이터를 표시합니다.
export function OfflineBanner() {
  const [offline, setOffline] = useState(isClient ? !navigator.onLine : false);
  const [recovery, setRecovery] = useState<Exclude<RecoveryState, 'fresh'> | null>(null);
  const states = useRef(new Map<string, Exclude<RecoveryState, 'fresh'>>());

  useEffect(() => {
    if (!isClient) return;
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    const updateRecovery = (event: Event) => {
      const detail = (event as CustomEvent<{ state: RecoveryState; path: string }>).detail;
      if (!detail?.path) return;
      if (detail.state === 'fresh') states.current.delete(detail.path);
      else states.current.set(detail.path, detail.state);
      const values = [...states.current.values()];
      setRecovery(values.includes('stale') ? 'stale' : values.includes('retrying') ? 'retrying' : null);
    };

    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    window.addEventListener('stock-app:data-recovery', updateRecovery);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      window.removeEventListener('stock-app:data-recovery', updateRecovery);
    };
  }, []);

  if (!offline && !recovery) return null;

  const stale = offline || recovery === 'stale';
  return (
    <div className="flex items-center justify-center gap-2 bg-warning/15 px-3 py-1.5 text-center text-xs font-medium text-warning">
      {stale ? <WifiOff className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
      {offline
        ? '오프라인 상태입니다 · 마지막으로 불러온 데이터를 표시합니다'
        : recovery === 'stale'
          ? '일시적인 데이터 장애입니다 · 마지막 정상 데이터를 표시합니다'
          : '데이터 연결을 자동으로 복구하고 있습니다'}
    </div>
  );
}
