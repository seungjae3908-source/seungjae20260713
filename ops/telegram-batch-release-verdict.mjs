/** Aggregated single-batch GO/NO-GO based on authenticated protected receipts.
 * Offline evaluator ONLY. No Bot call, DB, PM2, finance mutation or deploy.
 * A fixture that passes never authorizes a release.
 */
const SHA=/^[0-9a-f]{40}$/u;
const HASH=/^[0-9a-f]{64}$/u;
const ROOMS=['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES','AUTO_TRADING','HOLDINGS'];
const MARKET_SIDES=['KR_STOCK:BUY','US_STOCK:BUY','CRYPTO_SPOT:BUY','CRYPTO_FUTURES:LONG','CRYPTO_FUTURES:SHORT'];
const REQUIRED_CI=['application-ci/verified','browser-ui/verified','database-rls/verified',
  'security-integration/verified','ai-privacy/verified','futures-public-network-smoke/verified'];
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exactly=(given,expected)=>Array.isArray(given)&&given.length===expected.length
  &&new Set(given).size===expected.length&&expected.every(x=>given.includes(x));
export function evaluateTelegramBatchRelease(receipt,{expectedSha,nowMs}={}) {
  const blockers=[];
  const block=code=>{if(!blockers.includes(code))blockers.push(code);};
  if(!SHA.test(String(expectedSha))||!Number.isSafeInteger(nowMs)||nowMs<=0
    ||!object(receipt)||receipt.sha!==expectedSha) {
    return Object.freeze({status:'NO_GO',blockers:Object.freeze(['INVALID_OR_UNBOUND_BATCH_RECEIPT']),
      productionApproved:false,tradingActivated:false,humanReceiptProven:false});
  }
  const recent=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))
    &&Date.parse(value)<=nowMs+5000&&nowMs-Date.parse(value)<=30*60_000;
  const ci=receipt.ci;
  if(!object(ci)||ci.sha!==expectedSha||ci.fullConclusion!=='success'
    ||ci.completed!==true||!Number.isSafeInteger(ci.runId)||ci.runId<=0
    ||!object(ci.statuses)||!REQUIRED_CI.every(key=>ci.statuses[key]==='success'))
    block('EXACT_HEAD_FULL_CI_MISSING');
  const staging=receipt.staging;
  if(!object(staging)||staging.sha!==expectedSha||staging.releaseReady!==true
    ||staging.authAndRlsReady!==true||staging.paperHoldingsHttp400Resolved!==true
    ||staging.telegramMockPassed!==true||staging.protected!==true
    ||!Number.isSafeInteger(staging.runId)||staging.runId<=0||!recent(staging.checkedAt))
    block('STAGING_FULL_AND_TELEGRAM_QA_MISSING');
  const source=receipt.signalV3;
  if(!object(source)||source.http!==200||source.snapshotFresh!==true
    ||source.cycleSucceeded!==true||source.canonicalDataReady!==true
    ||source.sourceSha!==expectedSha||!recent(source.observedAt))
    block('SIGNAL_V3_503_OR_STALE');
  const delivery=receipt.delivery;
  if(!object(delivery)||!exactly(delivery.rooms,ROOMS)
    ||!exactly(delivery.marketSides,MARKET_SIDES)
    ||delivery.botAcceptedAllRooms!==true||delivery.personalSentReceipt!==true
    ||delivery.memberOwnershipVerified!==true||delivery.dedupeVerified!==true
    ||delivery.fillToJournalToTelegramVerified!==true||delivery.uncertainSendNotReplayed!==true
    ||!recent(delivery.observedAt))block('SIX_ROOM_PERSONAL_TRADE_EVENT_EVIDENCE_MISSING');
  const cutover=receipt.cutover;
  if(!object(cutover)||cutover.isolatedWorkerInstalled!==true
    ||cutover.leaseOwnerUnique!==true||cutover.oldTelegramWorkersOff!==true
    ||cutover.persistedLedgerPreserved!==true||cutover.recoveryVerified!==true
    ||cutover.productionSha!==expectedSha||!recent(cutover.checkedAt))
    block('ISOLATED_TG_SINGLE_WRITER_CUTOVER_NOT_PROVEN');
  const safety=receipt.safety;
  if(!object(safety)||!HASH.test(String(safety.tradingRuntimeBeforeHash))
    ||safety.tradingRuntimeBeforeHash!==safety.tradingRuntimeAfterHash
    ||safety.telegramTriggeredOrders!==0||safety.telegramTriggeredCancels!==0
    ||safety.telegramTriggeredAmendments!==0||safety.telegramTriggeredTransfers!==0
    ||safety.telegramTriggeredWithdrawals!==0||safety.telegramChangedTradingFlags!==false)
    block('LIVE_TRADING_PRESERVATION_NOT_PROVEN');
  return Object.freeze({status:blockers.length?'NO_GO':'GO_FOR_PROTECTED_HUMAN_REVIEW',
    blockers:Object.freeze(blockers),productionApproved:false,
    tradingActivated:false,humanReceiptProven:false});
}
