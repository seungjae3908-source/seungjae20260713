import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Router, type IRouter } from 'express';

const RUNTIME_VERSION = 'video-research-public-provider-runtime-v3';
const PROVIDER = 'YOUTUBE_DATA_API_V3';
const PROVIDER_ACCESS = 'OFFICIAL_PUBLIC_API';
const REQUEST_MODE = 'READ_ONLY_GET';
const SNAPSHOT_FILE = 'video-research-public-provider-runtime-v3.json';

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

type SafeEvidence = {
  runtimeVersion: typeof RUNTIME_VERSION;
  status: string;
  provider: typeof PROVIDER;
  providerAccess: typeof PROVIDER_ACCESS;
  requestMode: typeof REQUEST_MODE;
  query: string;
  pagesUsed: number;
  quotaState: string;
  credentialConfigured: boolean;
  credentialValueExposed: false;
  sourceCount: number;
  records: SafeRecord[];
  safety: typeof REQUIRED_SAFETY;
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

function safeRecord(value: unknown): SafeRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.videoId !== 'string' || !value.videoId.trim()) return null;
  if (typeof value.canonicalUrl !== 'string' || !value.canonicalUrl.startsWith('https://')) return null;
  if (typeof value.title !== 'string' || !value.title.trim()) return null;
  const channelOrPublisher = nullableString(value.channelOrPublisher);
  const publishedAt = nullableString(value.publishedAt);
  const discoveredAt = nullableString(value.discoveredAt);
  const language = nullableString(value.language);
  if (channelOrPublisher === undefined || publishedAt === undefined || discoveredAt === undefined || language === undefined) return null;
  const durationSec = value.durationSec === null
    ? null
    : Number.isFinite(value.durationSec) && Number(value.durationSec) >= 0
      ? Number(value.durationSec)
      : undefined;
  if (durationSec === undefined) return null;
  if (typeof value.transcriptStatus !== 'string' || !value.transcriptStatus) return null;
  if (value.captionsKnownPresent !== null && typeof value.captionsKnownPresent !== 'boolean') return null;
  if (typeof value.sourceTrustTier !== 'string' || !value.sourceTrustTier) return null;
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

function safetyMatches(value: unknown): value is typeof REQUIRED_SAFETY {
  if (!isRecord(value)) return false;
  return Object.entries(REQUIRED_SAFETY).every(([key, expected]) => value[key] === expected);
}

export function sanitizeVideoResearchRuntimeEvidence(value: unknown): SafeEvidence | null {
  if (!isRecord(value) || containsForbiddenCredentialKey(value)) return null;
  if (value.runtimeVersion !== RUNTIME_VERSION || value.provider !== PROVIDER) return null;
  if (value.providerAccess !== PROVIDER_ACCESS || value.requestMode !== REQUEST_MODE) return null;
  if (value.credentialValueExposed !== false || typeof value.credentialConfigured !== 'boolean') return null;
  if (typeof value.status !== 'string' || !value.status) return null;
  if (typeof value.query !== 'string' || !value.query.trim()) return null;
  if (!Number.isSafeInteger(value.pagesUsed) || Number(value.pagesUsed) < 0 || Number(value.pagesUsed) > 1) return null;
  if (typeof value.quotaState !== 'string' || !value.quotaState) return null;
  if (!Number.isSafeInteger(value.sourceCount) || Number(value.sourceCount) < 0 || Number(value.sourceCount) > 5) return null;
  if (!Array.isArray(value.records) || value.records.length !== value.sourceCount) return null;
  if (!safetyMatches(value.safety)) return null;

  const records = value.records.map(safeRecord);
  if (records.some((record) => record === null)) return null;

  return {
    runtimeVersion: RUNTIME_VERSION,
    status: value.status,
    provider: PROVIDER,
    providerAccess: PROVIDER_ACCESS,
    requestMode: REQUEST_MODE,
    query: value.query,
    pagesUsed: Number(value.pagesUsed),
    quotaState: value.quotaState,
    credentialConfigured: value.credentialConfigured,
    credentialValueExposed: false,
    sourceCount: Number(value.sourceCount),
    records: records as SafeRecord[],
    safety: REQUIRED_SAFETY,
  };
}

export async function loadVideoResearchRuntimeEvidenceSnapshot(): Promise<unknown> {
  const candidates = [
    resolve(process.cwd(), 'api-server', 'data', SNAPSHOT_FILE),
    resolve(process.cwd(), 'data', SNAPSHOT_FILE),
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
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
