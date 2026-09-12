import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SOURCE_TRUST_TIERS_V2, VIDEO_TRANSCRIPT_STATUSES_V2 } from './video-intelligence-phase2.js';

export const VIDEO_RESEARCH_SANITIZED_SNAPSHOT_FILE_V1 = 'video-research-public-provider-runtime-v3.json';
export const VIDEO_RESEARCH_SANITIZED_SNAPSHOT_SCHEMA_V1 = 'video-research-sanitized-snapshot-v1';

const RUNTIME_VERSION = 'video-research-public-provider-runtime-v3';
const PROVIDER = 'YOUTUBE_DATA_API_V3';
const PROVIDER_ACCESS = 'OFFICIAL_PUBLIC_API';
const REQUEST_MODE = 'READ_ONLY_GET';
const SAFE_CREDENTIAL_METADATA = new Set([
  'credentialConfigured',
  'credentialEnvName',
  'credentialValueExposed',
  'credentialMutation',
]);
const FORBIDDEN_KEY = /(api.?key|access.?token|refresh.?token|secret|password|credential)/iu;
const TRANSCRIPT_STATUSES = new Set(VIDEO_TRANSCRIPT_STATUSES_V2);
const SOURCE_TRUST_TIERS = new Set(SOURCE_TRUST_TIERS_V2);
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

export class VideoResearchSnapshotPublisherError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'VideoResearchSnapshotPublisherError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, details = {}) {
  throw new VideoResearchSnapshotPublisherError(code, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsForbiddenCredentialKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenCredentialKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => {
    if (SAFE_CREDENTIAL_METADATA.has(key)) return containsForbiddenCredentialKey(nested);
    if (FORBIDDEN_KEY.test(key)) return true;
    return containsForbiddenCredentialKey(nested);
  });
}

function exactSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/iu.test(value) ? value.toLowerCase() : null;
}

function isoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function nullableString(value) {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

function canonicalYoutubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function sanitizeRecord(value) {
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

function safetyMatches(value) {
  if (!isRecord(value)) return false;
  return Object.entries(REQUIRED_SAFETY).every(([key, expected]) => value[key] === expected);
}

export function createSanitizedVideoResearchSnapshotV1(result, { sourceHeadSha, observedAt } = {}) {
  if (!isRecord(result)) fail('VIDEO_RESEARCH_SNAPSHOT_RESULT_INVALID');
  if (containsForbiddenCredentialKey(result)) fail('VIDEO_RESEARCH_SNAPSHOT_SECRET_BEARING_KEY');
  if (result.runtimeVersion !== RUNTIME_VERSION) fail('VIDEO_RESEARCH_SNAPSHOT_RUNTIME_VERSION_INVALID');
  if (result.status !== 'SUCCESS') fail('VIDEO_RESEARCH_SNAPSHOT_STATUS_NOT_SUCCESS', { status: result.status ?? null });
  if (result.provider !== PROVIDER || result.providerAccess !== PROVIDER_ACCESS || result.requestMode !== REQUEST_MODE) {
    fail('VIDEO_RESEARCH_SNAPSHOT_PROVIDER_CONTRACT_INVALID');
  }
  if (result.credentialConfigured !== true || result.credentialValueExposed !== false) {
    fail('VIDEO_RESEARCH_SNAPSHOT_CREDENTIAL_CONTRACT_INVALID');
  }
  if (typeof result.query !== 'string' || !result.query.trim()) fail('VIDEO_RESEARCH_SNAPSHOT_QUERY_INVALID');
  if (!Number.isSafeInteger(result.pagesUsed) || result.pagesUsed < 0 || result.pagesUsed > 1) fail('VIDEO_RESEARCH_SNAPSHOT_PAGES_INVALID');
  if (typeof result.quotaState !== 'string' || !result.quotaState) fail('VIDEO_RESEARCH_SNAPSHOT_QUOTA_STATE_INVALID');
  if (!Number.isSafeInteger(result.sourceCount) || result.sourceCount < 0 || result.sourceCount > 5) fail('VIDEO_RESEARCH_SNAPSHOT_SOURCE_COUNT_INVALID');
  if (!Array.isArray(result.records) || result.records.length !== result.sourceCount) fail('VIDEO_RESEARCH_SNAPSHOT_RECORD_COUNT_MISMATCH');
  if (!safetyMatches(result.safety)) fail('VIDEO_RESEARCH_SNAPSHOT_AUTHORITY_LOCK_INVALID');

  const sha = exactSha(sourceHeadSha);
  if (!sha) fail('VIDEO_RESEARCH_SNAPSHOT_SOURCE_SHA_INVALID');
  const timestamp = isoTimestamp(observedAt);
  if (!timestamp) fail('VIDEO_RESEARCH_SNAPSHOT_OBSERVED_AT_INVALID');
  const records = result.records.map(sanitizeRecord);
  if (records.some((record) => record === null)) fail('VIDEO_RESEARCH_SNAPSHOT_RECORD_INVALID');

  return Object.freeze({
    runtimeVersion: RUNTIME_VERSION,
    status: 'SUCCESS',
    provider: PROVIDER,
    providerAccess: PROVIDER_ACCESS,
    requestMode: REQUEST_MODE,
    query: result.query,
    pagesUsed: result.pagesUsed,
    quotaState: result.quotaState,
    credentialConfigured: true,
    credentialValueExposed: false,
    sourceCount: result.sourceCount,
    records: Object.freeze(records),
    safety: REQUIRED_SAFETY,
    snapshotProvenance: Object.freeze({
      schemaVersion: VIDEO_RESEARCH_SANITIZED_SNAPSHOT_SCHEMA_V1,
      sourceHeadSha: sha,
      observedAt: timestamp,
      publisherMode: 'LOCAL_ATOMIC_FILE',
      providerRuntimeVersion: RUNTIME_VERSION,
      economicEvidenceCredit: 0,
      profitabilityCredit: 0,
      executionAuthority: 'NONE',
    }),
  });
}

export async function publishSanitizedVideoResearchSnapshotV1({ result, outputDir, sourceHeadSha, observedAt } = {}) {
  if (typeof outputDir !== 'string' || !outputDir.trim()) fail('VIDEO_RESEARCH_SNAPSHOT_OUTPUT_DIR_REQUIRED');
  const snapshot = createSanitizedVideoResearchSnapshotV1(result, { sourceHeadSha, observedAt });
  const directory = resolve(outputDir);
  const targetPath = resolve(directory, VIDEO_RESEARCH_SANITIZED_SNAPSHOT_FILE_V1);
  if (!targetPath.startsWith(`${directory}/`) && targetPath !== `${directory}\\${VIDEO_RESEARCH_SANITIZED_SNAPSHOT_FILE_V1}`) {
    fail('VIDEO_RESEARCH_SNAPSHOT_OUTPUT_PATH_INVALID');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = resolve(directory, `.${VIDEO_RESEARCH_SANITIZED_SNAPSHOT_FILE_V1}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(tempPath, targetPath);
  } finally {
    await unlink(tempPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
  return Object.freeze({ path: targetPath, snapshot });
}
