/**
 * Telegram release Signal V3 public-only preflight.
 * Pure data verification + optional bounded loopback/systemd reads.
 * Never calls external networks, PM2 actions, Bot API, database or broker APIs.
 * In SSH mode, stdout contains only a fixed PASS/NO_GO label.
 */
import { execFileSync } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { readFileSync } from 'node:fs';

const MARKETS = Object.freeze(['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']);
const MODES = Object.freeze([
  {strategy:'SCALPING',timeframe:'15m'},
  {strategy:'SWING',timeframe:'60m'},
  {strategy:'MID_LONG',timeframe:'1D'},
]);
const SOURCES = new Set([
  'krx-symbol-master','finnhub-symbol-master',
  'nasdaq-trader-public-directory','upbit-public','bitget-public',
]);
const allowedStatuses = new Set(['VALID_NO_TRADE','CANDIDATES_AVAILABLE']);
const nonNegative = x => Number.isSafeInteger(x) && x >= 0;

/** All 12 source-backed lanes must have complete, zero-error public samples.
 * A new generatedAt timestamp alone is NOT real source freshness.
 */
export function verifiedSignalV3Coverage(snapshot) {
  if (!snapshot || typeof snapshot !== 'object'
    || snapshot.publicDataOnly !== true
    || snapshot.profile?.fullStrategyCoverage !== true
    || !Array.isArray(snapshot.coverage) || snapshot.coverage.length !== 12)
    return false;
  const expected = new Set(MARKETS.flatMap(m =>
    MODES.map(mode=>[m,mode.strategy,mode.timeframe].join('|'))));
  const seen = new Set();
  for(const row of snapshot.coverage) {
    if (!row || typeof row !== 'object')return false;
    const key=[row.market,row.strategy,row.timeframe].join('|');
    if(!expected.has(key)||seen.has(key))return false;
    seen.add(key);
    if(!allowedStatuses.has(row.status)
      ||!SOURCES.has(row.universeSource)
      ||row.universePartial!==false
      ||row.universeStale!==false
      ||row.responseDataState!=='complete'
      ||!nonNegative(row.totalUniverse)||row.totalUniverse===0
      ||!nonNegative(row.scannedCards)
      ||!nonNegative(row.retainedFromBatch)
      ||row.universeProviderErrors!==0
      ||row.providerErrors!==0
      ||row.timeouts!==0
      ||(row.status==='VALID_NO_TRADE'&&row.scannedCards!==0)
      ||(row.status==='CANDIDATES_AVAILABLE'&&row.scannedCards<1))return false;
  }
  return seen.size===12;
}

function safeResult(ok,code) {
  return Object.freeze({ok,code});
}
const SAFE_READY = 'TELEGRAM_PREDEPLOY_SIGNAL_V3_FRESH_PASS';
const SAFE_BLOCK = 'TELEGRAM_PREDEPLOY_SIGNAL_V3_NOT_READY';

export function classifySignalV3HealthAndSource(health,signals,nowMs=Date.now()){
  if (!health||!signals||!Number.isFinite(nowMs)||nowMs<=0
    ||health.ok!==true||health.service!=='signal-intelligence-v3'
    ||health.executionAuthority!=='NONE'
    ||health.privateTradingApiAllowed!==false||health.realOrderAllowed!==false
    ||health.snapshotReady!==true||health.snapshotFresh!==true
    ||!Number.isFinite(health.snapshotAgeMs)||health.snapshotAgeMs<0
    ||health.snapshotAgeMs>15*60_000
    ||!/^[a-f0-9]{40}$/u.test(String(health.serviceSha||'')))
    return safeResult(false,SAFE_BLOCK);
  const snap=signals.snapshot;
  const gen=Date.parse(snap?.generatedAt||'');
  const generatedAgeMs=nowMs-gen;
  if(signals.ok!==true||signals.executionAuthority!=='NONE'
    ||signals.serviceSha!==health.serviceSha
    ||snap?.serviceSha!==health.serviceSha
    ||snap?.safety?.executionAuthority!=='NONE'
    ||snap?.safety?.privateTradingApiAllowed!==false
    ||snap?.safety?.realOrderAllowed!==false
    ||!Array.isArray(snap.events)||snap.events.length>10000
    ||!Number.isFinite(gen)||generatedAgeMs< -5000
    ||generatedAgeMs>15*60_000
    ||Math.abs(generatedAgeMs-health.snapshotAgeMs)>2*60_000
    ||!verifiedSignalV3Coverage(snap))
    return safeResult(false,SAFE_BLOCK);
  return safeResult(true,SAFE_READY);
}

const V3_SERVER = 'investment-signal-intelligence-v3.service';
const V3_TIMER = 'investment-signal-intelligence-v3-cycle.timer';
const V3_CYCLE = 'investment-signal-intelligence-v3-cycle.service';
function unitProperties(unit,propertyList,execImpl) {
  try{
    const data=execImpl('systemctl',
      ['show','--no-pager','--property='+propertyList.join(','),unit],
      {encoding:'utf8',timeout:3500,maxBuffer:8192,stdio:['ignore','pipe','pipe']});
    if(typeof data!=='string'||data.length>8192)return null;
    const lines=data.split(/\r?\n/u), projected={};
    for(const property of propertyList){
      const matches=lines.filter(line=>line.startsWith(property+'='));
      if(matches.length!==1)return null;
      projected[property]=matches[0].slice(property.length+1);
    }
    return projected;
  }catch{return null;}
}
export function verifiedSignalV3Cycle({
  execImpl=execFileSync,
  uptimeReadImpl=()=>readFileSync('/proc/uptime','utf8'),
}={}){
  for(const unit of [V3_SERVER,V3_TIMER]){
    const r=unitProperties(unit,['LoadState','ActiveState'],execImpl);
    if(r?.LoadState!=='loaded'||r.ActiveState!=='active')return false;
  }
  const r=unitProperties(V3_CYCLE,[
    'LoadState','ActiveState','Result','ExecMainStatus','ExecMainStartTimestampMonotonic'
  ],execImpl);
  if(!r||r.LoadState!=='loaded'||r.ActiveState!=='inactive'
    ||r.Result!=='success'||r.ExecMainStatus!=='0'
    ||!/^\d{1,16}$/u.test(r.ExecMainStartTimestampMonotonic))return false;
  const startUs=Number(r.ExecMainStartTimestampMonotonic);
  if(!Number.isSafeInteger(startUs)||startUs<=0)return false;
  let uptime;
  try{uptime=String(uptimeReadImpl()).split(/\s+/u)[0];}catch{return false;}
  if(!/^\d{1,12}(?:\.\d{1,9})?$/u.test(uptime))return false;
  const ageMs=(Number(uptime)*1_000_000-startUs)/1000;
  return Number.isFinite(ageMs)&&ageMs>=0&&ageMs<=15*60_000;
}

/** Only two fixed localhost URLs, HTTP GET, strict size/timeout limits. */
export async function boundedSignalV3Read(path,{getImpl=httpGet}={}) {
  if(!['/health','/v1/signals'].includes(path))return null;
  return await new Promise(resolve=>{
    let finished=false,req=null;
    const done=value=>{
      if(finished)return;
      finished=true;clearTimeout(timer);resolve(value);
    };
    const timer=setTimeout(()=>{req?.destroy?.();done(null);},6000);
    try{
      req=getImpl('http://127.0.0.1:8790'+path,
        {method:'GET',timeout:5000},res=>{
          if(res.statusCode!==200){res.resume?.();done(null);return;}
          let bytes=0;const chunks=[];
          res.on('data',chunk=>{
            bytes+=chunk.length;
            if(bytes>1_048_576){req?.destroy?.();done(null);return;}
            chunks.push(chunk);
          });
          res.on('error',()=>done(null));
          res.on('end',()=>{
            try{done(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
            catch{done(null);}
          });
        });
      req.on('timeout',()=>{req.destroy?.();done(null);});
      req.on('error',()=>done(null));
    }catch{done(null);}
  });
}
export async function runReadOnlySignalV3Predeploy({
  cycle = verifiedSignalV3Cycle,
  read = boundedSignalV3Read,
  now = Date.now,
}={}) {
  try{
    if(!cycle())return safeResult(false,SAFE_BLOCK);
    const health=await read('/health');
    if(!health)return safeResult(false,SAFE_BLOCK);
    const signal=await read('/v1/signals');
    return classifySignalV3HealthAndSource(health,signal,now());
  }catch{return safeResult(false,SAFE_BLOCK);}
}

if(process.env.TELEGRAM_PREDEPLOY_REMOTE_READONLY==='true'){
  const verdict=await runReadOnlySignalV3Predeploy();
  process.stdout.write(verdict.code+'\n');
  if(!verdict.ok)process.exitCode=1;
}
