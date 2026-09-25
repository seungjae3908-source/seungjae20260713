import { useState } from 'react';
import { ResearchVideoPanel as ResearchVideoSourcePanel } from './research-video-source-panel';
import { ResearchWorkspacePanel } from './research-workspace-panel';

/** Preserve current app navigation and compact source view; show actual evidence on demand. */
export function ResearchVideoPanel() {
  const [section,setSection] = useState<'sources'|'results'>('sources');
  return <div className="flex h-full min-h-0 flex-col" data-testid="research-video-workspace">
    <nav className="flex shrink-0 flex-wrap gap-2 border-b border-card-border px-3 py-2" aria-label="영상 연구 세부 화면">
      {([{key:'sources',label:'영상 자료'},{key:'results',label:'전략·백테스트'}] as const).map(t=><button key={t.key} type="button"
        aria-pressed={section===t.key} onClick={()=>setSection(t.key)}
        className={`min-h-11 rounded-xl border border-card-border px-3 py-2 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${section===t.key?'bg-primary text-primary-foreground':'bg-card'}`}>{t.label}</button>)}
    </nav>
    <div className="min-h-0 flex-1 overflow-hidden">{section==='sources'?
      <section className="h-full overflow-y-auto bg-background p-3 sm:p-4">
        <header className="mx-auto max-w-6xl rounded-2xl border border-card-border bg-card p-4">
          <h2 className="text-xl font-black">영상 연구</h2>
          <p className="mt-2 text-sm text-muted-foreground">연구 참고용 · 수익성 증거 아님</p>
          <p className="mt-2 text-sm text-muted-foreground">영상 자료와 분석 근거는 별도로 확인합니다. 자료가 없으면 미확인 상태로 남깁니다.</p>
        </header>
        <details className="mx-auto mt-3 max-w-6xl rounded-2xl border border-card-border bg-card">
          <summary className="min-h-12 cursor-pointer px-4 py-3 text-sm font-bold">기술 상태 자세히 보기</summary>
          <ResearchVideoSourcePanel/>
        </details>
      </section>:<ResearchWorkspacePanel/>}</div>
  </div>;
}
