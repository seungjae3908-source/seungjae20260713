import { useMemo, useState } from 'react';
import { ArrowLeft, Cloud } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { PaperJournalSyncAnalyticsPanel } from '@/components/paper-journal-sync-analytics-panel';
import { PaperTradingPanel } from '@/components/paper-trading-panel';
import { useAuth } from '@/lib/auth';
import { createUserPaperStorage } from '@/lib/paper-journal-sync-storage';

export default function PaperTradingPage() {
  const { user, profile } = useAuth();
  const userId = user?.id ?? profile?.id ?? '';
  const [showJournalTools, setShowJournalTools] = useState(false);
  const [paperRevision, setPaperRevision] = useState(0);
  const paperStorage = useMemo(
    () => userId ? createUserPaperStorage(window.localStorage, userId) : window.localStorage,
    [userId],
  );

  if (!userId) {
    return <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">로그인 사용자 정보를 확인하지 못했습니다.</div>;
  }

  return <div className="relative h-full min-h-0 overflow-hidden">
    <PaperTradingPanel key={`${userId}:${paperRevision}`} storage={paperStorage} />
    <button
      type="button"
      className="absolute right-4 top-4 z-30 inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background/95 px-3 text-sm font-bold shadow-lg backdrop-blur"
      onClick={() => setShowJournalTools(true)}
      data-testid="open-journal-sync"
    >
      <Cloud className="h-4 w-4" />동기화·분석
    </button>

    {showJournalTools ? <div className="absolute inset-0 z-40 overflow-y-auto overscroll-contain bg-background pb-28" data-testid="journal-sync-overlay">
      <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-5 sm:px-5">
        <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold" onClick={() => setShowJournalTools(false)}>
          <ArrowLeft className="h-4 w-4" />모의매매로 돌아가기
        </button>
        <PaperJournalSyncAnalyticsPanel
          userId={userId}
          rootStorage={window.localStorage}
          paperStorage={paperStorage}
          onLocalStateChanged={() => setPaperRevision((value) => value + 1)}
        />
      </div>
    </div> : null}
    <BottomNav />
  </div>;
}
