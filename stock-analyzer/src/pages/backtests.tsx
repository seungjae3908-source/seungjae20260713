import { useState } from 'react';
import { Link } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import { BacktestResearchPanel } from '@/components/backtest-research-panel';
import { OriginalMinuteBacktestPanel } from '@/components/original-minute-backtest-panel';

export default function BacktestsPage() {
  const [researchMode, setResearchMode] = useState<'price' | 'original-minute'>('price');
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <CenteredPageHeader
        title="백테스트"
        eyebrow="전략·원본 데이터 연구"
        action={<Link href="/paper-trading" className="flex min-h-11 items-center rounded-xl border border-card-border bg-card px-3 text-[11px] font-black text-primary">모의매매</Link>}
      />
      <div className="flex shrink-0 gap-2 border-b border-border px-3 py-2" aria-label="백테스트 연구 방식">
        <button type="button" aria-pressed={researchMode === 'price'} onClick={() => setResearchMode('price')} className={`min-h-11 flex-1 rounded-xl px-3 text-sm font-semibold ${researchMode === 'price' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>가격 백테스트</button>
        <button type="button" aria-pressed={researchMode === 'original-minute'} onClick={() => setResearchMode('original-minute')} className={`min-h-11 flex-1 rounded-xl px-3 text-sm font-semibold ${researchMode === 'original-minute' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>원본 1분봉 연구</button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{researchMode === 'price' ? <BacktestResearchPanel compact /> : <OriginalMinuteBacktestPanel />}</div>
      <BottomNav />
    </div>
  );
}
