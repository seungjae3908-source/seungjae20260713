import { useState } from 'react';
import { Bot, Clapperboard, FileSearch, LayoutDashboard, ListTree, WalletCards } from 'lucide-react';
import ResearchCenterPage, { type ResearchTab } from './research-center';
import { ResearchCenterGeneral } from '@/components/research-center-general';
import { ResearchCopilotPanel } from '@/components/research-copilot-panel';
import { ResearchVideoPanel } from '@/components/research-video-panel';
import { ResearchRuleValidationPanel } from '@/components/research-rule-validation-panel';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';

type ResearchWorkspaceView = 'general' | 'expert' | 'evidence' | 'paper' | 'copilot' | 'video' | 'ai-lab';
const DETAIL_VIEWS: Partial<Record<ResearchWorkspaceView, ResearchTab>> = { expert: 'overview', evidence: 'evidence', paper: 'paper', 'ai-lab': 'ai-lab' };

const WORKSPACE_TABS = [
  {
    value: 'general',
    label: '요약',
    icon: LayoutDashboard,
  },
  {
    value: 'expert',
    label: '연구',
    icon: ListTree,
  },
  { value: 'evidence', label: '검증', icon: FileSearch },
  { value: 'paper', label: '모의매매', icon: WalletCards },
  {
    value: 'copilot',
    label: 'AI',
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
  const { isAdmin } = useAuth();
  const [view, setView] = useState<ResearchWorkspaceView>('general');
  const [rulesOpen, setRulesOpen] = useState(false);
  const selectedView = view === 'ai-lab' ? 'copilot' : view;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="research-center-workspace">
      <div className="shrink-0 border-b border-border bg-background/95 px-3 py-2 backdrop-blur sm:px-4">
        <div
          className="mx-auto grid w-full max-w-5xl grid-cols-3 gap-1 rounded-2xl border border-card-border bg-card p-1 sm:grid-cols-6"
          data-testid="research-workspace-tabs"
          aria-label="연구센터 보기"
        >
          {WORKSPACE_TABS.map((tab, index) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.value}
                type="button"
                id={`research-tab-${DETAIL_VIEWS[tab.value] ?? (tab.value === 'copilot' ? 'ai-lab' : tab.value)}-trigger`}
                aria-pressed={selectedView === tab.value}
                aria-label={tab.label}
                onClick={() => setView(tab.value === 'copilot' && !isAdmin ? 'ai-lab' : tab.value)}
                onKeyDown={(event) => {
                  const target = event.key === 'Home' ? 0 : event.key === 'End' ? WORKSPACE_TABS.length - 1
                    : event.key === 'ArrowRight' ? (index + 1) % WORKSPACE_TABS.length
                      : event.key === 'ArrowLeft' ? (index + WORKSPACE_TABS.length - 1) % WORKSPACE_TABS.length : null;
                  if (target == null) return;
                  event.preventDefault();
                  const next = WORKSPACE_TABS[target].value;
                  setView(next === 'copilot' && !isAdmin ? 'ai-lab' : next);
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[target]?.focus();
                }}
                className={cn(
                  'flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl px-1 text-center text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:text-sm',
                  selectedView === tab.value
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="block truncate">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {view === 'evidence' && isAdmin ? (
        <details
          className="shrink-0 border-b border-border bg-background px-3 py-2 sm:px-4"
          data-testid="research-rule-validation-toggle"
          onToggle={(event) => setRulesOpen(event.currentTarget.open)}
        >
          <summary className="mx-auto min-h-11 w-full max-w-5xl cursor-pointer py-3 text-sm font-bold">규칙 검증 결과 (관리자)</summary>
          {rulesOpen ? (
            <div className="mx-auto max-h-[60vh] w-full max-w-5xl overflow-y-auto pb-2">
              <ResearchRuleValidationPanel />
            </div>
          ) : null}
        </details>
      ) : null}

      <div className="min-h-0 flex-1">
        {view === 'general' ? <ResearchCenterGeneral onOpenExpert={() => setView('expert')} /> : null}
        {DETAIL_VIEWS[view] ? <ResearchCenterPage embedded activeTab={DETAIL_VIEWS[view]} onTabChange={(tab) => setView(tab === 'overview' ? 'expert' : tab)} /> : null}
        {view === 'copilot' ? <ResearchCopilotPanel onOpenReview={() => setView('ai-lab')} /> : null}
        {view === 'video' ? <ResearchVideoPanel /> : null}
      </div>
    </div>
  );
}
