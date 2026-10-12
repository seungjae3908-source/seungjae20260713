// Bounded, resumable PUBLIC-ONLY 1m history planner. No scheduler or order authority.
// State is a progress cursor, NOT a complete market/PIT/strategy evidence certificate.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { MINUTE_MS, MINUTE_ARCHIVE_LIMITS, validateMinuteTask,
  runMinuteArchiveIntakeV1 } from './four-market-minute-archive-intake-v1.mjs';
import { assessMinuteManifestCapacity, assessMinuteArchiveCapacity } from './four-market-minute-roster-capacity-v1.mjs';

// Two independent venue lanes are programmatic/offline only, never selected
// by the installed CLI. Only one GET per venue is outstanding at a time.
const PUBLIC_VENUES = Object.freeze(['CRYPTO_SPOT','CRYPTO_FUTURES']);
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
  // 120 is the existing immutable cursor contract. 180 is a distinct
  // optional scope, so changing page size never silently reuses a v1 cursor.
  const pageWindowMinutes = manifest.pageWindowMinutes ?? 120;
  if (![120,180].includes(pageWindowMinutes))
    fail('MINUTE_QUEUE_PAGE_WINDOW_INVALID');
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
    ranges:Object.freeze(ranges),pageWindowMinutes,
    scopeDigest:pageWindowMinutes===120
      ?digest(ranges):digest(['PAGE_WINDOW_MINUTES',pageWindowMinutes,ranges]),
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
    ...(scope.pageWindowMinutes===180?{pageWindowMinutes:180}:{}),
    createdBySha:researchSha, lastUpdatedBySha:researchSha,
    createdAtMs:atMs, updatedAtMs:atMs, nextIndex:0,
    ranges:scope.ranges.map(r => ({
      ...r, cursorMs:r.startMs, completedPages:0, observedCandles:0,
      attempts:0, status:'PENDING', retryAtMs:0, lastFailure:null,
      lastSuccessAtMs:0,
      sourceGapAuditVersion:1,sourceGapPages:0,
      unverifiedMissingMinuteSlots:0,historicalMissingBeforeAudit:false,
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
    || ![120,180].includes(scope.pageWindowMinutes)
    || (state.pageWindowMinutes ?? 120) !== scope.pageWindowMinutes
    || (state.pageWindowMinutes !== undefined && state.pageWindowMinutes !== 180)
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
      || ((r.sourceGapAuditVersion!=null||r.sourceGapPages!=null
           ||r.unverifiedMissingMinuteSlots!=null
           ||r.historicalMissingBeforeAudit!=null)
        && (r.sourceGapAuditVersion!==1
          ||!nonnegative(r.sourceGapPages)
          ||r.sourceGapPages>r.completedPages
          ||!nonnegative(r.unverifiedMissingMinuteSlots)
          ||typeof r.historicalMissingBeforeAudit!=='boolean'))
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
// A public 429 is a provider-shared rate limit, not a single-symbol defect.
// Existing durable range backoff also holds sibling requests in this market.
function provider429HoldMarkets(state, atMs) {
  return new Set(state.ranges.filter(r =>
    r.lastFailure === 'MINUTE_SOURCE_HTTP_429'
    && (r.status === 'NEEDS_REVIEW'
      || (r.status === 'BACKOFF' && r.retryAtMs > atMs))
  ).map(r => r.market));
}
export function pickBackfillWindow(state, atMs, marketFilter=null) {
  if (!positive(atMs)) fail('MINUTE_QUEUE_TIME_INVALID');
  if (marketFilter!==null && !PUBLIC_VENUES.includes(marketFilter))
    fail('MINUTE_QUEUE_MARKET_FILTER_INVALID');
  const rateLimitedMarkets = provider429HoldMarkets(state, atMs);
  for (let offset=0; offset<state.ranges.length; offset++) {
    const index=(state.nextIndex + offset) % state.ranges.length;
    const r=state.ranges[index];
    if (marketFilter!==null && r.market!==marketFilter) continue;
    if (rateLimitedMarkets.has(r.market) || r.status === 'COMPLETE'
      || r.status === 'NEEDS_REVIEW'
      || r.status === 'BACKOFF' && r.retryAtMs > atMs) continue;
    const closedEnd=Math.floor((atMs-5_000)/MINUTE_MS)*MINUTE_MS;
    const horizon=r.mode==='CONTINUOUS'?closedEnd:Math.min(r.endMs,closedEnd);
    const end = Math.min(horizon, r.cursorMs
      + (state.pageWindowMinutes ?? 120) * MINUTE_MS);
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
      r.cursorMs+(state.pageWindowMinutes ?? 120)*MINUTE_MS))
    fail('MINUTE_QUEUE_RESULT_TASK_MISMATCH');
  if (result.market !== r.market || result.symbol !== r.symbol)
    fail('MINUTE_QUEUE_RESULT_SCOPE_MISMATCH');
  let next;
  if (result.status === 'ARCHIVED' || result.status === 'REUSED_IDENTICAL') {
    const expectedSlots=(selection.task.windowEndMs-selection.task.windowStartMs)/MINUTE_MS;
    if (!nonnegative(result.candleCount) || result.candleCount > expectedSlots
      || expectedSlots>(state.pageWindowMinutes ?? 120))
      fail('MINUTE_QUEUE_RESULT_CANDLES_INVALID');
    const missingSlots=expectedSlots-result.candleCount;
    const slotAudit=result.minuteSlotAudit;
    if(slotAudit!=null
      &&(slotAudit.contract!=='research-minute-source-window-slot-audit/v1'
        ||slotAudit.sourceWindowMinuteSlots!==expectedSlots
        ||slotAudit.observedOneMinuteSlots!==result.candleCount
        ||slotAudit.unverifiedMissingMinuteSlots!==missingSlots
        ||slotAudit.allAbsencesClassified!==false
        ||slotAudit.sourceTimelineIndependentlyAttested!==false))
      fail('MINUTE_QUEUE_SLOT_AUDIT_CONFLICT');
    const cursorMs = selection.task.windowEndMs;
    next = { ...r, cursorMs, completedPages:r.completedPages+1,
      observedCandles:r.observedCandles + result.candleCount,
      sourceGapAuditVersion:1,
      sourceGapPages:(r.sourceGapPages??0)+(missingSlots>0?1:0),
      unverifiedMissingMinuteSlots:(r.unverifiedMissingMinuteSlots??0)+missingSlots,
      historicalMissingBeforeAudit:r.historicalMissingBeforeAudit===true
        || r.sourceGapAuditVersion==null && r.completedPages>0,
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
  dualVenueMode=false, dualVenueOwnerApproved=false, dualVenueHostAttested=false,
}={}) {
  if (!enabled) return Object.freeze({status:'DISABLED',providerCalls:0,
    filesWritten:0,executionAuthority:'NONE'});
  if (!SHA40.test(researchSha ?? '') || !isAbsolute(queueRoot ?? '')
    || !isAbsolute(archiveRoot ?? '') || resolve(queueRoot)===resolve(archiveRoot)
    || !nonnegative(maxActions) || maxActions > QUEUE_LIMITS.maxActionsPerCycle
    || typeof dualVenueMode!=='boolean'
    || typeof dualVenueOwnerApproved!=='boolean'
    || typeof dualVenueHostAttested!=='boolean')
    fail('MINUTE_QUEUE_CONFIG_INVALID');
  if (dualVenueMode
    && (!dualVenueOwnerApproved || !dualVenueHostAttested))
    return Object.freeze({
      contract:QUEUE_CONTRACT,status:'HOLD_DUAL_VENUE_OPERATOR_ATTESTATION',
      attempts:0,providerCalls:0,filesWritten:0,
      hostCapacityVerified:false,sharedIpBudgetVerified:false,
      executionAuthority:'NONE',
    });
  const scope=validateBackfillScope(manifest);
  // Max 16 per provider lane, not an unconstrained 32-request pool.
  // Aggregate 32 is meaningful only if EACH venue independently meets
  // its 16-action budget. Stock sessions are never promoted here.
  const venueCapacities=dualVenueMode?PUBLIC_VENUES.map(market=>{
    const count=scope.ranges.filter(r=>r.mode==='CONTINUOUS'
      &&r.market===market).length;
    return Object.freeze({
      market,
      ...assessMinuteArchiveCapacity({
        cryptoSpotSymbols:market==='CRYPTO_SPOT'?count:0,
        cryptoFuturesSymbols:market==='CRYPTO_FUTURES'?count:0,
        actionsPerCycle:maxActions,windowMinutes:scope.pageWindowMinutes,
      }),
    });
  }):[];
  const capacity=assessMinuteManifestCapacity(manifest,{
    actionsPerCycle:dualVenueMode?maxActions*2:maxActions,
    windowMinutes:scope.pageWindowMinutes,
  });
  if(capacity.status==='CAPACITY_MODEL_INSUFFICIENT'
    ||capacity.status==='STOCK_SESSION_NOT_MODELLED'
    ||venueCapacities.some(v=>v.status==='CAPACITY_MODEL_INSUFFICIENT')) {
    // A short research pilot is not silently called sustainable all-symbol
    // capture. Do not create a queue or access providers until capacity
    // constraints have been separately reviewed and the job budget changed.
    return Object.freeze({
      contract:QUEUE_CONTRACT,status:'HOLD_CAPACITY',capacity,
      ...(dualVenueMode?{venueCapacities}:{}),
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
  let heldDisk=false, heldDeadline=false;
  const outcomes=[];
  const beganAt=performance.now();
  for(let step=0; step<maxActions; step++) {
    // The installed child has a 210s hard limit. Do not start a new
    // provider GET when an 8s timeout + a 15s shutdown reserve would
    // exceed it. Immutable pages already stored remain safe on a crash.
    if(dualVenueMode && performance.now()-beganAt
      + MINUTE_ARCHIVE_LIMITS.networkTimeoutMs+15_000>=210_000){
      heldDeadline=true;
      break;
    }
    const choices=(dualVenueMode?PUBLIC_VENUES:[null])
      .map(market=>pickBackfillWindow(state,now(),market)).filter(Boolean);
    if(!choices.length) break;
    // Parallelize independent public providers ONLY. No two requests
    // in-flight from the same provider. State writes remain SERIAL and
    // globally lease-protected by the single outer flock process.
    const settled=await Promise.allSettled(choices.map(choice=>
      runMinuteArchiveIntakeV1({
        enabled:true,root:archiveRoot,tasks:[choice.task],researchSha,
        now,fetchImpl,sleep,freeBytes,
      })));
    let fatal=false;
    for(let i=0;i<choices.length;i++){
      if(settled[i].status!=='fulfilled'){fatal=true;continue;}
      const response=settled[i].value;
      if(response.status==='HOLD_DISK'){heldDisk=true;continue;}
      const result=response.results?.[0];
      if(!result)fail('MINUTE_QUEUE_INTAKE_RESULT_MISSING');
      const next=applyBackfillOutcome(state,choices[i],result,now(),researchSha);
      state=await writeBackfillQueue(root,scope,next,state.stateDigest);
      attempts++;
      providerCalls+=response.providerCalls;
      filesWritten+=response.filesWritten;
      outcomes.push({market:result.market,symbol:result.symbol,status:result.status,
        error:result.error ?? null});
    }
    if(fatal)fail('MINUTE_QUEUE_DUAL_VENUE_INTAKE_FAILED');
    if(heldDisk)break;
    if(providerCalls && step<maxActions-1)
      await sleep(MINUTE_ARCHIVE_LIMITS.minRequestIntervalMs);
  }
  const completeCount=state.ranges.filter(r=>r.status==='COMPLETE').length;
  const rollingCount=state.ranges.filter(r=>r.mode==='CONTINUOUS').length;
  const reviewCount=state.ranges.filter(r=>r.status==='NEEDS_REVIEW').length;
  const backoffCount=state.ranges.filter(r=>r.status==='BACKOFF').length;
  const unverifiedMissingMinuteSlots=state.ranges.reduce((sum,r)=>
    sum+(r.unverifiedMissingMinuteSlots??0),0);
  const gapAffectedPageCount=state.ranges.reduce((sum,r)=>
    sum+(r.sourceGapPages??0),0);
  const legacyGapAuditUnverified=state.ranges.some(r=>
    r.sourceGapAuditVersion==null||r.historicalMissingBeforeAudit===true);
  const gapsUnresolved=unverifiedMissingMinuteSlots>0||legacyGapAuditUnverified;
  const providerRateLimitedMarkets=Object.freeze([...provider429HoldMarkets(state,now())].sort());
  return Object.freeze({
    contract:QUEUE_CONTRACT,status:heldDisk?'HOLD_DISK'
      :heldDeadline?'HOLD_WORKER_DEADLINE'
      :providerRateLimitedMarkets.length?'HOLD_PROVIDER_RATE_LIMIT'
      :reviewCount?'NEEDS_REVIEW'
      :completeCount===state.ranges.length?(gapsUnresolved
        ?'PLANNED_WINDOWS_ARCHIVED_SOURCE_LIMITED':'PLANNED_WINDOWS_ARCHIVED')
        :attempts?'PROGRESS_RECORDED':'WAIT_OR_NO_ELIGIBLE_WINDOW',
    scopeDigest:scope.scopeDigest,rangeCount:state.ranges.length,
    completeCount,rollingCount,reviewCount,backoffCount,
    attempts,providerCalls,filesWritten,outcomes,capacity,
    ...(dualVenueMode?{venueCapacities,dualVenueMode:true,
      providerLaneMaxActionsPerCycle:maxActions,
      sourceOnlyConcurrentProviderLimit:2}:{}),
    providerRateLimitedMarkets,
    gapAffectedPageCount,unverifiedMissingMinuteSlots,
    legacyGapAuditUnverified,
    sourceSlotEvidenceStatus:legacyGapAuditUnverified
      ?'LEGACY_GAP_AUDIT_UNVERIFIED':unverifiedMissingMinuteSlots>0
        ?'UNVERIFIED_GAPS_PRESENT':'LOCALLY_OBSERVED_SLOTS_ONLY',
    // These are *not* source gap closure, full population, or historic PIT proof.
    missingMinuteClassificationComplete:false,fullUniverseProven:false,
    independentOosProven:false,profitabilityProven:false,
    executionAuthority:'NONE',
  });
}
