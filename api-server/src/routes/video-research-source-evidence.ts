import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Router, type IRouter } from 'express';

const RUNTIME_VERSION = 'video-research-public-provider-runtime-v3';
const PROVIDER = 'YOUTUBE_DATA_API_V3';
const PROVIDER_ACCESS = 'OFFICIAL_PUBLIC_API';
const REQUEST_MODE = 'READ_ONLY_GET';
const SNAPSHOT_FILE = 'video-research-public-provider-runtime-v3.json';
const SNAPSHOT_SCHEMA = 'video-research-sanitized-snapshot-v1';
const SNAPSHOT_PUBLISHER_MODE = 'LOCAL_ATOMIC_FILE';
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

const REQUIRED_SAFETY = Object.freeze({
  researchOnly: true,
  economicEvidenceCredit: 0,
  profitabilityCredit: 0,
  executionAuthority: 'NONE',
  paidProviderEnabled: false,
  scheduleActive: false,
  automaticDiscoveryEnabled: false,
  liveTrading: false,
  privateTradingApi: false,
  realOrderEnabled: false,
  credentialMutation: false,
  transcriptDownloadEnabled: false,
});

const SAFE_CREDENTIAL_METADATA = new Set([
  'credentialConfigured',
  'credentialEnvName',
  'credentialValueExposed',
  'credentialMutation',
]);
const FORBIDDEN_KEY = /(api.?key|access.?token|refresh.?token|secret|password|credential)/iu;

type SnapshotLoader = () => Promise<unknown>;

type SafeRecord = {
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

type SafeAutomation = {
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

type SafeAiReview = {
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

type SafeSnapshotProvenance = {
  schemaVersion: typeof SNAPSHOT_SCHEMA;
  sourceHeadSha: string;
  observedAt: string;
  publisherMode: typeof SNAPSHOT_PUBLISHER_MODE;
  providerRuntimeVersion: typeof RUNTIME_VERSION;
  economicEvidenceCredit: 0;
  profitabilityCredit: 0;
  executionAuthority: 'NONE';
};

type SafeEvidence = {
  runtimeVersion: typeof RUNTIME_VERSION;
  status: 'SUCCESS';
  provider: typeof PROVIDER;
  providerAccess: typeof PROVIDER_ACCESS;
  requestMode: typeof REQUEST_MODE;
  query: string;
  pagesUsed: number;
  quotaState: string;
  credentialConfigured: true;
  credentialValueExposed: false;
  sourceCount: number;
  records: SafeRecord[];
  safety: typeof REQUIRED_SAFETY;
  snapshotProvenance: SafeSnapshotProvenance;
  automation: SafeAutomation | null;
  aiReview: SafeAiReview | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsForbiddenCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenCredentialKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => {
    if (SAFE_CREDENTIAL_METADATA.has(key)) return containsForbiddenCredentialKey(nested);
    if (FORBIDDEN_KEY.test(key)) return true;
    return containsForbiddenCredentialKey(nested);
  });
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

function exactSha(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{40}$/iu.test(value) ? value.toLowerCase() : null;
}

function canonicalIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const normalized = parsed.toISOString();
  return normalized === value ? normalized : null;
}

function canonicalYoutubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function safeRecord(value: unknown): SafeRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.videoId !== 'string' || !value.videoId.trim()) return null;
  if (value.canonicalUrl !== canonicalYoutubeUrl(value.videoId)) return null;
  if (typeof value.title !== 'string' || !value.title.trim()) return null;
  const channelOrPublisher = nullableString(value.channelOrPublisher);
  const publishedAt = nullableString(value.publishedAt);
  const discoveredAt = nullableString(value.discoveredAt);
  const language = nullableString(value.language);
  if (channelOrPublisher === undefined || publishedAt === undefined || discoveredAt === undefined || language === undefined) return null;
  const durationSec = value.durationSec === null
    ? null
    : typeof value.durationSec === 'number' && Number.isFinite(value.durationSec) && value.durationSec >= 0
      ? value.durationSec
      : undefined;
  if (durationSec === undefined) return null;
  if (typeof value.transcriptStatus !== 'string' || !TRANSCRIPT_STATUSES.has(value.transcriptStatus)) return null;
  if (value.captionsKnownPresent !== null && typeof value.captionsKnownPresent !== 'boolean') return null;
  if (typeof value.sourceTrustTier !== 'string' || !SOURCE_TRUST_TIERS.has(value.sourceTrustTier)) return null;
  if (value.contentAuthority !== 'UNTRUSTED_EXTERNAL_DATA') return null;
  if (value.economicEvidenceCredit !== 0 || value.profitabilityCredit !== 0 || value.executionAuthority !== 'NONE') return null;

  return {
    videoId: value.videoId,
    canonicalUrl: value.canonicalUrl,
    title: value.title,
    channelOrPublisher,
    publishedAt,
    discoveredAt,
    language,
    durationSec,
    transcriptStatus: value.transcriptStatus,
    captionsKnownPresent: value.captionsKnownPresent,
    sourceTrustTier: value.sourceTrustTier,
    contentAuthority: 'UNTRUSTED_EXTERNAL_DATA',
    economicEvidenceCredit: 0,
    profitabilityCredit: 0,
    executionAuthority: 'NONE',
  };
}

function safeSnapshotProvenance(value: unknown): SafeSnapshotProvenance | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SNAPSHOT_SCHEMA) return null;
  const sourceHeadSha = exactSha(value.sourceHeadSha);
  const observedAt = canonicalIsoTimestamp(value.observedAt);
  if (!sourceHeadSha || !observedAt) return null;
  if (value.publisherMode !== SNAPSHOT_PUBLISHER_MODE || value.providerRuntimeVersion !== RUNTIME_VERSION) return null;
  if (value.economicEvidenceCredit !== 0 || value.profitabilityCredit !== 0 || value.executionAuthority !== 'NONE') return null;
  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    sourceHeadSha,
    observedAt,
    publisherMode: SNAPSHOT_PUBLISHER_MODE,
    providerRuntimeVersion: RUNTIME_VERSION,
    economicEvidenceCredit: 0,
    profitabilityCredit: 0,
    executionAuthority: 'NONE',
  };
}

function safeAutomation(
  value: unknown,
  binding?: { provenance: SafeSnapshotProvenance; query: string; sourceCount: number },
): SafeAutomation | null {
  if (value == null) return null;
  if (!isRecord(value) || value.schemaVersion !== 'research-video-discovery-scan-v1') return null;
  if (value.status !== 'COMPLETE' && value.status !== 'BLOCKED' && value.status !== 'WAITING_CONFIGURATION') return null;
  const observedAt = canonicalIsoTimestamp(value.observedAt);
  const researchSha = exactSha(value.researchSha);
  const query = value.query === null ? null : typeof value.query === 'string' && value.query.trim() && value.query.length <= 120 ? value.query : undefined;
  const sourceCount = value.sourceCount === null ? null : typeof value.sourceCount === 'number' && Number.isSafeInteger(value.sourceCount) && value.sourceCount >= 0 && value.sourceCount <= 5 ? value.sourceCount : undefined;
  const snapshotDigest = value.snapshotDigest === null ? null : typeof value.snapshotDigest === 'string' && /^[0-9a-f]{64}$/u.test(value.snapshotDigest) ? value.snapshotDigest : undefined;
  const reason = value.reason === null ? null : typeof value.reason === 'string' && /^[A-Z0-9_:-]{1,160}$/u.test(value.reason) ? value.reason : undefined;
  const nextRequiredStep = typeof value.nextRequiredStep === 'string' && /^[A-Z0-9_:-]{1,160}$/u.test(value.nextRequiredStep) ? value.nextRequiredStep : null;
  if (!observedAt || !researchSha || query === undefined || sourceCount === undefined || snapshotDigest === undefined || reason === undefined || !nextRequiredStep) return null;
  if (value.invocationMode !== 'MANUAL' && value.invocationMode !== 'SYSTEMD_TIMER') return null;
  if (typeof value.scheduledInvocationObserved !== 'boolean'
    || typeof value.providerNetworkCalls !== 'number' || !Number.isSafeInteger(value.providerNetworkCalls)
    || value.providerNetworkCalls < 0 || value.providerNetworkCalls > 1) return null;
  const snapshotBound = Boolean(
    binding
    && value.status === 'COMPLETE'
    && researchSha === binding.provenance.sourceHeadSha
    && observedAt === binding.provenance.observedAt
    && query === binding.query
    && sourceCount === binding.sourceCount
  );
  return {
    schemaVersion: 'research-video-discovery-scan-v1',
    status: value.status,
    observedAt,
    researchSha,
    query,
    sourceCount,
    snapshotDigest,
    providerNetworkCalls: value.providerNetworkCalls,
    invocationMode: value.invocationMode,
    scheduledInvocationObserved: value.scheduledInvocationObserved,
    reason,
    nextRequiredStep,
    snapshotBound,
  };
}

function safeAiReview(value: unknown): SafeAiReview | null {
  if (value == null) return null;
  if (!isRecord(value)) return null;
  const statuses = new Set(['WAITING_FOR_FREE_AI','PARTIAL_AI_UNAVAILABLE','COMPLETE','NO_NEW_EVIDENCE']);
  if (!statuses.has(String(value.status ?? ''))) return null;
  if (typeof value.observedAt !== 'number' || !Number.isSafeInteger(value.observedAt) || value.observedAt <= 0) return null;
  const researchSha = exactSha(value.researchSha);
  const provider = value.provider === null ? null : value.provider === 'groq' || value.provider === 'gemini' ? value.provider : undefined;
  const model = value.model === null ? null : value.model === 'openai/gpt-oss-20b' || value.model === 'gemini-3.1-flash-lite' ? value.model : undefined;
  const reason = typeof value.reason === 'string' && /^[A-Z0-9_.:-]{1,160}$/u.test(value.reason) ? value.reason : null;
  const countKeys = ['providerNetworkCalls','cacheHits','reviewCount','proposerReviewCount','criticReviewCount','missingProfileCount','blockedProfileCount','deferredProfileCount'] as const;
  if (!researchSha || provider === undefined || model === undefined || !reason) return null;
  if (value.invocationMode !== 'MANUAL' && value.invocationMode !== 'SYSTEMD_TIMER') return null;
  if (typeof value.scheduledInvocationObserved !== 'boolean') return null;
  if (countKeys.some((key) => typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || (value[key] as number) < 0 || (value[key] as number) > 3)) return null;
  const reviewCount = value.reviewCount as number;
  const proposerReviewCount = value.proposerReviewCount as number;
  const criticReviewCount = value.criticReviewCount as number;
  if (proposerReviewCount + criticReviewCount !== reviewCount) return null;
  return {
    status: value.status as SafeAiReview['status'],
    observedAt: value.observedAt,
    researchSha,
    provider,
    model,
    reason,
    providerNetworkCalls: value.providerNetworkCalls as number,
    cacheHits: value.cacheHits as number,
    reviewCount,
    proposerReviewCount,
    criticReviewCount,
    missingProfileCount: value.missingProfileCount as number,
    blockedProfileCount: value.blockedProfileCount as number,
    deferredProfileCount: value.deferredProfileCount as number,
    invocationMode: value.invocationMode as SafeAiReview['invocationMode'],
    scheduledInvocationObserved: value.scheduledInvocationObserved,
  };
}

function safetyMatches(value: unknown): value is typeof REQUIRED_SAFETY {
  if (!isRecord(value)) return false;
  return Object.entries(REQUIRED_SAFETY).every(([key, expected]) => value[key] === expected);
}

export function sanitizeVideoResearchRuntimeEvidence(value: unknown): SafeEvidence | null {
  if (!isRecord(value) || containsForbiddenCredentialKey(value)) return null;
  if (value.runtimeVersion !== RUNTIME_VERSION || value.status !== 'SUCCESS' || value.provider !== PROVIDER) return null;
  if (value.providerAccess !== PROVIDER_ACCESS || value.requestMode !== REQUEST_MODE) return null;
  if (value.credentialValueExposed !== false || value.credentialConfigured !== true) return null;
  if (typeof value.query !== 'string' || !value.query.trim()) return null;
  if (typeof value.pagesUsed !== 'number' || !Number.isSafeInteger(value.pagesUsed) || value.pagesUsed < 0 || value.pagesUsed > 1) return null;
  if (typeof value.quotaState !== 'string' || !value.quotaState) return null;
  if (typeof value.sourceCount !== 'number' || !Number.isSafeInteger(value.sourceCount) || value.sourceCount < 0 || value.sourceCount > 5) return null;
  if (!Array.isArray(value.records) || value.records.length !== value.sourceCount) return null;
  if (!safetyMatches(value.safety)) return null;
  const snapshotProvenance = safeSnapshotProvenance(value.snapshotProvenance);
  if (!snapshotProvenance) return null;
  const automation = safeAutomation(value.automation, {
    provenance: snapshotProvenance,
    query: value.query,
    sourceCount: value.sourceCount,
  });
  const aiReview = safeAiReview(value.aiReview);
  if ((value.automation != null && !automation) || (value.aiReview != null && !aiReview)) return null;

  const records = value.records.map(safeRecord);
  if (records.some((record) => record === null)) return null;

  return {
    runtimeVersion: RUNTIME_VERSION,
    status: 'SUCCESS',
    provider: PROVIDER,
    providerAccess: PROVIDER_ACCESS,
    requestMode: REQUEST_MODE,
    query: value.query,
    pagesUsed: value.pagesUsed,
    quotaState: value.quotaState,
    credentialConfigured: true,
    credentialValueExposed: false,
    sourceCount: value.sourceCount,
    records: records as SafeRecord[],
    safety: REQUIRED_SAFETY,
    snapshotProvenance,
    automation,
    aiReview,
  };
}

export async function loadVideoResearchRuntimeEvidenceSnapshot(
  fetchImpl: typeof fetch = fetch,
  candidates: string[] = [
    resolve(process.cwd(), 'api-server', 'data', SNAPSHOT_FILE),
    resolve(process.cwd(), 'data', SNAPSHOT_FILE),
  ],
): Promise<unknown> {
  // The durable Research Dashboard readback is authoritative. A local snapshot
  // is compatibility fallback only when the fixed loopback endpoint is unavailable.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  let dashboardUnavailable = false;
  try {
    const response = await fetchImpl('http://127.0.0.1:18090/api/research/video/evidence', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.ok) {
      const payload = await response.json() as unknown;
      if (isRecord(payload) && payload.available === true) return payload;
      if (isRecord(payload) && payload.available === false) return null;
      dashboardUnavailable = true;
    } else {
      dashboardUnavailable = true;
    }
  } catch {
    dashboardUnavailable = true;
  } finally {
    clearTimeout(timer);
  }

  if (!dashboardUnavailable) return null;
  for (const path of candidates) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (sanitizeVideoResearchRuntimeEvidence(value)) return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return null;
}
function unavailable(reason: string) {
  return {
    ok: false,
    available: false,
    dataState: 'UNKNOWN',
    reason,
    provider: PROVIDER,
    providerAccess: PROVIDER_ACCESS,
    requestMode: REQUEST_MODE,
    credentialValueExposed: false,
    economicEvidenceCredit: 0,
    profitabilityCredit: 0,
    executionAuthority: 'NONE',
  } as const;
}

export function createVideoResearchEvidenceRouter(loadSnapshot: SnapshotLoader = loadVideoResearchRuntimeEvidenceSnapshot): IRouter {
  const router: IRouter = Router();
  router.get('/', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    let raw: unknown;
    try {
      raw = await loadSnapshot();
    } catch {
      res.status(200).json(unavailable('SANITIZED_RUNTIME_EVIDENCE_UNAVAILABLE'));
      return;
    }
    if (raw === null || raw === undefined) {
      res.status(200).json(unavailable('SANITIZED_RUNTIME_EVIDENCE_MISSING'));
      return;
    }
    if (isRecord(raw) && raw.available === false && raw.dataState === 'UNKNOWN') {
      const automation = safeAutomation(raw.automation);
      const aiReview = safeAiReview(raw.aiReview);
      const reason = typeof raw.reason === 'string' && /^[A-Z0-9_:-]{1,160}$/u.test(raw.reason)
        ? raw.reason : 'SANITIZED_RUNTIME_EVIDENCE_UNAVAILABLE';
      if ((raw.automation != null && !automation) || (raw.aiReview != null && !aiReview)) {
        res.status(200).json(unavailable('SANITIZED_RUNTIME_EVIDENCE_INVALID'));
        return;
      }
      res.status(200).json({ ...unavailable(reason), automation, aiReview });
      return;
    }
    const evidence = sanitizeVideoResearchRuntimeEvidence(raw);
    if (!evidence) {
      res.status(200).json(unavailable('SANITIZED_RUNTIME_EVIDENCE_INVALID'));
      return;
    }
    res.status(200).json({
      ok: true,
      available: true,
      dataState: 'MEASURED',
      ...evidence,
      economicEvidenceCredit: 0,
      profitabilityCredit: 0,
      executionAuthority: 'NONE',
    });
  });
  return router;
}

const videoResearchEvidenceRouter = createVideoResearchEvidenceRouter();
export default videoResearchEvidenceRouter;
