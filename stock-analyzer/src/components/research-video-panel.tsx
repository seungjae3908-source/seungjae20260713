import { useState } from 'react';
import { ResearchVideoPanel as ResearchVideoSourcePanel } from './research-video-source-panel';
import { ResearchWorkspacePanel } from './research-workspace-panel';

/** Existing Research Center video entrypoint. Source view stays the default for compatibility. */
export function ResearchVideoPanel() {
  const [section,setSection] = useState<'sources'|'results'>('sources');
  return <div className="flex h-full min-h-0 flex-col" data-testid="research-video-workspace">
    <nav className="flex shrink-0 flex-wrap gap-2 border-b border-card-border px-3 py-2" aria-label="영상 연구 세부 화면">
      {([{key:'sources',label:'영상 자료'},{key:'results',label:'전략·백테스트'}] as const).map(t=><button key={t.key} type="button"
        aria-pressed={section===t.key} onClick={()=>setSection(t.key)}
        className={`min-h-11 rounded-xl border border-card-border px-3 py-2 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${section===t.key?'bg-primary text-primary-foreground':'bg-card'}`}>{t.label}</button>)}
    </nav>
    <div className="min-h-0 flex-1 overflow-hidden">{section==='sources'?<ResearchVideoSourcePanel/>:<ResearchWorkspacePanel/>}</div>
  </div>;
}
