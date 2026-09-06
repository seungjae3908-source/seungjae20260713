import { useState } from 'react';
import ResearchCenterPage from './research-center';
import { ResearchCopilotPanel } from '@/components/research-copilot-panel';
import { ResponsiveTabs } from '@/components/responsive-tabs';

type ResearchWorkspaceView = 'overview' | 'copilot';

const WORKSPACE_TABS = [
  { value: 'overview', label: '연구센터' },
  { value: 'copilot', label: 'AI 연구 도우미' },
] as const;

/** Compose the existing owner screen without changing its research semantics. */
export default function ResearchCenterWorkspace() {
  const [view, setView] = useState<ResearchWorkspaceView>('overview');
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border bg-background px-3 py-2 sm:px-4">
        <div className="mx-auto w-full max-w-md">
          <ResponsiveTabs
            value={view}
            options={WORKSPACE_TABS}
            onChange={setView}
            ariaLabel="연구센터 작업 영역"
            testId="research-workspace-tabs"
            compact
          />
        </div>
      </div>
      <div className="min-h-0 flex-1">{view === 'overview' ? <ResearchCenterPage /> : <ResearchCopilotPanel />}</div>
    </div>
  );
}
