import { useEffect, useState } from 'react';

type RuntimeRecord = {
  videoId: string;
  canonicalUrl: string;
  title: string;
  channelOrPublisher: string | null;
  publishedAt: string | null;
  discoveredAt: string | null;
  language: string | null;
  durationSec: number | null;
  transcriptStatus: string;
  captionsKnownPresent: boolean | null;
  sourceTrustTier: string;
  contentAuthority: 'UNTRUSTED_EXTERNAL_DATA';
  economicEvidenceCredit: 0;
  profitabilityCredit: 0;
  executionAuthority: 'NONE';
};

type RuntimeEvidence = {
  available: true;
  dataState: 'MEASURED';
  runtimeVersion: 'video-research-public-provider-runtime-v3';
  status: string;
  provider: 'YOUTUBE_DATA_API_V3';
  providerAccess: 'OFFICIAL_PUBLIC_API';
  requestMode: 'READ_ONLY_GET';
  query: string;
  pagesUsed: number;
  quotaState: string;
  credentialConfigured: boolean;
  credentialValueExposed: false;
  sourceCount: number;
  records: RuntimeRecord[];
  safety: {
    researchOnly: true;
    economicEvidenceCredit: 0;
    profitabilityCredit: 0;
    executionAuthority: 'NONE';
    paidProviderEnabled: false;
    scheduleActive: false;
    automaticDiscoveryEnabled: false;
    liveTrading: false;
    privateTradingApi: false;
    realOrderEnabled: false;
    credentialMutation: false;
    transcriptDownloadEnabled: false;
  };
  economicEvidenceCredit: 0;
  profitabilityCredit: 0;
  executionAuthority: 'NONE';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseRuntimeEvidence(value: unknown): RuntimeEvidence | null {
  if (!isRecord(value) || value.available !== true || value.dataState !== 'MEASURED') return null;
  if (value.runtimeVersion !== 'video-research-public-provider-runtime-v3') return null;
  if (value.provider !== 'YOUTUBE_DATA_API_V3' || value.providerAccess !== 'OFFICIAL_PUBLIC_API' || value.requestMode !== 'READ_ONLY_GET') return null;
  if (value.credentialValueExposed !== false || typeof value.credentialConfigured !== 'boolean') return null;
  if (typeof value.status !== 'string' || typeof value.query !== 'string' || typeof value.quotaState !== 'string') return null;
  if (typeof value.pagesUsed !== 'number' || !Number.isSafeInteger(value.pagesUsed) || value.pagesUsed < 0 || value.pagesUsed > 1) return null;
  if (typeof value.sourceCount !== 'number' || !Number.isSafeInteger(value.sourceCount) || value.sourceCount < 0 || value.sourceCount > 5) return null;
  if (!Array.isArray(value.records) || value.records.length !== value.sourceCount) return null;
  if (!isRecord(value.safety)) return null;
  const safety = value.safety;
  if (safety.researchOnly !== true || safety.economicEvidenceCredit !== 0 || safety.profitabilityCredit !== 0 || safety.executionAuthority !== 'NONE') return null;
  if (safety.paidProviderEnabled !== false || safety.scheduleActive !== false || safety.automaticDiscoveryEnabled !== false) return null;
  if (safety.liveTrading !== false || safety.privateTradingApi !== false || safety.realOrderEnabled !== false || safety.credentialMutation !== false || safety.transcriptDownloadEnabled !== false) return null;
  if (value.economicEvidenceCredit !== 0 || value.profitabilityCredit !== 0 || value.executionAuthority !== 'NONE') return null;
  for (const record of value.records) {
    if (!isRecord(record)) return null;
    if (typeof record.videoId !== 'string' || typeof record.canonicalUrl !== 'string' || typeof record.title !== 'string') return null;
    if (typeof record.transcriptStatus !== 'string' || typeof record.sourceTrustTier !== 'string') return null;
    if (record.contentAuthority !== 'UNTRUSTED_EXTERNAL_DATA' || record.economicEvidenceCredit !== 0 || record.profitabilityCredit !== 0 || record.executionAuthority !== 'NONE') return null;
  }
  return value as unknown as RuntimeEvidence;
}

const truthBadges = [
  ['FACT', '확인된 원문/메타데이터'],
  ['CREATOR CLAIM', '출처의 주장'],
  ['AI INFERENCE', '추론 — 사실 아님'],
  ['UNKNOWN', '정보 부족'],
  ['CONTRADICTED', '상충 근거 존재'],
] as const;

export function ResearchVideoPanel() {
  const [runtimeEvidence, setRuntimeEvidence] = useState<RuntimeEvidence | null>(null);
  const [readerSettled, setReaderSettled] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/research/video/evidence', {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response) => response.ok ? response.json() as Promise<unknown> : null)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setRuntimeEvidence(parseRuntimeEvidence(payload));
        setReaderSettled(true);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        setRuntimeEvidence(null);
        setReaderSettled(true);
      });
    return () => controller.abort();
  }, []);

  const latestRecord = runtimeEvidence?.records[0] ?? null;
  const runtimeState = runtimeEvidence
    ? `MEASURED · sanitized reader connected · ${runtimeEvidence.sourceCount} source${runtimeEvidence.sourceCount === 1 ? '' : 's'}`
    : readerSettled
      ? 'UNKNOWN — sanitized runtime snapshot unavailable'
      : 'UNKNOWN — sanitized runtime evidence loading';
  const sourceCountState = runtimeEvidence
    ? `${runtimeEvidence.sourceCount} — measured sanitized public-provider result`
    : 'UNKNOWN — missing runtime snapshot != 0';

  const statusRows = [
    ['Video discovery', '수동 / 공식 public API runtime'],
    ['Provider runtime', runtimeEvidence ? `${runtimeEvidence.provider} / ${runtimeEvidence.requestMode}` : 'SERVER READ_ONLY / browser credential 미노출'],
    ['Runtime evidence', runtimeState],
    ['Transcript access', latestRecord ? latestRecord.transcriptStatus : '승인된 입력만 허용'],
    ['Economic Evidence', '0'],
    ['Execution Authority', 'NONE'],
  ] as const;

  const phase2Sections = [
    {
      title: 'Discovery',
      testId: 'video-discovery-state',
      rows: [
        ['검색 경로', 'YouTube Data API 공식/public metadata'],
        ['Provider runtime', runtimeEvidence ? `${runtimeEvidence.providerAccess} / ${runtimeEvidence.requestMode}` : 'READ_ONLY SERVER RUNTIME AVAILABLE'],
        ['Browser credential', 'NOT_EXPOSED'],
        ['최근 discovery evidence', runtimeEvidence ? `${runtimeEvidence.status} · ${runtimeEvidence.query}` : runtimeState],
        ['자동 수집', 'OFF'],
        ['Schedule', 'INACTIVE'],
        ['Quota', runtimeEvidence?.quotaState ?? 'UNKNOWN — sanitized runtime snapshot unavailable'],
      ],
    },
    {
      title: 'Transcript',
      testId: 'video-transcript-state',
      rows: [
        ['상태', latestRecord?.transcriptStatus ?? 'UNKNOWN — authorized transcript evidence 없음'],
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
        ['Testability', 'UNKNOWN until source-bound strategy evidence is connected'],
      ],
    },
    {
      title: 'Evidence',
      testId: 'video-evidence-state',
      rows: [
        ['Video sources', sourceCountState],
        ['Independent sources', 'UNKNOWN — economic N 아님'],
        ['Academic / official', 'NOT_CHECKED'],
        ['Contradictions', 'UNKNOWN'],
        ['Source authority', latestRecord?.sourceTrustTier ?? 'UNKNOWN'],
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
            {latestRecord ? (
              <dl className="mt-2 space-y-2 text-sm">
                <div><dt className="text-muted-foreground">Title</dt><dd className="break-words font-medium">{latestRecord.title}</dd></div>
                <div><dt className="text-muted-foreground">Channel / Publisher</dt><dd className="break-words font-medium">{latestRecord.channelOrPublisher ?? 'UNKNOWN'}</dd></div>
                <div><dt className="text-muted-foreground">Transcript</dt><dd className="font-medium">{latestRecord.transcriptStatus}</dd></div>
                <div><dt className="text-muted-foreground">Provenance</dt><dd className="break-words font-medium">{runtimeEvidence?.providerAccess} · {latestRecord.contentAuthority}</dd></div>
              </dl>
            ) : runtimeEvidence ? (
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                bounded official/public discovery가 완료되어 sourceCount 0이 실제 측정되었습니다. 이 0은 missing 추론이 아니라 연결된 sanitized runtime 결과입니다.
              </p>
            ) : (
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                sanitized runtime evidence reader는 연결됐지만 현재 읽을 수 있는 snapshot이 없습니다. 실제 영상 레코드 존재 여부를 0으로 단정하지 않고 UNKNOWN으로 유지합니다.
              </p>
            )}
            <div className="mt-3 rounded-xl bg-muted p-3 text-xs">
              Transcript unavailable은 빈 문자열이나 0이 아니라 UNAVAILABLE / NOT_AUTHORIZED / NOT_PROVIDED / UNKNOWN 같은 명시 상태로 유지합니다.
            </div>
          </article>

          <article className="min-w-0 rounded-2xl border border-card-border bg-card p-4" data-testid="video-cluster-empty-state">
            <h2 className="font-semibold">Strategy cluster</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              discovery provenance가 연결돼도 strategy mining 결과가 없으면 cluster 개수는 UNKNOWN입니다. 향후 Video count, Independent source count, Supporting / Contradicting source count, Common / Conflicting / Missing rules를 source provenance와 분리해 표시합니다.
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
