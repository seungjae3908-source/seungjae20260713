#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';

export const SCHEMA_VERSION = 'paper-forward-flat-snapshot-republish-v1';
export const BINDING_VERSION = 'paper-state-publisher-runtime-binding-v1';
export const SNAPSHOT_VERSION = 'paper-trading-state-snapshot-v2';
const EPSILON = 1e-8;
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

function exactSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function digest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function zero(value) {
  return finite(value) && Math.abs(value) <= EPSILON;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function openPositions(state) {
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
  return true;
}

export function validateFlatSnapshot(snapshot, { publisherDigest, targetSha = null, requireFresh = false, nowMs = Date.now() } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail('SNAPSHOT_REQUIRED');
  if (snapshot.schemaVersion !== SNAPSHOT_VERSION || snapshot.paperStateSchemaVersion !== 1) fail('SNAPSHOT_SCHEMA_INVALID');
  if (targetSha != null && snapshot.sourceSha !== targetSha) fail('SNAPSHOT_TARGET_SHA_MISMATCH');
  if (!exactSha(snapshot.sourceSha)) fail('SNAPSHOT_SOURCE_SHA_INVALID');
  if (snapshot.publisherAccountIdSha256 !== publisherDigest || !digest(snapshot.publisherAccountIdSha256)) fail('SNAPSHOT_ACCOUNT_MISMATCH');
  if (snapshot.market !== 'CRYPTO_FUTURES' || snapshot.currency !== 'USDT') fail('SNAPSHOT_MARKET_CONTRACT_INVALID');
  if (snapshot.immutable !== true
    || snapshot.executionAuthority !== 'NONE'
    || snapshot.privateApiAllowed !== false
    || snapshot.liveTrading !== false
    || snapshot.financialMutationAllowed !== false) fail('SNAPSHOT_SAFETY_INVALID');
  if (!snapshot.state || snapshot.state.schemaVersion !== 1 || !snapshot.state.account) fail('SNAPSHOT_STATE_INVALID');
  if (!digest(snapshot.stateDigestSha256) || sha256(canonicalJson(snapshot.state)) !== snapshot.stateDigestSha256) fail('SNAPSHOT_DIGEST_INVALID');
  if (openPositions(snapshot.state).length !== 0 || pendingOrders(snapshot.state).length !== 0 || snapshot.openPositionCount !== 0) fail('SNAPSHOT_NOT_FLAT');
  if (!zero(snapshot.state.account.usedMargin) || !zero(snapshot.state.account.unrealizedPnl)) fail('SNAPSHOT_ACCOUNT_NOT_FLAT');
  if (!finite(snapshot.state.account.cashBalance) || !finite(snapshot.state.account.equity) || !finite(snapshot.state.account.availableMargin)
    || Math.abs(snapshot.state.account.equity - snapshot.state.account.cashBalance) > EPSILON
    || Math.abs(snapshot.state.account.availableMargin - snapshot.state.account.equity) > EPSILON) fail('SNAPSHOT_FLAT_ACCOUNT_INCONSISTENT');
  const stateUpdatedAtMs = Date.parse(String(snapshot.state.updatedAt ?? ''));
  if (!finite(stateUpdatedAtMs) || snapshot.stateUpdatedAtMs !== stateUpdatedAtMs) fail('SNAPSHOT_STATE_TIMESTAMP_INVALID');
  if (!finite(snapshot.observedAtMs) || !finite(snapshot.maximumAgeMs) || snapshot.maximumAgeMs <= 0) fail('SNAPSHOT_TIME_METADATA_INVALID');
  if (requireFresh && (nowMs < snapshot.observedAtMs || nowMs - snapshot.stateUpdatedAtMs > snapshot.maximumAgeMs)) fail('SNAPSHOT_STALE_OR_FUTURE');
  if (snapshot.accountId !== snapshot.state.account.id || snapshot.equity !== snapshot.state.account.equity) fail('SNAPSHOT_ACCOUNT_METADATA_MISMATCH');
  return snapshot;
}

function dayKey(at) {
  return at.toISOString().slice(0, 10);
}

function weekKey(at) {
  const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function requireStableRiskWindow(state, now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !state?.riskState) fail('RISK_WINDOW_INVALID');
  if (state.riskState.dayKey !== dayKey(now) || state.riskState.weekKey !== weekKey(now)) fail('RISK_WINDOW_ROLLOVER_REQUIRES_SEPARATE_ACCOUNTING_ACTION');
  return true;
}

export function selectRefreshAnchor(state) {
  const positions = Array.isArray(state?.positions) ? state.positions : [];
  const closed = positions.find((position) => position?.status === 'closed'
    && typeof position?.symbol === 'string' && /^[A-Z0-9]{2,20}$/u.test(position.symbol.trim().toUpperCase())
    && finite(position?.currentPrice) && position.currentPrice > 0);
  if (!closed) fail('FLAT_REFRESH_ANCHOR_REQUIRED');
  return { symbol: closed.symbol.trim().toUpperCase(), price: closed.currentPrice };
}

export function buildRefreshAction({ stateDigest, symbol, price }) {
  if (!digest(stateDigest)) fail('REFRESH_STATE_DIGEST_INVALID');
  if (!/^[A-Z0-9]{2,20}$/u.test(symbol) || !finite(price) || price <= 0) fail('REFRESH_ANCHOR_INVALID');
  return {
    type: 'mark_price',
    eventId: `paper-flat-republish:${stateDigest.slice(0, 24)}`,
    symbol,
    price,
  };
}

function invariantStateView(state) {
  const account = clone(state.account ?? {});
  delete account.updatedAt;
  return {
    schemaVersion: state.schemaVersion,
    account,
    orders: clone(state.orders ?? []),
    positions: clone(state.positions ?? []),
    fills: clone(state.fills ?? []),
    journal: clone(state.journal ?? []),
    riskState: clone(state.riskState ?? null),
    createdAt: state.createdAt,
  };
}

export function validateRepublishResponse(body, { beforeState, targetSha, publisherDigest, action, nowIso }) {
  if (!body || body.ok !== true || body.mode !== 'paper-only' || body.orderSubmitted !== false || body.exchangeRequestSent !== false) {
    fail('REPUBLISH_SAFETY_ENVELOPE_INVALID');
  }
  const result = body.result;
  if (!result || result.ok !== true || result.mode !== 'paper-only' || result.orderSubmitted !== false || result.exchangeRequestSent !== false) {
    fail('REPUBLISH_RESULT_INVALID');
  }
  if (result.duplicateEvent !== false || result.order !== null || result.position !== null || !Array.isArray(result.fills) || result.fills.length !== 0) {
    fail('REPUBLISH_MUST_BE_METADATA_ONLY');
  }
  const afterState = result.state;
  if (canonicalJson(invariantStateView(afterState)) !== canonicalJson(invariantStateView(beforeState))) fail('REPUBLISH_ECONOMIC_STATE_CHANGED');
  const beforeEvents = Array.isArray(beforeState.processedEventIds) ? beforeState.processedEventIds : [];
  const afterEvents = Array.isArray(afterState.processedEventIds) ? afterState.processedEventIds : [];
  const expectedEvents = [...beforeEvents, action.eventId].slice(-500);
  if (canonicalJson(afterEvents) !== canonicalJson(expectedEvents)) fail('REPUBLISH_EVENT_LEDGER_INVALID');
  if (afterState.updatedAt !== nowIso || afterState.account?.updatedAt !== nowIso) fail('REPUBLISH_FRESHNESS_TIMESTAMP_INVALID');
  if (openPositions(afterState).length !== 0 || pendingOrders(afterState).length !== 0 || !zero(afterState.account?.usedMargin) || !zero(afterState.account?.unrealizedPnl)) {
    fail('REPUBLISH_RESULT_NOT_FLAT');
  }
  const transport = body.paperStateTransport;
  if (!transport || transport.status !== 'PUBLISHED' || transport.publisherAccountBound !== true
    || transport.executionAuthority !== 'NONE' || transport.privateApiAllowed !== false
    || transport.liveTrading !== false || transport.financialMutationAllowed !== false
    || transport.reason !== null || !digest(transport.stateDigestSha256)) fail('REPUBLISH_TRANSPORT_INVALID');
  if (sha256(canonicalJson(afterState)) !== transport.stateDigestSha256) fail('REPUBLISH_TRANSPORT_DIGEST_MISMATCH');
  return { afterState, transportDigest: transport.stateDigestSha256, targetSha, publisherDigest };
}

function managedCronCount() {
  const result = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (result.status === 0) return String(result.stdout ?? '').split(/\r?\n/u).filter((line) => line.includes('# stock-app-paper-forward-v1')).length;
  if (/no crontab/iu.test(String(result.stderr ?? ''))) return 0;
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
  try { raw = await readFile(path, 'utf8'); } catch { fail(code); }
  try { return JSON.parse(raw); } catch { fail(`${code}_INVALID_JSON`); }
}

async function fetchJson(url, init = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('FETCH_TIMEOUT')), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* validated below */ }
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
    || body?.deployMarkerSha !== targetSha || body?.identityMatch !== true || body?.identityStatus !== 'match') fail('PRODUCTION_HEALTH_IDENTITY_MISMATCH');
}

export function internalEmail(loginName) {
  const normalized = String(loginName ?? '').trim().normalize('NFKC').toLowerCase();
  if (normalized.length < 2 || normalized.length > 20) fail('QA_LOGIN_INVALID');
  const token = sha256(`seungjae-stock-account:${normalized}`).slice(0, 40);
  return `${token}@accounts.seungjae-stock.com`;
}

async function authenticatePublisher({ supabaseUrl, supabaseAnonKey, qaLogin, qaPassword, publisherDigest }) {
  const { response, body } = await fetchJson(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: internalEmail(qaLogin), password: qaPassword }),
  });
  const token = String(body?.access_token ?? '');
  const userId = String(body?.user?.id ?? '');
  if (!response.ok || !token || !userId) fail('PUBLISHER_AUTHENTICATION_FAILED');
  if (sha256(userId) !== publisherDigest) fail('AUTHENTICATED_PUBLISHER_ACCOUNT_MISMATCH');
  return token;
}

export async function runFlatSnapshotRepublish() {
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
  const markerBefore = String(await readFile(`${liveDir}/.deploy/current-sha`, 'utf8')).trim().toLowerCase();
  if (markerBefore !== targetSha) fail('PRODUCTION_APP_SHA_MISMATCH');
  const cronBefore = managedCronCount();
  if (cronBefore !== 0) fail('PAPER_SCHEDULE_MUST_BE_INACTIVE');

  const binding = await readJson(bindingPath, 'BINDING_READ_FAILED');
  validateBinding(binding, { targetSha, publisherDigest, snapshotPath });
  const beforeSnapshot = validateFlatSnapshot(await readJson(snapshotPath, 'SNAPSHOT_READ_FAILED'), { publisherDigest });
  const beforeState = clone(beforeSnapshot.state);
  const anchor = selectRefreshAnchor(beforeState);
  const action = buildRefreshAction({ stateDigest: beforeSnapshot.stateDigestSha256, ...anchor });
  const now = new Date();
  requireStableRiskWindow(beforeState, now);
  const nowIso = now.toISOString();
  const baseUrl = `http://127.0.0.1:${livePort}`;
  await requireHealth(baseUrl, targetSha);

  const runtime = runtimeEnvironment(pm2Name);
  const token = await authenticatePublisher({ ...runtime, qaLogin, qaPassword, publisherDigest });
  const response = await fetchJson(`${baseUrl}/api/paper-trading/evaluate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state: beforeState, action, now: nowIso }),
  });
  if (!response.response.ok) fail(String(response.body?.code ?? 'PAPER_REPUBLISH_REQUEST_FAILED'));
  const validated = validateRepublishResponse(response.body, { beforeState, targetSha, publisherDigest, action, nowIso });

  const finalSnapshot = validateFlatSnapshot(await readJson(snapshotPath, 'FINAL_SNAPSHOT_READ_FAILED'), {
    publisherDigest,
    targetSha,
    requireFresh: true,
    nowMs: Date.now(),
  });
  if (finalSnapshot.stateDigestSha256 !== validated.transportDigest
    || canonicalJson(finalSnapshot.state) !== canonicalJson(validated.afterState)) fail('FINAL_SNAPSHOT_PUBLISH_MISMATCH');

  await requireHealth(baseUrl, targetSha);
  const markerAfter = String(await readFile(`${liveDir}/.deploy/current-sha`, 'utf8')).trim().toLowerCase();
  const cronAfter = managedCronCount();
  if (markerAfter !== markerBefore) fail('PRODUCTION_APP_SHA_CHANGED_DURING_REPUBLISH');
  if (cronAfter !== cronBefore) fail('PAPER_SCHEDULE_CHANGED_DURING_REPUBLISH');

  process.stdout.write(`${JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    status: 'FLAT_REPUBLISHED',
    targetSha,
    sourceShaBefore: beforeSnapshot.sourceSha,
    sourceShaAfter: finalSnapshot.sourceSha,
    stateDigestChanged: beforeSnapshot.stateDigestSha256 !== finalSnapshot.stateDigestSha256,
    economicStatePreserved: true,
    freshnessMetadataMutation: 1,
    paperAccountingMutation: 0,
    openPositionCountBefore: 0,
    openPositionCountAfter: 0,
    pendingOrderCountBefore: 0,
    pendingOrderCountAfter: 0,
    usedMarginZero: true,
    unrealizedPnlZero: true,
    publisherAccountBound: true,
    paperStateTransport: 'PUBLISHED',
    scheduleActiveBefore: false,
    scheduleActiveAfter: false,
    scheduleMutation: 0,
    productionAppMutation: 0,
    productionDbMutation: 0,
    realFinancialMutation: 0,
    privateBrokerExchangeApi: 0,
    realOrder: 0,
    realCancel: 0,
    realAmend: 0,
    realTransfer: 0,
    realWithdrawal: 0,
    liveTrading: false,
    executionAuthority: 'NONE',
    naturalCycleCredit: 0,
    naturalSampleCredit: 0,
    naturalSettlementCredit: 0,
    sensitiveValuesEmitted: false,
  }, null, 2)}\n`);
}

const isDirect = process.env.PAPER_FLAT_REPUBLISH_EXECUTE === '1'
  || (process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname);
if (isDirect) {
  runFlatSnapshotRepublish().catch((error) => {
    process.stderr.write(`[paper-flat-republish] ${String(error?.code ?? 'PAPER_FLAT_REPUBLISH_FAILED')}\n`);
    process.exit(1);
  });
}
