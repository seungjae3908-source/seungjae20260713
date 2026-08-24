#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';

const SCHEMA_VERSION = 'paper-forward-one-shot-close-v1';
const BINDING_VERSION = 'paper-state-publisher-runtime-binding-v1';
const SNAPSHOT_VERSION = 'paper-trading-state-snapshot-v2';
const EPSILON = 1e-8;
const MARKET_FRESHNESS_MS = 60_000;
const DEFAULT_STATE_ROOT = '/opt/stock-app-data/paper-forward-v1';
const DEFAULT_LIVE_DIR = '/opt/stock-app';
const DEFAULT_PM2_NAME = 'stock-app';
const DEFAULT_LIVE_PORT = 8080;

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function internalEmail(loginName) {
  const normalized = String(loginName ?? '').trim().normalize('NFKC').toLowerCase();
  if (normalized.length < 2 || normalized.length > 20) fail('QA_LOGIN_INVALID');
  const token = sha256(`seungjae-stock-account:${normalized}`).slice(0, 40);
  return `${token}@accounts.seungjae-stock.com`;
}

function exactSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function digest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeZero(value) {
  return finite(value) && Math.abs(value) <= EPSILON;
}

function stateOpenPositions(state) {
  return Array.isArray(state?.positions)
    ? state.positions.filter((position) => position?.status !== 'closed' && Number(position?.remainingQuantity) > EPSILON)
    : [];
}

function pendingOrders(state) {
  return Array.isArray(state?.orders)
    ? state.orders.filter((order) => order?.status === 'pending')
    : [];
}

export function validateBinding(binding, { targetSha, publisherDigest, snapshotPath }) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) fail('BINDING_REQUIRED');
  if (binding.schemaVersion !== BINDING_VERSION) fail('BINDING_SCHEMA_INVALID');
  if (binding.paperRuntimeSourceSha !== targetSha || !exactSha(binding.paperRuntimeSourceSha)) fail('BINDING_TARGET_SHA_MISMATCH');
  if (binding.snapshotPath !== snapshotPath) fail('BINDING_SNAPSHOT_PATH_MISMATCH');
  if (binding.publisherAccountIdSha256 !== publisherDigest || !digest(binding.publisherAccountIdSha256)) fail('BINDING_ACCOUNT_MISMATCH');
  if (binding.immutable !== true
    || binding.executionAuthority !== 'NONE'
    || binding.privateApiAllowed !== false
    || binding.liveTrading !== false
    || binding.financialMutationAllowed !== false) fail('BINDING_SAFETY_INVALID');
  return binding;
}

export function validateRecoverySnapshot(snapshot, { publisherDigest }) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail('SNAPSHOT_REQUIRED');
  if (snapshot.schemaVersion !== SNAPSHOT_VERSION || snapshot.paperStateSchemaVersion !== 1) fail('SNAPSHOT_SCHEMA_INVALID');
  if (snapshot.immutable !== true
    || snapshot.executionAuthority !== 'NONE'
    || snapshot.privateApiAllowed !== false
    || snapshot.liveTrading !== false
    || snapshot.financialMutationAllowed !== false) fail('SNAPSHOT_SAFETY_INVALID');
  if (snapshot.publisherAccountIdSha256 !== publisherDigest || !digest(snapshot.publisherAccountIdSha256)) fail('SNAPSHOT_ACCOUNT_MISMATCH');
  if (!exactSha(snapshot.sourceSha)) fail('SNAPSHOT_SOURCE_SHA_INVALID');
  if (snapshot.market !== 'CRYPTO_FUTURES' || snapshot.currency !== 'USDT') fail('SNAPSHOT_MARKET_CONTRACT_INVALID');
  if (!Array.isArray(snapshot.provenance) || snapshot.provenance.length === 0
    || snapshot.provenance.some((value) => typeof value !== 'string' || !value.trim())) fail('SNAPSHOT_PROVENANCE_INVALID');
  if (!snapshot.state || snapshot.state.schemaVersion !== 1 || !snapshot.state.account) fail('SNAPSHOT_STATE_INVALID');
  if (!digest(snapshot.stateDigestSha256)) fail('SNAPSHOT_DIGEST_INVALID');
  const computed = sha256(canonicalJson(snapshot.state));
  if (computed !== snapshot.stateDigestSha256) fail('SNAPSHOT_DIGEST_MISMATCH');
  const stateUpdatedAtMs = Date.parse(String(snapshot.state.updatedAt ?? ''));
  if (!finite(stateUpdatedAtMs) || snapshot.stateUpdatedAtMs !== stateUpdatedAtMs) fail('SNAPSHOT_STATE_TIMESTAMP_INVALID');
  if (!finite(snapshot.observedAtMs) || snapshot.observedAtMs <= 0
    || !finite(snapshot.maximumAgeMs) || snapshot.maximumAgeMs <= 0) fail('SNAPSHOT_TIME_METADATA_INVALID');
  if (snapshot.accountId !== snapshot.state.account.id || snapshot.equity !== snapshot.state.account.equity) fail('SNAPSHOT_ACCOUNT_METADATA_MISMATCH');
  const open = stateOpenPositions(snapshot.state);
  const pending = pendingOrders(snapshot.state);
  if (snapshot.openPositionCount !== open.length) fail('SNAPSHOT_OPEN_POSITION_COUNT_MISMATCH');
  if (open.length !== 1) fail('RECOVERY_REQUIRES_EXACTLY_ONE_OPEN_POSITION');
  if (pending.length !== 0) fail('RECOVERY_PENDING_ORDER_BLOCK');
  const position = open[0];
  const symbol = String(position?.symbol ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/u.test(symbol)) fail('RECOVERY_POSITION_SYMBOL_INVALID');
  if (typeof position?.id !== 'string' || !position.id.trim()) fail('RECOVERY_POSITION_ID_INVALID');
  if (!finite(position.remainingQuantity) || position.remainingQuantity <= EPSILON) fail('RECOVERY_POSITION_QUANTITY_INVALID');
  return { position, symbol, openCount: 1, pendingCount: 0 };
}

export function validateFreshMarket(market, { symbol, nowMs }) {
  if (!market || typeof market !== 'object' || Array.isArray(market)) fail('MARKET_REQUIRED');
  if (String(market.symbol ?? '').trim().toUpperCase() !== symbol) fail('MARKET_SYMBOL_MISMATCH');
  if (market.status !== 'live') fail('MARKET_NOT_LIVE');
  const updatedAtMs = Date.parse(String(market.updatedAt ?? ''));
  if (!finite(updatedAtMs) || nowMs < updatedAtMs || nowMs - updatedAtMs > MARKET_FRESHNESS_MS) fail('MARKET_STALE');
  const candidates = [market.bidPrice, market.askPrice, market.markPrice, market.price];
  if (!candidates.some((value) => finite(value) && value > 0)) fail('MARKET_PRICE_UNAVAILABLE');
  return market;
}

export function buildCloseAction({ snapshotDigest, positionId, market }) {
  const eventId = `paper-flat-recovery:${String(snapshotDigest).slice(0, 24)}`;
  if (!/^paper-flat-recovery:[0-9a-f]{24}$/u.test(eventId)) fail('RECOVERY_EVENT_ID_INVALID');
  return {
    type: 'close_position',
    eventId,
    positionId,
    percentage: 100,
    market,
    reason: 'manual_close',
  };
}

export function validateCloseResponse(body, { targetSha, publisherDigest }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('CLOSE_RESPONSE_INVALID');
  if (body.ok !== true || body.mode !== 'paper-only' || body.orderSubmitted !== false || body.exchangeRequestSent !== false) {
    fail('CLOSE_SAFETY_ENVELOPE_INVALID');
  }
  const result = body.result;
  if (!result || result.ok !== true || result.mode !== 'paper-only' || result.orderSubmitted !== false || result.exchangeRequestSent !== false) {
    fail('CLOSE_RESULT_INVALID');
  }
  if (result.duplicateEvent !== false) fail('CLOSE_DUPLICATE_EVENT');
  if (!Array.isArray(result.fills) || result.fills.length !== 1 || result.fills[0]?.fillReason !== 'manual_close') {
    fail('CLOSE_FILL_INVALID');
  }
  if (!result.position || result.position.status !== 'closed' || !nonNegativeZero(result.position.remainingQuantity)) {
    fail('CLOSE_POSITION_NOT_FLAT');
  }
  const state = result.state;
  if (stateOpenPositions(state).length !== 0 || pendingOrders(state).length !== 0) fail('CLOSE_STATE_NOT_FLAT');
  if (!nonNegativeZero(state?.account?.usedMargin) || !nonNegativeZero(state?.account?.unrealizedPnl)) fail('CLOSE_ACCOUNT_NOT_FLAT');
  const transport = body.paperStateTransport;
  if (!transport || transport.status !== 'PUBLISHED' || transport.publisherAccountBound !== true
    || transport.executionAuthority !== 'NONE' || transport.privateApiAllowed !== false
    || transport.liveTrading !== false || transport.financialMutationAllowed !== false) {
    fail('CLOSE_PUBLISHER_NOT_PUBLISHED');
  }
  if (transport.reason !== null || !digest(transport.stateDigestSha256)
    || !finite(transport.observedAtMs) || transport.observedAtMs <= 0) fail('CLOSE_PUBLISHER_EVIDENCE_INVALID');
  if (sha256(canonicalJson(state)) !== transport.stateDigestSha256) fail('CLOSE_PUBLISHER_STATE_DIGEST_MISMATCH');
  return { state, transportDigest: transport.stateDigestSha256, targetSha, publisherDigest };
}

export function validateFlatSnapshot(snapshot, { targetSha, publisherDigest, expectedDigest }) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail('FINAL_SNAPSHOT_REQUIRED');
  if (snapshot.schemaVersion !== SNAPSHOT_VERSION || snapshot.paperStateSchemaVersion !== 1) fail('FINAL_SNAPSHOT_SCHEMA_INVALID');
  if (snapshot.sourceSha !== targetSha) fail('FINAL_SNAPSHOT_TARGET_SHA_MISMATCH');
  if (snapshot.publisherAccountIdSha256 !== publisherDigest) fail('FINAL_SNAPSHOT_ACCOUNT_MISMATCH');
  if (snapshot.stateDigestSha256 !== expectedDigest) fail('FINAL_SNAPSHOT_PUBLISH_DIGEST_MISMATCH');
  if (sha256(canonicalJson(snapshot.state)) !== snapshot.stateDigestSha256) fail('FINAL_SNAPSHOT_DIGEST_MISMATCH');
  if (snapshot.openPositionCount !== 0 || stateOpenPositions(snapshot.state).length !== 0 || pendingOrders(snapshot.state).length !== 0) {
    fail('FINAL_SNAPSHOT_NOT_FLAT');
  }
  if (!nonNegativeZero(snapshot.state?.account?.usedMargin) || !nonNegativeZero(snapshot.state?.account?.unrealizedPnl)) {
    fail('FINAL_ACCOUNT_NOT_FLAT');
  }
  if (snapshot.immutable !== true || snapshot.executionAuthority !== 'NONE'
    || snapshot.privateApiAllowed !== false || snapshot.liveTrading !== false
    || snapshot.financialMutationAllowed !== false) fail('FINAL_SNAPSHOT_SAFETY_INVALID');
  const nowMs = Date.now();
  const stateUpdatedAtMs = Date.parse(String(snapshot.state?.updatedAt ?? ''));
  if (!finite(snapshot.observedAtMs) || !finite(snapshot.maximumAgeMs) || snapshot.maximumAgeMs <= 0
    || !finite(stateUpdatedAtMs) || snapshot.stateUpdatedAtMs !== stateUpdatedAtMs
    || nowMs < snapshot.observedAtMs || nowMs - snapshot.stateUpdatedAtMs > snapshot.maximumAgeMs) {
    fail('FINAL_SNAPSHOT_FRESHNESS_INVALID');
  }
  if (snapshot.accountId !== snapshot.state?.account?.id || snapshot.equity !== snapshot.state?.account?.equity) {
    fail('FINAL_SNAPSHOT_ACCOUNT_METADATA_MISMATCH');
  }
  const manualClosed = Array.isArray(snapshot.state?.journal)
    && snapshot.state.journal.some((entry) => entry?.status === 'closed' && entry?.exitReason === 'manual_close' && Number(entry?.remainingQuantity) <= EPSILON);
  if (!manualClosed) fail('FINAL_MANUAL_CLOSE_JOURNAL_MISSING');
  return true;
}

function managedCronCount() {
  const result = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (result.status === 0) {
    return String(result.stdout ?? '').split(/\r?\n/u).filter((line) => line.includes('# stock-app-paper-forward-v1')).length;
  }
  const stderr = String(result.stderr ?? '');
  if (/no crontab/iu.test(stderr)) return 0;
  fail('CRONTAB_READ_FAILED');
}

function runtimeEnvironment(pm2Name) {
  let processes;
  try {
    processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
  } catch {
    fail('PM2_ENV_READ_FAILED');
  }
  const processInfo = Array.isArray(processes) ? processes.find((item) => item?.name === pm2Name) : null;
  const env = processInfo?.pm2_env;
  if (!env || env.status !== 'online') fail('PM2_APP_NOT_ONLINE');
  const supabaseUrl = String(env.SUPABASE_URL ?? '').trim().replace(/\/$/u, '');
  const supabaseAnonKey = String(env.SUPABASE_ANON_KEY ?? '').trim();
  if (!/^https:\/\//u.test(supabaseUrl) || !supabaseAnonKey) fail('SUPABASE_AUTH_ENV_UNAVAILABLE');
  return { supabaseUrl, supabaseAnonKey };
}

async function readJson(path, code) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    fail(code);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${code}_INVALID_JSON`);
  }
}

async function fetchJson(url, init = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('FETCH_TIMEOUT')), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* fail below */ }
    return { response, body };
  } catch (error) {
    fail('NETWORK_REQUEST_FAILED', error instanceof Error ? error.message : 'NETWORK_REQUEST_FAILED');
  } finally {
    clearTimeout(timer);
  }
}

async function requireHealth(baseUrl, targetSha) {
  const { response, body } = await fetchJson(`${baseUrl}/api/health`, {}, 15_000);
  if (!response.ok || body?.ok !== true || body?.deploySha !== targetSha || body?.processDeploySha !== targetSha
    || body?.deployMarkerSha !== targetSha || body?.identityMatch !== true || body?.identityStatus !== 'match') {
    fail('PRODUCTION_HEALTH_IDENTITY_MISMATCH');
  }
}

async function authenticatePublisher({ supabaseUrl, supabaseAnonKey, qaLogin, qaPassword, publisherDigest }) {
  const email = internalEmail(qaLogin);
  const { response, body } = await fetchJson(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password: qaPassword }),
  }, 20_000);
  const accessToken = String(body?.access_token ?? '');
  const userId = String(body?.user?.id ?? '');
  if (!response.ok || !accessToken || !userId) fail('PUBLISHER_AUTHENTICATION_FAILED');
  if (sha256(userId) !== publisherDigest) fail('AUTHENTICATED_PUBLISHER_ACCOUNT_MISMATCH');
  return accessToken;
}

export async function runOneShotClose() {
  const targetSha = String(process.env.TARGET_SHA ?? '').trim().toLowerCase();
  const publisherDigest = String(process.env.PUBLISHER_ACCOUNT_ID_SHA256 ?? '').trim().toLowerCase();
  const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '');
  const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
  const stateRoot = String(process.env.PAPER_FORWARD_STATE_ROOT ?? DEFAULT_STATE_ROOT).replace(/\/$/u, '');
  const liveDir = String(process.env.LIVE_DIR ?? DEFAULT_LIVE_DIR).replace(/\/$/u, '');
  const pm2Name = String(process.env.PM2_NAME ?? DEFAULT_PM2_NAME).trim();
  const livePort = Number(process.env.LIVE_PORT ?? DEFAULT_LIVE_PORT);
  if (!exactSha(targetSha)) fail('TARGET_SHA_INVALID');
  if (!digest(publisherDigest)) fail('PUBLISHER_DIGEST_INVALID');
  if (!qaLogin.trim() || !qaPassword) fail('PRODUCTION_QA_CREDENTIAL_MISSING');
  if (!Number.isInteger(livePort) || livePort < 1 || livePort > 65535) fail('LIVE_PORT_INVALID');

  const bindingPath = `${stateRoot}/publisher-binding.json`;
  const snapshotPath = `${stateRoot}/publisher/paper-state-v2.json`;
  const markerSha = String(await readFile(`${liveDir}/.deploy/current-sha`, 'utf8')).trim().toLowerCase();
  if (markerSha !== targetSha) fail('PRODUCTION_APP_SHA_MISMATCH');
  const cronBefore = managedCronCount();
  if (cronBefore !== 0) fail('PAPER_SCHEDULE_MUST_BE_INACTIVE');

  const binding = await readJson(bindingPath, 'BINDING_READ_FAILED');
  validateBinding(binding, { targetSha, publisherDigest, snapshotPath });
  const snapshot = await readJson(snapshotPath, 'SNAPSHOT_READ_FAILED');
  const recovery = validateRecoverySnapshot(snapshot, { publisherDigest });
  const baseUrl = `http://127.0.0.1:${livePort}`;
  await requireHealth(baseUrl, targetSha);

  const runtime = runtimeEnvironment(pm2Name);
  const token = await authenticatePublisher({ ...runtime, qaLogin, qaPassword, publisherDigest });

  const marketResult = await fetchJson(`${baseUrl}/api/crypto/futures/${encodeURIComponent(recovery.symbol)}/snapshot`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 20_000);
  if (!marketResult.response.ok || marketResult.body?.ok !== true) fail('PUBLIC_MARKET_SNAPSHOT_FAILED');
  const now = new Date();
  const market = validateFreshMarket(marketResult.body.data, { symbol: recovery.symbol, nowMs: now.getTime() });
  const action = buildCloseAction({ snapshotDigest: snapshot.stateDigestSha256, positionId: recovery.position.id, market });

  const closeResult = await fetchJson(`${baseUrl}/api/paper-trading/evaluate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ state: snapshot.state, action, now: now.toISOString() }),
  }, 20_000);
  if (!closeResult.response.ok) fail(String(closeResult.body?.code ?? 'PAPER_CLOSE_REQUEST_FAILED'));
  const validated = validateCloseResponse(closeResult.body, { targetSha, publisherDigest });

  const finalSnapshot = await readJson(snapshotPath, 'FINAL_SNAPSHOT_READ_FAILED');
  validateFlatSnapshot(finalSnapshot, {
    targetSha,
    publisherDigest,
    expectedDigest: validated.transportDigest,
  });
  await requireHealth(baseUrl, targetSha);
  const markerAfter = String(await readFile(`${liveDir}/.deploy/current-sha`, 'utf8')).trim().toLowerCase();
  const cronAfter = managedCronCount();
  if (markerAfter !== targetSha) fail('PRODUCTION_APP_SHA_CHANGED_DURING_CLOSE');
  if (cronAfter !== cronBefore) fail('PAPER_SCHEDULE_CHANGED_DURING_CLOSE');

  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    status: 'CLOSED_AND_PUBLISHED',
    targetSha,
    productionAppShaUnchanged: true,
    publisherAccountBound: true,
    openPositionCountBefore: recovery.openCount,
    openPositionCountAfter: 0,
    pendingOrderCountBefore: recovery.pendingCount,
    pendingOrderCountAfter: 0,
    paperStateTransport: 'PUBLISHED',
    manualClose: true,
    finalFlat: true,
    usedMarginZero: true,
    unrealizedPnlZero: true,
    scheduleActiveBefore: false,
    scheduleActiveAfter: false,
    scheduleMutation: 0,
    productionAppMutation: 0,
    productionDbMutation: 0,
    paperAccountingMutation: 1,
    realFinancialMutation: 0,
    privateBrokerExchangeApi: 0,
    realOrder: 0,
    realCancel: 0,
    realAmend: 0,
    realTransfer: 0,
    realWithdrawal: 0,
    liveTrading: false,
    executionAuthority: 'NONE',
    naturalSampleCredit: 0,
    naturalSettlementCredit: 0,
    sensitiveValuesEmitted: false,
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

const isDirect = process.env.PAPER_ONE_SHOT_EXECUTE === '1'
  || (process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname);
if (isDirect) {
  runOneShotClose().catch((error) => {
    const code = String(error?.code ?? 'PAPER_ONE_SHOT_CLOSE_FAILED');
    process.stderr.write(`[paper-one-shot-close] ${code}\n`);
    process.exit(1);
  });
}
