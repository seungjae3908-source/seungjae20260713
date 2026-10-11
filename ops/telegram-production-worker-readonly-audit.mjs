/**
 * Read-only production Telegram runtime/ledger observability.
 * Does not send messages, alter PM2, execute orders, or query personal records.
 * Ledger evidence may represent a delivered OR deduped report; never claim
 * Telegram Bot API acceptance or user receipt from this evidence alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { get as httpGet } from 'node:http';

// PM2 is started from Production root, NOT from its api-server child folder.
const ROOT = '/opt/stock-app';
const ENTRYPOINT = path.join(ROOT, 'api-server', 'dist', 'index.mjs');
const STATE_ROOTS = Object.freeze([
  path.join(ROOT, '.runtime'),
  path.join(ROOT, 'api-server', '.runtime'),
  '/opt/stock-app-data',
]);
const MARKER = '/opt/stock-app/.deploy/current-sha';
const MAX_STATE_BYTES = 1_048_576;
const ROOM_KEYS = Object.freeze([
  'TELEGRAM_KR_STOCK_CHAT_ID', 'TELEGRAM_US_STOCK_CHAT_ID',
  'TELEGRAM_CRYPTO_SPOT_CHAT_ID', 'TELEGRAM_CRYPTO_FUTURES_CHAT_ID',
  'TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID', 'TELEGRAM_AUTO_TRADING_CHAT_ID',
]);
const KINDS = Object.freeze(['MORNING', 'KR_CLOSING', 'US_PREMARKET', 'WEEKLY']);

export function safeSha(value) {
  const result = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/u.test(result) ? result : null;
}

function sanitizedErrorCode(value) {
  const valueString = String(value ?? '');
  return /^[A-Z0-9_]{1,64}$/u.test(valueString) ? valueString : null;
}

// Never copy a raw timestamp from an HTTP health payload into a public QA receipt.
function sanitizedIsoTime(value) {
  if (typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function emptyState(status) {
  return {
    status, recordCount: 0, recent24hCount: 0, lastEvidenceAt: null,
    briefKinds: Object.fromEntries(KINDS.map(kind => [kind, 0])),
  };
}

export function inspectDeliveryStateText(raw, type, nowMs = Date.now()) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_STATE_BYTES
    || !Number.isFinite(nowMs) || !['market', 'signal'].includes(type)) {
    return emptyState('INVALID');
  }
  let data;
  try { data = JSON.parse(raw); } catch { return emptyState('INVALID'); }
  if (data?.version !== 1 || !data.delivered
    || typeof data.delivered !== 'object' || Array.isArray(data.delivered)) {
    return emptyState('INVALID');
  }
  const entries = Object.entries(data.delivered);
  if (entries.length > 10000) return emptyState('INVALID');
  const result = emptyState(entries.length ? 'PRESENT' : 'EMPTY');
  let newest = 0;
  for (const [key, value] of entries) {
    let kind = null;
    if (type === 'market') {
      const match = /^telegram-intelligence:(MORNING|KR_CLOSING|US_PREMARKET|WEEKLY):[0-9]{4}-[0-9]{2}-[0-9]{2}:(KR_STOCK_ROOM|US_STOCK_ROOM|CRYPTO_SPOT_ROOM|CRYPTO_FUTURES_ROOM):-100[0-9]{8,15}$/u.exec(key);
      if (!match) continue;
      kind = match[1];
    } else if (!key.startsWith('signal-intelligence-v3:') || key.length > 1024) {
      continue;
    }
    if (typeof value !== 'string') continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time) || time > nowMs + 5000) continue;
    result.recordCount++;
    if (time >= nowMs - 24 * 3600_000) result.recent24hCount++;
    if (kind) result.briefKinds[kind]++;
    if (time > newest) newest = time;
  }
  result.lastEvidenceAt = newest > 0 ? new Date(newest).toISOString() : null;
  if (entries.length > 0 && result.recordCount === 0) result.status = 'NO_VALID_RECEIPTS';
  return result;
}

function pathWithinRoot(filePath) {
  const candidate = path.resolve(ROOT, filePath);
  const allowed = STATE_ROOTS;
  if (!allowed.some(root => candidate.startsWith(root + path.sep))) return null;
  try {
    const parentReal = fs.realpathSync(path.dirname(candidate));
    if (!allowed.some(root => parentReal === root || parentReal.startsWith(root + path.sep))) return null;
  } catch (error) {
    if (error?.code === 'ENOENT') return candidate;
    return null;
  }
  return candidate;
}

export function resolveSafeTelegramStatePath(configuredPath, defaultFilename) {
  const filename = typeof configuredPath === 'string' && configuredPath.trim()
    ? configuredPath.trim() : path.join(ROOT, '.runtime', defaultFilename);
  return pathWithinRoot(filename);
}

export function readStateFile(configuredPath, defaultFilename, type, nowMs = Date.now()) {
  const candidate = resolveSafeTelegramStatePath(configuredPath, defaultFilename);
  if (!candidate) return emptyState('UNSAFE_PATH');
  let fd;
  try {
    const before = fs.lstatSync(candidate);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_STATE_BYTES) return emptyState('UNSAFE_FILE');
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const after = fs.fstatSync(fd);
    if (!after.isFile() || after.size > MAX_STATE_BYTES
      || after.dev !== before.dev || after.ino !== before.ino) return emptyState('UNSAFE_FILE');
    return inspectDeliveryStateText(fs.readFileSync(fd, { encoding: 'utf8' }), type, nowMs);
  } catch (error) {
    return emptyState(error?.code === 'ENOENT' ? 'ABSENT' : 'UNREADABLE');
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// Preserve exact PM2 cwd and entrypoint gates used by the existing Production
// deploy and Telegram six-room binding scripts; never emit those paths in receipts.
export function canonicalPm2Paths(runtime) {
  return {
    canonicalCwd: runtime?.pm_cwd === ROOT,
    canonicalEntrypoint: runtime?.pm_exec_path === ENTRYPOINT,
  };
}

function readPm2Snapshot() {
  const all = JSON.parse(execFileSync('pm2', ['jlist'], {
    encoding: 'utf8', maxBuffer: 20_000_000, timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const matches = Array.isArray(all) ? all.filter(p => p?.name === 'stock-app') : [];
  if (matches.length !== 1) return null;
  const runtime = matches[0].pm2_env ?? {};
  let marker = null;
  try { marker = safeSha(fs.readFileSync(MARKER, 'utf8')); } catch {}
  return {
    runtime, pm2Sha: safeSha(runtime.DEPLOY_SHA), markerSha: marker,
    online: runtime.status === 'online',
    ...canonicalPm2Paths(runtime),
  };
}

export async function readHealthOnce({ getImpl = httpGet } = {}) {
  return await new Promise(resolve => {
    let doneFlag = false;
    let request = null;
    const done = value => {
      if (doneFlag) return;
      doneFlag = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { request?.destroy?.(); done(null); }, 6000);
    try {
      request = getImpl('http://127.0.0.1:8080/api/health', { timeout: 5000 }, response => {
        if (response.statusCode !== 200) { response.resume?.(); done(null); return; }
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 131072) { response.destroy?.(); done(null); return; }
          chunks.push(chunk);
        });
        response.on('error', () => done(null));
        response.on('end', () => {
          let obj = null;
          try { obj = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
          if (obj?.ok !== true || obj?.service !== 'api-server'
            || obj?.route !== '/api/health') { done(null); return; }
          const worker = obj.userTelegramDelivery ?? {};
          done({
            nodeSha: safeSha(obj.processDeploySha),
            markerSha: safeSha(obj.deployMarkerSha),
            identityMatch: obj.identityMatch === true,
            enabled: worker.enabled === true,
            tickOk: worker.tickOk === true,
            lastTickAt: typeof worker.lastTickAt === 'string' ? worker.lastTickAt : null,
            deliveryConfirmed: worker.deliveryConfirmed === true,
            lastConfirmedDeliveryAt: sanitizedIsoTime(worker.lastConfirmedDeliveryAt),
            errorCode: sanitizedErrorCode(worker.errorCode),
          });
        });
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => done(null));
    } catch { done(null); }
  });
}


function emptySource(status) {
  return { status, eventCount: 0, safetyValidated: false };
}

/** Only the signal subscriber's loopback, GET-only public/evidence endpoint.
 * Never return event contents, symbols, member IDs, strategy text or prices.
 */
export async function readSignalSourceOnce({
  sourceUrl = process.env.SIGNAL_INTELLIGENCE_URL?.trim() || 'http://127.0.0.1:8790/v1/signals',
  getImpl = httpGet,
} = {}) {
  let target;
  try { target = new URL(sourceUrl); } catch { return emptySource('UNSAFE_ENDPOINT'); }
  if (target.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(target.hostname)
    || target.pathname !== '/v1/signals' || target.search || target.hash
    || target.username || target.password) return emptySource('UNSAFE_ENDPOINT');
  return await new Promise(resolve => {
    let finished = false;
    let req = null;
    const done = v => { if (!finished) { finished = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { req?.destroy?.(); done(emptySource('UNREACHABLE')); }, 5000);
    try {
      req = getImpl(target, { method: 'GET', timeout: 4500 }, res => {
        if (res.statusCode !== 200) {
          res.resume?.(); done(emptySource('UNREACHABLE')); return;
        }
        const chunks = [];
        let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 1_048_576) { res.destroy?.(); done(emptySource('INVALID_RESPONSE')); return; }
          chunks.push(chunk);
        });
        res.on('error', () => done(emptySource('UNREACHABLE')));
        res.on('end', () => {
          let envelope = null;
          try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
          const snapshot = envelope?.snapshot;
          const valid = envelope?.ok === true && envelope?.executionAuthority === 'NONE'
            && snapshot?.safety?.executionAuthority === 'NONE'
            && snapshot?.safety?.privateTradingApiAllowed === false
            && snapshot?.safety?.realOrderAllowed === false
            && safeSha(envelope?.serviceSha) && safeSha(envelope.serviceSha) === safeSha(snapshot?.serviceSha)
            && Array.isArray(snapshot?.events) && snapshot.events.length <= 10000;
          done(valid ? { status: 'READY', eventCount: snapshot.events.length, safetyValidated: true }
            : emptySource('INVALID_RESPONSE'));
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => done(emptySource('UNREACHABLE')));
    } catch { done(emptySource('UNREACHABLE')); }
  });
}

export async function observeProductionTelegram({
  mainSha = process.env.TELEGRAM_AUDIT_MAIN_SHA,
  deployedSha = process.env.TELEGRAM_AUDIT_DEPLOYED_SHA,
  snapshot = readPm2Snapshot,
  health = readHealthOnce,
  state = readStateFile,
  signalSource = readSignalSourceOnce,
  nowMs = Date.now(),
} = {}) {
  const receipt = {
    schemaVersion: 'telegram-production-worker-readonly-v1',
    scope: 'PRODUCTION_TELEGRAM_READ_ONLY',
    mainSha: safeSha(mainSha), expectedDeployedSha: safeSha(deployedSha),
    pm2Sha: null, markerSha: null, pm2Online: false, exactDeployedIdentity: false,
    activationEnabled: false, marketWorkerConfigured: false, personalWorkerConfigured: false,
    roomBindingsValid: false, personal: {
      healthAvailable: false, enabled: false, tickFresh: false, tickOk: false,
      lastTickAt: null, deliveryConfirmed: false, lastConfirmedDeliveryAt: null, errorCode: null,
    },
    marketBrief: emptyState('NOT_CHECKED'),
    signalSubscriber: emptyState('NOT_CHECKED'),
    signalSource: emptySource('NOT_CHECKED'),
    proofLevel: 'NO_DELIVERY_PROOF',
    classification: 'NOT_STARTED',
    telegramSends: 0, databaseWrites: 0, pm2Restarts: 0,
    financialMutations: 0, secretValuesRecorded: false,
  };
  if (!receipt.mainSha || !receipt.expectedDeployedSha || !Number.isFinite(nowMs)) {
    receipt.classification = 'INVALID_REQUEST'; return receipt;
  }
  try {
    const observed = snapshot();
    if (!observed) { receipt.classification = 'PM2_UNAVAILABLE'; return receipt; }
    const runtime = observed.runtime ?? {};
    receipt.pm2Sha = safeSha(observed.pm2Sha);
    receipt.markerSha = safeSha(observed.markerSha);
    receipt.pm2Online = observed.online === true;
    receipt.exactDeployedIdentity = receipt.pm2Online
      && observed.canonicalCwd === true && observed.canonicalEntrypoint === true
      && receipt.pm2Sha === receipt.expectedDeployedSha
      && receipt.markerSha === receipt.expectedDeployedSha;
    if (!receipt.exactDeployedIdentity) {
      // Safe, actionable failure classification — never print cwd/entrypoint.
      receipt.classification = !receipt.pm2Online ? 'PM2_NOT_ONLINE'
        : receipt.pm2Sha !== receipt.expectedDeployedSha
          || receipt.markerSha !== receipt.expectedDeployedSha
          ? 'PRODUCTION_SHA_MISMATCH'
          : observed.canonicalCwd !== true ? 'PM2_CWD_MISMATCH'
            : observed.canonicalEntrypoint !== true ? 'PM2_ENTRYPOINT_MISMATCH'
              : 'PRODUCTION_IDENTITY_MISMATCH';
      return receipt;
    }
    const ids = ROOM_KEYS.map(key => String(runtime[key] ?? '').trim());
    receipt.roomBindingsValid = ids.every(id => /^-100[0-9]{8,15}$/u.test(id))
      && new Set(ids).size === ROOM_KEYS.length;
    receipt.activationEnabled = runtime.LIVE_TELEGRAM_ACTIVATION_APPROVED === 'true';
    receipt.marketWorkerConfigured = runtime.TELEGRAM_INTELLIGENCE_WORKER_ENABLED !== 'false'
      && runtime.BACKGROUND_WORKERS_ENABLED !== 'false';
    receipt.personalWorkerConfigured = runtime.PERSONAL_TELEGRAM_WORKER_ENABLED === 'true'
      && runtime.BACKGROUND_WORKERS_ENABLED !== 'false';
    if (!receipt.roomBindingsValid || !receipt.activationEnabled
      || !receipt.marketWorkerConfigured || !receipt.personalWorkerConfigured) {
      receipt.classification = 'TELEGRAM_CONFIGURATION_BLOCKED'; return receipt;
    }

    const result = await health();
    if (!result) { receipt.classification = 'HEALTH_UNAVAILABLE'; return receipt; }
    if (result.identityMatch !== true
      || result.nodeSha !== receipt.expectedDeployedSha
      || result.markerSha !== receipt.expectedDeployedSha) {
      receipt.classification = 'HEALTH_IDENTITY_MISMATCH'; return receipt;
    }
    const lastTickMs = Date.parse(result.lastTickAt ?? '');
    const recent = Number.isFinite(lastTickMs) && lastTickMs <= nowMs + 5000
      && nowMs - lastTickMs <= 360_000;
    receipt.personal = {
      healthAvailable: true,
      enabled: result.enabled === true,
      tickFresh: recent,
      tickOk: result.tickOk === true,
      lastTickAt: Number.isFinite(lastTickMs) ? new Date(lastTickMs).toISOString() : null,
      deliveryConfirmed: result.deliveryConfirmed === true
        && sanitizedIsoTime(result.lastConfirmedDeliveryAt) !== null,
      lastConfirmedDeliveryAt: sanitizedIsoTime(result.lastConfirmedDeliveryAt),
      errorCode: sanitizedErrorCode(result.errorCode),
    };
    receipt.marketBrief = state(runtime.TELEGRAM_INTELLIGENCE_STATE_PATH,
      'telegram-intelligence-delivery-state.json', 'market', nowMs);
    receipt.signalSubscriber = state(runtime.SIGNAL_INTELLIGENCE_TELEGRAM_STATE_PATH,
      'signal-intelligence-telegram-state.json', 'signal', nowMs);
    receipt.signalSource = await signalSource({ sourceUrl: runtime.SIGNAL_INTELLIGENCE_URL });
    // Saved state is dedupe-or-delivery evidence, never Bot API confirmation.
    receipt.proofLevel = receipt.marketBrief.recordCount > 0
      || receipt.signalSubscriber.recordCount > 0 ? 'PERSISTED_LEDGER_ONLY' : 'NO_DELIVERY_PROOF';
    receipt.classification = 'READ_ONLY_OBSERVATION_COMPLETE';
    return receipt;
  } catch {
    receipt.classification = 'READ_ONLY_INSPECTION_FAILED';
    return receipt;
  }
}

if (process.env.TELEGRAM_AUDIT_EXECUTE === 'true') {
  process.stdout.write(JSON.stringify(await observeProductionTelegram()) + '\n');
}
