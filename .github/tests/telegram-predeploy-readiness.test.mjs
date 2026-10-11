import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTelegramPredeploy, REQUIRED_CI_CONTEXTS,
  REQUIRED_ROOMS, REQUIRED_MARKET_SIDES } from '../../ops/telegram-predeploy-readiness.mjs';

const now = Date.parse('2026-10-11T03:45:00.000Z');
const sha = 'a'.repeat(40);
const serviceSha = 'b'.repeat(40);
const at = offset => new Date(now-offset).toISOString();
const valid = () => ({
  sourceSha:sha,
  ci:{headSha:sha,fullRunCompleted:true,fullRunConclusion:'success',
    statuses:Object.fromEntries(REQUIRED_CI_CONTEXTS.map(key=>[key,'success']))},
  staging:{runtimeSha:sha,markerSha:sha,healthSha:sha,identityMatch:true,
    pm2Online:true,releaseReady:true,postgresAuth:true,dbReadOnly:true,
    protectedReceipt:true,runId:12345,checkedAt:at(60_000),
    tlsProbes:[{checkedAt:at(8*60_000),code:'IPV4_TLS_READY'},
      {checkedAt:at(60_000),code:'IPV4_TLS_READY'}]},
  signalV3:{serviceSha,healthStatus:'READY',getHttpStatus:200,
    snapshotReady:true,snapshotFresh:true,snapshotAgeMs:60_000,
    serverUnit:'ACTIVE',timerUnit:'ACTIVE',lastCycleResult:'SUCCEEDED',
    lastCycleAt:at(60_000)},
  stagingDryRun:{headSha:sha,exactMockOnly:true,
    roomRoutes:[...REQUIRED_ROOMS],marketSides:[...REQUIRED_MARKET_SIDES],
    botApiSends:0,dbWrites:0,privateApiCalls:0,realOrderCalls:0,
    personal403RelinkPass:true,dedupePass:true,briefSchedulePass:true,
    alertFormattingPass:true,signalToDeliveryPass:true},
  readOnlyPermissions:{botIdentityValid:true,
    sixRoomPostingPermissionsValid:true,noBotApiSends:true,
    noCredentialChanges:true,checkedAt:at(60_000)},
  safety:{executionAuthority:'NONE',liveTradingEnabled:false,orderActions:0,
    transfers:0,withdrawals:0,productionDatabaseWrites:0,proofSends:0},
});
const check = evidence => evaluateTelegramPredeploy(evidence,{expectedSha:sha,nowMs:now});
const rejected=(mutate,code)=>{
  const evidence=valid();mutate(evidence);
  const verdict=check(evidence);
  assert.equal(verdict.status,'NO_GO');
  assert.ok(verdict.blockers.includes(code),verdict.blockers.join(','));
  assert.equal(verdict.productionApproved,false);
  assert.equal(verdict.actualMessagesVerified,false);
};

test('even fully proven predeploy GO cannot authorize Production or claim real sends',()=>{
  const result=check(valid());
  assert.equal(result.status,'GO_FOR_HUMAN_REVIEW');
  assert.deepEqual(result.blockers,[]);
  assert.equal(result.productionApproved,false);
  assert.equal(result.actualMessagesVerified,false);
});

test('existing real-world failures block deployment despite CI 6/6 green',()=>{
  rejected(x=>{x.signalV3.healthStatus='SNAPSHOT_STALE';
    x.signalV3.snapshotFresh=false;x.signalV3.getHttpStatus=503;},
    'SIGNAL_V3_STALE_OR_HTTP_503');
  rejected(x=>{x.staging.tlsProbes[1].code='IPV4_TLS_TIMEOUT';},
    'TELEGRAM_TLS_RELIABILITY_NOT_PROVEN');
  rejected(x=>{x.staging.tlsProbes[1].code='IPV4_TCP_TIMEOUT';},
    'TELEGRAM_TLS_RELIABILITY_NOT_PROVEN');
  rejected(x=>{x.signalV3.lastCycleResult='FAILED';},
    'SIGNAL_V3_CYCLE_NOT_PROVEN');
});

test('missing, stale, mismatched, or incomplete evidence fails closed',()=>{
  const missing=check(null);
  assert.equal(missing.status,'NO_GO');
  rejected(x=>{x.ci.statuses['database-rls/verified']='pending';},'CI_6_OF_6_NOT_PROVEN');
  rejected(x=>{x.ci.headSha=serviceSha;},'CI_6_OF_6_NOT_PROVEN');
  rejected(x=>{x.staging.runtimeSha=serviceSha;},'STAGING_SAME_SHA_READINESS_NOT_PROVEN');
  rejected(x=>{x.staging.protectedReceipt=false;},'STAGING_SAME_SHA_READINESS_NOT_PROVEN');
  rejected(x=>{x.staging.checkedAt=at(45*60_000);},'STAGING_SAME_SHA_READINESS_NOT_PROVEN');
  rejected(x=>{x.staging.tlsProbes[1].checkedAt=at(6*60_000);},
    'TELEGRAM_TLS_RELIABILITY_NOT_PROVEN');
  rejected(x=>{x.signalV3.snapshotAgeMs=901_000;},'SIGNAL_V3_STALE_OR_HTTP_503');
  rejected(x=>{x.signalV3.lastCycleAt=at(20*60_000);},'SIGNAL_V3_CYCLE_NOT_PROVEN');
});

test('all six rooms, five market-direction lanes, 403 and dedupe mock proofs are mandatory',()=>{
  rejected(x=>{x.stagingDryRun.roomRoutes.pop();},'TELEGRAM_SIX_ROOM_DRY_RUN_NOT_PROVEN');
  rejected(x=>{x.stagingDryRun.marketSides.pop();},'TELEGRAM_SIX_ROOM_DRY_RUN_NOT_PROVEN');
  rejected(x=>{x.stagingDryRun.roomRoutes[0]=x.stagingDryRun.roomRoutes[1];},
    'TELEGRAM_SIX_ROOM_DRY_RUN_NOT_PROVEN');
  rejected(x=>{x.stagingDryRun.personal403RelinkPass=false;},
    'TELEGRAM_SIX_ROOM_DRY_RUN_NOT_PROVEN');
  rejected(x=>{x.stagingDryRun.dedupePass=false;},
    'TELEGRAM_SIX_ROOM_DRY_RUN_NOT_PROVEN');
  rejected(x=>{x.stagingDryRun.botApiSends=1;},
    'TELEGRAM_SIX_ROOM_DRY_RUN_NOT_PROVEN');
  rejected(x=>{x.readOnlyPermissions.sixRoomPostingPermissionsValid=false;},
    'TELEGRAM_READ_ONLY_PERMISSIONS_NOT_PROVEN');
});

test('release authority must remain NONE and no financial or DB mutations',()=>{
  rejected(x=>{x.safety.executionAuthority='LIVE';},'SAFETY_BOUNDARY_NOT_PROVEN');
  rejected(x=>{x.safety.orderActions=1;},'SAFETY_BOUNDARY_NOT_PROVEN');
  rejected(x=>{x.safety.proofSends=1;},'SAFETY_BOUNDARY_NOT_PROVEN');
  rejected(x=>{x.safety.productionDatabaseWrites=1;},'SAFETY_BOUNDARY_NOT_PROVEN');
});

test('no secrets or inputs ever appear in bounded blocker report',()=>{
  const secret='BOT_TOKEN_DO_NOT_PUBLISH';
  const x=valid();
  x.privateToken=secret;
  x.signalV3.healthStatus='SNAPSHOT_STALE';
  x.signalV3.privateError=secret;
  const report=JSON.stringify(check(x));
  assert.ok(!report.includes(secret));
  assert.ok(!report.includes('03:'));
  assert.ok(!report.includes('198.51.100'));
});

test('invalid clocks, timestamps and untrusted evidence do not auto-approve',()=>{
  assert.equal(evaluateTelegramPredeploy(valid(),{
    expectedSha:'bad',nowMs:now}).status,'NO_GO');
  assert.equal(evaluateTelegramPredeploy(valid(),{
    expectedSha:sha,nowMs:NaN}).status,'NO_GO');
  rejected(x=>{x.staging.tlsProbes[0].checkedAt='PRIVATE_BAD_DATE';},
    'TELEGRAM_TLS_RELIABILITY_NOT_PROVEN');
  rejected(x=>{x.readOnlyPermissions.checkedAt='2025-01-01T00:00:00Z';},
    'TELEGRAM_READ_ONLY_PERMISSIONS_NOT_PROVEN');
});
