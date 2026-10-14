/** Read-only recovery evidence after a protected dormant install's post-check failed.
 * Does NOT install, clear locks, chmod, start a worker, call Telegram or change PM2.
 */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT='/opt/stock-app-data/telegram-isolated-v1';
const APP='/opt/stock-app';
const SHA=/^[0-9a-f]{40}$/u;
const HASH=/^[0-9a-f]{64}$/u;
const FILES=[
 'api-server/dist/telegram-isolated-worker.mjs',
 'ops/telegram-legacy-owner-runtime-proof.mjs',
 'ops/run-telegram-isolated-worker.sh',
];
const LIMITS=[64*1024*1024,128*1024,128*1024];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const safeDir=directory=>{
 try {
  const stat=fs.lstatSync(directory);
  return stat.isDirectory()&&!stat.isSymbolicLink()
    &&(stat.mode&0o022)===0&&fs.realpathSync(directory)===directory;
 }catch{return false;}
};
function safeRead(filename,limit){
 let fd;
 try {
  const before=fs.lstatSync(filename);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1
     ||before.size<1||before.size>limit||(before.mode&0o022)!==0)
    return null;
  fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const after=fs.fstatSync(fd);
  if(!after.isFile()||after.nlink!==1||after.dev!==before.dev
    ||after.ino!==before.ino||after.size!==before.size)return null;
  const bytes=fs.readFileSync(fd);
  return bytes.length===after.size?bytes:null;
 }catch{return null;}
 finally {if(fd!==undefined)fs.closeSync(fd);}
}
const safeJson=(bytes)=>{
 try{return bytes&&JSON.parse(bytes.toString('utf8'));}
 catch{return null;}
};
const exactKeys=(value,keys)=>value&&typeof value==='object'
 &&!Array.isArray(value)
 &&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());

/** Validate exact original package manifest against the immutable push artifact. */
export function inspectSealedDormant({root=ROOT,sha,expectedManifestSha,expectedPreparationSha}){
 const invalid=code=>({valid:false,code});
 if(!SHA.test(String(sha))||!HASH.test(String(expectedManifestSha))
  ||!HASH.test(String(expectedPreparationSha))
  ||typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)!==root)
  return invalid('INVALID_READBACK_ARGUMENTS');
 if(!safeDir(path.dirname(root)))
  return invalid('DORMANT_PARENT_ROOT_UNSAFE');
 const release=path.join(root,'release','current');
 if(!safeDir(root)||!safeDir(path.join(root,'release')))
  return invalid('DORMANT_ROOT_UNSAFE_OR_MISSING');
 if(!fs.existsSync(release))
  return invalid('DORMANT_RELEASE_ABSENT');
 for(const part of [
  release,path.join(release,'api-server'),path.join(release,'api-server','dist'),
  path.join(release,'ops'),path.join(release,'.deploy'),
 ])if(!safeDir(part))return invalid('DORMANT_RELEASE_UNSAFE');
 const state=path.join(root,'state');
 let stateSecure=false;
 try{
  const st=fs.lstatSync(state);
  stateSecure=safeDir(state)&&(st.mode&0o777)===0o700;
 }catch{/* Treat disappeared/unstable state root as an explicit NO-GO. */}
 if(!stateSecure)return invalid('DORMANT_STATE_ROOT_UNSAFE');
 // A dormant installation must not silently be counted as a started worker.
 try {if(fs.readdirSync(state).length!==0)return invalid('DORMANT_STATE_NOT_EMPTY');}
 catch{return invalid('DORMANT_STATE_UNREADABLE');}
 const marker=safeRead(path.join(release,'.deploy','current-sha'),128);
 if(marker?.toString('utf8')!==sha+'\n')return invalid('DORMANT_MARKER_NOT_EXACT');
 try {
  fs.lstatSync(path.join(release,'.deploy','INSTALLATION_INCOMPLETE'));
  return invalid('DORMANT_INCOMPLETE_MARKER_PRESENT');
 }catch(error){if(error?.code!=='ENOENT')return invalid('DORMANT_INCOMPLETE_MARKER_UNVERIFIED');}
 const manifest=safeRead(path.join(release,'.deploy','telegram-sha256.manifest'),8192);
 if(!manifest||digest(manifest)!==expectedManifestSha)
  return invalid('DORMANT_MANIFEST_PROVENANCE_MISMATCH');
 const lines=manifest.toString('utf8').split('\n');
 if(lines.length!==FILES.length+1||lines.at(-1)!=='')
  return invalid('DORMANT_MANIFEST_INVALID');
 for(let i=0;i<FILES.length;i++){
  const match=/^([0-9a-f]{64})  (.+)$/u.exec(lines[i]);
  if(!match||match[2]!==FILES[i])
   return invalid('DORMANT_MANIFEST_INVALID');
  const bytes=safeRead(path.join(release,FILES[i]),LIMITS[i]);
  if(!bytes||digest(bytes)!==match[1])
   return invalid('DORMANT_PAYLOAD_INVALID');
 }
 const preparationBytes=safeRead(path.join(release,'.deploy','preparation.json'),8192);
 if(!preparationBytes||digest(preparationBytes)!==expectedPreparationSha)
  return invalid('DORMANT_PREPARATION_PROVENANCE_MISMATCH');
 const preparation=safeJson(preparationBytes);
 if(!preparation||preparation.schemaVersion!=='telegram-isolated-dormant-package-v1'
  ||preparation.sha!==sha||preparation.mode!=='PREPARE_ONLY'
  ||preparation.workerStarted!==false||preparation.productionAppChanged!==false
  ||preparation.pm2Restarts!==0||preparation.telegramMessages!==0
  ||preparation.financialMutations!==0
  ||JSON.stringify(preparation.paths)!==JSON.stringify(FILES))
  return invalid('DORMANT_PREPARATION_INVALID');
 const receipt=safeJson(safeRead(path.join(release,'.deploy','installation.json'),8192));
 const fields=['schemaVersion','sha','mode','workerStarted','productionAppChanged',
  'pm2Restarts','telegramMessages','financialMutations','manifestSha256'];
 if(!exactKeys(receipt,fields)
  ||receipt.schemaVersion!=='telegram-isolated-dormant-install-v1'
  ||receipt.sha!==sha||receipt.mode!=='STAGED_INACTIVE'
  ||receipt.workerStarted!==false||receipt.productionAppChanged!==false
  ||receipt.pm2Restarts!==0||receipt.telegramMessages!==0
  ||receipt.financialMutations!==0||receipt.manifestSha256!==expectedManifestSha)
  return invalid('DORMANT_INSTALL_RECEIPT_INVALID');
 return {valid:true,code:'SEALED_DORMANT_BYTES_VERIFIED'};
}
/** Match guarded installer configuration coverage, not just trading keys.
 * Include all app uppercase environment, exclude only PM2 internal metadata.
 * Never emit raw values; hash them before returning any process evidence.
 */
export function safeApplicationPm2Digest(env){
 if(!env||typeof env!=='object'||Array.isArray(env))return null;
 const keys=Object.keys(env)
  .filter(key=>(/^[A-Z][A-Z0-9_]*$/u.test(key)
    &&!key.startsWith('PM2_')&&!key.startsWith('AXM_'))
    ||key==='executionAuthority')
  .sort();
 const configured=keys.map(key=>[key,env[key]]);
 return digest(Buffer.from(JSON.stringify(configured),'utf8'));
}
export function sanitizePm2ForDormantReadback(rows,marker){
 if(!Array.isArray(rows))return null;
 const matches=rows.filter(row=>row?.name==='stock-app');
 if(matches.length!==1)return null;
 const row=matches[0],env=row.pm2_env;
 if(!env||typeof env!=='object'||Array.isArray(env)
  ||env.status!=='online'||!SHA.test(String(marker))
  ||env.DEPLOY_SHA!==marker
  ||env.pm_cwd!==APP||env.pm_exec_path!==APP+'/api-server/dist/index.mjs'
  ||!Number.isSafeInteger(row.pid)||row.pid<=0
  ||!Number.isSafeInteger(env.pm_uptime)||env.pm_uptime<=0
  ||!Number.isSafeInteger(env.restart_time)||env.restart_time<0)
  return null;
 const protectedDigest=safeApplicationPm2Digest(env);
 if(!protectedDigest)return null;
 return {
  sha:marker,pid:row.pid,started:env.pm_uptime,restarts:env.restart_time,
  owner:env.TELEGRAM_WORKER_OWNER==='isolated'?'isolated':
   env.TELEGRAM_WORKER_OWNER==null||env.TELEGRAM_WORKER_OWNER==='embedded'
    ?'embedded':'UNKNOWN',
  protectedDigest,
 };
}
function readPm2(){
 try {
  const rows=JSON.parse(execFileSync('pm2',['jlist'],{
   encoding:'utf8',timeout:10000,maxBuffer:20000000,
   stdio:['ignore','pipe','pipe'],
  }));
  const marker=fs.readFileSync(APP+'/.deploy/current-sha','utf8').trim();
  return sanitizePm2ForDormantReadback(rows,marker);
 }catch{return null;}
}
export async function auditTelegramDormantReadback({
 sha,expectedManifestSha,expectedPreparationSha,expectedDeployedSha,root=ROOT,
 readPm2Impl=readPm2,waitImpl=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
}){
 const evidence={
  schemaVersion:'telegram-dormant-install-readback-v1',
  sourceSha:SHA.test(String(sha))?sha:null,
  deployedSha:null,owner:'UNKNOWN',
  sealed:false,pm2Stable:false,activationReady:false,
  classification:'INVALID_REQUEST',observations:2,
  telegramSends:0,pm2Mutations:0,databaseWrites:0,financialMutations:0,
  secretValuesRecorded:false,
 };
 if(!SHA.test(String(sha))||!HASH.test(String(expectedManifestSha))
   ||!HASH.test(String(expectedPreparationSha))
   ||!SHA.test(String(expectedDeployedSha)))return evidence;
 const seal=inspectSealedDormant({root,sha,expectedManifestSha,expectedPreparationSha});
 if(!seal.valid){evidence.classification=seal.code;return evidence;}
 evidence.sealed=true;
 const first=await readPm2Impl();
 await waitImpl(1100);
 const second=await readPm2Impl();
 if(!first||!second){
  evidence.classification='SEALED_PRESENT_PM2_UNVERIFIED';return evidence;
 }
 evidence.deployedSha=first.sha;
 evidence.owner=first.owner;
 evidence.pm2Stable=JSON.stringify(first)===JSON.stringify(second);
 // The inspection does not hold a write lock (strictly zero host mutations).
 // Recheck all sealed bytes AFTER the second process observation; otherwise a
 // concurrently modified payload can incorrectly be reported as sealed.
 const endSeal=inspectSealedDormant({root,sha,expectedManifestSha,expectedPreparationSha});
 if(!endSeal.valid){
  evidence.sealed=false;
  evidence.pm2Stable=false;
  evidence.classification='DORMANT_CHANGED_DURING_READBACK';
  return evidence;
 }
 if(evidence.owner!=='embedded'){
  evidence.classification='SEALED_PRESENT_PM2_OWNER_UNEXPECTED';
  return evidence;
 }
 // Stable current process != proven original production revision. Demand the
 // pre-install SHA recorded by the original protected Production audit.
 if(first.sha!==expectedDeployedSha){
  evidence.classification='SEALED_PRESENT_DEPLOYED_SHA_UNEXPECTED';
  return evidence;
 }
 evidence.classification=evidence.pm2Stable
  ?'SEALED_DORMANT_BYTES_PM2_STABLE_NOW'
  :'SEALED_PRESENT_PM2_CHANGED_NOW';
 // Historical PM2 stability during the earlier failed installation is UNPROVEN.
 return evidence;
}
if(process.env.TELEGRAM_DORMANT_READBACK_EXECUTE==='true'){
 const report=await auditTelegramDormantReadback({
  sha:process.env.TELEGRAM_DORMANT_READBACK_SHA,
  expectedManifestSha:process.env.TELEGRAM_DORMANT_READBACK_MANIFEST,
  expectedPreparationSha:process.env.TELEGRAM_DORMANT_READBACK_PREPARATION_SHA,
  expectedDeployedSha:process.env.TELEGRAM_DORMANT_READBACK_EXPECTED_DEPLOYED_SHA,
 });
 process.stdout.write(JSON.stringify(report)+'\n');
}
