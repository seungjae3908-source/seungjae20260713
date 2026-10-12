import { createPublicKey, verify } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

/** Optional independent Research -> Signal V3 link. Completely OFF by default.
 * A signed manifest is not a historical-data download or an OOS result.
 * The trusted, independent issuer is responsible for verifying underlying
 * original-minute, PIT, fills and held-out receipts before signing.
 */
export const V3_ECONOMIC_BRIDGE_SCHEMA='signal-v3-economic-proof-bundle-v1';
const SHA40=/^[0-9a-f]{40}$/u, SHA256=/^[0-9a-f]{64}$/u;
const MAX_BYTES=1_048_576;
const validPublicKey=x=>typeof x==='string'&&x.length>0&&x.length<8000
  &&x.includes('-----BEGIN PUBLIC KEY-----');
const MARKETS=new Set(['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']);
const COSTS=['commissionPercent','taxPercent','spreadPercent','slippagePercent',
  'fundingPercent','latencyPercent','liquidityImpactPercent','partialFillImpactPercent'];
const object=x=>x&&typeof x==='object'&&!Array.isArray(x)?x:null;
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
const natural=x=>Number.isSafeInteger(x)&&x>0;
const text=(x,max=256)=>typeof x==='string'&&x.length>0&&x.length<=max
  &&x.trim()===x;
function canonical(value){
 if(Array.isArray(value)) return value.map(canonical);
 if(!object(value))return value;
 return Object.fromEntries(Object.keys(value).sort()
   .map(key=>[key,canonical(value[key])]));
}
export function v3SignedResearchPayload(bundle){
 if(!object(bundle))throw Error('V3_ECONOMIC_BUNDLE_INVALID');
 const {signature,...body}=bundle;
 return Buffer.from(JSON.stringify(canonical(body)),'utf8');
}
// A frozen Map still has working .set/.delete. Never expose mutable proof.
const verifiedBridges=new WeakSet();
function sealedRecords(entries){
 const owned=new Map();
 const deepFreeze=x=>{
  if(x&&typeof x==='object'&&!Object.isFrozen(x)){
   for(const child of Object.values(x))deepFreeze(child);
   Object.freeze(x);
  }
  return x;
 };
 for(const [key,value] of entries)owned.set(key,deepFreeze(structuredClone(value)));
 return Object.freeze({size:owned.size,get(key){return owned.get(key);}});
}
function blocked(status){
 return Object.freeze({status,records:sealedRecords([]),
   diagnostic:Object.freeze({schemaVersion:V3_ECONOMIC_BRIDGE_SCHEMA,
     status,linkedRecords:0,publicRequestsAdded:0,realOrders:0,
     independentlyVerifiedOperationalProof:false,executionAuthority:'NONE'})});
}
function signedEntryValid(entry,expectedResearchSha){
 const binding=object(entry?.cardBinding),id=object(entry?.paperIdentity);
 const proof=object(entry?.independentAudit),quality=object(entry?.backtestQuality);
 const cost=object(entry?.costPolicy),profit=object(entry?.profitEvidence);
 if(!binding||!id||!proof||!quality||!cost||!profit
   ||!MARKETS.has(binding.market)||!text(binding.symbol,128)
   ||!['15m','60m','1D'].includes(binding.timeframe)
   ||!(binding.market==='CRYPTO_FUTURES'
     ?['LONG','SHORT'].includes(binding.direction):binding.direction==='BUY')
   ||!text(binding.scannerSignalId)
   ||id.signalId!==binding.scannerSignalId
   ||id.market!==binding.market||id.symbol!==binding.symbol
   ||id.timeframe!==binding.timeframe||id.direction!==binding.direction
   ||!text(id.strategyId,200)||!text(id.strategyVersion,200)
   ||!text(id.parameterHash)||id.researchCodeSha!==expectedResearchSha
   ||!natural(id.horizon)||!text(id.costPolicyVersion,200)
   ||id.executionAuthority!=='NONE'
   ||profit.status!=='READY'||profit.market!==binding.market
   ||profit.timeframe!==binding.timeframe||profit.direction!==binding.direction
   ||profit.strategyVersion!==id.strategyVersion
   ||profit.costPolicyId!==id.costPolicyVersion
   ||profit.executionAuthority!=='NONE'
   ||!positive(profit.expectedNetEdge)||!positive(profit.expectedNetReturn)
   ||!positive(profit.riskRewardRatio)||profit.riskRewardRatio<1
   ||!natural(profit.sampleSize)
   ||cost.source!=='EXPLICIT_RUNTIME_POLICY'
   ||cost.id!==profit.costPolicyId||cost.market!==binding.market
   ||COSTS.some(k=>typeof cost[k]!=='number'||!Number.isFinite(cost[k])||cost[k]<0)
   ||quality.status!=='verified'||quality.oos!==true
   ||quality.walkForward!==true||quality.costsIncluded!==true
   ||quality.slippageIncluded!==true||quality.lookaheadGuarded!==true
   ||quality.survivorshipGuarded!==true
   ||!natural(quality.tradeCount)||!natural(quality.minimumTradeCount)
   ||quality.tradeCount<quality.minimumTradeCount
   ||!natural(quality.oosTradeCount)||!natural(quality.walkForwardTradeCount)
   ||!positive(quality.netReturnPercent)||!positive(quality.expectancyPercent)
   ||!positive(quality.profitFactor)||quality.profitFactor<=1)return false;
 const lineage=object(quality.canonicalLineage);
 if(!lineage)return false;
 const fields={signalId:id.signalId,strategyId:id.strategyId,
   strategyVersion:id.strategyVersion,parameterHash:id.parameterHash,
   researchCodeSha:id.researchCodeSha,costPolicyId:id.costPolicyVersion,
   market:id.market,symbol:id.symbol,timeframe:id.timeframe,direction:id.direction};
 if(Object.entries(fields).some(([k,v])=>lineage[k]!==v))return false;
 if(proof.evidenceClass!=='INDEPENDENT_CANONICAL_EVALUATION'
   ||proof.pointInTimeRosterComplete!==true
   ||proof.originalMinuteCoverageComplete!==true
   ||proof.heldOutOosPass!==true||proof.walkForwardPass!==true
   ||proof.fullCostReady!==true||proof.fillAndSlippageAudited!==true
   ||proof.finalHoldoutRetuned!==false
   ||proof.fixture!==false||proof.synthetic!==false
   ||proof.replay!==false||proof.backfill!==false||proof.manual!==false
   ||proof.executionAuthority!=='NONE'
   ||['datasetDigest','rosterDigest','oosReportDigest',
      'walkForwardDigest','fillsDigest','fullCostDigest','independenceAuditDigest']
     .some(k=>!SHA256.test(proof[k]??'')))return false;
 return true;
}
function uniqueKey(binding){
 return [binding.market,binding.symbol,binding.timeframe,binding.direction,
   binding.scannerSignalId].join('|');
}
function validatedBundle(bundle,publicKeyPem,expectedResearchSha,nowMs){
 if(bundle?.schemaVersion!==V3_ECONOMIC_BRIDGE_SCHEMA
   ||bundle?.issuer!=='INDEPENDENT_CANONICAL_RESEARCH_EVALUATOR'
   ||bundle?.researchCodeSha!==expectedResearchSha
   ||bundle?.executionAuthority!=='NONE'
   ||!Array.isArray(bundle.entries)||bundle.entries.length>1000
   ||typeof bundle.signature!=='string'
   ||!/^[A-Za-z0-9+/]{86}==$/u.test(bundle.signature))return blocked('BUNDLE_SCHEMA_BLOCKED');
 const issued=Date.parse(bundle.issuedAt??'');
 const expires=Date.parse(bundle.expiresAt??'');
 if(!Number.isFinite(issued)||!Number.isFinite(expires)
   ||new Date(issued).toISOString()!==bundle.issuedAt
   ||new Date(expires).toISOString()!==bundle.expiresAt
   ||issued>nowMs+5000||expires<=nowMs||expires-issued>7*24*60*60_000)
   return blocked('BUNDLE_EXPIRED_OR_CLOCK_INVALID');
 try{
  const key=createPublicKey(publicKeyPem);
  if(key.asymmetricKeyType!=='ed25519')return blocked('SIGNING_KEY_INVALID');
  if(!verify(null,v3SignedResearchPayload(bundle),key,
      Buffer.from(bundle.signature,'base64')))return blocked('SIGNATURE_INVALID');
 }catch{return blocked('SIGNATURE_INVALID');}
 const records=new Map();
 for(const entry of bundle.entries){
  if(!signedEntryValid(entry,expectedResearchSha))
    return blocked('INDEPENDENT_EVIDENCE_INVALID');
  const key=uniqueKey(entry.cardBinding);
  if(records.has(key))return blocked('DUPLICATE_RESEARCH_IDENTITY');
  records.set(key,entry);
 }
 // Only this module can brand a bridge as cryptographically verified;
 // sealed copies prevent mutation after the signature check.
 let handle;
 try{
  handle=Object.freeze({status:'SIGNED_EVIDENCE_AVAILABLE',
    records:sealedRecords(records),
    diagnostic:Object.freeze({schemaVersion:V3_ECONOMIC_BRIDGE_SCHEMA,
      status:'SIGNED_EVIDENCE_AVAILABLE',linkedRecords:records.size,
      publicRequestsAdded:0,realOrders:0,
      independentlyVerifiedOperationalProof:false,executionAuthority:'NONE'})});
 }catch{return blocked('INDEPENDENT_EVIDENCE_INVALID');}
 verifiedBridges.add(handle);
 return handle;
}
export function inspectV3SignedResearchBundle(bundle,{publicKeyPem,expectedResearchSha,
  nowMs=Date.now(),enabled=false}={}){
 if(enabled!==true)return blocked('DISABLED');
 if(!SHA40.test(expectedResearchSha??'')||!validPublicKey(publicKeyPem)
   ||!Number.isSafeInteger(nowMs)||nowMs<=0)return blocked('NOT_CONFIGURED');
 return validatedBundle(bundle,publicKeyPem,expectedResearchSha,nowMs);
}
export async function loadV3SignedResearchBundle({enabled=false,root,fileName,
  publicKeyPem,expectedResearchSha,nowMs=Date.now()}={}){
 if(enabled!==true)return blocked('DISABLED');
 if(!isAbsolute(root??'')||!text(fileName,128)
   ||basename(fileName)!==fileName||fileName==='.'||fileName==='..'
   ||!SHA40.test(expectedResearchSha??'')||!validPublicKey(publicKeyPem)
   ||!Number.isSafeInteger(nowMs)||nowMs<=0)
   return blocked('NOT_CONFIGURED');
 try{
  const resolved=resolve(root),file=join(resolved,fileName);
  if(file!==resolve(resolved,fileName)||file===resolved)
    return blocked('UNSAFE_PRIVATE_SOURCE');
  const stat=await lstat(resolved);
  if(!stat.isDirectory()||stat.isSymbolicLink()
    ||(stat.mode&0o077)!==0||await realpath(resolved)!==resolved
    ||(typeof process.getuid==='function'&&stat.uid!==process.getuid()))
    return blocked('UNSAFE_PRIVATE_SOURCE');
  const before=await lstat(file);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1
    ||before.size<32||before.size>MAX_BYTES
    ||(before.mode&0o077)!==0
    ||(typeof process.getuid==='function'&&before.uid!==process.getuid()))
    return blocked('UNSAFE_PRIVATE_SOURCE');
  const fd=await open(file,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);
  let bytes;
  try{
   const opened=await fd.stat();
   if(opened.ino!==before.ino||opened.dev!==before.dev
     ||opened.size!==before.size||opened.mtimeMs!==before.mtimeMs)
     return blocked('SOURCE_CHANGED');
   bytes=await fd.readFile();
   const after=await fd.stat();
   if(after.size!==before.size||after.mtimeMs!==before.mtimeMs
     ||after.ctimeMs!==before.ctimeMs||bytes.length!==before.size)
     return blocked('SOURCE_CHANGED');
  }finally{await fd.close();}
  if(bytes.length>MAX_BYTES)return blocked('SOURCE_TOO_LARGE');
  const bundle=JSON.parse(bytes.toString('utf8'));
  return inspectV3SignedResearchBundle(bundle,{enabled:true,publicKeyPem,
    expectedResearchSha,nowMs});
 }catch{return blocked('SOURCE_UNAVAILABLE');}
}
export function attachV3SignedResearchEvidence(card,{lane,bridge}={}){
 const fallback=Object.freeze({card,timeframe:lane?.timeframe});
 if(!object(card)||!object(lane)||bridge?.status!=='SIGNED_EVIDENCE_AVAILABLE'
   ||!verifiedBridges.has(bridge))return fallback;
 const market=lane.market;
 const direction=market==='CRYPTO_FUTURES'
   ?(['LONG','SHORT'].includes(card.direction)&&card.action===card.direction
     ?card.direction:null)
   :card.action==='BUY'&&['LONG','BUY'].includes(card.direction)?'BUY':null;
 if(!direction||!text(card.symbol,128)||!text(card.signalId))return fallback;
 const binding={market,symbol:card.symbol.toUpperCase(),
   timeframe:lane.timeframe,direction,scannerSignalId:card.signalId};
 const receipt=bridge.records.get(uniqueKey(binding));
 if(!receipt)return fallback;
 return Object.freeze({card:{...card,backtestQuality:receipt.backtestQuality},
   timeframe:lane.timeframe,paperIdentity:receipt.paperIdentity,
   profitEvidence:receipt.profitEvidence,costPolicy:receipt.costPolicy});
}
