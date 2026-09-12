const statusRows = [
  ['Video discovery', '수동 / 공식 public API runtime'],
  ['Provider runtime', 'SERVER READ_ONLY / browser credential 미노출'],
  ['Runtime evidence', 'UI reader 미연결 → UNKNOWN'],
  ['Transcript access', '승인된 입력만 허용'],
  ['Economic Evidence', '0'],
  ['Execution Authority', 'NONE'],
] as const;

const truthBadges = [
  ['FACT', '확인된 원문/메타데이터'],
  ['CREATOR CLAIM', '출처의 주장'],
  ['AI INFERENCE', '추론 — 사실 아님'],
  ['UNKNOWN', '정보 부족'],
  ['CONTRADICTED', '상충 근거 존재'],
] as const;

const phase2Sections = [
  {
    title: 'Discovery',
    testId: 'video-discovery-state',
    rows: [
      ['검색 경로', 'YouTube Data API 공식/public metadata'],
      ['Provider runtime', 'READ_ONLY SERVER RUNTIME AVAILABLE'],
      ['Browser credential', 'NOT_EXPOSED'],
      ['최근 discovery evidence', 'UNKNOWN — UI evidence reader 미연결'],
      ['자동 수집', 'OFF'],
      ['Schedule', 'INACTIVE'],
      ['Quota', 'UNKNOWN — runtime evidence 미연결'],
    ],
  },
  {
    title: 'Transcript',
    testId: 'video-transcript-state',
    rows: [
      ['상태', 'UNKNOWN — authorized transcript evidence 미연결'],
      ['권한', '승인된 transcript만 ingest'],
      ['Segment', 'UNKNOWN — missing != 0'],
      ['Timestamp coverage', 'UNKNOWN_TIMESTAMP'],
      ['우회 다운로드', 'DISABLED'],
    ],
  },
  {
    title: 'Strategy',
    testId: 'video-strategy-state',
    rows: [
      ['Strategy family', 'UNKNOWN'],
      ['Market / Side / Timeframe', 'UNSPECIFIED'],
      ['Entry / Exit', 'UNSPECIFIED'],
      ['SL / TP', 'UNSPECIFIED'],
      ['Testability', 'UNKNOWN until source-bound evidence is connected'],
    ],
  },
  {
    title: 'Evidence',
    testId: 'video-evidence-state',
    rows: [
      ['Video sources', 'UNKNOWN — UI runtime evidence 미연결'],
      ['Independent sources', 'UNKNOWN — economic N 아님'],
      ['Academic / official', 'NOT_CHECKED'],
      ['Contradictions', 'UNKNOWN'],
      ['Source authority', 'UNKNOWN'],
    ],
  },
  {
    title: 'Validation',
    testId: 'video-validation-state',
    rows: [
      ['Cross-validation', 'NOT_CHECKED'],
      ['Compiler', 'NOT_EVALUATED — source-bound testability evidence 필요'],
      ['Backtester candidate', 'NOT_EVALUATED'],
      ['Economic Evidence', '0'],
      ['Profitability Credit', '0'],
    ],
  },
] as const;

export function ResearchVideoPanel() {
  return (
    <section className="h-full overflow-y-auto bg-background px-3 py-4 sm:px-4" data-testid="research-video-panel">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        <header className="rounded-2xl border border-card-border bg-card p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold sm:text-xl">영상 연구</h1>
            <span className="rounded-full border px-2 py-1 text-[11px] font-semibold text-muted-foreground">Research Source Only</span>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            공식/public metadata와 승인된 transcript만 연구 입력으로 사용합니다. 영상·강의의 주장은 아이디어 소스이며 수익성·OOS·Forward·Paper 증거로 승격되지 않습니다.
          </p>
        </header>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" data-testid="research-video-safety-grid">
          {statusRows.map(([label, value]) => (
            <div key={label} className="min-w-0 rounded-2xl border border-card-border bg-card p-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="mt-1 break-words text-sm font-semibold">{value}</div>
            </div>
          ))}
        </div>

        <div className="rounded-2xl border border-card-border bg-card p-4" data-testid="video-truth-legend">
          <h2 className="font-semibold">Fact / Inference / Unknown</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {truthBadges.map(([label, description]) => (
              <span key={label} className="max-w-full rounded-full border border-card-border bg-muted px-3 py-1 text-xs">
                <strong>{label}</strong> · {description}
              </span>
            ))}
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3" data-testid="research-video-phase2-grid">
          {phase2Sections.map((section) => (
            <article key={section.title} className="min-w-0 rounded-2xl border border-card-border bg-card p-4" data-testid={section.testId}>
              <h2 className="font-semibold">{section.title}</h2>
              <dl className="mt-3 space-y-2 text-sm">
                {section.rows.map(([label, value]) => (
                  <div key={label} className="grid min-w-0 gap-1 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)] sm:gap-3">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="min-w-0 break-words font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <article className="min-w-0 rounded-2xl border border-card-border bg-card p-4" data-testid="video-detail-empty-state">
            <h2 className="font-semibold">Video detail</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              서버의 공식/public discovery runtime은 존재하지만, 그 sanitized runtime evidence를 이 화면으로 읽어오는 reader는 아직 연결되지 않았습니다. 따라서 실제 영상 레코드 존재 여부를 0으로 단정하지 않고 UNKNOWN으로 유지합니다.
            </p>
            <div className="mt-3 rounded-xl bg-muted p-3 text-xs">
              Transcript unavailable은 빈 문자열이나 0이 아니라 UNAVAILABLE / NOT_AUTHORIZED / NOT_PROVIDED / UNKNOWN 같은 명시 상태로 유지합니다.
            </div>
          </article>

          <article className="min-w-0 rounded-2xl border border-card-border bg-card p-4" data-testid="video-cluster-empty-state">
            <h2 className="font-semibold">Strategy cluster</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              runtime evidence reader가 연결되기 전에는 cluster 개수도 UNKNOWN입니다. 연결 후 Video count, Independent source count, Supporting / Contradicting source count, Common / Conflicting / Missing rules를 source provenance와 함께 분리해 표시합니다.
            </p>
            <div className="mt-3 rounded-xl bg-muted p-3 text-xs">
              Independent source count는 경제적 표본 N이 아닙니다. Economic Evidence Credit = 0을 유지합니다.
            </div>
          </article>
        </div>

        <footer className="rounded-2xl border border-card-border bg-card p-4 text-xs leading-5 text-muted-foreground" data-testid="video-phase2-safety-footer">
          Official public provider only · Browser credential NOT_EXPOSED · Automatic discovery OFF · Schedule OFF · No downloader bypass · No new Backtester · Existing canonical compiler only · Economic Evidence Credit 0 · Execution Authority NONE
        </footer>
      </div>
    </section>
  );
}
