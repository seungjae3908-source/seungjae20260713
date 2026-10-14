import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const PUBLIC_PROVIDER_RESEARCH_LANE_CONTRACT_V1 = 'public-provider-research-lane/v1';

const SHA40 = /^[a-f0-9]{40}$/u;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const ENDPOINTS = Object.freeze([
  Object.freeze({
    provider: 'UPBIT',
    category: 'DATA_SOURCE',
    url: 'https://api.upbit.com/v1/market/all?is_details=true',
    expectedShape: 'UPBIT_MARKET_ARRAY',
    verifiedCapability: 'PUBLIC_MARKET_UNIVERSE_METADATA',
  }),
  Object.freeze({
    provider: 'BITGET',
    category: 'DATA_SOURCE',
    url: 'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES',
    expectedShape: 'BITGET_CONTRACT_ARRAY',
    verifiedCapability: 'PUBLIC_FUTURES_CONTRACT_METADATA',
  }),
]);
const REQUEST_TIMEOUT_MS = 15_000;

const SAFETY = Object.freeze({
  publicMetadataOnly: true,
  providerTermsVerifiedForRedistribution: false,
  formulaInputAllowed: false,
  liveSignalAllowed: false,
  executionReferenceVerified: false,
  orderEndpointCalled: false,
  privateTradingApi: false,
  realOrder: false,
  executionAuthority: 'NONE',
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function exactSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(sha)) throw new Error('PROVIDER_RESEARCH_SHA_INVALID');
  return sha;
}

function exactIso(value) {
  const raw = String(value ?? '');
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== raw) throw new Error('PROVIDER_RESEARCH_TIMESTAMP_INVALID');
  return raw;
}

function safeError(error) {
  return String(error?.message ?? error ?? 'PROVIDER_RESEARCH_UNAVAILABLE').trim().toUpperCase()
    .replace(/[^A-Z0-9_.:-]/gu, '_').slice(0, 180) || 'PROVIDER_RESEARCH_UNAVAILABLE';
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function readOptional(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function validatePayload(endpoint, payload) {
  const rows = endpoint.expectedShape === 'UPBIT_MARKET_ARRAY' ? payload
    : endpoint.expectedShape === 'BITGET_CONTRACT_ARRAY' && String(payload?.code ?? '') === '00000' ? payload.data : null;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('OFFICIAL_PUBLIC_PAYLOAD_INVALID');
  const first = rows.find((row) => row && typeof row === 'object' && !Array.isArray(row));
  if (!first) throw new Error('OFFICIAL_PUBLIC_PAYLOAD_ROW_INVALID');
  const required = endpoint.provider === 'UPBIT' ? ['market'] : ['symbol'];
  if (required.some((field) => typeof first[field] !== 'string' || !first[field].trim())) {
    throw new Error('OFFICIAL_PUBLIC_PAYLOAD_FIELDS_INVALID');
  }
  return Object.freeze({ rowCount: rows.length, observedFields: Object.freeze(Object.keys(first).sort().slice(0, 80)) });
}

async function probe(endpoint, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(endpoint.url, { method: 'GET', redirect: 'follow', signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'seungjae-public-provider-research-v1/1.0' } });
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('OFFICIAL_PUBLIC_PAYLOAD_TOO_LARGE');
    if (response.status !== 200) throw new Error(`OFFICIAL_PUBLIC_HTTP_${response.status}`);
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error('OFFICIAL_PUBLIC_JSON_INVALID'); }
    const shape = validatePayload(endpoint, payload);
    return Object.freeze({
      provider: endpoint.provider,
      category: endpoint.category,
      status: 'PUBLIC_API_RESPONSE_VERIFIED',
      httpStatus: response.status,
      canonicalUrl: endpoint.url,
      responseSha256: createHash('sha256').update(text).digest('hex'),
      rowCount: shape.rowCount,
      observedFields: shape.observedFields,
      verifiedCapability: endpoint.verifiedCapability,
      usageCondition: 'PUBLIC_READ_CONFIRMED_TERMS_NOT_VERIFIED_FOR_REPUBLICATION_OR_LIVE_SIGNAL',
      connectedToFormula: false,
      connectedToExecution: false,
      reason: null,
    });
  } catch (error) {
    return Object.freeze({
      provider: endpoint.provider,
      category: endpoint.category,
      status: 'BLOCKED_DATA',
      httpStatus: null,
      canonicalUrl: endpoint.url,
      responseSha256: null,
      rowCount: 0,
      observedFields: Object.freeze([]),
      verifiedCapability: null,
      usageCondition: 'NOT_VERIFIED',
      connectedToFormula: false,
      connectedToExecution: false,
      reason: controller.signal.aborted ? 'OFFICIAL_PUBLIC_TIMEOUT' : safeError(error),
    });
  } finally { clearTimeout(timer); }
}

export async function runPublicProviderResearchLaneV1({
  stateRoot: rawRoot,
  researchCodeSha: rawSha,
  now = () => new Date().toISOString(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const stateRoot = resolve(String(rawRoot ?? ''));
  if (!rawRoot || typeof fetchImpl !== 'function') throw new Error('PROVIDER_RESEARCH_CONFIGURATION_INVALID');
  const researchCodeSha = exactSha(rawSha);
  const observedAt = exactIso(now());
  const researchDate = observedAt.slice(0, 10);
  const latestPath = join(stateRoot, 'latest', 'public-provider-research-lane-v1.json');
  const prior = await readOptional(latestPath);
  if (prior?.researchCodeSha === researchCodeSha && prior?.researchDate === researchDate) {
    const priorCore = { ...prior };
    delete priorCore.resultDigest;
    const resumedCore = { ...priorCore, observedAt, cacheHit: true, actualPublicRequestsThisRun: 0 };
    const resumed = Object.freeze({ ...resumedCore, resultDigest: digest(resumedCore) });
    await atomicJson(latestPath, resumed);
    await atomicJson(join(stateRoot, 'provider-research', 'runs', `${resumed.resultDigest}.json`), resumed);
    return resumed;
  }
  const providers = await Promise.all(ENDPOINTS.map((endpoint) => probe(endpoint, fetchImpl)));
  const verified = providers.filter((row) => row.status === 'PUBLIC_API_RESPONSE_VERIFIED');
  const core = {
    schemaVersion: 1,
    contract: PUBLIC_PROVIDER_RESEARCH_LANE_CONTRACT_V1,
    status: verified.length === providers.length ? 'COMPLETE' : verified.length > 0 ? 'PARTIAL_DATA' : 'BLOCKED_DATA',
    observedAt,
    researchDate,
    researchCodeSha,
    cacheHit: false,
    actualPublicRequests: providers.length,
    actualPublicRequestsThisRun: providers.length,
    targetProviderCount: 7,
    probedProviderCount: providers.length,
    verifiedProviderCount: verified.length,
    providerResults: Object.freeze(providers),
    notProbedProviders: Object.freeze([
      Object.freeze({ provider: 'KIWOOM', reason: 'OFFICIAL_DOCUMENT_ACCESS_NOT_VERIFIED_IN_CURRENT_BOUNDED_RUN' }),
      Object.freeze({ provider: 'TOSS_SECURITIES', reason: 'OFFICIAL_DOCUMENT_ACCESS_NOT_VERIFIED_IN_CURRENT_BOUNDED_RUN' }),
      Object.freeze({ provider: 'BITHUMB', reason: 'OFFICIAL_DOCUMENT_ACCESS_NOT_VERIFIED_IN_CURRENT_BOUNDED_RUN' }),
      Object.freeze({ provider: 'BYBIT', reason: 'OFFICIAL_DOCUMENT_ACCESS_NOT_VERIFIED_IN_CURRENT_BOUNDED_RUN' }),
      Object.freeze({ provider: 'BINANCE', reason: 'OFFICIAL_DOCUMENT_ACCESS_NOT_VERIFIED_IN_CURRENT_BOUNDED_RUN' }),
    ]),
    categoryCounts: Object.freeze({
      STRATEGY_RESEARCH: 0,
      DATA_SOURCE: verified.length,
      EXECUTION_REFERENCE: 0,
    }),
    nextAction: 'VERIFY_OFFICIAL_DOCUMENT_TERMS_BEFORE_ANY_DOWNSTREAM_CONNECTION',
    safety: SAFETY,
  };
  const result = Object.freeze({ ...core, resultDigest: digest(core) });
  await atomicJson(latestPath, result);
  await atomicJson(join(stateRoot, 'provider-research', 'runs', `${result.resultDigest}.json`), result);
  return result;
}
