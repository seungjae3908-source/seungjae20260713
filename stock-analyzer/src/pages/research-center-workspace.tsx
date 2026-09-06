import { useState } from 'react';
import ResearchCenterPage from './research-center';
import { ResearchCenterGeneral } from '@/components/research-center-general';
import { ResearchCopilotPanel } from '@/components/research-copilot-panel';
import { ResponsiveTabs } from '@/components/responsive-tabs';

type ResearchWorkspaceView = 'general' | 'expert' | 'copilot';

const WORKSPACE_TABS = [
  { value: 'general', label: '일반 보기' },
  { value: 'expert', label: '전문가 보기' },
  { value: 'copilot', label: 'AI Research Copilot' },
] as const;

/**
 * General users see a concise read-only summary first. The existing canonical
 * Research Center remains intact behind Expert View so evidence detail is not
 * removed or simplified away.
 */
export default function ResearchCenterWorkspace() {
  const [view, setView] = useState<ResearchWorkspaceView>('general');
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="research-center-workspace">
      <div className="shrink-0 border-b border-border bg-background px-3 py-2 sm:px-4">
        <div className="mx-auto w-full max-w-2xl">
          <ResponsiveTabs
            value={view}
            options={WORKSPACE_TABS}
            onChange={setView}
            ariaLabel="연구센터 보기"
            testId="research-workspace-tabs"
            compact
          />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {view === 'general' ? <ResearchCenterGeneral /> : null}
        {view === 'expert' ? <ResearchCenterPage /> : null}
        {view === 'copilot' ? <ResearchCopilotPanel /> : null}
      </div>
    </div>
  );
}
