import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateTelegramBatchRelease } from '../../ops/telegram-batch-release-verdict.mjs';
const sha='a'.repeat(40),hash='b'.repeat(64);
const now=Date.parse('2026-10-13T01:00:00Z'),date=new Date(now-1000).toISOString();
const rooms=['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES','AUTO_TRADING','HOLDINGS'];
const marketSides=['KR_STOCK:BUY','US_STOCK:BUY','CRYPTO_SPOT:BUY','CRYPTO_FUTURES:LONG','CRYPTO_FUTURES:SHORT'];
const ciKeys=['application-ci/verified','browser-ui/verified','database-rls/verified',
  'security-integration/verified','ai-privacy/verified','futures-public-network-smoke/verified'];
function fixture() {
 return {
  sha,
  release:{candidateSha:sha,latestMainSha:sha,immutableSourceVerified:true,
    independentTelegramOnlyScope:true},
  permissions:{ipv4TlsReliable:true,botGetMeVerified:true,
    allSixRoomPostingRightsVerified:true,roomIdsUniqueVerified:true,
    noCurrentForbidden403:true,rateLimitBackoffVerified:true,checkedAt:date},
  operations:{aiWatchMigratedSafely:true,allFourSendersOwnedByOneProcess:true,
    noInFlightLegacyPosts:true,durableLedgerFsyncAndRollbackVerified:true,
    diskAndPermissionsAdequate:true,sharedDeploymentLockVerified:true,
    manualLivePreservedDuringCutover:true,restartAndRecoveryProbePassed:true},
  ci:{sha,completed:true,fullConclusion:'success',runId:1,
    statuses:Object.fromEntries(ciKeys.map(k=>[k,'success']))},
  staging:{sha,releaseReady:true,authAndRlsReady:true,paperHoldingsHttp400Resolved:true,
    telegramMockPassed:true,protected:true,runId:2,checkedAt:date},
  signalV3:{http:200,snapshotFresh:true,cycleSucceeded:true,canonicalDataReady:true,
    sourceSha:sha,observedAt:date},
  delivery:{rooms,marketSides,botAcceptedAllRooms:true,personalSentReceipt:true,
    memberOwnershipVerified:true,dedupeVerified:true,fillToJournalToTelegramVerified:true,
    uncertainSendNotReplayed:true,aiWatchDurableDedupeVerified:true,
    aiWatchMigrationApproved:true,observedAt:date},
  cutover:{isolatedWorkerInstalled:true,leaseOwnerUnique:true,oldTelegramWorkersOff:true,
    persistedLedgerPreserved:true,recoveryVerified:true,productionSha:sha,checkedAt:date},
  safety:{tradingRuntimeBeforeHash:hash,tradingRuntimeAfterHash:hash,telegramTriggeredOrders:0,
    telegramTriggeredCancels:0,telegramTriggeredAmendments:0,telegramTriggeredTransfers:0,
    telegramTriggeredWithdrawals:0,telegramChangedTradingFlags:false},
 };
}
test('all structural proofs still require protected approval, not real-send proof',()=>{
 const v=evaluateTelegramBatchRelease(fixture(),{expectedSha:sha,nowMs:now});
 assert.equal(v.status,'GO_FOR_PROTECTED_HUMAN_REVIEW');
 assert.equal(v.productionApproved,false);
 assert.equal(v.tradingActivated,false);
 assert.equal(v.humanReceiptProven,false);
});
test('one run inventories every blocker without repeated Full CI',()=>{
 assert.deepEqual(evaluateTelegramBatchRelease({sha},{expectedSha:sha,nowMs:now}).blockers,[
  'RELEASE_MAIN_DRIFT_OR_SCOPE_UNPROVEN',
  'TELEGRAM_RIGHTS_TLS_403_OR_RATE_LIMIT_BLOCKED',
  'FOUR_WORKERS_STORAGE_AND_ROLLBACK_UNPROVEN',
  'EXACT_HEAD_FULL_CI_MISSING',
  'STAGING_FULL_AND_TELEGRAM_QA_MISSING',
  'SIGNAL_V3_503_OR_STALE',
  'SIX_ROOM_PERSONAL_TRADE_EVENT_EVIDENCE_MISSING',
  'ISOLATED_TG_SINGLE_WRITER_CUTOVER_NOT_PROVEN',
  'LIVE_TRADING_PRESERVATION_NOT_PROVEN',
 ]);
});
test('each independent weakness is NO_GO, never quietly skipped',()=>{
 for(const [change,reason] of [
  [x=>x.release.latestMainSha='c'.repeat(40),'RELEASE_MAIN_DRIFT_OR_SCOPE_UNPROVEN'],
  [x=>x.permissions.noCurrentForbidden403=false,'TELEGRAM_RIGHTS_TLS_403_OR_RATE_LIMIT_BLOCKED'],
  [x=>x.permissions.ipv4TlsReliable=false,'TELEGRAM_RIGHTS_TLS_403_OR_RATE_LIMIT_BLOCKED'],
  [x=>x.operations.allFourSendersOwnedByOneProcess=false,'FOUR_WORKERS_STORAGE_AND_ROLLBACK_UNPROVEN'],
  [x=>x.operations.sharedDeploymentLockVerified=false,'FOUR_WORKERS_STORAGE_AND_ROLLBACK_UNPROVEN'],
  [x=>x.operations.restartAndRecoveryProbePassed=false,'FOUR_WORKERS_STORAGE_AND_ROLLBACK_UNPROVEN'],
  [x=>x.ci.statuses['browser-ui/verified']='failure','EXACT_HEAD_FULL_CI_MISSING'],
  [x=>x.staging.paperHoldingsHttp400Resolved=false,'STAGING_FULL_AND_TELEGRAM_QA_MISSING'],
  [x=>x.signalV3.http=503,'SIGNAL_V3_503_OR_STALE'],
  [x=>x.delivery.personalSentReceipt=false,'SIX_ROOM_PERSONAL_TRADE_EVENT_EVIDENCE_MISSING'],
  [x=>x.delivery.aiWatchMigrationApproved=false,'SIX_ROOM_PERSONAL_TRADE_EVENT_EVIDENCE_MISSING'],
  [x=>x.delivery.aiWatchDurableDedupeVerified=false,'SIX_ROOM_PERSONAL_TRADE_EVENT_EVIDENCE_MISSING'],
  [x=>x.cutover.oldTelegramWorkersOff=false,'ISOLATED_TG_SINGLE_WRITER_CUTOVER_NOT_PROVEN'],
  [x=>x.safety.telegramTriggeredOrders=1,'LIVE_TRADING_PRESERVATION_NOT_PROVEN'],
 ]){const x=fixture();change(x);const v=evaluateTelegramBatchRelease(x,{expectedSha:sha,nowMs:now});
   assert.equal(v.status,'NO_GO');assert.ok(v.blockers.includes(reason));}
});
test('stale and mismatched-SHA protected readings are never borrowed',()=>{
 const x=fixture();
 x.staging.checkedAt=new Date(now-3600000).toISOString();
 x.signalV3.sourceSha='c'.repeat(40);
 x.cutover.productionSha='c'.repeat(40);
 const v=evaluateTelegramBatchRelease(x,{expectedSha:sha,nowMs:now});
 assert.ok(v.blockers.includes('STAGING_FULL_AND_TELEGRAM_QA_MISSING'));
 assert.ok(v.blockers.includes('SIGNAL_V3_503_OR_STALE'));
 assert.ok(v.blockers.includes('ISOLATED_TG_SINGLE_WRITER_CUTOVER_NOT_PROVEN'));
 assert.equal(evaluateTelegramBatchRelease(x,{expectedSha:'bad',nowMs:now}).status,'NO_GO');
});
