import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { runAndPublishSanitizedVideoResearchSnapshotV1 } from '../../packages/external-research/src/video-intelligence-phase3-snapshot-caller.js';
import { preflightResearchProduction } from './engine.mjs';

const DEFAULT_QUERIES = Object.freeze([
  'korea stock trading strategy',
  'us stock day trading strategy',
  'crypto spot trading strategy',
  'crypto futures trading strategy',
]);
const MAX_QUERY_COUNT = 8;
const MAX_RESULTS = 3;

export const RESEARCH_VIDEO_DISCOVERY_SAFETY = Object.freeze({
  researchOnly: true,
  metadataDiscoveryOnly: true,
  transcriptDownloadEnabled: false,
  automaticGeminiExecution: false,
  automaticGroqExecution: false,
  automaticAdoption: false,
  paidFallback: false,
  economicEvidenceCredit: 0,
  profitabilityCredit: 0,
  executionAuthority: 'NONE',
  liveTrading: false,
  privateTradingApiAllowed: false,
  realOrderEnabled: false,
});

const secretPattern = /(?:bearer\s+\S+|sk-[A-Za-z0-9_-]{12,}|(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S+)/iu;
const controlPattern = /[\u0000-\u001f\u007f]/u;

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function cleanQuery(value) {
  if (typeof value !== 'string') return null;
  const query = value.normalize('NFKC').trim();
  if (!query || query.length > 120 || controlPattern.test(query) || secretPattern.test(query)) return null;
  return query;
}

function parseQueries(env) {
  const raw = String(env.RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON ?? '').trim();
  if (!raw) return [...DEFAULT_QUERIES];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('VIDEO_DISCOVERY_QUERIES_INVALID'); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_QUERY_COUNT) {
    throw new Error('VIDEO_DISCOVERY_QUERIES_INVALID');
  }
  const queries = parsed.map(cleanQuery);
  if (queries.some((query) => !query) || new Set(queries).size !== queries.length) {
    throw new Error('VIDEO_DISCOVERY_QUERIES_INVALID');
  }
  return queries;
}

function parseInvocationMode(env) {
  const raw = String(env.RESEARCH_VIDEO_INVOCATION_MODE ?? 'MANUAL').trim().toUpperCase();
  return raw === 'SYSTEMD_TIMER' ? 'SYSTEMD_TIMER' : 'MANUAL';
}

function safeError(error) {
  const code = String(error?.code ?? error?.message ?? 'VIDEO_DISCOVERY_UNAVAILABLE')
    .trim().toUpperCase().replace(/[^A-Z0-9_:-]/g, '_').slice(0, 120);
  return code || 'VIDEO_DISCOVERY_UNAVAILABLE';
}

function iso(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString() === value ? value : null;
}

async function readJsonOptional(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function atomicJson(path, value, env) {
  const serialized = JSON.stringify(value, null, 2);
  for (const secret of [env.YOUTUBE_DATA_API_KEY].map((item) => String(item ?? '').trim()).filter(Boolean)) {
    if (serialized.includes(secret)) throw new Error('VIDEO_DISCOVERY_SECRET_SERIALIZATION_FORBIDDEN');
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${serialized}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}

async function exclusiveJson(path, value, env) {
  const serialized = JSON.stringify(value, null, 2);
  for (const secret of [env.YOUTUBE_DATA_API_KEY].map((item) => String(item ?? '').trim()).filter(Boolean)) {
    if (serialized.includes(secret)) throw new Error('VIDEO_DISCOVERY_SECRET_SERIALIZATION_FORBIDDEN');
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${serialized}\n`, { mode: 0o600, flag: 'wx' });
}

export function resolveResearchVideoDiscoveryPolicy(env = process.env) {
  const approved = String(env.RESEARCH_VIDEO_DISCOVERY_APPROVED ?? '').trim().toLowerCase() === 'true';
  const apiKey = String(env.YOUTUBE_DATA_API_KEY ?? '').trim();
  const queries = parseQueries(env);
  const maxResultsRaw = Number(env.RESEARCH_VIDEO_DISCOVERY_MAX_RESULTS ?? MAX_RESULTS);
  const maxResults = Number.isSafeInteger(maxResultsRaw) && maxResultsRaw >= 1 && maxResultsRaw <= MAX_RESULTS
    ? maxResultsRaw : MAX_RESULTS;
  if (!approved) return Object.freeze({ ready: false, reason: 'VIDEO_DISCOVERY_NOT_APPROVED', apiKey: null, queries, maxResults });
  if (apiKey.length < 8 || apiKey.length > 512 || /[\s\u0000-\u001f]/u.test(apiKey)) {
    return Object.freeze({ ready: false, reason: 'YOUTUBE_PROVIDER_NOT_CONFIGURED', apiKey: null, queries, maxResults });
  }
  return Object.freeze({ ready: true, reason: 'CONFIGURED_UNPROBED', apiKey, queries, maxResults });
}

export async function preflightResearchVideoDiscovery({
  repoRoot,
  stateRoot,
  researchSha,
  env = process.env,
  verifyGitHead = true,
  preflight = preflightResearchProduction,
} = {}) {
  const base = await preflight({ repoRoot, stateRoot, researchSha, env, verifyGitHead });
  const policy = resolveResearchVideoDiscoveryPolicy(env);
  return Object.freeze({
    schemaVersion: 'research-video-discovery-preflight-v1',
    status: policy.ready ? 'READY_CONFIG_UNPROBED' : 'WAITING_CONFIGURATION',
    researchSha: base.researchSha,
    provider: 'YOUTUBE_DATA_API_V3',
    queryCount: policy.queries.length,
    maxResults: policy.maxResults,
    reason: policy.reason,
    providerNetworkCalls: 0,
    invocationMode: parseInvocationMode(env),
    safety: RESEARCH_VIDEO_DISCOVERY_SAFETY,
  });
}

export async function runResearchVideoDiscoveryScan({
  repoRoot,
  stateRoot,
  researchSha,
  env = process.env,
  verifyGitHead = true,
  preflight = preflightResearchProduction,
  discover = runAndPublishSanitizedVideoResearchSnapshotV1,
  clock = () => new Date().toISOString(),
} = {}) {
  const base = await preflight({ repoRoot, stateRoot, researchSha, env, verifyGitHead });
  const policy = resolveResearchVideoDiscoveryPolicy(env);
  const root = join(resolve(base.stateRoot), 'video-research');
  const latestPath = join(root, 'latest.json');
  const cursorPath = join(root, 'cursor.json');
  const invocationMode = parseInvocationMode(env);
  const observedAt = iso(clock());
  if (!observedAt) throw new Error('VIDEO_DISCOVERY_CLOCK_INVALID');

  if (!policy.ready) {
    const waiting = Object.freeze({
      schemaVersion: 'research-video-discovery-scan-v1',
      status: 'WAITING_CONFIGURATION',
      observedAt,
      researchSha: base.researchSha,
      provider: 'YOUTUBE_DATA_API_V3',
      query: null,
      queryIndex: null,
      queryCount: policy.queries.length,
      sourceCount: null,
      snapshotDigest: null,
      providerNetworkCalls: 0,
      invocationMode,
      scheduledInvocationObserved: false,
      reason: policy.reason,
      nextRequiredStep: 'CONFIGURE_APPROVED_READ_ONLY_YOUTUBE_DISCOVERY',
      safety: RESEARCH_VIDEO_DISCOVERY_SAFETY,
    });
    await atomicJson(latestPath, waiting, env);
    return waiting;
  }

  const cursor = await readJsonOptional(cursorPath);
  const candidateIndex = Number(cursor?.nextQueryIndex ?? 0);
  const queryIndex = Number.isSafeInteger(candidateIndex) && candidateIndex >= 0 && candidateIndex < policy.queries.length
    ? candidateIndex : 0;
  const query = policy.queries[queryIndex];

  try {
    const outcome = await discover({
      query,
      outputDir: join(root, 'current'),
      sourceHeadSha: base.researchSha,
      observedAt,
      env: { YOUTUBE_DATA_API_KEY: policy.apiKey },
      maxResults: policy.maxResults,
    });
    if (outcome?.published !== true || !outcome.snapshot) {
      const error = new Error('VIDEO_DISCOVERY_SNAPSHOT_NOT_PUBLISHED');
      error.code = 'VIDEO_DISCOVERY_SNAPSHOT_NOT_PUBLISHED';
      throw error;
    }
    const snapshot = outcome.snapshot;
    const snapshotDigest = digest(snapshot);
    const historyId = `${observedAt.replace(/[:.]/g, '-')}-${snapshotDigest}`;
    await exclusiveJson(join(root, 'history', `${historyId}.json`), snapshot, env);

    const inbox = Object.freeze({
      schemaVersion: 'research-video-source-review-inbox-v1',
      createdAt: observedAt,
      researchSha: base.researchSha,
      query,
      snapshotDigest,
      sourceCount: Number(snapshot.sourceCount ?? 0),
      sources: Object.freeze((Array.isArray(snapshot.records) ? snapshot.records : []).map((record) => Object.freeze({
        videoId: record.videoId,
        canonicalUrl: record.canonicalUrl,
        title: record.title,
        channelOrPublisher: record.channelOrPublisher,
        publishedAt: record.publishedAt,
        transcriptStatus: record.transcriptStatus,
        sourceTrustTier: record.sourceTrustTier,
        reviewStatus: 'SOURCE_REVIEW_REQUIRED',
      }))),
      nextRequiredStep: 'REVIEW_SOURCE_THEN_USE_EXISTING_V7_APPROVED_ONE_SHOT',
      economicEvidenceCredit: 0,
      profitabilityCredit: 0,
      executionAuthority: 'NONE',
    });
    await exclusiveJson(join(root, 'inbox', `${snapshotDigest}.json`), inbox, env);

    const nextQueryIndex = (queryIndex + 1) % policy.queries.length;
    await atomicJson(cursorPath, {
      schemaVersion: 'research-video-discovery-cursor-v1',
      updatedAt: observedAt,
      nextQueryIndex,
      queryCount: policy.queries.length,
    }, env);

    const result = Object.freeze({
      schemaVersion: 'research-video-discovery-scan-v1',
      status: 'COMPLETE',
      observedAt,
      researchSha: base.researchSha,
      provider: 'YOUTUBE_DATA_API_V3',
      query,
      queryIndex,
      queryCount: policy.queries.length,
      nextQueryIndex,
      sourceCount: Number(snapshot.sourceCount ?? 0),
      snapshotDigest,
      providerNetworkCalls: 1,
      invocationMode,
      scheduledInvocationObserved: invocationMode === 'SYSTEMD_TIMER',
      reason: null,
      nextRequiredStep: 'SOURCE_REVIEW_THEN_EXISTING_GEMINI_GROQ_ORCHESTRATOR',
      safety: RESEARCH_VIDEO_DISCOVERY_SAFETY,
    });
    await atomicJson(latestPath, result, env);
    return result;
  } catch (error) {
    const blocked = Object.freeze({
      schemaVersion: 'research-video-discovery-scan-v1',
      status: 'BLOCKED',
      observedAt,
      researchSha: base.researchSha,
      provider: 'YOUTUBE_DATA_API_V3',
      query,
      queryIndex,
      queryCount: policy.queries.length,
      sourceCount: null,
      snapshotDigest: null,
      providerNetworkCalls: 1,
      invocationMode,
      scheduledInvocationObserved: invocationMode === 'SYSTEMD_TIMER',
      reason: safeError(error),
      nextRequiredStep: 'RETRY_SAME_QUERY_AFTER_PROVIDER_OR_CONFIGURATION_RECOVERY',
      safety: RESEARCH_VIDEO_DISCOVERY_SAFETY,
    });
    await atomicJson(latestPath, blocked, env);
    return blocked;
  }
}
