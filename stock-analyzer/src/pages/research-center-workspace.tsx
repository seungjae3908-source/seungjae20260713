import { useState } from 'react';
import ResearchCenterPage from './research-center';
import { ResearchCenterGeneral } from '@/components/research-center-general';
import { ResearchCopilotPanel } from '@/components/research-copilot-panel';
import { ResearchVideoPanel } from '@/components/research-video-panel';
import { cn } from '@/lib/utils';

type ResearchWorkspaceView = 'general' | 'expert' | 'copilot' | 'video';

const WORKSPACE_TABS = [
  { value: 'general', label: '일반 보기' },
  { value: 'expert', label: '전문가 보기' },
  { value: 'copilot', label: 'AI Research Copilot' },
  { value: 'video', label: '영상 연구' },
] as const;

/**
 * Preserve the canonical Research Center as the default evidence workspace.
 * Video Research remains a research-source-only surface with zero execution authority.
 */
export default function ResearchCenterWorkspace() {
  const [view, setView] = useState<ResearchWorkspaceView>('expert');
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="research-center-workspace">
      <div className="shrink-0 border-b border-border bg-background px-3 py-2 sm:px-4">
        <div className="mx-auto grid w-full max-w-3xl grid-cols-2 gap-1 rounded-2xl border border-card-border bg-card p-1 sm:grid-cols-4" data-testid="research-workspace-tabs" aria-label="연구센터 보기">
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
        {view === 'video' ? <ResearchVideoPanel /> : null}
      </div>
    </div>
  );
}
