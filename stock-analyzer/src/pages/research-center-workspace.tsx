import { useState } from 'react';
import { Bot, Clapperboard, LayoutDashboard, ListTree } from 'lucide-react';
import ResearchCenterPage from './research-center';
import { ResearchCenterGeneral } from '@/components/research-center-general';
import { ResearchCopilotPanel } from '@/components/research-copilot-panel';
import { ResearchVideoPanel } from '@/components/research-video-panel';
import { cn } from '@/lib/utils';

type ResearchWorkspaceView = 'general' | 'expert' | 'copilot' | 'video';

const WORKSPACE_TABS = [
  {
    value: 'general',
    label: '요약',
    icon: LayoutDashboard,
  },
  {
    value: 'expert',
    label: '상세',
    icon: ListTree,
  },
  {
    value: 'copilot',
    label: 'AI 도우미',
    icon: Bot,
  },
  {
    value: 'video',
    label: '영상',
    icon: Clapperboard,
  },
] as const;

/**
 * Keep the canonical Research Center read-only and make the default mobile entry concise.
 * Expert/raw evidence remains available as a separate explicit view.
 */
export default function ResearchCenterWorkspace() {
  const [view, setView] = useState<ResearchWorkspaceView>('general');

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="research-center-workspace">
      <div className="shrink-0 border-b border-border bg-background/95 px-3 py-2 backdrop-blur sm:px-4">
        <div
          className="mx-auto grid w-full max-w-3xl grid-cols-4 gap-1 rounded-2xl border border-card-border bg-card p-1"
          data-testid="research-workspace-tabs"
          aria-label="연구센터 보기"
        >
          {WORKSPACE_TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.value}
                type="button"
                aria-pressed={view === tab.value}
                aria-label={tab.label}
                onClick={() => setView(tab.value)}
                className={cn(
                  'flex min-h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-center text-[11px] font-semibold transition sm:flex-row sm:gap-1.5 sm:text-sm',
                  view === tab.value
                    ? 'bg-primary/12 text-primary ring-1 ring-inset ring-primary/35'
                    : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="block truncate">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {view === 'general' ? <ResearchCenterGeneral onOpenExpert={() => setView('expert')} /> : null}
        {view === 'expert' ? <ResearchCenterPage /> : null}
        {view === 'copilot' ? <ResearchCopilotPanel /> : null}
        {view === 'video' ? <ResearchVideoPanel /> : null}
      </div>
    </div>
  );
}
