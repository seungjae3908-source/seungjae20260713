#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { readFile, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const SCHEMA_VERSION = 'paper-forward-flat-snapshot-republish-v1';
const BINDING_VERSION = 'paper-state-publisher-runtime-binding-v1';
const SNAPSHOT_VERSION = 'paper-trading-state-snapshot-v2';
const TRANSPORT_VERSION = 'paper-state-transport-publish-result-v2';
const EPSILON = 1e-8;
const MAX_PROCESSED_EVENTS = 500;
const DEFAULT_STATE_ROOT = '/opt/stock-app-data/paper-forward-v1';
const DEFAULT_LIVE_DIR = '/opt/stock-app';
const DEFAULT_PM2_NAME = 'stock-app';
const DEFAULT_LIVE_PORT = 8080;
const MANAGED_CRON_TAG = '# stock-app-paper-forward-v1';

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
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
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

function positive(value) {
  return finite(value) && value > 0;
}

function nearZero(value) {
  return finite(value) && Math.abs(value) <= EPSILON;
}

function equalJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
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

function canonicalSymbol(value) {
  return typeof value === 'string' && /^[A-Z0-9]{2,20}$/u.test(value.trim().toUpperCase());
}

function accountFinancials(account) {
  return {
    id: account?.id ?? null,
    initialBalance: account?.initialBalance ?? null,
    cashBalance: account?.cashBalance ?? null,
    realizedPnl: account?.realizedPnl ?? null,
    unrealizedPnl: account?.unrealizedPnl ?? null,
    equity: account?.equity ?? null,
    usedMargin: account?.usedMargin ?? null,
    availableMargin: account?.availableMargin ?? null,
    createdAt: account?.createdAt ?? null,
  };
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

export function expectedNormalizedRiskState(riskState, nowIso) {
  const at = new Date(nowIso);
  if (!Number.isFinite(at.getTime())) fail('REPUBLISH_NOW_INVALID');
  if (!riskState || typeof riskState !== 'object') fail('REPUBLISH_RISK_STATE_REQUIRED');
  const currentDay = dayKey(at);
  const currentWeek = weekKey(at);
  return {
    dayKey: currentDay,
    weekKey: currentWeek,
    dailyRealizedPnl: riskState.dayKey === currentDay ? riskState.dailyRealizedPnl : 0,
    weeklyRealizedPnl: riskState.weekKey === currentWeek ? riskState.weeklyRealizedPnl : 0,
    consecutiveLosses: riskState.consecutiveLosses,
  };
}

export function validateBinding(binding, { snapshotPath, publisherDigest, expectedSourceSha = null }) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) fail('BINDING_REQUIRED');
  if (binding.schemaVersion !== BINDING_VERSION) fail('BINDING_SCHEMA_INVALID');
  if (!exactSha(binding.paperRuntimeSourceSha)) fail('BINDING_SOURCE_SHA_INVALID');
  if (expectedSourceSha && binding.paperRuntimeSourceSha !== expectedSourceSha) fail('BINDING_SOURCE_SHA_MISMATCH');
  if (binding.snapshotPath !== snapshotPath) fail('BINDING_SNAPSHOT_PATH_MISMATCH');
  if (!digest(publisherDigest) || binding.publisherAccountIdSha256 !== publisherDigest) fail('BINDING_ACCOUNT_MISMATCH');
  if (binding.immutable !== true
    || binding.executionAuthority !== 'NONE'
    || binding.privateApiAllowed !== false
    || binding.liveTrading !== false
    || binding.financialMutationAllowed !== false) fail('BINDING_SAFETY_INVALID');
  return binding;
}

function validateStateDigest(snapshot) {
  if (!digest(snapshot?.stateDigestSha256)) fail('SNAPSHOT_DIGEST_INVALID');
  if (sha256(canonicalJson(snapshot.state)) !== snapshot.stateDigestSha256) fail('SNAPSHOT_DIGEST_MISMATCH');
}

function republishAnchor(state) {
  const position = Array.isArray(state?.positions)
    ? [...state.positions].reverse().find((item) => item?.status === 'closed' && canonicalSymbol(item?.symbol)
      && [item?.currentPrice, item?.entryPrice].some(positive))
    : null;
  if (position) {
    return {
      symbol: String(position.symbol).trim().toUpperCase(),
      price: [position.currentPrice, position.entryPrice].find(positive),
    };
  }
  const journal = Array.isArray(state?.journal)
    ? [...state.journal].reverse().find((item) => item?.status === 'closed' && canonicalSymbol(item?.symbol)
      && [item?.exitPrice, item?.entryPrice].some(positive))
    : null;
  if (journal) {
    return {
      symbol: String(journal.symbol).trim().toUpperCase(),
      price: [journal.exitPrice, journal.entryPrice].find(positive),
    };
  }
  fail('REPUBLISH_CLOSED_MARK_ANCHOR_REQUIRED');
}

export function validateFlatSnapshotForRepublish(snapshot, {
  binding,
  targetSha,
  publisherDigest,
  snapshotPath,
}) {
  validateBinding(binding, { snapshotPath, publisherDigest });
  if (!exactSha(targetSha)) fail('TARGET_SHA_INVALID');
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail('SNAPSHOT_REQUIRED');
  if (snapshot.schemaVersion !== SNAPSHOT_VERSION || snapshot.paperStateSchemaVersion !== 1) fail('SNAPSHOT_SCHEMA_INVALID');
  if (snapshot.sourceSha !== binding.paperRuntimeSourceSha) fail('SNAPSHOT_BINDING_SOURCE_MISMATCH');
  if (snapshot.sourceSha === targetSha) fail('SNAPSHOT_ALREADY_TARGET_SOURCE');
  if (snapshot.publisherAccountIdSha256 !== publisherDigest) fail('SNAPSHOT_ACCOUNT_MISMATCH');
  if (snapshot.market !== 'CRYPTO_FUTURES' || snapshot.currency !== 'USDT') fail('SNAPSHOT_MARKET_CONTRACT_INVALID');
  if (snapshot.immutable !== true
    || snapshot.executionAuthority !== 'NONE'
    || snapshot.privateApiAllowed !== false
    || snapshot.liveTrading !== false
    || snapshot.financialMutationAllowed !== false) fail('SNAPSHOT_SAFETY_INVALID');
  if (!Array.isArray(snapshot.provenance) || snapshot.provenance.length === 0
    || snapshot.provenance.some((entry) => typeof entry !== 'string' || !entry.trim())) fail('SNAPSHOT_PROVENANCE_INVALID');
  if (!snapshot.state || snapshot.state.schemaVersion !== 1 || !snapshot.state.account || !snapshot.state.riskState) {
    fail('SNAPSHOT_STATE_INVALID');
  }
  validateStateDigest(snapshot);
  const stateUpdatedAtMs = Date.parse(String(snapshot.state.updatedAt ?? ''));
  if (!finite(stateUpdatedAtMs) || stateUpdatedAtMs <= 0 || snapshot.stateUpdatedAtMs !== stateUpdatedAtMs) {
    fail('SNAPSHOT_STATE_TIMESTAMP_INVALID');
  }
  if (!finite(snapshot.observedAtMs) || snapshot.observedAtMs <= 0
    || !finite(snapshot.maximumAgeMs) || snapshot.maximumAgeMs <= 0) fail('SNAPSHOT_TIME_METADATA_INVALID');
  if (snapshot.accountId !== snapshot.state.account.id || snapshot.equity !== snapshot.state.account.equity) {
    fail('SNAPSHOT_ACCOUNT_METADATA_MISMATCH');
  }
  if (snapshot.openPositionCount !== 0 || openPositions(snapshot.state).length !== 0) fail('REPUBLISH_REQUIRES_FLAT_POSITION_STATE');
  if (pendingOrders(snapshot.state).length !== 0) fail('REPUBLISH_PENDING_ORDER_BLOCK');
  if (!nearZero(snapshot.state.account.usedMargin) || !nearZero(snapshot.state.account.unrealizedPnl)) {
    fail('REPUBLISH_ACCOUNT_NOT_FLAT');
  }
  if (!finite(snapshot.state.account.cashBalance)
    || !finite(snapshot.state.account.equity)
    || !finite(snapshot.state.account.availableMargin)
    || Math.abs(snapshot.state.account.equity - snapshot.state.account.cashBalance) > EPSILON
    || Math.abs(snapshot.state.account.availableMargin - snapshot.state.account.equity) > EPSILON) {
    fail('REPUBLISH_FLAT_ACCOUNT_INCONSISTENT');
  }
  if (!Array.isArray(snapshot.state.orders)
    || !Array.isArray(snapshot.state.positions)
    || !Array.isArray(snapshot.state.fills)
    || !Array.isArray(snapshot.state.journal)
    || !Array.isArray(snapshot.state.processedEventIds)) fail('REPUBLISH_STATE_COLLECTION_INVALID');
  const anchor = republishAnchor(snapshot.state);
  return {
    previousSourceSha: snapshot.sourceSha,
    anchor,
    beforeState: snapshot.state,
    beforeStateDigest: snapshot.stateDigestSha256,
  };
}

export function buildRepublishRequest(snapshot, targetSha, nowMs = Date.now()) {
  if (!exactSha(targetSha)) fail('TARGET_SHA_INVALID');
  if (!finite(nowMs) || nowMs <= 0) fail('REPUBLISH_NOW_INVALID');
  validateStateDigest(snapshot);
  const anchor = republishAnchor(snapshot.state);
  const eventId = `paper-flat-republish:${targetSha.slice(0, 12)}:${snapshot.stateDigestSha256.slice(0, 12)}`;
  if (snapshot.state.processedEventIds?.includes(eventId)) fail('REPUBLISH_EVENT_ALREADY_PROCESSED');
  const nowIso = new Date(nowMs).toISOString();
  return {
    eventId,
    nowIso,
    request: {
      now: nowIso,
      state: snapshot.state,
      action: {
        type: 'mark_price',
        eventId,
        symbol: anchor.symbol,
        price: anchor.price,
        at: nowIso,
      },
    },
  };
}

function expectedProcessedEvents(before, eventId) {
  return [...before, eventId].slice(-MAX_PROCESSED_EVENTS);
}

export function validateRepublishResponse(body, {
  beforeState,
  eventId,
  nowIso,
}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('REPUBLISH_RESPONSE_INVALID');
  if (body.ok !== true || body.mode !== 'paper-only'
    || body.orderSubmitted !== false || body.exchangeRequestSent !== false) fail('REPUBLISH_SAFETY_ENVELOPE_INVALID');
  const result = body.result;
  if (!result || result.ok !== true || result.mode !== 'paper-only'
    || result.orderSubmitted !== false || result.exchangeRequestSent !== false) fail('REPUBLISH_RESULT_INVALID');
  if (result.duplicateEvent !== false) fail('REPUBLISH_DUPLICATE_EVENT');
  if (result.order !== null || result.position !== null || !Array.isArray(result.fills) || result.fills.length !== 0) {
    fail('REPUBLISH_TRADE_MUTATION_DETECTED');
  }
  const state = result.state;
  if (!state || state.schemaVersion !== 1) fail('REPUBLISH_STATE_INVALID');
  for (const key of ['orders', 'positions', 'fills', 'journal']) {
    if (!equalJson(state[key], beforeState[key])) fail(`REPUBLISH_${key.toUpperCase()}_MUTATED`);
  }
  if (!equalJson(accountFinancials(state.account), accountFinancials(beforeState.account))) {
    fail('REPUBLISH_ACCOUNT_FINANCIALS_MUTATED');
  }
  if (!nearZero(state.account.usedMargin) || !nearZero(state.account.unrealizedPnl)
    || openPositions(state).length !== 0 || pendingOrders(state).length !== 0) fail('REPUBLISH_FINAL_STATE_NOT_FLAT');
  const expectedRisk = expectedNormalizedRiskState(beforeState.riskState, nowIso);
  if (!equalJson(state.riskState, expectedRisk)) fail('REPUBLISH_RISK_NORMALIZATION_UNEXPECTED');
  const expectedEvents = expectedProcessedEvents(beforeState.processedEventIds, eventId);
  if (!equalJson(state.processedEventIds, expectedEvents)) fail('REPUBLISH_EVENT_LEDGER_UNEXPECTED');
  if (state.updatedAt !== nowIso || state.account.updatedAt !== nowIso) fail('REPUBLISH_FRESHNESS_TIMESTAMP_UNEXPECTED');
  const transport = body.paperStateTransport;
  if (!transport || transport.schemaVersion !== TRANSPORT_VERSION || transport.status !== 'PUBLISHED'
    || transport.invoked !== true || transport.callbackEligible !== true
    || transport.reason !== null || transport.publisherAccountBound !== true
    || transport.executionAuthority !== 'NONE' || transport.privateApiAllowed !== false
    || transport.liveTrading !== false || transport.financialMutationAllowed !== false
    || transport.unknownIsZero !== false || !digest(transport.stateDigestSha256)
    || !finite(transport.observedAtMs) || transport.observedAtMs <= 0) fail('REPUBLISH_PUBLISHER_NOT_PUBLISHED');
  const stateDigest = sha256(canonicalJson(state));
  if (stateDigest !== transport.stateDigestSha256) fail('REPUBLISH_PUBLISHER_DIGEST_MISMATCH');
  return { state, stateDigest, transportObservedAtMs: transport.observedAtMs };
}

export function validateFinalSnapshot(snapshot, {
  targetSha,
  publisherDigest,
  responseState,
  responseDigest,
  nowMs = Date.now(),
}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail('FINAL_SNAPSHOT_REQUIRED');
  if (snapshot.schemaVersion !== SNAPSHOT_VERSION || snapshot.paperStateSchemaVersion !== 1) fail('FINAL_SNAPSHOT_SCHEMA_INVALID');
  if (snapshot.sourceSha !== targetSha) fail('FINAL_SNAPSHOT_SOURCE_SHA_MISMATCH');
  if (snapshot.publisherAccountIdSha256 !== publisherDigest) fail('FINAL_SNAPSHOT_ACCOUNT_MISMATCH');
  if (snapshot.sourceOwner !== 'authenticated-paper-trading-evaluate-v2') fail('FINAL_SNAPSHOT_SOURCE_OWNER_INVALID');
  if (!Array.isArray(snapshot.provenance)
    || !['authenticated-member-session', 'paper-trading-engine-result', 'lossless-atomic-shared-path', 'paper-runtime-source-binding']
      .every((item) => snapshot.provenance.includes(item))) fail('FINAL_SNAPSHOT_PROVENANCE_INVALID');
  if (snapshot.immutable !== true || snapshot.executionAuthority !== 'NONE'
    || snapshot.privateApiAllowed !== false || snapshot.liveTrading !== false
    || snapshot.financialMutationAllowed !== false) fail('FINAL_SNAPSHOT_SAFETY_INVALID');
  validateStateDigest(snapshot);
  if (snapshot.stateDigestSha256 !== responseDigest || !equalJson(snapshot.state, responseState)) {
    fail('FINAL_SNAPSHOT_RESPONSE_MISMATCH');
  }
  if (snapshot.openPositionCount !== 0 || openPositions(snapshot.state).length !== 0 || pendingOrders(snapshot.state).length !== 0) {
    fail('FINAL_SNAPSHOT_NOT_FLAT');
  }
  if (!nearZero(snapshot.state.account.usedMargin) || !nearZero(snapshot.state.account.unrealizedPnl)) {
    fail('FINAL_SNAPSHOT_ACCOUNT_NOT_FLAT');
  }
  const stateUpdatedAtMs = Date.parse(String(snapshot.state.updatedAt ?? ''));
  if (!finite(snapshot.observedAtMs) || !finite(snapshot.maximumAgeMs) || snapshot.maximumAgeMs <= 0
    || !finite(stateUpdatedAtMs) || snapshot.stateUpdatedAtMs !== stateUpdatedAtMs
    || nowMs < snapshot.observedAtMs || nowMs - snapshot.stateUpdatedAtMs > snapshot.maximumAgeMs) {
    fail('FINAL_SNAPSHOT_FRESHNESS_INVALID');
  }
  if (snapshot.accountId !== snapshot.state.account.id || snapshot.equity !== snapshot.state.account.equity) {
    fail('FINAL_SNAPSHOT_ACCOUNT_METADATA_MISMATCH');
  }
  return true;
}

export function internalEmail(loginName) {
  const normalized = String(loginName ?? '').trim().normalize('NFKC').toLowerCase();
  if (normalized.length < 2 || normalized.length > 20) fail('QA_LOGIN_INVALID');
  const token = sha256(`seungjae-stock-account:${normalized}`).slice(0, 40);
  return `${token}@accounts.seungjae-stock.com`;
}

function managedCronCount() {
  const result = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (result.status === 0) {
    return String(result.stdout ?? '').split(/\r?\n/u).filter((line) => line.includes(MANAGED_CRON_TAG)).length;
  }
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

async function fetchJson(url, init = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('FETCH_TIMEOUT')), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* handled by caller */ }
    return { response, body };
  } catch {
    fail('NETWORK_REQUEST_FAILED');
  } finally {
    clearTimeout(timer);
  }
}

async function requireHealth(baseUrl, targetSha) {
  const { response, body } = await fetchJson(`${baseUrl}/api/health`, {}, 15_000);
  if (!response.ok || body?.ok !== true || body?.deploySha !== targetSha
    || body?.processDeploySha !== targetSha || body?.deployMarkerSha !== targetSha
    || body?.identityMatch !== true || body?.identityStatus !== 'match') {
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
  });
  const accessToken = String(body?.access_token ?? '');
  const userId = String(body?.user?.id ?? '');
  if (!response.ok || !accessToken || !userId) fail('PUBLISHER_AUTHENTICATION_FAILED');
  if (sha256(userId) !== publisherDigest) fail('AUTHENTICATED_PUBLISHER_ACCOUNT_MISMATCH');
  return accessToken;
}

async function readJson(path, code) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    fail(code);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(`${code}_INVALID_JSON`);
  }
  return { raw, value };
}

async function atomicRestore(path, raw) {
  const temporary = `${path}.rollback-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(raw, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function restoreOriginals({ bindingPath, bindingRaw, snapshotPath, snapshotRaw }) {
  try {
    await atomicRestore(bindingPath, bindingRaw);
    await atomicRestore(snapshotPath, snapshotRaw);
  } catch {
    await rm(`${bindingPath}.rollback-${process.pid}-${Date.now()}`, { force: true }).catch(() => {});
    fail('REPUBLISH_ROLLBACK_FAILED');
  }
}

export async function runFlatSnapshotRepublish() {
  if (String(process.env.PAPER_FLAT_SNAPSHOT_REPUBLISH_EXECUTE ?? '') !== '1') {
    fail('REPUBLISH_EXECUTION_GUARD_REQUIRED');
  }
  const targetSha = String(process.env.TARGET_SHA ?? '').trim().toLowerCase();
  const publisherDigest = String(process.env.PUBLISHER_ACCOUNT_ID_SHA256 ?? '').trim().toLowerCase();
  const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '').trim();
  const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
  const stateRoot = String(process.env.PAPER_FORWARD_STATE_ROOT ?? DEFAULT_STATE_ROOT).trim();
  const liveDir = String(process.env.LIVE_DIR ?? DEFAULT_LIVE_DIR).trim();
  const pm2Name = String(process.env.PM2_NAME ?? DEFAULT_PM2_NAME).trim();
  const livePort = Number(process.env.LIVE_PORT ?? DEFAULT_LIVE_PORT);
  if (!exactSha(targetSha)) fail('TARGET_SHA_INVALID');
  if (!digest(publisherDigest)) fail('PUBLISHER_DIGEST_INVALID');
  if (!qaLogin || !qaPassword) fail('PRODUCTION_QA_CREDENTIALS_REQUIRED');
  if (stateRoot !== DEFAULT_STATE_ROOT || liveDir !== DEFAULT_LIVE_DIR || !Number.isInteger(livePort) || livePort <= 0) {
    fail('REPUBLISH_RUNTIME_PATH_INVALID');
  }

  const bindingPath = join(stateRoot, 'publisher-binding.json');
  const snapshotPath = join(stateRoot, 'publisher', 'paper-state-v2.json');
  const deployMarker = join(liveDir, '.deploy', 'current-sha');
  const bindingScript = join(liveDir, 'ops', 'prepare-paper-forward-publisher-binding.sh');
  if (!fs.existsSync(bindingScript)) fail('BINDING_PREPARATION_SCRIPT_MISSING');

  const deployedSha = String(await readFile(deployMarker, 'utf8')).trim().toLowerCase();
  if (deployedSha !== targetSha) fail('PRODUCTION_APP_SHA_MISMATCH');
  const baseUrl = `http://127.0.0.1:${livePort}`;
  await requireHealth(baseUrl, targetSha);

  const cronBefore = managedCronCount();
  if (cronBefore !== 0) fail('REPUBLISH_REQUIRES_DISABLED_SCHEDULE');

  const originalBinding = await readJson(bindingPath, 'BINDING_READ_FAILED');
  const originalSnapshot = await readJson(snapshotPath, 'SNAPSHOT_READ_FAILED');
  const preflight = validateFlatSnapshotForRepublish(originalSnapshot.value, {
    binding: originalBinding.value,
    targetSha,
    publisherDigest,
    snapshotPath,
  });

  const { supabaseUrl, supabaseAnonKey } = runtimeEnvironment(pm2Name);
  const { eventId, nowIso, request } = buildRepublishRequest(originalSnapshot.value, targetSha, Date.now());

  let mutationStarted = false;
  let completed = false;
  try {
    mutationStarted = true;
    try {
      execFileSync(bindingScript, [targetSha], {
        encoding: 'utf8',
        env: {
          ...process.env,
          TARGET_SHA: targetSha,
          PAPER_FORWARD_STATE_ROOT: stateRoot,
          PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256: publisherDigest,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      fail('BINDING_PREPARATION_FAILED');
    }

    const rebound = await readJson(bindingPath, 'REBOUND_BINDING_READ_FAILED');
    validateBinding(rebound.value, {
      snapshotPath,
      publisherDigest,
      expectedSourceSha: targetSha,
    });

    const token = await authenticatePublisher({
      supabaseUrl,
      supabaseAnonKey,
      qaLogin,
      qaPassword,
      publisherDigest,
    });

    const { response, body } = await fetchJson(`${baseUrl}/api/paper-trading/evaluate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    }, 25_000);
    if (!response.ok) fail(String(body?.code ?? 'REPUBLISH_API_REQUEST_FAILED'));
    const published = validateRepublishResponse(body, {
      beforeState: preflight.beforeState,
      eventId,
      nowIso,
    });

    const finalSnapshot = await readJson(snapshotPath, 'FINAL_SNAPSHOT_READ_FAILED');
    validateFinalSnapshot(finalSnapshot.value, {
      targetSha,
      publisherDigest,
      responseState: published.state,
      responseDigest: published.stateDigest,
      nowMs: Date.now(),
    });
    const finalBinding = await readJson(bindingPath, 'FINAL_BINDING_READ_FAILED');
    validateBinding(finalBinding.value, {
      snapshotPath,
      publisherDigest,
      expectedSourceSha: targetSha,
    });

    const cronAfter = managedCronCount();
    if (cronAfter !== 0 || cronAfter !== cronBefore) fail('REPUBLISH_SCHEDULE_MUTATION_DETECTED');
    const finalDeployedSha = String(await readFile(deployMarker, 'utf8')).trim().toLowerCase();
    if (finalDeployedSha !== targetSha) fail('REPUBLISH_PRODUCTION_APP_MUTATION_DETECTED');
    await requireHealth(baseUrl, targetSha);

    completed = true;
    return {
      schemaVersion: SCHEMA_VERSION,
      status: 'REPUBLISHED_FLAT',
      targetSha,
      previousSourceSha: preflight.previousSourceSha,
      publisherAccountBound: true,
      paperStateTransport: 'PUBLISHED',
      finalFlat: true,
      openPositionCountBefore: 0,
      openPositionCountAfter: 0,
      pendingOrderCountBefore: 0,
      pendingOrderCountAfter: 0,
      usedMarginZero: true,
      unrealizedPnlZero: true,
      positionsPreserved: true,
      ordersPreserved: true,
      fillsPreserved: true,
      journalPreserved: true,
      accountFinancialsPreserved: true,
      riskWindowNormalizationOnly: true,
      freshnessEvent: 'mark_price',
      tradeFillCount: 0,
      paperTradeMutation: 0,
      paperFinancialMutation: 0,
      paperMetadataRepublish: 1,
      bindingUpdated: true,
      snapshotRepublished: true,
      scheduleActiveBefore: false,
      scheduleActiveAfter: false,
      scheduleMutation: 0,
      productionAppMutation: 0,
      applicationDatabaseMutation: 0,
      privateApiUsed: false,
      realOrder: 0,
      realCancel: 0,
      realAmend: 0,
      transfer: 0,
      withdrawal: 0,
      liveTrading: false,
      executionAuthority: 'NONE',
      naturalSampleCredit: 0,
      naturalSettlementCredit: 0,
      sensitiveValuesEmitted: false,
    };
  } catch (error) {
    if (mutationStarted && !completed) {
      await restoreOriginals({
        bindingPath,
        bindingRaw: originalBinding.raw,
        snapshotPath,
        snapshotRaw: originalSnapshot.raw,
      });
      if (managedCronCount() !== cronBefore) fail('REPUBLISH_ROLLBACK_SCHEDULE_MISMATCH');
      const restoredBinding = await readJson(bindingPath, 'ROLLBACK_BINDING_READ_FAILED');
      const restoredSnapshot = await readJson(snapshotPath, 'ROLLBACK_SNAPSHOT_READ_FAILED');
      if (restoredBinding.raw !== originalBinding.raw || restoredSnapshot.raw !== originalSnapshot.raw) {
        fail('REPUBLISH_ROLLBACK_CONTENT_MISMATCH');
      }
    }
    throw error;
  }
}

const directFileExecution = Boolean(process.argv[1]) && import.meta.url === `file://${process.argv[1]}`;
const protectedStdinExecution = process.argv[1] === '-'
  && String(process.env.PAPER_FLAT_SNAPSHOT_REPUBLISH_EXECUTE ?? '') === '1';

if (directFileExecution || protectedStdinExecution) {
  runFlatSnapshotRepublish()
    .then((evidence) => {
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
    })
    .catch((error) => {
      const code = String(error?.code ?? error?.message ?? 'REPUBLISH_FAILED').replace(/[^A-Z0-9_:-]/giu, '_').slice(0, 120);
      process.stderr.write(`[paper-flat-republish] ${code}\n`);
      process.exitCode = 1;
    });
}
