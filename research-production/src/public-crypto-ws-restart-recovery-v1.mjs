// Pure source-only restart assessment from an existing immutable private
// provisional WS sidecar. NO SOCKET/REST call, no bar fabrication, no
// economic evidence or automatic expiry of preexisting REST audit debt.
import {readPublicWsProvisionalBatchV1} from './public-crypto-ws-sidecar-v1.mjs';
import {PUBLIC_WS_SIDECAR_CONTRACT} from './public-crypto-ws-sidecar-v1.mjs';

export const PUBLIC_WS_RESTART_RECOVERY_CONTRACT=
  'research-public-ws-restart-recovery/v1';
const markets=new Set(['CRYPTO_SPOT','CRYPTO_FUTURES']);
const int=v=>Number.isSafeInteger(v)&&v>0;
const fail=code=>{throw new TypeError(code);};
const authority=()=>({
  inferredNoTradeMinutes:0,syntheticCandlesCreated:0,
  websocketConnectionsOpened:0,publicProviderGETCount:0,
  archiveFilesWritten:0,originalMinuteProof:false,
  independentPITProven:false,independentOosProven:false,
  paperAdmissionAllowed:false,profitabilityProven:false,
  executionAuthority:'NONE',
});
export async function planPublicWsRestartRecoveryV1({
  enabled=false,root,market,socketDigest,producerSha,startMs,endMs,
  expectedSymbols,resumeAtMs=Date.now(),maxRestWindowMinutes=120,
}={}){
  if(!enabled)return Object.freeze({
    contract:PUBLIC_WS_RESTART_RECOVERY_CONTRACT,
    status:'DISABLED',sourceAudits:Object.freeze([]),...authority(),
  });
  if(!markets.has(market)||!Array.isArray(expectedSymbols)
    ||!expectedSymbols.length||expectedSymbols.length>40
    ||!int(resumeAtMs)||resumeAtMs<endMs+5_000
    ||![120,180].includes(maxRestWindowMinutes))
    fail('WS_RESTART_INPUT_INVALID');
  const validSymbol=market==='CRYPTO_SPOT'
    ?/^[A-Z0-9]{1,20}$/u
    :/^[A-Z0-9\p{Script=Han}]{1,26}USDT$/u;
  if(expectedSymbols.some(s=>typeof s!=='string'||!validSymbol.test(s))
    ||new Set(expectedSymbols).size!==expectedSymbols.length)
    fail('WS_RESTART_SYMBOLS_INVALID');
  let sealed;
  try {
    sealed=await readPublicWsProvisionalBatchV1({
      root,market,socketDigest,producerSha,startMs,endMs,
    });
  }catch(e) {
    if(e?.code!=='ENOENT')throw e;
    sealed={status:'NO_PROVISIONAL_SIDECAR'};
  }
  if(sealed.status==='NO_PROVISIONAL_SIDECAR')
    return Object.freeze({
      contract:PUBLIC_WS_RESTART_RECOVERY_CONTRACT,
      status:'HOLD_SIDECAR_NOT_FOUND',
      sourceAudits:Object.freeze([]),
      possibleOutageFromMs:startMs,
      possibleOutageToMs:resumeAtMs,
      sourceDataUnproven:true,requiresIndependentRest:true,
      ...authority(),
    });
  if(sealed.contract!==PUBLIC_WS_SIDECAR_CONTRACT
    ||sealed.status!=='PROVISIONAL_READBACK_ONLY'
    ||!Array.isArray(sealed.observations)
    ||sealed.executionAuthority!=='NONE')
    fail('WS_RESTART_SIDECAR_UNTRUSTED');
  const closeUntil=Math.floor((resumeAtMs-5_000)/60_000)*60_000;
  const records=new Map();
  for(const o of sealed.observations){
    if(o.market!==market||!expectedSymbols.includes(o.symbol)
      ||!int(o.timestamp)||o.timestamp%60_000
      ||o.timestamp<startMs||o.timestamp>=endMs
      ||!int(o.lastObservedAtMs)||o.lastObservedAtMs>resumeAtMs+5_000)
      fail('WS_RESTART_OBSERVATION_OUT_OF_SCOPE');
    const older=records.get(o.symbol);
    if(!older||o.timestamp>older.timestamp)
      records.set(o.symbol,o);
  }
  const audits=[];
  for(const symbol of expectedSymbols){
    const last=records.get(symbol);
    // The last provisional minute may never have been REST confirmed.
    // Start from that candle itself (not the following minute).
    const fromMs=last?.timestamp??startMs;
    const toExclusiveMs=Math.min(closeUntil,
      fromMs+maxRestWindowMinutes*60_000);
    if(toExclusiveMs<=fromMs)continue;
    audits.push(Object.freeze({
      market,symbol,fromMs,toExclusiveMs,
      requestedEndExclusiveMs:closeUntil,
      unverifiedBeyondCap:toExclusiveMs<closeUntil,
      lastWebsocketMinuteMs:last?.timestamp??null,
      lastProvisionalReceiptMs:last?.lastObservedAtMs??null,
      missingFromSidecar:last==null,
      historicalBeforeSidecarUnverified:true,
      needsRestReadback:true,
      sourceVerified:false,noTradeIndependentlyCertified:false,
      ...authority(),
    }));
  }
  return Object.freeze({
    contract:PUBLIC_WS_RESTART_RECOVERY_CONTRACT,
    status:audits.length?'RESTART_REST_SOURCE_AUDITS_REQUIRED'
      :'NO_CLOSED_MINUTES_YET',
    sourceAudits:Object.freeze(audits),
    market,expectedSymbolCount:expectedSymbols.length,
    symbolsWithProvisionalObservations:records.size,
    cutoffMinuteMs:closeUntil,
    resumeAtMs,sidecarDigest:sealed.payloadDigest,
    sourceOnly:true,operatorMustApproveRestCalls:true,
    ...authority(),
  });
}
