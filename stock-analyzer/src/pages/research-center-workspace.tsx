import { useState } from 'react';
import ResearchCenterPage from './research-center';
import { ResearchCopilotPanel } from '@/components/research-copilot-panel';

/** Compose the existing owner screen without changing its leased implementation. */
export default function ResearchCenterWorkspace() {
  const [view, setView] = useState<'overview' | 'copilot'>('overview');
  return <div className="flex h-full min-h-0 flex-col bg-background">
    <nav aria-label="연구센터 작업 영역" className="flex shrink-0 gap-2 border-b border-border px-3 py-2">
      <button type="button" aria-pressed={view === 'overview'} onClick={() => setView('overview')} className="min-h-11 rounded-xl border border-border px-4 text-sm font-bold">연구 현황</button>
      <button type="button" aria-pressed={view === 'copilot'} onClick={() => setView('copilot')} className="min-h-11 rounded-xl border border-border px-4 text-sm font-bold">AI Research Copilot</button>
    </nav>
    <div className="min-h-0 flex-1">{view === 'overview' ? <ResearchCenterPage /> : <ResearchCopilotPanel />}</div>
  </div>;
}
