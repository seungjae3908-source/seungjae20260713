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


const BRIEF_STATES=new Set(['NOT_STARTED','DISABLED','RUNNING','STOPPED']);
const BRIEF_START_CODES=new Set([null,'FLAG_DISABLED','ACTIVATION_REQUIRED','TOKEN_MISSING','ROOMS_MISSING']);
const BRIEF_DUE_CODES=new Set([
  'NOT_OBSERVED','BOT_API_ACCEPTED','DEDUPED_ONLY','NOT_CONFIGURED',
  'DELIVERY_FAILED','NO_ATTEMPTS','LEDGER_UNREADABLE','TICK_FAILED',
]);
const BRIEF_COUNTERS=[
  'lastDuePlans','lastDueAttempted','lastDueDelivered','lastDueDeduped',
  'lastDueNotConfigured','lastDueFailed',
];
function emptyBriefHealth(status){
  return {status,enabled:false,state:null,startErrorCode:null,
    lastTickAt:null,tickOk:null,tickFresh:false,lastDueTickAt:null,
    lastDuePlans:0,lastDueAttempted:0,lastDueDelivered:0,
    lastDueDeduped:0,lastDueNotConfigured:0,lastDueFailed:0,lastDueCode:null};
}
/** Strict public shape. Any extra private payload is discarded. */
export function sanitizeBriefWorkerHealth(value){
  if(value==null)return emptyBriefHealth('NOT_AVAILABLE');
  if(typeof value!=='object'||Array.isArray(value))return emptyBriefHealth('INVALID');
  if(typeof value.enabled!=='boolean'||!BRIEF_STATES.has(value.state)
    ||!BRIEF_START_CODES.has(value.startErrorCode)
    ||!BRIEF_DUE_CODES.has(value.lastDueCode)
    ||!(value.tickOk===null||typeof value.tickOk==='boolean')
    ||!(value.lastTickAt===null||sanitizedIsoTime(value.lastTickAt)!==null)
    ||!(value.lastDueTickAt===null||sanitizedIsoTime(value.lastDueTickAt)!==null)
    ||!BRIEF_COUNTERS.every(k=>Number.isSafeInteger(value[k])&&value[k]>=0&&value[k]<=10000))
    return emptyBriefHealth('INVALID');
  return {
    status:'PRESENT',enabled:value.enabled,state:value.state,
    startErrorCode:value.startErrorCode,lastTickAt:sanitizedIsoTime(value.lastTickAt),
    tickOk:value.tickOk,tickFresh:false,lastDueTickAt:sanitizedIsoTime(value.lastDueTickAt),
    lastDuePlans:value.lastDuePlans,lastDueAttempted:value.lastDueAttempted,
    lastDueDelivered:value.lastDueDelivered,lastDueDeduped:value.lastDueDeduped,
    lastDueNotConfigured:value.lastDueNotConfigured,lastDueFailed:value.lastDueFailed,
    lastDueCode:value.lastDueCode,
  };
}
function emptyState(status) {
  return {
    status, recordCount: 0, recent24hCount: 0, lastEvidenceAt: null,
    unconfirmedCount: 0, unconfirmedRecent24hCount: 0, lastUnconfirmedAt: null,
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
  const pending = data.unconfirmed === undefined ? {} : data.unconfirmed;
  if (!pending || typeof pending !== 'object' || Array.isArray(pending))
    return emptyState('INVALID');
  const unconfirmedEntries = Object.entries(pending);
  if (entries.length + unconfirmedEntries.length > 10000) return emptyState('INVALID');
  const result = emptyState(entries.length ? 'PRESENT'
    : unconfirmedEntries.length ? 'UNCONFIRMED_ONLY' : 'EMPTY');
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
  let lastUnknown = 0;
  for (const [key, value] of unconfirmedEntries) {
    const validMarket = type === 'market'
      && /^telegram-intelligence:(MORNING|KR_CLOSING|US_PREMARKET|WEEKLY):[0-9]{4}-[0-9]{2}-[0-9]{2}:(KR_STOCK_ROOM|US_STOCK_ROOM|CRYPTO_SPOT_ROOM|CRYPTO_FUTURES_ROOM):-100[0-9]{8,15}$/u.test(key);
    const validSignal = type === 'signal'
      && key.startsWith('signal-intelligence-v3:') && key.length <= 1024;
    const when = typeof value === 'string' ? Date.parse(value) : NaN;
    if ((!validMarket && !validSignal)
      || Object.prototype.hasOwnProperty.call(data.delivered, key)
      || !Number.isFinite(when) || when > nowMs + 5000)
      return emptyState('INVALID');
    result.unconfirmedCount++;
    if (when >= nowMs - 24 * 3600_000) result.unconfirmedRecent24hCount++;
    if (when > lastUnknown) lastUnknown = when;
  }
  result.lastUnconfirmedAt = lastUnknown ? new Date(lastUnknown).toISOString() : null;
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
            briefWorker:sanitizeBriefWorkerHealth(obj.telegramIntelligenceWorker),
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
          const status = res.statusCode === 503 ? 'HTTP_503' : 'HTTP_ERROR';
          res.resume?.(); done(emptySource(status)); return;
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


const SIGNAL_UNITS = Object.freeze({
  server: 'investment-signal-intelligence-v3.service',
  timer: 'investment-signal-intelligence-v3-cycle.timer',
  cycle: 'investment-signal-intelligence-v3-cycle.service',
});

// Read only three fixed systemd unit names, never journal data or unit env.
// All returned statuses are whitelisted: no raw paths, usernames or secrets.
export function readSignalV3Units({ execImpl = execFileSync } = {}) {
  const inspect = (unit) => {
    let value;
    try {
      value = execImpl('systemctl',
        ['show', '--no-pager', '--property=LoadState,ActiveState', unit],
        { encoding: 'utf8', timeout: 3500, maxBuffer: 8192,
          stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return 'UNAVAILABLE'; }
    if (typeof value !== 'string' || value.length > 8192) return 'UNAVAILABLE';
    const load = /^LoadState=([a-z-]+)$/mu.exec(value)?.[1];
    const active = /^ActiveState=([a-z-]+)$/mu.exec(value)?.[1];
    if (load === 'not-found') return 'NOT_FOUND';
    if (load !== 'loaded') return 'UNKNOWN';
    if (active === 'active') return 'ACTIVE';
    if (active === 'inactive') return 'INACTIVE';
    if (active === 'failed') return 'FAILED';
    return 'UNKNOWN';
  };
  return Object.fromEntries(Object.entries(SIGNAL_UNITS)
    .map(([label, unit]) => [label, inspect(unit)]));
}


/** Read only fixed systemd cycle-unit metadata, without querying journals,
 * restarting units or exposing raw paths, environment or stdout/stderr.
 * An INACTIVE oneshot after success is normal and must not be a failure.
 */
export function safeSignalAgeBand(ms) {
  if (!Number.isFinite(ms) || ms < 0 || ms > 365 * 24 * 60 * 60_000)
    return 'UNKNOWN';
  return ms <= 5 * 60_000 ? 'UNDER_5M'
    : ms <= 15 * 60_000 ? 'UNDER_15M'
      : ms <= 60 * 60_000 ? 'UNDER_60M' : 'OVER_60M';
}

export function readSignalV3CycleResult({
  execImpl = execFileSync,
  uptimeReadImpl = () => fs.readFileSync('/proc/uptime', 'utf8'),
} = {}) {
  const empty = (unitState = 'UNAVAILABLE',lastResult = 'UNKNOWN') => ({
    unitState,lastResult,exitCode:null,hasStarted:false,startedAgeBand:'UNKNOWN',
  });
  let raw;
  try {
    raw=execImpl('systemctl', [
      'show','--no-pager',
      '--property=LoadState,ActiveState,Result,ExecMainStatus,ExecMainStartTimestampMonotonic',
      'investment-signal-intelligence-v3-cycle.service',
    ], { encoding:'utf8',timeout:3500,maxBuffer:8192,stdio:['ignore','pipe','pipe'] });
  } catch { return empty(); }
  if (typeof raw!=='string' || raw.length>8192) return empty();
  const lines=raw.split(/\r?\n/u);
  const property=key=>{
    const values=lines.filter(line=>line.startsWith(key+'='));
    return values.length===1 ? values[0].slice(key.length+1) : null;
  };
  const load=property('LoadState'), active=property('ActiveState');
  const unitState=load==='not-found' ? 'NOT_FOUND'
    : load!=='loaded' ? 'UNKNOWN'
      : active==='active' ? 'ACTIVE'
        : active==='inactive' ? 'INACTIVE'
          : active==='failed' ? 'FAILED' : 'UNKNOWN';
  if(unitState==='UNKNOWN'||unitState==='NOT_FOUND')return empty(unitState);
  const startedRaw=property('ExecMainStartTimestampMonotonic');
  const hasStarted=typeof startedRaw==='string' && /^\d{1,16}$/u.test(startedRaw)
    && Number.isSafeInteger(Number(startedRaw)) && Number(startedRaw)>0;
  const exitRaw=property('ExecMainStatus');
  const exitCode=hasStarted && typeof exitRaw==='string' && /^\d{1,3}$/u.test(exitRaw)
    && Number(exitRaw)<=255 ? Number(exitRaw) : null;
  const result=property('Result');
  const failure=new Set(['exit-code','signal','core-dump','timeout','watchdog',
    'resources','start-limit-hit','oom-kill','protocol']);
  const lastResult=!hasStarted ? 'NOT_OBSERVED'
    : unitState==='ACTIVE' ? 'RUNNING'
      : unitState==='FAILED' ? 'FAILED'
        : result==='success' && exitCode===0 ? 'SUCCEEDED'
          : failure.has(result)||(exitCode!==null&&exitCode>0) ? 'FAILED' : 'UNKNOWN';
  let startedAgeBand='UNKNOWN';
  if(hasStarted){
    try{
      const uptime=String(uptimeReadImpl()).split(/\s+/u)[0];
      if(/^\d{1,12}(?:\.\d{1,9})?$/u.test(uptime)){
        const ageMs=(Number(uptime)*1_000_000-Number(startedRaw))/1_000;
        startedAgeBand=safeSignalAgeBand(ageMs);
      }
    }catch{/* uptime unavailable; never leak raw files or exceptions */}
  }
  return {unitState,lastResult,exitCode,hasStarted,startedAgeBand};
}

function emptySignalHealth(status) {
  return { status, serviceSha: null, snapshotReady: false, snapshotFresh: false, snapshotAgeBand: 'UNKNOWN' };
}

/** Only fixed loopback V3 /health. Never emit response body or snapshotError. */
export async function readSignalV3HealthOnce({
  sourceUrl = process.env.SIGNAL_INTELLIGENCE_URL?.trim() || 'http://127.0.0.1:8790/v1/signals',
  getImpl = httpGet,
} = {}) {
  let target;
  try { target = new URL(sourceUrl); } catch { return emptySignalHealth('UNSAFE_ENDPOINT'); }
  if (target.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    || target.pathname !== '/v1/signals' || target.search || target.hash
    || target.username || target.password) return emptySignalHealth('UNSAFE_ENDPOINT');
  target.pathname = '/health';
  return await new Promise(resolve => {
    let finished = false;
    let req = null;
    const done = status => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(status);
    };
    const timer = setTimeout(() => {
      done(emptySignalHealth('TIMEOUT'));
      req?.destroy?.();
    }, 5000);
    try {
      req = getImpl(target, { method: 'GET', timeout: 4500 }, res => {
        if (res.statusCode !== 200) {
          res.resume?.();
          done(emptySignalHealth(res.statusCode === 503 ? 'HTTP_503' : 'HTTP_ERROR'));
          return;
        }
        const chunks = [];
        let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 131072) {
            done(emptySignalHealth('INVALID_RESPONSE'));
            res.destroy?.();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', () => done(emptySignalHealth('UNREACHABLE')));
        res.on('end', () => {
          let payload;
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
          const sha = safeSha(payload?.serviceSha);
          if (payload?.ok !== true || payload?.service !== 'signal-intelligence-v3'
            || payload?.executionAuthority !== 'NONE'
            || payload?.privateTradingApiAllowed !== false || payload?.realOrderAllowed !== false
            || !['127.0.0.1', '::1', 'localhost'].includes(payload?.bindHost)
            || !sha || typeof payload.snapshotReady !== 'boolean'
            || typeof payload.snapshotFresh !== 'boolean'
            || ![undefined,null,true,false].includes(payload.snapshotCurrentPageSourceReady)
            || (payload.snapshotCurrentPageSourceReady===false
              && payload.snapshotFresh===true)
            || (payload.snapshotReady === true
              && (!Number.isFinite(payload.snapshotAgeMs) || payload.snapshotAgeMs < 0))) {
            done(emptySignalHealth('INVALID_RESPONSE'));
            return;
          }
          const shaMismatch = payload.snapshotError === 'SNAPSHOT_SERVICE_SHA_MISMATCH';
          // Only this exact server-owned enum is projected; never log or
          // return the raw snapshotError/body, which may contain sensitive text.
          if (shaMismatch && (payload.snapshotReady !== false
            || payload.snapshotFresh !== false || payload.snapshotAgeMs !== null)) {
            done(emptySignalHealth('INVALID_RESPONSE'));
            return;
          }
          const ageBand = safeSignalAgeBand(payload.snapshotAgeMs);
          const fresh = payload.snapshotFresh === true
            && Number.isFinite(payload.snapshotAgeMs)
            && payload.snapshotAgeMs <= 15 * 60_000;
          // The V3 server's snapshotFresh=false can mean blocked current
          // data coverage, not necessarily old snapshot or a stopped timer.
          const ageRecent=Number.isFinite(payload.snapshotAgeMs)
            && payload.snapshotAgeMs<=15*60_000;
          const status = shaMismatch ? 'SNAPSHOT_SHA_MISMATCH'
            : !payload.snapshotReady ? 'SNAPSHOT_MISSING'
            : !ageRecent ? 'SNAPSHOT_STALE'
              : payload.snapshotCurrentPageSourceReady===false
                ? 'SOURCE_DATA_BLOCKED' : fresh ? 'READY' : 'SNAPSHOT_STALE';
          done({ status, serviceSha: sha, snapshotReady: payload.snapshotReady,
            snapshotFresh: fresh, snapshotAgeBand: ageBand });
        });
      });
      req.on('timeout', () => {
        done(emptySignalHealth('TIMEOUT'));
        req.destroy?.();
      });
      req.on('error', () => done(emptySignalHealth('UNREACHABLE')));
    } catch { done(emptySignalHealth('UNREACHABLE')); }
  });
}


const V3_DEFAULT_PATH='/opt/investment-signal-intelligence/state/latest-snapshot.json';
function missingV3(status){return {status,serviceSha:null,
  generatedAgeBand:'UNKNOWN',fileAgeBand:'UNKNOWN'};}
/** Hardcoded public snapshot path; no arbitrary file read, no symlink follow,
 * no raw candle/strategy/member/secret or pathname in the report.
 */
export function readV3SnapshotFile({fsOps=fs,nowMs=Date.now(),
  filePath=V3_DEFAULT_PATH}={}){
  if(filePath!==V3_DEFAULT_PATH)return missingV3('UNSAFE_PATH');
  if(!Number.isSafeInteger(nowMs)||nowMs<=0)return missingV3('INVALID_CLOCK');
  let fd=null;
  try{
    fd=fsOps.openSync(filePath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const stat=fsOps.fstatSync(fd),n=Number(stat?.size);
    if(!stat?.isFile?.())return missingV3('UNSAFE_FILE');
    if(!Number.isSafeInteger(n)||n<=0||n>4*1024*1024)
      return missingV3('INVALID_SIZE');
    const buf=Buffer.alloc(n);let got=0;
    while(got<n){
      const bytes=fsOps.readSync(fd,buf,got,n-got,got);
      if(!Number.isSafeInteger(bytes)||bytes<1||bytes>n-got)
        return missingV3('UNREADABLE');
      got+=bytes;
    }
    let obj;try{obj=JSON.parse(buf.toString('utf8'));}
    catch{return missingV3('INVALID_JSON');}
    const sha=safeSha(obj?.serviceSha);
    if(!sha||obj?.publicDataOnly!==true
      ||obj?.safety?.executionAuthority!=='NONE'
      ||obj?.safety?.privateTradingApiAllowed!==false
      ||obj?.safety?.realOrderAllowed!==false)
      return missingV3('INVALID_ENVELOPE');
    const generated=Date.parse(obj?.generatedAt??'');
    const fileAge=nowMs-Number(stat.mtimeMs);
    const genAge=nowMs-generated;
    if(!Number.isFinite(generated)||!Number.isFinite(fileAge))
      return missingV3('INVALID_TIMESTAMP');
    if(genAge< -5000||fileAge< -5000)return missingV3('FUTURE_TIMESTAMP');
    return {status:genAge>900000?'STALE_PUBLICATION':'RECENT_PUBLICATION',
      serviceSha:sha,generatedAgeBand:safeSignalAgeBand(Math.max(0,genAge)),
      fileAgeBand:safeSignalAgeBand(Math.max(0,fileAge))};
  }catch(err){return missingV3(err?.code==='ENOENT'?'ABSENT':'UNREADABLE');}
  finally{if(fd!==null)try{fsOps.closeSync(fd);}catch{/* no output */}}
}
export function v3StalenessHypothesis(health,cycle,file,units){
  if(health?.status==='NOT_CHECKED')return 'NOT_CHECKED';
  if(health?.status==='SNAPSHOT_SHA_MISMATCH')
    return 'SHA_OR_READ_PATH_MISMATCH_SUSPECT';
  if(file?.status==='ABSENT')return 'DEFAULT_FILE_ABSENT';
  if(!['RECENT_PUBLICATION','STALE_PUBLICATION'].includes(file?.status))
    return 'FILE_NOT_VERIFIABLE';
  if(health?.serviceSha&&health.serviceSha!==file.serviceSha)
    return 'SHA_OR_READ_PATH_MISMATCH_SUSPECT';
  if(health?.status==='READY')
    return file.status==='RECENT_PUBLICATION'?'RECENT_HTTP_AND_FILE':'HTTP_FILE_AGE_DISAGREE';
  if(health?.status==='SOURCE_DATA_BLOCKED')
    return file.status==='RECENT_PUBLICATION'
      ?'CURRENT_PAGE_SOURCE_COVERAGE_BLOCKED':'HTTP_FILE_AGE_DISAGREE';
  if(health?.status==='SNAPSHOT_STALE'){
    if(file.status==='RECENT_PUBLICATION')return 'HTTP_FILE_AGE_DISAGREE';
    if(cycle?.lastResult==='FAILED')return 'CYCLE_FAILED_SUSPECT';
    // A still-running oneshot is NOT an inactive timer. Distinguish a long
    // blocked public-provider cycle from a timer that never started.
    if(cycle?.lastResult==='RUNNING')
      return cycle?.startedAgeBand==='OVER_60M'
        ? 'CYCLE_RUNNING_OVER_60M_SUSPECT'
        : 'CYCLE_RUNNING_WITH_STALE_SNAPSHOT';
    if(units?.timer!=='ACTIVE'||cycle?.startedAgeBand==='OVER_60M')
      return 'TIMER_NOT_RECENT_SUSPECT';
    if(cycle?.lastResult==='SUCCEEDED'
      &&['UNDER_5M','UNDER_15M'].includes(cycle.startedAgeBand))
      return 'RECENT_CYCLE_DID_NOT_PUBLISH_SUSPECT';
    return 'STALE_PUBLICATION_UNEXPLAINED';
  }
  return 'UNRESOLVED';
}

/**
 * PM2 opportunity through today's Korea 07:50–08:10 briefing window.
 * This cannot establish worker execution or any Telegram delivery.
 */
export function morningWindowProcessCoverage(startedAt, nowMs = Date.now()) {
  if (!sanitizedIsoTime(startedAt) || !Number.isSafeInteger(nowMs)) return 'UNKNOWN';
  const now = new Date(nowMs);
  if (Number.isNaN(now.getTime())) return 'UNKNOWN';
  const startedMs = Date.parse(startedAt);
  if (startedMs > nowMs + 5000) return 'UNKNOWN';
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
  const year = Number(dateParts.year);
  const month = Number(dateParts.month);
  const day = Number(dateParts.day);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return 'UNKNOWN';
  const endUtc = Date.UTC(year, month - 1, day, -1, 10); // 08:10 KST
  const startUtc = endUtc - 20 * 60_000; // 07:50 KST
  if (nowMs < endUtc) return 'NOT_ELAPSED';
  if (startedMs <= startUtc) return 'FULL_WINDOW';
  if (startedMs <= endUtc) return 'PARTIAL_WINDOW';
  return 'MISSED_WINDOW';
}

function safePm2StartAt(raw, nowMs) {
  const milliseconds = Number(raw);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 946684800000
    || milliseconds > nowMs + 5000) return null;
  return new Date(milliseconds).toISOString();
}

export async function observeProductionTelegram({
  mainSha = process.env.TELEGRAM_AUDIT_MAIN_SHA,
  deployedSha = process.env.TELEGRAM_AUDIT_DEPLOYED_SHA,
  snapshot = readPm2Snapshot,
  health = readHealthOnce,
  state = readStateFile,
  signalSource = readSignalSourceOnce,
  signalHealth = readSignalV3HealthOnce,
  signalUnits = readSignalV3Units,
  signalCycle = readSignalV3CycleResult,
  signalFile = readV3SnapshotFile,
  nowMs = Date.now(),
} = {}) {
  const receipt = {
    schemaVersion: 'telegram-production-worker-readonly-v6',
    scope: 'PRODUCTION_TELEGRAM_READ_ONLY',
    mainSha: safeSha(mainSha), expectedDeployedSha: safeSha(deployedSha),
    pm2Sha: null, markerSha: null, pm2Online: false, exactDeployedIdentity: false,
    pm2StartedAt: null, morningWindowCoverage: 'UNKNOWN',
    activationEnabled: false, marketWorkerConfigured: false, personalWorkerConfigured: false,
    roomBindingsValid: false, personal: {
      healthAvailable: false, enabled: false, tickFresh: false, tickOk: false,
      lastTickAt: null, deliveryConfirmed: false, lastConfirmedDeliveryAt: null, errorCode: null,
    },
    briefWorker:emptyBriefHealth('NOT_CHECKED'),
    marketBrief: emptyState('NOT_CHECKED'),
    signalSubscriber: emptyState('NOT_CHECKED'),
    signalSource: emptySource('NOT_CHECKED'),
    signalHealth: emptySignalHealth('NOT_CHECKED'),
    signalUnits: { server: 'NOT_CHECKED', timer: 'NOT_CHECKED', cycle: 'NOT_CHECKED' },
    signalCycle: { unitState:'NOT_CHECKED',lastResult:'NOT_OBSERVED',exitCode:null,hasStarted:false,startedAgeBand:'UNKNOWN' },
    signalFile: missingV3('NOT_CHECKED'),
    staleCause: 'NOT_CHECKED',
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
    receipt.pm2StartedAt = safePm2StartAt(runtime.pm_uptime, nowMs);
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
    receipt.morningWindowCoverage = morningWindowProcessCoverage(receipt.pm2StartedAt, nowMs);
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
    receipt.briefWorker=result.briefWorker??emptyBriefHealth('NOT_AVAILABLE');
    if(receipt.briefWorker.status==='INVALID'){
      receipt.classification='BRIEF_WORKER_HEALTH_INVALID';return receipt;
    }
    const briefTick=Date.parse(receipt.briefWorker.lastTickAt??'');
    receipt.briefWorker.tickFresh=Number.isFinite(briefTick)
      && briefTick<=nowMs+5000 && nowMs-briefTick<=360000;
    receipt.marketBrief = state(runtime.TELEGRAM_INTELLIGENCE_STATE_PATH,
      'telegram-intelligence-delivery-state.json', 'market', nowMs);
    receipt.signalSubscriber = state(runtime.SIGNAL_INTELLIGENCE_TELEGRAM_STATE_PATH,
      'signal-intelligence-telegram-state.json', 'signal', nowMs);
    receipt.signalSource = await signalSource({ sourceUrl: runtime.SIGNAL_INTELLIGENCE_URL });
    receipt.signalHealth = await signalHealth({ sourceUrl: runtime.SIGNAL_INTELLIGENCE_URL });
    receipt.signalUnits = signalUnits();
    receipt.signalCycle = signalCycle();
    receipt.signalFile = signalFile({nowMs});
    receipt.staleCause = v3StalenessHypothesis(receipt.signalHealth,
      receipt.signalCycle,receipt.signalFile,receipt.signalUnits);
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
