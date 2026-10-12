// Bounded, resumable PUBLIC-ONLY 1m history planner. No scheduler or order authority.
// State is a progress cursor, NOT a complete market/PIT/strategy evidence certificate.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { MINUTE_MS, MINUTE_ARCHIVE_LIMITS, validateMinuteTask,
  runMinuteArchiveIntakeV1 } from './four-market-minute-archive-intake-v1.mjs';
import { assessMinuteManifestCapacity } from './four-market-minute-roster-capacity-v1.mjs';

export const QUEUE_CONTRACT = 'research-minute-backfill-cursor/v1';
export const SCOPE_CONTRACT = 'research-minute-backfill-scope/v1';
export const QUEUE_LIMITS = Object.freeze({
  maxRanges: 2048, maxActionsPerCycle: 16, maxStateBytes: 1024 * 1024,
  maxAttemptsPerWindow: 5, retryBaseMs: 5 * 60_000,
  retryRateLimitMs: 15 * 60_000, retryCapMs: 60 * 60_000,
});
const SHA40 = /^[a-f0-9]{40}$/u;
const HASH64 = /^[a-f0-9]{64}$/u;
const STATUS = new Set(['PENDING', 'BACKOFF', 'NEEDS_REVIEW', 'COMPLETE']);
const RETRYABLE = new Set(['MINUTE_SOURCE_TIMEOUT',
  'MINUTE_SOURCE_NETWORK_UNAVAILABLE', 'MINUTE_SOURCE_HTTP_408',
  'MINUTE_SOURCE_HTTP_425', 'MINUTE_SOURCE_HTTP_429',
  'MINUTE_SOURCE_HTTP_500', 'MINUTE_SOURCE_HTTP_502',
  'MINUTE_SOURCE_HTTP_503', 'MINUTE_SOURCE_HTTP_504']);
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const positive = x => Number.isSafeInteger(x) && x > 0;
const nonnegative = x => Number.isSafeInteger(x) && x >= 0;
const fail = code => { throw new Error(code); };
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');

export function validateBackfillScope(manifest) {
  if (!object(manifest) || manifest.schemaVersion !== SCOPE_CONTRACT
    || !Array.isArray(manifest.ranges) || !manifest.ranges.length
    || manifest.ranges.length > QUEUE_LIMITS.maxRanges)
    fail('MINUTE_QUEUE_MANIFEST_INVALID');
  const ranges = manifest.ranges.map(value => {
    const mode=object(value) ? (value.mode ?? 'BACKFILL') : null;
    const isRolling=mode==='CONTINUOUS';
    if (!object(value) || !['BACKFILL','CONTINUOUS'].includes(mode)
      || !positive(value.startMs) || value.startMs % MINUTE_MS
      || (isRolling ? value.endMs != null
        : !positive(value.endMs) || value.endMs % MINUTE_MS
          || value.endMs <= value.startMs))
      fail('MINUTE_QUEUE_RANGE_INVALID');
    // Reuse the same canonical market/symbol parser as the source owner.
    const valid = validateMinuteTask({ market:value.market, symbol:value.symbol,
      windowStartMs:value.startMs, windowEndMs:value.startMs + MINUTE_MS });
    return Object.freeze({ market:valid.market, symbol:valid.symbol, mode,
      startMs:value.startMs, endMs:isRolling ? null : value.endMs });
  }).sort((a,b) => a.market.localeCompare(b.market)
    || a.symbol.localeCompare(b.symbol) || a.mode.localeCompare(b.mode));
  if (new Set(ranges.map(r => r.market + ':' + r.symbol + ':' + r.mode)).size !== ranges.length)
    fail('MINUTE_QUEUE_DUPLICATE_SYMBOL');
  return Object.freeze({
    contract:SCOPE_CONTRACT,
    ranges:Object.freeze(ranges),
    scopeDigest:digest(ranges),
    fullUniverseProven:false, pitMembershipProven:false,
  });
}
function stateDigest(state) {
  const { stateDigest: discarded, ...rest } = state;
  return digest(rest);
}
function seal(state) {
  return Object.freeze({ ...state, stateDigest:stateDigest(state) });
}
export function createBackfillQueue({ scope, researchSha, atMs }) {
  if (!scope || scope.contract !== SCOPE_CONTRACT
    || !HASH64.test(scope.scopeDigest ?? '') || !SHA40.test(researchSha ?? '')
    || !positive(atMs)) fail('MINUTE_QUEUE_INITIALIZATION_INVALID');
  return seal({
    schemaVersion:QUEUE_CONTRACT, scopeDigest:scope.scopeDigest,
    createdBySha:researchSha, lastUpdatedBySha:researchSha,
    createdAtMs:atMs, updatedAtMs:atMs, nextIndex:0,
    ranges:scope.ranges.map(r => ({
      ...r, cursorMs:r.startMs, completedPages:0, observedCandles:0,
      attempts:0, status:'PENDING', retryAtMs:0, lastFailure:null,
      lastSuccessAtMs:0,
    })),
    economicEvidenceCredit:0, oosCredit:0, paperCredit:0,
    profitabilityProven:false, fullUniverseProven:false,
    executionAuthority:'NONE',
  });
}
export function verifyBackfillQueue(state, scope) {
  if (!object(state) || state.schemaVersion !== QUEUE_CONTRACT
    || !scope || scope.contract !== SCOPE_CONTRACT
    || state.scopeDigest !== scope.scopeDigest
    || !HASH64.test(state.stateDigest ?? '')
    || state.stateDigest !== stateDigest(state)
    || !SHA40.test(state.createdBySha ?? '')
    || !SHA40.test(state.lastUpdatedBySha ?? '')
    || !positive(state.createdAtMs) || !positive(state.updatedAtMs)
    || state.updatedAtMs < state.createdAtMs
    || !Array.isArray(state.ranges)
    || state.ranges.length !== scope.ranges.length
    || !nonnegative(state.nextIndex)
    || state.nextIndex >= state.ranges.length
    || state.economicEvidenceCredit !== 0 || state.oosCredit !== 0
    || state.paperCredit !== 0 || state.profitabilityProven !== false
    || state.fullUniverseProven !== false || state.executionAuthority !== 'NONE')
    fail('MINUTE_QUEUE_STATE_INVALID');
  for (let i=0; i<state.ranges.length; i++) {
    const r = state.ranges[i], expected = scope.ranges[i];
    if (!object(r) || r.market !== expected.market
      || r.symbol !== expected.symbol || r.mode !== expected.mode
      || r.startMs !== expected.startMs || r.endMs !== expected.endMs
      || !nonnegative(r.cursorMs) || r.cursorMs < r.startMs
      || (r.mode==='BACKFILL' && r.cursorMs > r.endMs)
      || r.cursorMs % MINUTE_MS
      || !nonnegative(r.completedPages)
      || !nonnegative(r.observedCandles)
      || !nonnegative(r.attempts)
      || r.attempts > QUEUE_LIMITS.maxAttemptsPerWindow
      || !STATUS.has(r.status)
      || !nonnegative(r.retryAtMs) || !nonnegative(r.lastSuccessAtMs)
      || (r.lastFailure != null
        && !/^(?:MINUTE_[A-Z0-9_]{1,80}|BLOCKED_EMPTY_RESPONSE|BLOCKED_STOCK_FEED_NOT_CONFIGURED)$/u.test(r.lastFailure))
      || (r.status === 'COMPLETE' && (r.mode!=='BACKFILL' || r.cursorMs !== r.endMs))
      || (r.mode==='BACKFILL' && r.status !== 'COMPLETE' && r.cursorMs === r.endMs)
      || (r.status === 'BACKOFF' && r.retryAtMs <= 0)
      || (r.status !== 'BACKOFF' && r.retryAtMs !== 0)
      || (r.status === 'NEEDS_REVIEW' && r.lastFailure == null))
      fail('MINUTE_QUEUE_STATE_INVALID');
  }
  return state;
}
export function pickBackfillWindow(state, atMs) {
  if (!positive(atMs)) fail('MINUTE_QUEUE_TIME_INVALID');
  for (let offset=0; offset<state.ranges.length; offset++) {
    const index=(state.nextIndex + offset) % state.ranges.length;
    const r=state.ranges[index];
    if (r.status === 'COMPLETE' || r.status === 'NEEDS_REVIEW'
      || r.status === 'BACKOFF' && r.retryAtMs > atMs) continue;
    const closedEnd=Math.floor((atMs-5_000)/MINUTE_MS)*MINUTE_MS;
    const horizon=r.mode==='CONTINUOUS'?closedEnd:Math.min(r.endMs,closedEnd);
    const end = Math.min(horizon, r.cursorMs
      + MINUTE_ARCHIVE_LIMITS.maxWindowMinutes * MINUTE_MS);
    if (end <= r.cursorMs || end > closedEnd) continue;
    return Object.freeze({
      index, task:Object.freeze({ market:r.market, symbol:r.symbol,
        windowStartMs:r.cursorMs, windowEndMs:end }),
    });
  }
  return null;
}
export function applyBackfillOutcome(state, selection, result, atMs, researchSha) {
  if (!positive(atMs) || !SHA40.test(researchSha ?? '')
    || !object(selection) || !nonnegative(selection.index)
    || selection.index >= state.ranges.length || !object(result))
    fail('MINUTE_QUEUE_RESULT_INVALID');
  const r=state.ranges[selection.index];
  const expectedHorizon=r.mode==='CONTINUOUS'
    ?Math.floor((atMs-5_000)/MINUTE_MS)*MINUTE_MS:r.endMs;
  const t=selection.task;
  if (!object(t) || t.market!==r.market || t.symbol!==r.symbol
    || t.windowStartMs!==r.cursorMs || !positive(t.windowEndMs)
    || t.windowEndMs % MINUTE_MS || t.windowEndMs<=r.cursorMs
    || t.windowEndMs>Math.min(expectedHorizon,
      r.cursorMs+MINUTE_ARCHIVE_LIMITS.maxWindowMinutes*MINUTE_MS))
    fail('MINUTE_QUEUE_RESULT_TASK_MISMATCH');
  if (result.market !== r.market || result.symbol !== r.symbol)
    fail('MINUTE_QUEUE_RESULT_SCOPE_MISMATCH');
  let next;
  if (result.status === 'ARCHIVED' || result.status === 'REUSED_IDENTICAL') {
    if (!nonnegative(result.candleCount) || result.candleCount > 200)
      fail('MINUTE_QUEUE_RESULT_CANDLES_INVALID');
    const cursorMs = selection.task.windowEndMs;
    next = { ...r, cursorMs, completedPages:r.completedPages+1,
      observedCandles:r.observedCandles + result.candleCount,
      status:r.mode==='BACKFILL' && cursorMs === r.endMs ? 'COMPLETE' : 'PENDING',
      attempts:0, retryAtMs:0, lastFailure:null, lastSuccessAtMs:atMs };
  } else {
    const error = result.status === 'BLOCKED' ? result.error : result.status;
    if (typeof error !== 'string' || !/^MINUTE_[A-Z0-9_]{1,80}$|^BLOCKED_(?:EMPTY_RESPONSE|STOCK_FEED_NOT_CONFIGURED)$/u.test(error))
      fail('MINUTE_QUEUE_RESULT_INVALID');
    const attempts=r.attempts+1;
    const retryable=RETRYABLE.has(error) && attempts < QUEUE_LIMITS.maxAttemptsPerWindow;
    const delay=error === 'MINUTE_SOURCE_HTTP_429'
      ? QUEUE_LIMITS.retryRateLimitMs * (2 ** (attempts-1))
      : QUEUE_LIMITS.retryBaseMs * (2 ** (attempts-1));
    next = { ...r, attempts, lastFailure:error,
      retryAtMs:retryable ? atMs+Math.min(delay,QUEUE_LIMITS.retryCapMs) : 0,
      status:retryable ? 'BACKOFF' : 'NEEDS_REVIEW' };
  }
  const ranges=state.ranges.map((row,i) => i === selection.index ? next : row);
  return seal({ ...state, ranges,
    nextIndex:(selection.index+1) % ranges.length,
    updatedAtMs:Math.max(state.updatedAtMs,atMs),lastUpdatedBySha:researchSha });
}
async function checkRoot(root) {
  if (!isAbsolute(root ?? '')) fail('MINUTE_QUEUE_ROOT_INVALID');
  const path=resolve(root);
  if (/^\/(?:opt\/stock-app-data|srv\/stock-app|var\/lib\/stock-app)(?:\/|$)/u.test(path))
    fail('MINUTE_QUEUE_PROTECTED_APP_ROOT');
  let part=path;
  while (true) {
    const info=await lstat(part);
    if (info.isSymbolicLink()) fail('MINUTE_QUEUE_ROOT_SYMLINK');
    if (part === path && (!info.isDirectory() || (info.mode & 0o077)))
      fail('MINUTE_QUEUE_ROOT_UNSAFE');
    const parent=dirname(part);
    if (parent===part) break;
    part=parent;
  }
  return path;
}
async function readProtectedFile(path) {
  let handle;
  try {
    handle=await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
    const info=await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077)
      || !positive(info.size) || info.size > QUEUE_LIMITS.maxStateBytes)
      fail('MINUTE_QUEUE_FILE_UNSAFE');
    return await handle.readFile('utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    if (e?.code === 'ELOOP') fail('MINUTE_QUEUE_FILE_UNSAFE');
    throw e;
  } finally { await handle?.close(); }
}
async function syncParent(path) {
  const handle=await open(dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function readBackfillQueue(queueRoot, scope) {
  const root=await checkRoot(queueRoot);
  const text=await readProtectedFile(join(root,'backfill-state-v1.json'));
  if (text == null) return null;
  let decoded;
  try { decoded=JSON.parse(text); } catch { fail('MINUTE_QUEUE_STATE_CORRUPT'); }
  return verifyBackfillQueue(decoded,scope);
}
export async function writeBackfillQueue(queueRoot, scope, state, previousDigest=null) {
  const root=await checkRoot(queueRoot);
  verifyBackfillQueue(state,scope);
  const path=join(root,'backfill-state-v1.json');
  const existing=await readBackfillQueue(root,scope);
  if ((existing?.stateDigest ?? null) !== previousDigest)
    fail('MINUTE_QUEUE_CONCURRENT_MODIFICATION');
  const bytes=Buffer.from(JSON.stringify(state)+'\n');
  if (bytes.byteLength > QUEUE_LIMITS.maxStateBytes)
    fail('MINUTE_QUEUE_STATE_OVERSIZE');
  const temporary=join(root,'.backfill-tmp-'+randomUUID());
  try {
    const handle=await open(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary,path);
    await syncParent(path);
  } finally {
    await unlink(temporary).catch(e => { if (e?.code !== 'ENOENT') throw e; });
  }
  const reread=await readBackfillQueue(root,scope);
  if (reread.stateDigest !== state.stateDigest) fail('MINUTE_QUEUE_READBACK_MISMATCH');
  return reread;
}

export async function runDurableMinuteBackfillCycle({
  enabled=false, queueRoot, archiveRoot, manifest, researchSha,
  now=()=>Date.now(), fetchImpl=globalThis.fetch, sleep=ms=>new Promise(r=>setTimeout(r,ms)),
  freeBytes=null, maxActions=QUEUE_LIMITS.maxActionsPerCycle,
}={}) {
  if (!enabled) return Object.freeze({status:'DISABLED',providerCalls:0,
    filesWritten:0,executionAuthority:'NONE'});
  if (!SHA40.test(researchSha ?? '') || !isAbsolute(queueRoot ?? '')
    || !isAbsolute(archiveRoot ?? '') || resolve(queueRoot)===resolve(archiveRoot)
    || !nonnegative(maxActions) || maxActions > QUEUE_LIMITS.maxActionsPerCycle)
    fail('MINUTE_QUEUE_CONFIG_INVALID');
  const scope=validateBackfillScope(manifest);
  const capacity=assessMinuteManifestCapacity(manifest,{actionsPerCycle:maxActions});
  if(capacity.status==='CAPACITY_MODEL_INSUFFICIENT'
    ||capacity.status==='STOCK_SESSION_NOT_MODELLED') {
    // A short research pilot is not silently called sustainable all-symbol
    // capture. Do not create a queue or access providers until capacity
    // constraints have been separately reviewed and the job budget changed.
    return Object.freeze({
      contract:QUEUE_CONTRACT,status:'HOLD_CAPACITY',capacity,
      attempts:0,providerCalls:0,filesWritten:0,
      fullUniverseProven:false,independentOosProven:false,
      profitabilityProven:false,executionAuthority:'NONE',
    });
  }
  const root=await checkRoot(queueRoot);
  let state=await readBackfillQueue(root,scope);
  if (!state) {
    state=createBackfillQueue({scope,researchSha,atMs:now()});
    state=await writeBackfillQueue(root,scope,state,null);
  }
  let attempts=0, providerCalls=0, filesWritten=0;
  let heldDisk=false;
  const outcomes=[];
  for(let step=0; step<maxActions; step++) {
    const choice=pickBackfillWindow(state,now());
    if(!choice) break;
    const response=await runMinuteArchiveIntakeV1({
      enabled:true,root:archiveRoot,tasks:[choice.task],researchSha,
      now,fetchImpl,sleep,freeBytes,
    });
    if(response.status==='HOLD_DISK') {heldDisk=true;break;}
    const result=response.results?.[0];
    if(!result) fail('MINUTE_QUEUE_INTAKE_RESULT_MISSING');
    const next=applyBackfillOutcome(state,choice,result,now(),researchSha);
    state=await writeBackfillQueue(root,scope,next,state.stateDigest);
    attempts++;
    providerCalls+=response.providerCalls;
    filesWritten+=response.filesWritten;
    outcomes.push({market:result.market,symbol:result.symbol,status:result.status,
      error:result.error ?? null});
    if(providerCalls && step<maxActions-1)
      await sleep(MINUTE_ARCHIVE_LIMITS.minRequestIntervalMs);
  }
  const completeCount=state.ranges.filter(r=>r.status==='COMPLETE').length;
  const rollingCount=state.ranges.filter(r=>r.mode==='CONTINUOUS').length;
  const reviewCount=state.ranges.filter(r=>r.status==='NEEDS_REVIEW').length;
  const backoffCount=state.ranges.filter(r=>r.status==='BACKOFF').length;
  return Object.freeze({
    contract:QUEUE_CONTRACT,status:heldDisk?'HOLD_DISK':reviewCount?'NEEDS_REVIEW'
      :completeCount===state.ranges.length?'PLANNED_WINDOWS_ARCHIVED'
        :attempts?'PROGRESS_RECORDED':'WAIT_OR_NO_ELIGIBLE_WINDOW',
    scopeDigest:scope.scopeDigest,rangeCount:state.ranges.length,
    completeCount,rollingCount,reviewCount,backoffCount,
    attempts,providerCalls,filesWritten,outcomes,capacity,
    // These are *not* source gap closure, full population, or historic PIT proof.
    missingMinuteClassificationComplete:false,fullUniverseProven:false,
    independentOosProven:false,profitabilityProven:false,
    executionAuthority:'NONE',
  });
}
