import { ResearchVideoPanel as ResearchVideoSourcePanel } from './research-video-source-panel';

/** Video remains a source-evidence surface. Strategy research now has its own top-level Research Center tab. */
export function ResearchVideoPanel() {
  return (
    <section className="h-full overflow-y-auto bg-background p-3 sm:p-4" data-testid="research-video-workspace">
      <header className="mx-auto max-w-6xl rounded-2xl border border-card-border bg-card p-4">
        <h2 className="text-xl font-black">영상 연구 자료</h2>
        <p className="mt-2 text-sm text-muted-foreground">연구 참고용 · 수익성 증거 아님</p>
        <p className="mt-2 text-sm text-muted-foreground">
          영상·전사본은 가설의 출처로만 사용합니다. 수식·백테스트·검증·승격 상태는 상단의 전략 연구 탭에서 확인합니다.
        </p>
      </header>
      <details className="mx-auto mt-3 max-w-6xl rounded-2xl border border-card-border bg-card">
        <summary className="min-h-12 cursor-pointer px-4 py-3 text-sm font-bold">기술 상태 자세히 보기</summary>
        <ResearchVideoSourcePanel />
      </details>
    </section>
  );
}
