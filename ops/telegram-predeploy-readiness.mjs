/**
 * Strict Telegram pre-production GO/NO-GO evidence evaluator.
 *
 * This file is pure and never deploys, sends messages, reads credentials,
 * touches Production, or grants trading/order authority. Its inputs MUST
 * originate from separately verified, same-SHA protected QA receipts:
 * an untrusted JSON file is not evidence provenance by itself.
 */
export const REQUIRED_CI_CONTEXTS = Object.freeze([
  'application-ci/verified',
  'browser-ui/verified',
  'database-rls/verified',
  'security-integration/verified',
  'ai-privacy/verified',
  'futures-public-network-smoke/verified',
]);
export const REQUIRED_ROOMS = Object.freeze([
  'KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES',
  'HOLDINGS', 'AUTO_TRADING',
]);
export const REQUIRED_MARKET_SIDES = Object.freeze([
  'KR_STOCK:BUY', 'US_STOCK:BUY', 'CRYPTO_SPOT:BUY',
  'CRYPTO_FUTURES:LONG', 'CRYPTO_FUTURES:SHORT',
]);
const SHA = /^[a-f0-9]{40}$/u;
const MAX_CLOCK_SKEW_MS = 5_000;
const MAX_QA_AGE_MS = 30 * 60_000;
const MAX_TLS_LAST_AGE_MS = 10 * 60_000;
const MIN_TLS_GAP_MS = 5 * 60_000;
const MAX_SNAPSHOT_AGE_MS = 15 * 60_000;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const validSha = x => typeof x === 'string' && SHA.test(x);
const inWindow = (timestamp,now,age) => Number.isFinite(Date.parse(timestamp))
  && Date.parse(timestamp) <= now + MAX_CLOCK_SKEW_MS
  && now - Date.parse(timestamp) <= age;
const distinctExactly = (provided, expected) => Array.isArray(provided)
  && provided.length === expected.length
  && provided.every(x => typeof x === 'string')
  && new Set(provided).size === expected.length
  && expected.every(x => provided.includes(x));

export function evaluateTelegramPredeploy(evidence,{expectedSha,nowMs}={}) {
  const blockers = [];
  const block = code => { if (!blockers.includes(code)) blockers.push(code); };
  if (!validSha(expectedSha) || !Number.isSafeInteger(nowMs) || nowMs <= 0) {
    return Object.freeze({status:'NO_GO',blockers:['INVALID_TARGET_OR_CLOCK'],
      productionApproved:false,actualMessagesVerified:false});
  }
  if (!object(evidence) || evidence.sourceSha !== expectedSha) {
    return Object.freeze({status:'NO_GO',blockers:['SOURCE_EVIDENCE_MISSING_OR_MISMATCH'],
      productionApproved:false,actualMessagesVerified:false});
  }

  const ci = evidence.ci;
  if (!object(ci) || ci.headSha !== expectedSha
    || ci.fullRunCompleted !== true || ci.fullRunConclusion !== 'success'
    || !object(ci.statuses)
    || !REQUIRED_CI_CONTEXTS.every(key => ci.statuses[key] === 'success')) {
    block('CI_6_OF_6_NOT_PROVEN');
  }

  const staging = evidence.staging;
  if (!object(staging) || staging.runtimeSha !== expectedSha
    || staging.markerSha !== expectedSha || staging.healthSha !== expectedSha
    || staging.identityMatch !== true || staging.pm2Online !== true
    || staging.releaseReady !== true || staging.postgresAuth !== true
    || staging.dbReadOnly === false || staging.protectedReceipt !== true
    || !Number.isSafeInteger(staging.runId) || staging.runId <= 0
    || !inWindow(staging.checkedAt,nowMs,MAX_QA_AGE_MS)) {
    block('STAGING_SAME_SHA_READINESS_NOT_PROVEN');
  }

  const probes = staging?.tlsProbes;
  const validProbes = Array.isArray(probes) && probes.length >= 2
    && probes.length <= 12
    && probes.every(x => object(x)
      && typeof x.code === 'string'
      && inWindow(x.checkedAt,nowMs,MAX_QA_AGE_MS));
  if (!validProbes) {
    block('TELEGRAM_TLS_RELIABILITY_NOT_PROVEN');
  } else {
    const sorted = [...probes].sort((a,b)=>Date.parse(a.checkedAt)-Date.parse(b.checkedAt));
    const reliable = sorted.every(x => x.code === 'IPV4_TLS_READY')
      && inWindow(sorted.at(-1).checkedAt,nowMs,MAX_TLS_LAST_AGE_MS)
      && Date.parse(sorted.at(-1).checkedAt)-Date.parse(sorted[0].checkedAt)>=MIN_TLS_GAP_MS;
    if (!reliable) block('TELEGRAM_TLS_RELIABILITY_NOT_PROVEN');
  }

  const v3 = evidence.signalV3;
  if (!object(v3)
    || !validSha(v3.serviceSha)
    || v3.healthStatus !== 'READY'
    || v3.getHttpStatus !== 200 || v3.snapshotReady !== true
    || v3.snapshotFresh !== true
    || !Number.isSafeInteger(v3.snapshotAgeMs)
    || v3.snapshotAgeMs < 0 || v3.snapshotAgeMs > MAX_SNAPSHOT_AGE_MS) {
    block('SIGNAL_V3_STALE_OR_HTTP_503');
  }
  if (!object(v3) || v3.serverUnit !== 'ACTIVE'
    || v3.timerUnit !== 'ACTIVE'
    || v3.lastCycleResult !== 'SUCCEEDED'
    || !inWindow(v3.lastCycleAt,nowMs,MAX_SNAPSHOT_AGE_MS)) {
    block('SIGNAL_V3_CYCLE_NOT_PROVEN');
  }

  const dryRun = evidence.stagingDryRun;
  if (!object(dryRun) || dryRun.headSha !== expectedSha
    || dryRun.exactMockOnly !== true || dryRun.botApiSends !== 0
    || dryRun.dbWrites !== 0 || dryRun.privateApiCalls !== 0
    || dryRun.realOrderCalls !== 0
    || !distinctExactly(dryRun.roomRoutes,REQUIRED_ROOMS)
    || !distinctExactly(dryRun.marketSides,REQUIRED_MARKET_SIDES)
    || dryRun.personal403RelinkPass !== true
    || dryRun.dedupePass !== true
    || dryRun.briefSchedulePass !== true
    || dryRun.alertFormattingPass !== true
    || dryRun.signalToDeliveryPass !== true) {
    block('TELEGRAM_SIX_ROOM_DRY_RUN_NOT_PROVEN');
  }

  const credentials = evidence.readOnlyPermissions;
  if (!object(credentials) || credentials.botIdentityValid !== true
    || credentials.sixRoomPostingPermissionsValid !== true
    || credentials.noBotApiSends !== true
    || credentials.noCredentialChanges !== true
    || !inWindow(credentials.checkedAt,nowMs,MAX_QA_AGE_MS)) {
    block('TELEGRAM_READ_ONLY_PERMISSIONS_NOT_PROVEN');
  }

  if (!object(evidence.safety)
    || evidence.safety.executionAuthority !== 'NONE'
    || evidence.safety.liveTradingEnabled !== false
    || evidence.safety.orderActions !== 0
    || evidence.safety.transfers !== 0
    || evidence.safety.withdrawals !== 0
    || evidence.safety.productionDatabaseWrites !== 0
    || evidence.safety.proofSends !== 0) {
    block('SAFETY_BOUNDARY_NOT_PROVEN');
  }
  // A green predeploy evaluation is NEVER a Production or Bot API send approval.
  return Object.freeze({ status:blockers.length?'NO_GO':'GO_FOR_HUMAN_REVIEW',
    blockers:Object.freeze(blockers),productionApproved:false,
    actualMessagesVerified:false });
}
