import { open, lstat, readdir, statfs, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { planPITNativeMinuteSourceGapsV1 } from "./four-market-pit-minute-gap-queue-v1.js";
import { collectPITNativeCryptoMinuteSourceV1 } from "./pit-native-crypto-minute-backfill-v1.js";
import { inspectArchivedResearchMinuteSessionV1 } from "./research-minute-archive-v1.js";

/**
 * Opt-in single proposed PIT crypto 1m source task -> existing native collector.
 *
 * Unlike consuming the truncated day preview or trusting an editable task
 * JSON, this recalculates the complete historical day page ledger on EVERY
 * call. It requires the exact reviewed candidate-page SHA before any GET.
 *
 * Maximum one historical market/symbol/day per call, with a private-root
 * single-writer lock and bounded local disk reserve (NOT a background worker).
 * This is only retrospective source materialization, never live orders.
 */
const DAY = 86_400_000;
const MIB = 1024 * 1024;
const MAX_SINGLE_SOURCE_BYTES = 3 * MIB;
const DEFAULT_MAX_LOCAL_BYTES = 2048 * MIB; // 2 GiB staging ceiling
const DEFAULT_MIN_FREE_BYTES = 2048 * MIB; // preserve 2 GiB free
const SHA = /^[a-f0-9]{64}$/u;
const EXPECTED = Object.freeze({
  CRYPTO_SPOT: "UPBIT_PUBLIC_REST",
  CRYPTO_FUTURES: "BITGET_PUBLIC_V2",
});
const blocked = ({market,day,taskPageIndex,taskIndex},reason,extras={}) => Object.freeze({
  schemaVersion: "pit-minute-source-task-executor-v1",
  status: "BLOCKED_DATA", reason, market, day, taskPageIndex, taskIndex,
  ...extras,
  maxTasksThisInvocation: 1,
  scheduledWorkAllowed: false,
  sourceArchiveCompletenessProven: false,
  independentlyAuthenticatedPITAndPriceData: false,
  historicalScannerAvailabilityProven: false,
  sourceLicenseAndReuseRightsIndependentlyVerified: false,
  fullMarketOpportunityDenominatorVerified: false,
  actualMarketWideOpportunityCount: null,
  trueMarketWideRecall: null, actualFillCount: null,
  netProfitPct: null, profitabilityProven: false,
  executionAuthority: "NONE", liveTrading: false,
  autoTrading: false, realOrders: false,
  privateTradingApiAllowed: false,
});
const fail = reason => { throw new TypeError(reason); };

async function assertPrivateRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root)
    fail("PIT_MINUTE_TASK_ROOT_INVALID");
  let at = root;
  while (true) {
    const st = await lstat(at);
    if (st.isSymbolicLink() || !st.isDirectory())
      fail("PIT_MINUTE_TASK_SYMLINK_OR_PARENT_INVALID");
    const next = dirname(at);
    if (next === at) break;
    at = next;
  }
  const st=await lstat(root);
  if ((st.mode & 0o077)!==0)
    fail("PIT_MINUTE_TASK_ROOT_MUST_BE_PRIVATE");
}
async function countArchiveBytes(root, maxEntries=100000) {
  const top=join(root,"minute-sessions-v1");
  let q=[top], used=0, entries=0;
  while(q.length) {
    const path=q.pop();
    let children;
    try {
      const current=await lstat(path);
      if(current.isSymbolicLink()||!current.isDirectory())
        fail("PIT_MINUTE_TASK_ARCHIVE_DIRECTORY_UNSAFE");
      children=await readdir(path,{withFileTypes:true});
    }
    catch(e) { if(e?.code==="ENOENT"&&path===top)return used;throw e; }
    for(const entry of children) {
      entries++;
      if (entries>maxEntries) fail("PIT_MINUTE_TASK_ARCHIVE_SCAN_BOUNDED");
      const item=join(path,entry.name);
      const st=await lstat(item);
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()))
        fail("PIT_MINUTE_TASK_ARCHIVE_ENTRY_INVALID");
      if (st.isDirectory()) q.push(item);
      else {
        if ((st.mode&0o077)!==0 || st.nlink!==1)
          fail("PIT_MINUTE_TASK_ARCHIVE_FILE_UNSAFE");
        used+=st.size;
        if(!Number.isSafeInteger(used))
          fail("PIT_MINUTE_TASK_ARCHIVE_BYTES_OVERFLOW");
      }
    }
  }
  return used;
}
/** Shared source-only archive guard. All public capture paths use this lock. */
export async function withResearchMinuteArchiveBudgetV1({
  root,maxSources=1,maxLocalBytes=DEFAULT_MAX_LOCAL_BYTES,
  minFreeBytes=DEFAULT_MIN_FREE_BYTES,statfsImpl=statfs,
}={},work) {
  if(!Number.isSafeInteger(maxSources)||maxSources<1||maxSources>20
    ||!Number.isSafeInteger(maxLocalBytes)||maxLocalBytes<MAX_SINGLE_SOURCE_BYTES
    ||maxLocalBytes>16*1024*MIB||!Number.isSafeInteger(minFreeBytes)
    ||minFreeBytes<0||minFreeBytes>100*1024*MIB
    ||typeof statfsImpl!=="function"||typeof work!=="function")
    fail("RESEARCH_MINUTE_BUDGET_ARGUMENT_INVALID");
  await assertPrivateRoot(root);
  const lockPath=join(root,".pit-native-minute-task.lock");
  let lock;
  try {
    lock=await open(lockPath,"wx",0o600);
    await lock.writeFile("RESEARCH_PUBLIC_SOURCE_GET_ONLY\n","utf8");
    await lock.sync();
  }catch(error){
    if(lock){await lock.close();await unlink(lockPath);}
    if(error?.code==="EEXIST")return Object.freeze({
      status:"BLOCKED_DATA",reason:"ARCHIVE_WRITER_LOCK_HELD",
    });
    throw error;
  }
  try {
    const before=await countArchiveBytes(root);
    const fs=await statfsImpl(root);
    const reserve=MAX_SINGLE_SOURCE_BYTES*maxSources;
    const budget=Object.freeze({archiveBytesCheckedBeforeGet:before,
      maxLocalBytes,minFreeBytes,reservedSourceBytes:reserve,
      archiveWriterLockUsed:true});
    const stop=reason=>Object.freeze({status:"BLOCKED_DATA",reason,...budget});
    if(!fs||!Number.isSafeInteger(fs.bavail)||!Number.isSafeInteger(fs.bsize)
      ||fs.bavail<0||fs.bsize<1)return stop("ARCHIVE_DISK_STAT_UNAVAILABLE");
    if(before+reserve>maxLocalBytes)return stop("ARCHIVE_LOCAL_QUOTA_EXCEEDED");
    if(BigInt(fs.bavail)*BigInt(fs.bsize)<BigInt(minFreeBytes+reserve))
      return stop("ARCHIVE_MINIMUM_FREE_SPACE_NOT_MET");
    return await work(budget);
  }finally{
    await lock.close();
    await unlink(lockPath);
  }
}
function validate({root,market,day,pages,taskPageIndex,taskIndex,
  expectedTaskDigestSha256,allowPublicReadOnlyFetch,
  retryPartialSource,allowSourceLimitedArchive,
  expectedExistingSourceDigestSha256,
  maxLocalBytes,minFreeBytes,nowImpl,statfsImpl}) {
  if(!isAbsolute(root??"") || resolve(root)!==root
    ||!Object.hasOwn(EXPECTED,market)
    ||typeof day!=="string"
    ||!/^\d{4}-\d{2}-\d{2}$/u.test(day)
    ||!Array.isArray(pages)||pages.length<1||pages.length>2500
    ||!Number.isSafeInteger(taskPageIndex)||taskPageIndex<0
    ||taskPageIndex>=pages.length
    ||!Number.isSafeInteger(taskIndex)||taskIndex<0||taskIndex>=20
    ||!SHA.test(expectedTaskDigestSha256??"")
    ||typeof allowPublicReadOnlyFetch!=="boolean"
    ||typeof retryPartialSource!=="boolean"
    ||typeof allowSourceLimitedArchive!=="boolean"
    ||(retryPartialSource
      ? !SHA.test(expectedExistingSourceDigestSha256??"")
      :expectedExistingSourceDigestSha256!=null)
    ||!Number.isSafeInteger(maxLocalBytes)
    ||maxLocalBytes<MAX_SINGLE_SOURCE_BYTES||maxLocalBytes>16*1024*MIB
    ||!Number.isSafeInteger(minFreeBytes)
    ||minFreeBytes<0||minFreeBytes>100*1024*MIB
    ||typeof nowImpl!=="function"
    ||typeof statfsImpl!=="function")
    fail("PIT_MINUTE_TASK_ARGUMENT_INVALID");
}
function verifyTask(task,market,day,{retryPartialSource=false,
  expectedExistingSourceDigestSha256=null}={}) {
  const ms=Date.parse(day+"T00:00:00Z");
  if(!task || task.market!==market || task.utcDay!==day
    ||task.tradingDate!==day ||task.sessionStartMs!==ms
    ||task.sessionEndMs!==ms+DAY ||task.sessionKind!=="UTC_24H"
    ||task.proposedProvider!==EXPECTED[market]
    ||task.sourceReadRequiresExplicitConsent!==true
    ||task.independentlyAuthenticatedPIT!==false
    ||task.historicalMinuteAvailabilityProven!==false)
    return false;
  if(retryPartialSource) {
    // The caller explicitly selects a REVIEW ticket, never the missing-source
    // candidate array; both groups have different immutable page digests.
    return task.action==="REVIEW_PARTIAL_NATIVE_MINUTE_RETRY"
      &&task.expectedExistingSourceDigestSha256===expectedExistingSourceDigestSha256
      &&SHA.test(task.expectedExistingSourceDigestSha256??"")
      &&Number.isSafeInteger(task.priorOriginalMinuteRows)
      &&task.priorOriginalMinuteRows>=1
      &&Number.isSafeInteger(task.missingUnverifiedMinuteSlots)
      &&task.missingUnverifiedMinuteSlots>=1
      &&task.priorOriginalMinuteRows+task.missingUnverifiedMinuteSlots===1440
      &&task.originalMinuteNoTradeGapsVerified===false
      &&task.sourceRevisionAutoSelected===false
      &&task.autoExecuteAllowed===false &&task.providerGETCount===0;
  }
  return task.selectionDate===day
    &&task.sourcePlanReason==="MISSING_ORIGINAL_ONE_MINUTE_SESSION"
    &&task.expectedExistingSourceDigestSha256===undefined;
}
/** One fresh source gap receipt, one approved public GET only when explicitly opted in. */
export async function runPlannedPITMinuteSourceTaskV1({
  root,market,day,manifest=null,pages=[],taskPageIndex=0,taskIndex=0,
  expectedTaskDigestSha256=null,allowPublicReadOnlyFetch=false,
  retryPartialSource=false,allowSourceLimitedArchive=false,
  expectedExistingSourceDigestSha256=null,
  maxLocalBytes=DEFAULT_MAX_LOCAL_BYTES,minFreeBytes=DEFAULT_MIN_FREE_BYTES,
  nowImpl=()=>Date.now(),statfsImpl=statfs,
  upbitFetchImpl=null,bitgetClient=null,
}={}) {
  validate({root,market,day,pages,taskPageIndex,taskIndex,
    expectedTaskDigestSha256,allowPublicReadOnlyFetch,
    retryPartialSource,allowSourceLimitedArchive,
    expectedExistingSourceDigestSha256,
    maxLocalBytes,minFreeBytes,nowImpl,statfsImpl});
  const id={market,day,taskPageIndex,taskIndex};
  const plan=planPITNativeMinuteSourceGapsV1({
    market,day,manifest,pages,taskPageIndex,
  });
  if (!["PLANNED_EXPLICIT_PUBLIC_READ_ONLY",
    "PLANNED_MISSING_SOURCES_WITH_MANUAL_REVIEW"].includes(plan.status))
    return blocked(id,"NO_VERIFIED_PUBLIC_SOURCE_TASK",{
      plannerStatus:plan.status,
    });
  const reviewDigest=retryPartialSource
    ?plan.partialRetryReviewDigestSha256:plan.candidateTaskDigestSha256;
  if (reviewDigest!==expectedTaskDigestSha256)
    return blocked(id,"SELECTED_TASK_PAGE_SHA_CHANGED",{
      selectedTaskKind:retryPartialSource?"PARTIAL_SOURCE_REVIEW":"MISSING_SOURCE",
    });
  const task=retryPartialSource
    ?plan.partialRetryReviewTasks?.[taskIndex]
    :plan.candidateTasks?.[taskIndex];
  if (!verifyTask(task,market,day,{
    retryPartialSource,expectedExistingSourceDigestSha256,
  }))return blocked(id,"SELECTED_TASK_NOT_ELIGIBLE");
  const selectedTaskKind=retryPartialSource
    ?"PARTIAL_SOURCE_REVIEW":"MISSING_SOURCE";
  // Genuine zero-network preflight: recheck the CURRENT immutable source,
  // not just a previously issued 20-member PIT receipt. Do this before
  // explicit public-read consent, before a writer lock, and before ANY GET.
  // The native collector performs another check under the writer lock.
  await assertPrivateRoot(root);
  let retained;
  try {
    retained=await inspectArchivedResearchMinuteSessionV1({
      root,market,symbol:task.symbol,sessionStartMs:task.sessionStartMs,
    });
  }catch{
    return blocked(id,"EXISTING_ARCHIVE_REQUIRES_MANUAL_SOURCE_REVIEW",{
      plannedSymbol:task.symbol,selectedTaskKind,providerGETCount:0,
    });
  }
  if(retryPartialSource) {
    if(retained.status==="BLOCKED_DATA")return blocked(id,
      retained.reason==="ARCHIVED_SESSION_NOT_FOUND"
        ?"RETRY_EXISTING_PARTIAL_ARCHIVE_REQUIRED"
        :"EXISTING_ARCHIVE_REQUIRES_MANUAL_SOURCE_REVIEW",{
        plannedSymbol:task.symbol,selectedTaskKind,
        archiveReason:retained.reason,providerGETCount:0,
      });
    if(retained.archiveSourceDigestSha256
      !==expectedExistingSourceDigestSha256)
      return blocked(id,"RETRY_SOURCE_REVISION_DIGEST_MISMATCH",{
        plannedSymbol:task.symbol,selectedTaskKind,
        currentSourceDigestSha256:retained.archiveSourceDigestSha256,
        providerGETCount:0,
      });
    if(retained.archivedRevisionCount!==1
      ||retained.nativeMinuteSlotInventoryComplete===true)
      return blocked(id,
        retained.nativeMinuteSlotInventoryComplete===true
          ?"ALREADY_RETAINED_COMPLETE_1M_SOURCE"
          :"EXISTING_ARCHIVE_REQUIRES_MANUAL_SOURCE_REVIEW",{
          plannedSymbol:task.symbol,selectedTaskKind,providerGETCount:0,
        });
    if(retained.sourceMinuteRows!==task.priorOriginalMinuteRows
      ||retained.missingUnverifiedSourceMinuteSlots
        !==task.missingUnverifiedMinuteSlots)
      return blocked(id,"RETRY_SOURCE_PLAN_OUTDATED",{
        plannedSymbol:task.symbol,selectedTaskKind,providerGETCount:0,
      });
  }else if(retained.status!=="BLOCKED_DATA"
    ||retained.reason!=="ARCHIVED_SESSION_NOT_FOUND") {
    const existing=retained.status==="BLOCKED_DATA"
      ?"EXISTING_ARCHIVE_REQUIRES_MANUAL_SOURCE_REVIEW"
      :retained.nativeMinuteSlotInventoryComplete===true
        ?"ALREADY_RETAINED_COMPLETE_1M_SOURCE"
        :"EXISTING_PARTIAL_SOURCE_NEEDS_EXPLICIT_RETRY";
    return blocked(id,existing,{
      plannedSymbol:task.symbol,selectedTaskKind,providerGETCount:0,
    });
  }
  if (!allowPublicReadOnlyFetch)
    return blocked(id,"EXPLICIT_PUBLIC_READ_ONLY_OPT_IN_REQUIRED",{
      plannedSymbol:task.symbol,expectedTaskDigestSha256,selectedTaskKind,
      permittedProvider:task.proposedProvider,
      reviewedExistingSourceDigestSha256:retryPartialSource
        ?retained.archiveSourceDigestSha256:null,
      reviewedExistingNativeMinuteCount:retryPartialSource
        ?retained.sourceMinuteRows:null,
      reviewSourceOnly:true,providerGETCount:0,
      publicGETAttempted:false,
    });
  const lockPath=join(root,".pit-native-minute-task.lock");
  let lock;
  try {
    lock=await open(lockPath,"wx",0o600);
    await lock.writeFile("PIT_RESEARCH_PUBLIC_GET_ONLY\n","utf8");
    await lock.sync();
  } catch(error) {
    // Lock creation must not strand a stale lock if writing/syncing fails.
    if(lock) {
      await lock.close();
      await unlink(lockPath);
    }
    if(error?.code==="EEXIST")
      return blocked(id,"ARCHIVE_WRITER_LOCK_HELD");
    throw error;
  }
  try {
    const before=await countArchiveBytes(root);
    const fs=await statfsImpl(root);
    if (!fs || !Number.isSafeInteger(fs.bavail)
      || !Number.isSafeInteger(fs.bsize)
      || fs.bavail<0 || fs.bsize<1)
      return blocked(id,"ARCHIVE_DISK_STAT_UNAVAILABLE");
    const free=BigInt(fs.bavail)*BigInt(fs.bsize);
    if(before+MAX_SINGLE_SOURCE_BYTES>maxLocalBytes)
      return blocked(id,"ARCHIVE_LOCAL_QUOTA_EXCEEDED",{
        existingArchiveBytes:before,maxLocalBytes,
      });
    if(free<BigInt(minFreeBytes+MAX_SINGLE_SOURCE_BYTES))
      return blocked(id,"ARCHIVE_MINIMUM_FREE_SPACE_NOT_MET",{
        existingArchiveBytes:before,maxLocalBytes,minFreeBytes,
      });
    const retrieved=await collectPITNativeCryptoMinuteSourceV1({
      root,market,symbol:task.symbol,
      dayStartMs:task.sessionStartMs,
      manifest,expectedRosterDigestSha256:plan.pitRosterDigestSha256,
      allowPublicReadOnlyFetch:true,retryPartialSource,
      allowSourceLimitedArchive,expectedExistingSourceDigestSha256,
      nowImpl,upbitFetchImpl,bitgetClient,
    });
    return Object.freeze({
      ...blocked(id,retrieved.reason??null,{
        plannedSymbol:task.symbol,taskDigestSha256:expectedTaskDigestSha256,
        selectedTaskKind,
        retainedSourceDigestSha256:
          retrieved.archiveSourceDigestSha256??null,
        retainedMinuteRows:retrieved.sourceMinuteCount??null,
        archiveWriterLockUsed:true,
        archiveBytesCheckedBeforeGet:before,
        maxLocalBytes,minFreeBytes,
      }),
      status:retrieved.status==="RETROSPECTIVE_PRIVATE_SOURCE_RETAINED_ONLY"
        ?"RETROSPECTIVE_SOURCE_STORED_WITHIN_LOCAL_BUDGET"
        :retrieved.status==="RETROSPECTIVE_IMMUTABLE_SUPERSET_AWAITING_REVISION_REVIEW"
          ?"RETROSPECTIVE_IMMUTABLE_SUPERSET_AWAITING_REVISION_REVIEW"
          :retrieved.status==="RETROSPECTIVE_SOURCE_LIMITED_RETAINED_REVIEW_ONLY"
            ?"RETROSPECTIVE_SOURCE_LIMITED_STORED_WITHIN_LOCAL_BUDGET"
            :"BLOCKED_DATA",
      sourceRevisionAutoSelected:false,
      sourceLimitedOnly:retrieved.sourceLimitedOnly??null,
      providerRequestWindowVerified:retrieved.providerRequestWindowVerified??null,
      missingUnverifiedMinuteSlots:retrieved.missingUnverifiedMinuteSlots??null,
      requestedProviderPages:retrieved.requestedProviderPages??null,
      allowSourceLimitedArchiveUsed:retrieved.allowSourceLimitedArchiveUsed??false,
      priorSourceDigestSha256:retrieved.priorSourceDigestSha256??null,
      reason:retrieved.reason??null,
      providerReadAuthorized:true,
    });
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
