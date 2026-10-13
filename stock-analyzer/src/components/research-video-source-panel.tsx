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

type DiscoveryAutomation = {
  schemaVersion: 'research-video-discovery-scan-v1';
  status: 'COMPLETE' | 'BLOCKED' | 'WAITING_CONFIGURATION';
  observedAt: string;
  researchSha: string;
  query: string | null;
  sourceCount: number | null;
  snapshotDigest: string | null;
  providerNetworkCalls: number;
  invocationMode: 'MANUAL' | 'SYSTEMD_TIMER';
  scheduledInvocationObserved: boolean;
  reason: string | null;
  nextRequiredStep: string;
  snapshotBound: boolean;
};

type AiReviewStatus = {
  status: 'WAITING_FOR_FREE_AI' | 'PARTIAL_AI_UNAVAILABLE' | 'COMPLETE' | 'NO_NEW_EVIDENCE';
  observedAt: number;
  researchSha: string;
  provider: 'groq' | 'gemini' | null;
  model: 'openai/gpt-oss-20b' | 'gemini-3.1-flash-lite' | null;
  reason: string;
  providerNetworkCalls: number;
  cacheHits: number;
  reviewCount: number;
  proposerReviewCount: number;
  criticReviewCount: number;
  missingProfileCount: number;
  blockedProfileCount: number;
  deferredProfileCount: number;
  invocationMode: 'MANUAL' | 'SYSTEMD_TIMER';
  scheduledInvocationObserved: boolean;
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
  automation: DiscoveryAutomation | null;
  aiReview: AiReviewStatus | null;
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

function parseDiscoveryAutomation(value: unknown): DiscoveryAutomation | null {
  if (value == null) return null;
  if (!isRecord(value) || value.schemaVersion !== 'research-video-discovery-scan-v1') return null;
  if (value.status !== 'COMPLETE' && value.status !== 'BLOCKED' && value.status !== 'WAITING_CONFIGURATION') return null;
  if (!canonicalIsoTimestamp(value.observedAt)
    || typeof value.researchSha !== 'string' || !/^[0-9a-f]{40}$/u.test(value.researchSha)
    || (value.invocationMode !== 'MANUAL' && value.invocationMode !== 'SYSTEMD_TIMER')
    || typeof value.scheduledInvocationObserved !== 'boolean'
    || typeof value.providerNetworkCalls !== 'number' || !Number.isSafeInteger(value.providerNetworkCalls)
    || value.providerNetworkCalls < 0 || value.providerNetworkCalls > 1
    || (value.query !== null && (typeof value.query !== 'string' || !value.query.trim() || value.query.length > 120))
    || (value.sourceCount !== null && (typeof value.sourceCount !== 'number' || !Number.isSafeInteger(value.sourceCount) || value.sourceCount < 0 || value.sourceCount > 5))
    || (value.snapshotDigest !== null && (typeof value.snapshotDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.snapshotDigest)))
    || (value.reason !== null && (typeof value.reason !== 'string' || !/^[A-Z0-9_:-]{1,160}$/u.test(value.reason)))
    || typeof value.nextRequiredStep !== 'string' || !/^[A-Z0-9_:-]{1,160}$/u.test(value.nextRequiredStep)
    || typeof value.snapshotBound !== 'boolean') return null;
  return value as unknown as DiscoveryAutomation;
}

function parseAiReview(value: unknown): AiReviewStatus | null {
  if (value == null) return null;
  if (!isRecord(value)) return null;
  const statuses = new Set(['WAITING_FOR_FREE_AI','PARTIAL_AI_UNAVAILABLE','COMPLETE','NO_NEW_EVIDENCE']);
  if (!statuses.has(String(value.status ?? ''))) return null;
  if (typeof value.observedAt !== 'number' || !Number.isSafeInteger(value.observedAt) || value.observedAt <= 0) return null;
  if (typeof value.researchSha !== 'string' || !/^[0-9a-f]{40}$/u.test(value.researchSha)) return null;
  if (value.provider !== null && value.provider !== 'groq' && value.provider !== 'gemini') return null;
  if (value.model !== null && value.model !== 'openai/gpt-oss-20b' && value.model !== 'gemini-3.1-flash-lite') return null;
  if (typeof value.reason !== 'string' || !/^[A-Z0-9_.:-]{1,160}$/u.test(value.reason)) return null;
  if (value.invocationMode !== 'MANUAL' && value.invocationMode !== 'SYSTEMD_TIMER') return null;
  if (typeof value.scheduledInvocationObserved !== 'boolean') return null;
  const keys = ['providerNetworkCalls','cacheHits','reviewCount','proposerReviewCount','criticReviewCount','missingProfileCount','blockedProfileCount','deferredProfileCount'] as const;
  if (keys.some((key) => typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || (value[key] as number) < 0 || (value[key] as number) > 3)) return null;
  const reviewCount = value.reviewCount as number;
  const proposerReviewCount = value.proposerReviewCount as number;
  const criticReviewCount = value.criticReviewCount as number;
  if (proposerReviewCount + criticReviewCount !== reviewCount) return null;
  return value as unknown as AiReviewStatus;
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
  const automation = parseDiscoveryAutomation(value.automation);
  const aiReview = parseAiReview(value.aiReview);
  if ((value.automation != null && !automation) || (value.aiReview != null && !aiReview)) return null;

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
  return { ...(value as unknown as RuntimeEvidence), automation, aiReview };
}

function formatEpochTime(value: number) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '시간 미확인';
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(date);
}

function formatAutomationTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '시간 미확인';
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(date);
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
  const [automationReadback, setAutomationReadback] = useState<DiscoveryAutomation | null>(null);
  const [aiReviewReadback, setAiReviewReadback] = useState<AiReviewStatus | null>(null);
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
        const measured = parseRuntimeEvidence(payload);
        setRuntimeEvidence(measured);
        setAutomationReadback(isRecord(payload) ? parseDiscoveryAutomation(payload.automation) : null);
        setAiReviewReadback(isRecord(payload) ? parseAiReview(payload.aiReview) : null);
        setReaderSettled(true);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        setRuntimeEvidence(null);
        setAutomationReadback(null);
        setAiReviewReadback(null);
        setReaderSettled(true);
      });
    return () => controller.abort();
  }, []);

  const automation = automationReadback ?? runtimeEvidence?.automation ?? null;
  const aiReview = aiReviewReadback ?? runtimeEvidence?.aiReview ?? null;
  const collectionLabel = !automation ? '미확인'
    : automation.status !== 'COMPLETE' ? '설정·자료 확인 필요'
      : !automation.snapshotBound ? '기록 연결 확인 필요'
        : automation.scheduledInvocationObserved ? '자동 실행 확인' : '수동 실행 확인';
  const aiLabel = !aiReview ? '미확인'
    : aiReview.status === 'WAITING_FOR_FREE_AI' ? '연결 대기'
      : aiReview.status === 'PARTIAL_AI_UNAVAILABLE' ? '부분 오류'
        : aiReview.status === 'NO_NEW_EVIDENCE' ? '새 자료 대기'
          : aiReview.reviewCount > 0 ? '검토 기록 있음' : '분석기 실행 · 검토 0건';
  const transcriptLabel = (status: string) => status === 'AVAILABLE' ? '전사본 준비됨'
    : status === 'NOT_AUTHORIZED' ? '전사본 사용 권한 필요'
      : status === 'RATE_LIMITED' || status === 'QUOTA_EXCEEDED' ? '조회 한도 대기'
        : status === 'PROVIDER_NOT_CONFIGURED' ? '제공자 연결 필요' : '전사본 없음';
  return (
    <section className="mx-auto w-full max-w-5xl space-y-3 p-3 [overflow-wrap:anywhere] sm:p-5" data-testid="research-video-panel">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-black">영상 연구</h1>
        <span className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">연구 전용</span>
      </header>
      {!readerSettled ? <p role="status">영상 자료를 불러오는 중…</p> : null}
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['영상', runtimeEvidence ? `${runtimeEvidence.sourceCount}개` : '미확인', 'video-source-count'],
          ['자동 수집', collectionLabel, 'video-discovery-state'],
          ['AI 분석', aiLabel, 'video-validation-state'],
          ['분석 기록', aiReview ? `${aiReview.reviewCount}건` : '미확인', 'video-review-count'],
        ].map(([label, value, id]) => <div key={label} data-testid={id} className="min-w-0 rounded-xl border border-card-border bg-card p-3"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-2 text-sm font-bold">{value}</dd></div>)}
      </dl>
      <section aria-label="영상 자료" className="space-y-2" data-testid="video-detail-empty-state">
        {runtimeEvidence?.records.length ? runtimeEvidence.records.map((record, index) => (
          <article key={record.videoId} data-testid={`video-detail-record-${index}`} className="rounded-xl border border-card-border bg-card p-4">
            <a href={record.canonicalUrl} target="_blank" rel="noopener noreferrer" className="font-bold text-primary underline">{record.title}</a>
            <p className="mt-2 text-xs text-muted-foreground">{record.channelOrPublisher ?? '발행자 미확인'} · {record.publishedAt ? formatAutomationTime(record.publishedAt) : '발행일 미확인'}</p>
            <p className="mt-2 text-sm">{transcriptLabel(record.transcriptStatus)}</p>
            <details className="mt-2 text-xs"><summary className="min-h-11 cursor-pointer py-3">출처 확인</summary>
              <p>원문 상태 · {record.transcriptStatus}</p><p>출처 등급 · {record.sourceTrustTier}</p>
              <p>전략 추출 · {record.transcriptStatus === 'AVAILABLE' ? '연결 기록 미확인' : '사용 가능한 전사본 필요'}</p>
            </details>
          </article>
        )) : <p className="rounded-xl border border-dashed border-card-border p-4 text-sm text-muted-foreground">{runtimeEvidence ? '수집된 영상이 없습니다.' : '영상 수집 결과를 아직 확인하지 못했습니다.'}</p>}
      </section>
      <details className="rounded-xl border border-card-border bg-card p-3">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-bold">수집·분석 기록</summary>
        <dl className="space-y-2 text-xs">
          <div><dt>마지막 수집</dt><dd>{automation ? formatAutomationTime(automation.observedAt) : '미확인'}</dd></div>
          <div><dt>마지막 AI 분석</dt><dd>{aiReview ? formatEpochTime(aiReview.observedAt) : '미확인'}</dd></div>
          <div><dt>자료 소스 버전</dt><dd className="break-all">{runtimeEvidence?.snapshotProvenance.sourceHeadSha ?? '미확인'}</dd></div>
          <div><dt>진단 코드</dt><dd className="break-all">{automation?.reason ?? aiReview?.reason ?? '미확인'}</dd></div>
          <div><dt>자료 연결</dt><dd>{runtimeEvidence ? '측정 자료 연결됨' : '미확인'}</dd></div>
          <div><dt>자료 지문</dt><dd className="break-all">{automation?.snapshotDigest ?? '미확인'}</dd></div>
          <div><dt>분석기 실행</dt><dd>{aiReview ? aiReview.scheduledInvocationObserved ? '자동 실행 확인' : '수동 실행 확인' : '미확인'}</dd></div>
          <div><dt>제안 검토 / 반대 검토</dt><dd>{aiReview ? `${aiReview.proposerReviewCount} / ${aiReview.criticReviewCount}` : '미확인'}</dd></div>
          <div><dt>실행 권한</dt><dd>없음 · 수익성 증거로 사용하지 않음</dd></div>
        </dl>
      </details>
    </section>
  );
}
