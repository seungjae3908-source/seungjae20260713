import { useEffect, useState } from 'react';
import { authorizedFetch } from '@/lib/auth-fetch';

const RUNTIME_VERSION = 'video-research-public-provider-runtime-v3' as const;
const SNAPSHOT_SCHEMA = 'video-research-sanitized-snapshot-v1' as const;
const SNAPSHOT_PUBLISHER_MODE = 'LOCAL_ATOMIC_FILE' as const;
const TRANSCRIPT_STATUSES = new Set([
  'AVAILABLE',
  'UNAVAILABLE',
  'NOT_AUTHORIZED',
  'NOT_PROVIDED',
  'UNSUPPORTED',
  'PROVIDER_NOT_CONFIGURED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'PARSE_FAILED',
  'UNKNOWN',
]);
const SOURCE_TRUST_TIERS = new Set([
  'TIER_A_OFFICIAL',
  'TIER_B_ACADEMIC',
  'TIER_C_PRIMARY_EXPERT',
  'TIER_D_SECONDARY_EDUCATIONAL',
  'TIER_E_UNVERIFIED_CREATOR',
  'UNKNOWN',
]);

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

type SnapshotProvenance = {
  schemaVersion: typeof SNAPSHOT_SCHEMA;
  sourceHeadSha: string;
  observedAt: string;
  publisherMode: typeof SNAPSHOT_PUBLISHER_MODE;
  providerRuntimeVersion: typeof RUNTIME_VERSION;
  economicEvidenceCredit: 0;
  profitabilityCredit: 0;
  executionAuthority: 'NONE';
};

type RuntimeEvidence = {
  available: true;
  dataState: 'MEASURED';
  runtimeVersion: typeof RUNTIME_VERSION;
  status: 'SUCCESS';
  provider: 'YOUTUBE_DATA_API_V3';
  providerAccess: 'OFFICIAL_PUBLIC_API';
  requestMode: 'READ_ONLY_GET';
  query: string;
  pagesUsed: number;
  quotaState: string;
  credentialConfigured: true;
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
  snapshotProvenance: SnapshotProvenance;
  economicEvidenceCredit: 0;
  profitabilityCredit: 0;
  executionAuthority: 'NONE';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function canonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function canonicalYoutubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function parseRuntimeEvidence(value: unknown): RuntimeEvidence | null {
  if (!isRecord(value) || value.available !== true || value.dataState !== 'MEASURED') return null;
  if (value.runtimeVersion !== RUNTIME_VERSION || value.status !== 'SUCCESS') return null;
  if (value.provider !== 'YOUTUBE_DATA_API_V3' || value.providerAccess !== 'OFFICIAL_PUBLIC_API' || value.requestMode !== 'READ_ONLY_GET') return null;
  if (value.credentialValueExposed !== false || value.credentialConfigured !== true) return null;
  if (typeof value.query !== 'string' || !value.query.trim() || typeof value.quotaState !== 'string' || !value.quotaState.trim()) return null;
  if (typeof value.pagesUsed !== 'number' || !Number.isSafeInteger(value.pagesUsed) || value.pagesUsed < 0 || value.pagesUsed > 1) return null;
  if (typeof value.sourceCount !== 'number' || !Number.isSafeInteger(value.sourceCount) || value.sourceCount < 0 || value.sourceCount > 5) return null;
  if (!Array.isArray(value.records) || value.records.length !== value.sourceCount) return null;
  if (!isRecord(value.safety)) return null;
  const safety = value.safety;
  if (safety.researchOnly !== true || safety.economicEvidenceCredit !== 0 || safety.profitabilityCredit !== 0 || safety.executionAuthority !== 'NONE') return null;
  if (safety.paidProviderEnabled !== false || safety.scheduleActive !== false || safety.automaticDiscoveryEnabled !== false) return null;
  if (safety.liveTrading !== false || safety.privateTradingApi !== false || safety.realOrderEnabled !== false || safety.credentialMutation !== false || safety.transcriptDownloadEnabled !== false) return null;
  if (value.economicEvidenceCredit !== 0 || value.profitabilityCredit !== 0 || value.executionAuthority !== 'NONE') return null;

  if (!isRecord(value.snapshotProvenance)) return null;
  const provenance = value.snapshotProvenance;
  if (provenance.schemaVersion !== SNAPSHOT_SCHEMA || provenance.publisherMode !== SNAPSHOT_PUBLISHER_MODE || provenance.providerRuntimeVersion !== RUNTIME_VERSION) return null;
  if (typeof provenance.sourceHeadSha !== 'string' || !/^[0-9a-f]{40}$/u.test(provenance.sourceHeadSha)) return null;
  if (!canonicalIsoTimestamp(provenance.observedAt)) return null;
  if (provenance.economicEvidenceCredit !== 0 || provenance.profitabilityCredit !== 0 || provenance.executionAuthority !== 'NONE') return null;

  for (const record of value.records) {
    if (!isRecord(record)) return null;
    if (typeof record.videoId !== 'string' || !record.videoId.trim()) return null;
    if (record.canonicalUrl !== canonicalYoutubeUrl(record.videoId)) return null;
    if (typeof record.title !== 'string' || !record.title.trim()) return null;
    if (!nullableString(record.channelOrPublisher) || !nullableString(record.publishedAt) || !nullableString(record.discoveredAt) || !nullableString(record.language)) return null;
    if (record.durationSec !== null && (typeof record.durationSec !== 'number' || !Number.isFinite(record.durationSec) || record.durationSec < 0)) return null;
    if (typeof record.transcriptStatus !== 'string' || !TRANSCRIPT_STATUSES.has(record.transcriptStatus)) return null;
    if (record.captionsKnownPresent !== null && typeof record.captionsKnownPresent !== 'boolean') return null;
    if (typeof record.sourceTrustTier !== 'string' || !SOURCE_TRUST_TIERS.has(record.sourceTrustTier)) return null;
    if (record.contentAuthority !== 'UNTRUSTED_EXTERNAL_DATA' || record.economicEvidenceCredit !== 0 || record.profitabilityCredit !== 0 || record.executionAuthority !== 'NONE') return null;
  }
  return value as unknown as RuntimeEvidence;
}

function uniqueSorted(values: string[]) {
  return [...new Set(values.map((value) => value.trim().toUpperCase()).filter(Boolean))].sort();
}

function describeStrategyMiningState(evidence: RuntimeEvidence | null) {
  if (!evidence) return 'UNKNOWN — strategy mining evidence missing != 0';
  if (evidence.sourceCount === 0) return 'NOT_APPLICABLE — measured video sourceCount 0';
  const transcriptStatuses = uniqueSorted(evidence.records.map((record) => record.transcriptStatus));
  if (transcriptStatuses.includes('AVAILABLE')) {
    return 'UNKNOWN — authorized transcript exists; source-bound strategy mining evidence not connected';
  }
  if (transcriptStatuses.length === 1) {
    return `BLOCKED_TRANSCRIPT_${transcriptStatuses[0]} — authorized transcript required; no caption bypass`;
  }
  if (transcriptStatuses.length > 1) {
    return `BLOCKED_TRANSCRIPT — ${transcriptStatuses.join(' / ')}; authorized transcript required`;
  }
  return 'UNKNOWN — transcript state missing != 0';
}

function describeRecordStrategyMiningState(record: RuntimeRecord) {
  return record.transcriptStatus === 'AVAILABLE'
    ? 'UNKNOWN — authorized transcript exists; source-bound strategy mining evidence not connected'
    : `BLOCKED_TRANSCRIPT_${record.transcriptStatus} — authorized transcript required; no caption bypass`;
}

function describeTranscriptAccessState(evidence: RuntimeEvidence | null) {
  if (!evidence) return '승인된 입력만 허용';
  if (evidence.sourceCount === 0) return 'NOT_APPLICABLE — measured video sourceCount 0';
  const statuses = uniqueSorted(evidence.records.map((record) => record.transcriptStatus));
  return statuses.length === 1 ? statuses[0] : `MULTI_SOURCE — ${statuses.join(' / ')}`;
}

function describeTranscriptSegmentState(evidence: RuntimeEvidence | null) {
  if (!evidence) return 'UNKNOWN — missing != 0';
  if (evidence.sourceCount === 0) return 'NOT_APPLICABLE — measured video sourceCount 0';
  const statuses = uniqueSorted(evidence.records.map((record) => record.transcriptStatus));
  if (statuses.length === 1) {
    return statuses[0] === 'AVAILABLE'
      ? 'UNKNOWN — authorized transcript segment evidence not connected'
      : `UNKNOWN — transcript ${statuses[0]}; segment count not measured`;
  }
  return `UNKNOWN — multi-source transcript states ${statuses.join(' / ')}; segment count not measured`;
}

function describeSourceAuthorityState(evidence: RuntimeEvidence | null) {
  if (!evidence) return 'UNKNOWN';
  if (evidence.sourceCount === 0) return 'NOT_APPLICABLE — measured video sourceCount 0';
  const tiers = uniqueSorted(evidence.records.map((record) => record.sourceTrustTier));
  return tiers.length === 1 ? tiers[0] : `MULTI_SOURCE — ${tiers.join(' / ')}`;
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
    void authorizedFetch('/api/research/video/evidence', {
      method: 'GET',
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

  const runtimeState = runtimeEvidence
    ? `MEASURED · sanitized reader connected · ${runtimeEvidence.sourceCount} source${runtimeEvidence.sourceCount === 1 ? '' : 's'}`
    : readerSettled
      ? 'UNKNOWN — sanitized runtime snapshot unavailable'
      : 'UNKNOWN — sanitized runtime evidence loading';
  const sourceCountState = runtimeEvidence
    ? `${runtimeEvidence.sourceCount} — measured sanitized public-provider result`
    : 'UNKNOWN — missing runtime snapshot != 0';
  const strategyMiningState = describeStrategyMiningState(runtimeEvidence);
  const transcriptAccessState = describeTranscriptAccessState(runtimeEvidence);
  const transcriptSegmentState = describeTranscriptSegmentState(runtimeEvidence);
  const sourceAuthorityState = describeSourceAuthorityState(runtimeEvidence);
  const compilerState = runtimeEvidence?.records.some((record) => record.transcriptStatus === 'AVAILABLE')
    ? 'NOT_EVALUATED — source-bound TESTABLE strategy evidence required'
    : 'BLOCKED — authorized transcript required before strategy extraction/compiler';

  const statusRows = [
    ['Video discovery', '수동 / 공식 public API runtime'],
    ['Provider runtime', runtimeEvidence ? `${runtimeEvidence.provider} / ${runtimeEvidence.requestMode}` : 'UNKNOWN — sanitized runtime snapshot unavailable'],
    ['Runtime evidence', runtimeState],
    ['Transcript access', transcriptAccessState],
    ['Economic Evidence', '0'],
    ['Execution Authority', 'NONE'],
  ] as const;

  const phase2Sections = [
    {
      title: 'Discovery',
      testId: 'video-discovery-state',
      rows: [
        ['검색 경로', 'YouTube Data API 공식/public metadata'],
        ['Provider runtime', runtimeEvidence ? `${runtimeEvidence.providerAccess} / ${runtimeEvidence.requestMode}` : 'UNKNOWN — sanitized runtime snapshot unavailable'],
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
        ['상태', runtimeEvidence ? transcriptAccessState : 'UNKNOWN — authorized transcript evidence 없음'],
        ['권한', '승인된 transcript만 ingest'],
        ['Segment', transcriptSegmentState],
        ['Timestamp coverage', 'UNKNOWN_TIMESTAMP'],
        ['우회 다운로드', 'DISABLED'],
      ],
    },
    {
      title: 'Strategy',
      testId: 'video-strategy-state',
      rows: [
        ['Strategy mining', strategyMiningState],
        ['Strategy family', 'UNKNOWN'],
        ['Market / Side / Timeframe', 'UNSPECIFIED'],
        ['Entry / Exit', 'UNSPECIFIED'],
        ['SL / TP', 'UNSPECIFIED'],
        ['Testability', strategyMiningState],
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
        ['Source authority', sourceAuthorityState],
        ['Snapshot provenance', runtimeEvidence ? `${runtimeEvidence.snapshotProvenance.schemaVersion} · ${runtimeEvidence.snapshotProvenance.sourceHeadSha.slice(0, 12)} · ${runtimeEvidence.snapshotProvenance.observedAt}` : 'UNKNOWN — sanitized provenance unavailable'],
      ],
    },
    {
      title: 'Validation',
      testId: 'video-validation-state',
      rows: [
        ['Cross-validation', 'NOT_CHECKED'],
        ['Compiler', compilerState],
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
            {runtimeEvidence?.records.length ? (
              <div className="mt-3 space-y-3">
                {runtimeEvidence.records.map((record, index) => (
                  <div key={record.videoId} className="rounded-xl border border-card-border bg-muted/30 p-3" data-testid={`video-detail-record-${index}`}>
                    <div className="text-xs text-muted-foreground">Source {index + 1} / {runtimeEvidence.sourceCount}</div>
                    <dl className="mt-2 space-y-2 text-sm">
                      <div><dt className="text-muted-foreground">Title</dt><dd className="break-words font-medium">{record.title}</dd></div>
                      <div><dt className="text-muted-foreground">Channel / Publisher</dt><dd className="break-words font-medium">{record.channelOrPublisher ?? 'UNKNOWN'}</dd></div>
                      <div><dt className="text-muted-foreground">Transcript</dt><dd className="font-medium">{record.transcriptStatus}</dd></div>
                      <div><dt className="text-muted-foreground">Source authority</dt><dd className="break-words font-medium">{record.sourceTrustTier}</dd></div>
                      <div><dt className="text-muted-foreground">Strategy mining</dt><dd className="break-words font-medium">{describeRecordStrategyMiningState(record)}</dd></div>
                      <div><dt className="text-muted-foreground">Provenance</dt><dd className="break-words font-medium">{runtimeEvidence.providerAccess} · {record.contentAuthority} · {runtimeEvidence.snapshotProvenance.schemaVersion} · {runtimeEvidence.snapshotProvenance.sourceHeadSha.slice(0, 12)}</dd></div>
                    </dl>
                  </div>
                ))}
              </div>
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
              {runtimeEvidence
                ? `${strategyMiningState}. Strategy mining evidence가 없으면 cluster count는 0으로 만들지 않고 UNKNOWN으로 유지합니다.`
                : 'sanitized runtime evidence가 없으므로 strategy cluster 존재 여부도 UNKNOWN입니다. missing을 0으로 만들지 않습니다.'}
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
