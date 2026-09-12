const statusRows = [
  ['Video discovery', '수동 / 비활성'],
  ['Transcript access', '권한 확인 필수'],
  ['Economic Evidence', '0'],
  ['Profitability Credit', '0'],
  ['Execution Authority', 'NONE'],
] as const;

export function ResearchVideoPanel() {
  return (
    <section className="h-full overflow-y-auto bg-background px-3 py-4 sm:px-4" data-testid="research-video-panel">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <header className="rounded-2xl border border-card-border bg-card p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold sm:text-xl">영상 연구</h1>
            <span className="rounded-full border px-2 py-1 text-[11px] font-semibold text-muted-foreground">Research Source Only</span>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            공개 영상·허가된 transcript·승인된 프레임 분석에서 연구 가설만 추출합니다. 영상 주장은 수익성·OOS·Forward·Paper 증거로 승격되지 않습니다.
          </p>
        </header>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" data-testid="research-video-safety-grid">
          {statusRows.map(([label, value]) => (
            <div key={label} className="min-w-0 rounded-2xl border border-card-border bg-card p-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="mt-1 break-words text-sm font-semibold">{value}</div>
            </div>
          ))}
        </div>

        <div className="rounded-2xl border border-card-border bg-card p-4" data-testid="research-video-empty-state">
          <h2 className="font-semibold">아직 수집된 영상 연구 자료가 없습니다</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Phase 1에서는 source contract, transcript/content firewall, 전략 가설, 교차검증 및 기존 Backtester 후보 handoff를 구축합니다. 자동 수집 스케줄과 유료 provider는 비활성 상태입니다.
          </p>
          <div className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
            <div className="rounded-xl bg-muted p-3"><strong>Transcript unavailable</strong><br />UNAVAILABLE / NOT_AUTHORIZED를 정상값으로 위장하지 않습니다.</div>
            <div className="rounded-xl bg-muted p-3"><strong>NON_TESTABLE</strong><br />누락된 진입·청산·시간봉은 AI가 임의로 채우지 않습니다.</div>
            <div className="rounded-xl bg-muted p-3"><strong>Provenance</strong><br />가능한 경우 URL과 timestamp를 원본 근거로 유지합니다.</div>
            <div className="rounded-xl bg-muted p-3"><strong>Canonical handoff</strong><br />검증된 연구 가설만 기존 compiler와 Backtester 후보 경로를 재사용합니다.</div>
          </div>
        </div>
      </div>
    </section>
  );
}
