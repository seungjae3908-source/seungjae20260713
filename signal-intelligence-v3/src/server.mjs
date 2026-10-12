import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { assertSignalIntelligenceV3Snapshot, SIGNAL_INTELLIGENCE_V3_POLICY } from './engine.mjs';
import { currentPublicV3CycleReady } from './public-v3-current-page-gate.mjs';
import {v3PublicCycleLockCommand,V3_PUBLIC_CYCLE_CONFLICT_EXIT} from './public-cycle-singleflight.mjs';
import { readV3StableSnapshot } from './public-snapshot-safe-read.mjs';

const HOST = process.env.SIGNAL_INTELLIGENCE_HOST || '127.0.0.1';
const PORT = Number(process.env.SIGNAL_INTELLIGENCE_PORT || 8790);
const SERVICE_SHA = String(process.env.SIGNAL_INTELLIGENCE_SERVICE_SHA || '').trim().toLowerCase();
const STATE_FILE = resolve(process.env.SIGNAL_INTELLIGENCE_STATE_FILE || './state/latest-snapshot.json');
const MAX_STATE_AGE_MS = Number(process.env.SIGNAL_INTELLIGENCE_MAX_STATE_AGE_MS || 15 * 60_000);
const PRODUCER_PATH = String(process.env.SIGNAL_INTELLIGENCE_PRODUCER_PATH || '').trim();

if (!/^([0-9a-f]{40})$/.test(SERVICE_SHA)) throw new Error('SIGNAL_INTELLIGENCE_SERVICE_SHA_REQUIRED');
if (HOST !== '127.0.0.1' && HOST !== '::1') throw new Error('SIGNAL_INTELLIGENCE_LOOPBACK_ONLY');
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) throw new Error('SIGNAL_INTELLIGENCE_PORT_INVALID');
if (!Number.isSafeInteger(MAX_STATE_AGE_MS) || MAX_STATE_AGE_MS < 1000 || MAX_STATE_AGE_MS > 15*60_000)
  throw new Error('SIGNAL_INTELLIGENCE_MAX_STATE_AGE_INVALID');
if (PRODUCER_PATH && (!isAbsolute(PRODUCER_PATH) || !PRODUCER_PATH.endsWith('.mjs'))) throw new Error('SIGNAL_INTELLIGENCE_PRODUCER_PATH_INVALID');

const EMPTY_STAT = Object.freeze({mtimeMs:-1,ctimeMs:-1,ino:null,size:null});
let cache = {...EMPTY_STAT,snapshot:null,loadedAt:null,error:'SNAPSHOT_NOT_READY'};
function safeSnapshotError(error){
  if(error?.code==='ENOENT')return 'SNAPSHOT_NOT_READY';
  if(error?.code==='EACCES'||error?.code==='EPERM')
    return 'SNAPSHOT_READ_PERMISSION_DENIED';
  if(error?.code==='EISDIR'||error?.message==='SNAPSHOT_NOT_A_FILE')return 'SNAPSHOT_NOT_A_FILE';
  if(error?.message==='SNAPSHOT_SIZE_OUT_OF_BOUNDS')return 'SNAPSHOT_SIZE_OUT_OF_BOUNDS';
  if(error instanceof SyntaxError)return 'SNAPSHOT_INVALID_JSON';
  if(error?.message==='SNAPSHOT_SERVICE_SHA_MISMATCH')
    return 'SNAPSHOT_SERVICE_SHA_MISMATCH';
  if(error?.message==='SNAPSHOT_FILE_CHANGED_DURING_READ')
    return 'SNAPSHOT_FILE_CHANGED_DURING_READ';
  return 'SNAPSHOT_CONTRACT_OR_READ_FAILED';
}
let rescanRunning = false;
let lastRescanStartedAt = null;
let lastRescanFinishedAt = null;
let lastRescanExitCode = null;
let lastRescanOutcome = null;

async function loadSnapshot() {
  try {
    // Atomic publication may overlap one stat/read pair. The helper retries
    // only once against fresh metadata, never returning the old snapshot.
    const read = await readV3StableSnapshot(STATE_FILE,{cached:cache});
    if(read.cached)return cache;
    const verified=read.metadata;
    const parsed=JSON.parse(read.content);
    assertSignalIntelligenceV3Snapshot(parsed);
    // Never present a previous release's snapshot under this service SHA.
    // The current public producer stamps every snapshot with its exact head.
    if (parsed.serviceSha !== SERVICE_SHA) throw new Error('SNAPSHOT_SERVICE_SHA_MISMATCH');
    cache = {mtimeMs:verified.mtimeMs,ctimeMs:verified.ctimeMs,ino:verified.ino,size:verified.size,snapshot:parsed,loadedAt:new Date().toISOString(),error:null};
    return cache;
  } catch (error) {
    cache = {
      ...EMPTY_STAT,snapshot:null,loadedAt:new Date().toISOString(),
      // Never expose raw JSON snippets, filesystem paths or private contents.
      error:safeSnapshotError(error),
    };
    return cache;
  }
}

function json(res, status, body) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function snapshotAgeMs(snapshot) {
  const generatedAt = Date.parse(snapshot?.generatedAt || '');
  if(!Number.isFinite(generatedAt))return Number.POSITIVE_INFINITY;
  const ageMs=Date.now()-generatedAt;
  // A future generatedAt is not a freshly completed scanner cycle.
  return ageMs < -5000 ? Number.POSITIVE_INFINITY : Math.max(0,ageMs);
}

function publicList(snapshot, name) {
  const rows = snapshot?.lists?.[name];
  return Array.isArray(rows) ? rows : [];
}

function triggerPublicRescan() {
  if (!PRODUCER_PATH) return { started: false, reason: 'PRODUCER_NOT_CONFIGURED' };
  if (rescanRunning) return { started: false, alreadyRunning: true };
  rescanRunning = true;
  lastRescanStartedAt = new Date().toISOString();
  lastRescanExitCode = null;
  lastRescanOutcome = 'RUNNING';
  const locked = v3PublicCycleLockCommand(STATE_FILE, PRODUCER_PATH);
  const child = spawn(locked.command, locked.args, {
    cwd: dirname(PRODUCER_PATH),
    env: {
      ...process.env,
      SIGNAL_INTELLIGENCE_SERVICE_SHA: SERVICE_SHA,
      SIGNAL_INTELLIGENCE_STATE_DIR: dirname(STATE_FILE),
      SIGNAL_INTELLIGENCE_STATE_FILE: STATE_FILE,
      SIGNAL_INTELLIGENCE_PUBLIC_ONLY_UNIVERSE: 'true',
      LIVE_TRADING: 'false',
      PRIVATE_API_ENABLED: 'false',
      ORDER_AUTHORITY: 'false',
      SIGNAL_INTELLIGENCE_EXECUTION_AUTHORITY: 'NONE',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.once('exit', (code) => {
    rescanRunning = false;
    lastRescanFinishedAt = new Date().toISOString();
    lastRescanExitCode = Number.isInteger(code) ? code : -1;
    lastRescanOutcome = lastRescanExitCode===V3_PUBLIC_CYCLE_CONFLICT_EXIT
      ? 'ALREADY_RUNNING_IN_TIMER_OR_ANOTHER_RESCAN'
      : lastRescanExitCode===0 ? 'COMPLETED' : 'PROCESS_FAILED';
    cache.mtimeMs = -1;
  });
  child.once('error', () => {
    rescanRunning = false;
    lastRescanFinishedAt = new Date().toISOString();
    lastRescanExitCode = -1;
    lastRescanOutcome = 'SPAWN_FAILED';
  });
  return { started: true };
}

const routes = new Map([
  ['/v1/signals/kr', 'krBuy'],
  ['/v1/signals/us', 'usBuy'],
  ['/v1/signals/spot', 'spotBuy'],
  ['/v1/signals/futures/long', 'futuresLong'],
  ['/v1/signals/futures/short', 'futuresShort'],
]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/internal/rescan') {
    // A localhost-bound daemon is not permission for arbitrary websites to
    // trigger rate-limited public scans through browser cross-site requests.
    // No CORS response headers, no credential, no remote/public re-scan.
    const origin=req.headers.origin;
    const fetchSite=req.headers['sec-fetch-site'];
    const expectedOrigin='http://'+HOST+':'+PORT;
    if((origin!=null&&origin!==expectedOrigin)
      ||fetchSite==='cross-site'||fetchSite==='same-site')
      return json(res,403,{ok:false,error:'INTERNAL_RESCAN_ORIGIN_FORBIDDEN',
        executionAuthority:'NONE'});
    const result = triggerPublicRescan();
    if (result.reason === 'PRODUCER_NOT_CONFIGURED') return json(res, 503, { ok: false, error: result.reason, executionAuthority: 'NONE' });
    return json(res, 202, {
      ok: true,
      publicDataRescan: true,
      started: result.started,
      alreadyRunning: result.alreadyRunning === true,
      executionAuthority: 'NONE',
      realOrderAllowed: false,
    });
  }

  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });

  // Unknown routes are 404 even before a first snapshot is published;
  // do not create false 503 alerts for typos or browser favicon probes.
  const listName = routes.get(url.pathname);
  if (url.pathname !== '/health' && url.pathname !== '/v1/signals' && !listName)
    return json(res, 404, { ok: false, error: 'NOT_FOUND' });

  if (url.pathname === '/health') {
    const state = await loadSnapshot();
    const ageMs = state.snapshot ? snapshotAgeMs(state.snapshot) : null;
    const sourceComplete = state.snapshot?.profile?.fullStrategyCoverage === true
      ? currentPublicV3CycleReady(state.snapshot.coverage) : null;
    const clockReady = ageMs != null && ageMs <= MAX_STATE_AGE_MS;
    const dataBlocker = !state.snapshot ? (state.error ?? 'SNAPSHOT_NOT_READY')
      : !clockReady ? 'SNAPSHOT_AGE_EXPIRED'
      : sourceComplete===false ? 'CURRENT_SOURCE_PAGES_BLOCKED'
      : sourceComplete===null ? 'FULL_STRATEGY_SOURCE_NOT_VERIFIED' : null;
    return json(res, 200, {
      ok: true,
      service: 'signal-intelligence-v3',
      serviceSha: SERVICE_SHA,
      policyVersion: SIGNAL_INTELLIGENCE_V3_POLICY.version,
      bindHost: HOST,
      port: PORT,
      snapshotReady: Boolean(state.snapshot),
      snapshotAgeMs: ageMs,
      snapshotFresh: clockReady && sourceComplete !== false,
      snapshotClockReady: clockReady,
      snapshotPublicationReady: clockReady && sourceComplete===true,
      snapshotBlockedReason: dataBlocker,
      // Current-page health is separate from full-roster historical coverage.
      snapshotCurrentPageSourceReady: sourceComplete,
      snapshotError: state.error,
      rescan: { running: rescanRunning, lastStartedAt: lastRescanStartedAt, lastFinishedAt: lastRescanFinishedAt, lastExitCode: lastRescanExitCode, lastOutcome: lastRescanOutcome },
      executionAuthority: 'NONE',
      privateTradingApiAllowed: false,
      realOrderAllowed: false,
      liveTrading: false,
    });
  }

  const state = await loadSnapshot();
  if (!state.snapshot) {
    return json(res, 503, { ok: false, error: state.error || 'SNAPSHOT_NOT_READY', executionAuthority: 'NONE' });
  }
  const ageMs = snapshotAgeMs(state.snapshot);
  if (ageMs > MAX_STATE_AGE_MS) {
    return json(res, 503, { ok: false, error: 'SNAPSHOT_STALE', generatedAt: state.snapshot.generatedAt, ageMs, executionAuthority: 'NONE' });
  }

  if (url.pathname === '/v1/signals') {
    return json(res, 200, { ok: true, serviceSha: SERVICE_SHA, snapshot: state.snapshot, executionAuthority: 'NONE' });
  }

  if (listName) {
    return json(res, 200, {
      ok: true,
      serviceSha: SERVICE_SHA,
      generatedAt: state.snapshot.generatedAt,
      list: listName,
      candidates: publicList(state.snapshot, listName),
      executionAuthority: 'NONE',
    });
  }

  return json(res, 404, { ok: false, error: 'NOT_FOUND' });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`${JSON.stringify({
    event: 'signal_intelligence_started',
    serviceSha: SERVICE_SHA,
    host: HOST,
    port: PORT,
    executionAuthority: 'NONE',
    privateTradingApiAllowed: false,
    realOrderAllowed: false,
  })}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
