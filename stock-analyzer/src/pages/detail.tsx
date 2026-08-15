import { useEffect, useState, type MouseEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import AiChartPage from '@/pages/ai-chart';
import LegacyDetailPage from '@/pages/detail-legacy';

function chartRequestedByUrl(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('tab') === 'chart';
}

export default function DetailPage() {
  const queryParams = typeof window === 'undefined'
    ? new URLSearchParams()
    : new URLSearchParams(window.location.search);
  const ticker = queryParams.get("ticker") ?? queryParams.get('symbol') ?? '';
  const [showCanonicalChart, setShowCanonicalChart] = useState(chartRequestedByUrl);

  useEffect(() => {
    const onPopState = () => setShowCanonicalChart(chartRequestedByUrl());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function openCanonicalChart(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement | null;
    const button = target?.closest('button');
    if (!button || button.textContent?.trim() !== '차트') return;
    event.preventDefault();
    event.stopPropagation();
    setShowCanonicalChart(true);
  }

  function returnToRichDetail() {
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (url.searchParams.get('tab') === 'chart') {
        url.searchParams.set('tab', 'overview');
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      }
    }
    setShowCanonicalChart(false);
  }

  if (showCanonicalChart) {
    return (
      <div
        className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
        data-testid="canonical-stock-analysis"
        data-ticker={ticker}
      >
        <div className="shrink-0 border-b border-card-border bg-background px-3 py-2 sm:px-4" data-testid="canonical-rich-detail-chart">
          <button
            type="button"
            onClick={returnToRichDetail}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-card-border bg-card px-3 text-sm font-extrabold"
            aria-label="종목 상세분석으로 돌아가기"
          >
            <ArrowLeft className="h-4 w-4" />
            상세분석으로 돌아가기
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <AiChartPage embedded />
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-full min-h-0"
      onClickCapture={openCanonicalChart}
      data-testid="rich-detail-shell"
      data-ticker={ticker}
    >
      <LegacyDetailPage />
    </div>
  );
}
