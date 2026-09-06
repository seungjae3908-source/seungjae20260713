import { useState } from 'react';
import ResearchCenterPage from './research-center';
import { ResearchCenterGeneral } from '@/components/research-center-general';
import { ResearchCopilotPanel } from '@/components/research-copilot-panel';
import { cn } from '@/lib/utils';

type ResearchWorkspaceView = 'general' | 'expert' | 'copilot';

const WORKSPACE_TABS = [
  { value: 'general', label: '일반 보기' },
  { value: 'expert', label: '전문가 보기' },
  { value: 'copilot', label: 'AI Research Copilot' },
] as const;

/**
 * General users see a concise read-only summary first. The existing canonical
 * Research Center remains intact behind Expert View so evidence detail is not
 * removed or simplified away. Buttons intentionally preserve the established
 * Research Copilot browser contract while using a centered segmented layout.
 */
export default function ResearchCenterWorkspace() {
  const [view, setView] = useState<ResearchWorkspaceView>('general');
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="research-center-workspace">
      <div className="shrink-0 border-b border-border bg-background px-3 py-2 sm:px-4">
        <div className="mx-auto grid w-full max-w-2xl grid-cols-3 gap-1 rounded-2xl border border-card-border bg-card p-1" data-testid="research-workspace-tabs" aria-label="연구센터 보기">
          {WORKSPACE_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              aria-pressed={view === tab.value}
              onClick={() => setView(tab.value)}
              className={cn(
                'min-h-11 min-w-0 rounded-xl px-2 text-center text-xs font-semibold transition sm:text-sm',
                view === tab.value
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <span className="block truncate">{tab.label}</span>
            </button>
          ))}
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
