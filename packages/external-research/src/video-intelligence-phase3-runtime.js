import { createYoutubeDiscoveryClientV2 } from './video-intelligence-phase2.js';

export const VIDEO_RESEARCH_PUBLIC_PROVIDER_ENV_V3 = 'YOUTUBE_DATA_API_KEY';
export const VIDEO_RESEARCH_PUBLIC_RUNTIME_VERSION_V3 = 'video-research-public-provider-runtime-v3';

const AUTHORITY_LOCKS = Object.freeze({
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

const CALLER_LOCKS = Object.freeze({
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

export class VideoResearchPhase3RuntimeError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'VideoResearchPhase3RuntimeError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, details = {}) {
  throw new VideoResearchPhase3RuntimeError(code, details);
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function boundedInteger(value, fallback, min, max, code) {
  const normalized = value == null ? fallback : value;
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) fail(code);
  return normalized;
}

function assertAuthorityLocks(options) {
  for (const [field, expected] of Object.entries(CALLER_LOCKS)) {
    if (Object.prototype.hasOwnProperty.call(options, field) && options[field] !== expected) {
      fail('VIDEO_RESEARCH_PHASE3_AUTHORITY_LOCK_VIOLATION', { field, expected });
    }
  }
}

function readCredential(env) {
  if (!env || typeof env !== 'object') return null;
  const value = env[VIDEO_RESEARCH_PUBLIC_PROVIDER_ENV_V3];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sanitizeRecord(record) {
  const source = record?.source ?? {};
  const metadata = record?.metadata ?? {};
  return freeze({
    videoId: source.videoId ?? null,
    canonicalUrl: source.canonicalUrl ?? null,
    title: source.title ?? null,
    channelOrPublisher: source.channelOrPublisher ?? null,
    publishedAt: source.publishedAt ?? null,
    discoveredAt: source.discoveredAt ?? null,
    language: source.language ?? null,
    durationSec: source.durationSec ?? null,
    transcriptStatus: source.transcriptStatus ?? 'UNKNOWN',
    captionsKnownPresent: metadata.captionsKnownPresent ?? null,
    sourceTrustTier: record?.sourceTrustTier ?? 'UNKNOWN',
    contentAuthority: 'UNTRUSTED_EXTERNAL_DATA',
    economicEvidenceCredit: 0,
    profitabilityCredit: 0,
    executionAuthority: 'NONE',
  });
}

export function createPublicVideoDiscoveryRuntimeV3({
  env = process.env,
  fetchImpl = globalThis.fetch,
  limits = {},
} = {}) {
  const apiKey = readCredential(env);
  const maxResultsPerQuery = boundedInteger(limits.maxResultsPerQuery, 3, 1, 5, 'VIDEO_RESEARCH_PHASE3_MAX_RESULTS_INVALID');
  const maxVideosPerResearchBatch = boundedInteger(limits.maxVideosPerResearchBatch, 3, 1, 5, 'VIDEO_RESEARCH_PHASE3_BATCH_LIMIT_INVALID');
  const client = createYoutubeDiscoveryClientV2({
    apiKey,
    fetchImpl,
    limits: {
      maxResultsPerQuery,
      maxPagesPerRun: 1,
      maxVideosPerResearchBatch,
    },
  });

  return freeze({
    runtimeVersion: VIDEO_RESEARCH_PUBLIC_RUNTIME_VERSION_V3,
    provider: 'YOUTUBE_DATA_API_V3',
    providerAccess: 'OFFICIAL_PUBLIC_API',
    requestMode: 'READ_ONLY_GET',
    credentialEnvName: VIDEO_RESEARCH_PUBLIC_PROVIDER_ENV_V3,
    credentialConfigured: Boolean(apiKey),
    credentialValueExposed: false,
    safety: AUTHORITY_LOCKS,
    async discover(options = {}) {
      assertAuthorityLocks(options);
      const query = typeof options.query === 'string' ? options.query.trim() : '';
      if (!query) fail('VIDEO_RESEARCH_PHASE3_QUERY_REQUIRED');
      const maxResults = boundedInteger(options.maxResults, 3, 1, maxResultsPerQuery, 'VIDEO_RESEARCH_PHASE3_MAX_RESULTS_INVALID');
      const maxPages = boundedInteger(options.maxPages, 1, 1, 1, 'VIDEO_RESEARCH_PHASE3_MAX_PAGES_INVALID');
      const result = await client.discover({
        query,
        maxResults,
        maxPages,
        discoveredAt: options.discoveredAt,
        relevanceLanguage: options.relevanceLanguage ?? null,
        regionCode: options.regionCode ?? null,
        requireCaptions: options.requireCaptions === true,
        discoveryReason: options.discoveryReason ?? 'PHASE3_PUBLIC_PROVIDER_RUNTIME_READ_ONLY',
      });
      return freeze({
        runtimeVersion: VIDEO_RESEARCH_PUBLIC_RUNTIME_VERSION_V3,
        status: result.status,
        provider: result.provider,
        providerAccess: 'OFFICIAL_PUBLIC_API',
        requestMode: 'READ_ONLY_GET',
        query: result.query,
        pagesUsed: result.pagesUsed,
        quotaState: result.quotaState,
        credentialEnvName: VIDEO_RESEARCH_PUBLIC_PROVIDER_ENV_V3,
        credentialConfigured: Boolean(apiKey),
        credentialValueExposed: false,
        sourceCount: Array.isArray(result.records) ? result.records.length : 0,
        records: Array.isArray(result.records) ? result.records.map(sanitizeRecord) : [],
        safety: AUTHORITY_LOCKS,
      });
    },
  });
}

export async function runPublicVideoDiscoveryV3(options = {}) {
  assertAuthorityLocks(options);
  const runtime = createPublicVideoDiscoveryRuntimeV3({
    env: options.env ?? process.env,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    limits: options.limits ?? {},
  });
  return runtime.discover({
    query: options.query,
    maxResults: options.maxResults,
    maxPages: options.maxPages,
    discoveredAt: options.discoveredAt,
    relevanceLanguage: options.relevanceLanguage,
    regionCode: options.regionCode,
    requireCaptions: options.requireCaptions,
    discoveryReason: options.discoveryReason,
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
}
