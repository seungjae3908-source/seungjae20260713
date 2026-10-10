/**
 * Protected Telegram-only Vault -> PM2 room binding.
 * Separate PLAN (read-only) from APPLY (single approved PM2 restart).
 * Production source tree, DB, webhooks and trading flags never modified.
 * All public output is a small fixed sanitized receipt, NEVER config values.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { get as httpGet } from 'node:http';

export const ROOMS = Object.freeze([
  'TELEGRAM_KR_STOCK_CHAT_ID',
  'TELEGRAM_US_STOCK_CHAT_ID',
  'TELEGRAM_CRYPTO_SPOT_CHAT_ID',
  'TELEGRAM_CRYPTO_FUTURES_CHAT_ID',
  'TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID',
  'TELEGRAM_AUTO_TRADING_CHAT_ID',
]);
export const BIND_KEYS = Object.freeze([...ROOMS, 'TELEGRAM_OWNER_MEMBER_ID']);
export const TRADING_BOOLEAN_GATES = Object.freeze([
  'LIVE_TRADING','AUTO_TRADING','REAL_ORDER_ENABLED','PRIVATE_TRADING_API_ALLOWED',
  'ORDER_EXECUTION_ENABLED','LIVE_TRADING_ACTIVATION_APPROVED',
  'SPOT_LIVE_LIMITED_ACTIVATION_APPROVED','LIVE_AUTOMATIC_TRADING_ENABLED',
  'FUTURES_LIVE_LIMITED_ACTIVATION_APPROVED','BITGET_FUTURES_LIVE_ORDER_ENABLED',
  'CRYPTO_AUTO_LEGACY_EXECUTION_ENABLED','CRYPTO_AUTO_TRADE_ENABLED',
  'BITGET_AUTO_TRADE_ENABLED','BITGET_LIVE_ORDER_ENABLED',
  'UPBIT_LIVE_ORDER_ENABLED','KIWOOM_LIVE_ORDER_ENABLED','TOSS_LIVE_ORDER_ENABLED',
  'MEMBER_AUTO_TRADING_BACKGROUND_ENABLED',
  'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
  'MEMBER_AUTO_TRADING_PAPER_ONLY_ENABLED',
]);
export const TRADING_AUTHORITY_KEYS = Object.freeze([
  'executionAuthority','FUTURES_LIVE_EXECUTION_AUTHORITY',
]);
export const TELEGRAM_RUNTIME_FLAGS = Object.freeze([
  'LIVE_TELEGRAM_ACTIVATION_APPROVED',
  'TELEGRAM_INTELLIGENCE_WORKER_ENABLED',
  'PERSONAL_TELEGRAM_WORKER_ENABLED',
  'MEMBER_HOLDINGS_TELEGRAM_PRODUCER_ENABLED',
  'TELEGRAM_DAILY_BRIEF_RICH_ENABLED',
]);
const PM2_NAME = 'stock-app';
const ROOT = '/opt/stock-app';
const DEPLOY_MARKER = ROOT + '/.deploy/current-sha';

export function normalizeSha(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/u.test(s) ? s : null;
}
export function validateVault(proof) {
  const rooms = proof?.rooms;
  if (proof?.roomsUnique !== true || proof?.ownerUnique !== true
    || proof?.ownerVerified !== true || !rooms || typeof rooms !== 'object'
    || Array.isArray(rooms) || Object.keys(rooms).length !== 6
    || ROOMS.some(key => !Object.hasOwn(rooms,key))
    || ROOMS.some(key => typeof rooms[key] !== 'string'
      || !/^-100[0-9]{8,15}$/u.test(rooms[key]))
    || new Set(ROOMS.map(key => rooms[key])).size !== 6
    || typeof proof.owner !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(proof.owner)) return false;
  return true;
}
export function tradingIsOff(runtime) {
  if (!runtime || typeof runtime !== 'object') return false;
  for (const key of TRADING_BOOLEAN_GATES) {
    const value = runtime[key];
    if (value !== undefined && value !== null && value !== false && value !== 'false') return false;
  }
  for (const key of TRADING_AUTHORITY_KEYS) {
    if (runtime[key] !== undefined && runtime[key] !== null
      && runtime[key] !== 'NONE') return false;
  }
  // Execution authority is mandatory for this config-only PM2 restart.
  return runtime.executionAuthority === 'NONE';
}
export function snapshotProtectedFlags(runtime) {
  return Object.fromEntries(
    [...TRADING_BOOLEAN_GATES, ...TRADING_AUTHORITY_KEYS, ...TELEGRAM_RUNTIME_FLAGS]
      .map(key => [key, runtime?.[key] === undefined ? null : String(runtime[key])])
  );
}
export function flagsUnchanged(before, after) {
  return JSON.stringify(snapshotProtectedFlags(before))
    === JSON.stringify(snapshotProtectedFlags(after));
}
export function bindingValues(proof) {
  if (!validateVault(proof)) throw new Error('VAULT_PROOF_INVALID');
  return {...proof.rooms, TELEGRAM_OWNER_MEMBER_ID:proof.owner};
}
export function makeReceipt(mode, mainSha, deployedSha) {
  return {
    schemaVersion:'telegram-sixroom-vault-pm2-binding-v1',
    mode:mode === 'apply' ? 'APPLY' : 'PLAN',
    mainSha:normalizeSha(mainSha),
    expectedDeployedSha:normalizeSha(deployedSha),
    pm2Sha:null, markerSha:null, pm2Online:false,
    vaultValid:false, autoRoomPreserved:false, tradingSafe:false,
    bindingMatches:false, changedKeys:[],
    restartAttempts:0, rollbackAttempts:0,
    pm2Saved:false, postHealthVerified:false,
    secretValuesRecorded:false, telegramSends:0,
    databaseWrites:0, financialMutations:0, webhookMutations:0,
    classification:'NOT_READY',
  };
}
/** Public, safe verdict. Private proof and runtime never leave caller. */
export function preflightBinding({mode='plan',mainSha,deployedSha,pm2Sha,markerSha,
  runtime,pm2Online,proof,watchEnabled=false,canonicalCwd=true,canonicalEntrypoint=true}) {
  const receipt=makeReceipt(mode,mainSha,deployedSha);
  receipt.pm2Sha=normalizeSha(pm2Sha);
  receipt.markerSha=normalizeSha(markerSha);
  receipt.pm2Online=pm2Online===true;
  receipt.vaultValid=validateVault(proof);
  receipt.tradingSafe=tradingIsOff(runtime);
  if (!receipt.mainSha || !receipt.expectedDeployedSha) {
    receipt.classification='SHA_INVALID'; return receipt;
  }
  if (!receipt.pm2Online || !receipt.pm2Sha || receipt.pm2Sha!==receipt.markerSha
    || receipt.pm2Sha!==receipt.expectedDeployedSha) {
    receipt.classification='PRODUCTION_SHA_MISMATCH'; return receipt;
  }
  if (!canonicalCwd || !canonicalEntrypoint || watchEnabled) {
    receipt.classification='PM2_RUNTIME_NOT_CANONICAL'; return receipt;
  }
  if (!receipt.vaultValid) {
    receipt.classification='VAULT_PROOF_INVALID'; return receipt;
  }
  if (!receipt.tradingSafe) {
    receipt.classification='FINANCIAL_AUTHORITY_NOT_OFF'; return receipt;
  }
  if (runtime?.LIVE_TELEGRAM_ACTIVATION_APPROVED !== 'true'
    || runtime?.TELEGRAM_INTELLIGENCE_WORKER_ENABLED !== 'true'
    || runtime?.PERSONAL_TELEGRAM_WORKER_ENABLED !== 'true') {
    receipt.classification='TELEGRAM_WORKER_GATE_INACTIVE'; return receipt;
  }
  if (!/^[0-9]{6,20}:[A-Za-z0-9_-]{20,}$/u.test(String(runtime?.TELEGRAM_BOT_TOKEN??''))) {
    receipt.classification='TELEGRAM_BOT_NOT_CONFIGURED'; return receipt;
  }
  const bindings=bindingValues(proof);
  // Never overwrite an existing AUTO room that differs from canonical Vault.
  const actualAuto=String(runtime?.TELEGRAM_AUTO_TRADING_CHAT_ID??'').trim();
  receipt.autoRoomPreserved=actualAuto===bindings.TELEGRAM_AUTO_TRADING_CHAT_ID;
  if (!receipt.autoRoomPreserved) {
    receipt.classification='AUTO_ROOM_ID_CONFLICT'; return receipt;
  }
  // Existing nonempty binding conflicts must NOT be silently replaced.
  for (const key of BIND_KEYS) {
    const value=String(runtime?.[key]??'').trim();
    if (value && value!==bindings[key]) {
      receipt.classification='EXISTING_BINDING_CONFLICT'; return receipt;
    }
  }
  receipt.changedKeys=BIND_KEYS.filter(key=>!String(runtime?.[key]??'').trim());
  receipt.bindingMatches=receipt.changedKeys.length===0;
  receipt.classification=receipt.bindingMatches
    ? 'ALREADY_BOUND' : 'BINDING_READY';
  return receipt;
}

export function runtimeBindingMatches(runtime, proof) {
  const bindings=bindingValues(proof);
  return BIND_KEYS.every(key => String(runtime?.[key]??'').trim()===bindings[key]);
}

function parseProductionDb(dbUrl,runtimeUrl) {
  const site=new URL(String(runtimeUrl??''));
  const project=/^([a-z0-9]{10,})\.supabase\.co$/iu.exec(site.hostname);
  if (site.protocol!=='https:' || !project) throw new Error('DATABASE_PROJECT_INVALID');
  const db=new URL(String(dbUrl??''));
  const username=decodeURIComponent(db.username);
  const direct=db.hostname==='db.'+project[1]+'.supabase.co'&&username==='postgres';
  const pool=/(^|\.)pooler\.supabase\.com$/iu.test(db.hostname)
    && username==='postgres.'+project[1];
  if(!['postgres:','postgresql:'].includes(db.protocol) || !(direct||pool)
    || decodeURIComponent(db.pathname)!=='/postgres'
    || !['5432','6543'].includes(db.port||'5432') || !db.password) {
    throw new Error('DATABASE_PROJECT_INVALID');
  }
  return {host:db.hostname,port:db.port||'5432',user:username,
    password:decodeURIComponent(db.password),database:'postgres'};
}
const VAULT_SQL=[
  'WITH rooms AS (SELECT decrypted_secret::jsonb AS value FROM vault.decrypted_secrets',
  "WHERE name='telegram_sixroom_prod_config_v1'),",
  'owner AS (SELECT decrypted_secret AS value FROM vault.decrypted_secrets',
  "WHERE name='telegram_sixroom_owner_member_id_v1'),",
  'valid_owner AS (SELECT p.id FROM public.profiles p',
  'JOIN public.telegram_connections t ON t.user_id=p.id',
  'WHERE p.id::text=(SELECT value FROM owner)',
  "AND lower(p.role) IN ('admin','owner','super_admin')",
  "AND p.is_active IS TRUE AND lower(p.status::text)='approved'",
  'AND (p.membership_expires_at IS NULL OR p.membership_expires_at>now())',
  "AND t.status='ACTIVE' AND t.revoked_at IS NULL",
  'AND (SELECT count(DISTINCT lower(c.provider)) FROM public.account_readonly_credentials c',
  'WHERE c.user_id=p.id)>=4',
  'AND EXISTS(SELECT 1 FROM public.trade_automation_profiles ap WHERE ap.user_id=p.id))',
  "SELECT jsonb_build_object('rooms',(SELECT value FROM rooms),",
  "'owner',(SELECT value FROM owner),",
  "'roomsUnique',(SELECT count(*)=1 FROM rooms),",
  "'ownerUnique',(SELECT count(*)=1 FROM owner),",
  "'ownerVerified',(SELECT count(*)=1 FROM valid_owner))::text;",
].join('\n');
function fetchVault(databaseUrl,runtime) {
  const db=parseProductionDb(databaseUrl,runtime.SUPABASE_URL||runtime.VITE_SUPABASE_URL);
  const env={...process.env};
  for(const key of Object.keys(env)) {
    if(key.startsWith('PG')||key==='PROD_DATABASE_URL') delete env[key];
  }
  Object.assign(env,{PGHOST:db.host,PGPORT:db.port,PGUSER:db.user,
    PGPASSWORD:db.password,PGDATABASE:db.database,
    PGSSLMODE:'require',PGCONNECT_TIMEOUT:'10'});
  const query=spawnSync('psql',['-X','-qAt','-v','ON_ERROR_STOP=1'],{
    input:VAULT_SQL,encoding:'utf8',env,timeout:20000,maxBuffer:100000,
    stdio:['pipe','pipe','pipe'],
  });
  if(query.error||query.status!==0||!query.stdout?.trim()) {
    throw new Error('VAULT_READ_FAILED');
  }
  return JSON.parse(query.stdout.trim());
}
function readPm2Process() {
  const list=JSON.parse(execFileSync('pm2',['jlist'],{
    encoding:'utf8',timeout:10000,maxBuffer:20000000,
    stdio:['ignore','pipe','pipe'],
  }));
  const targets=Array.isArray(list)?list.filter(x=>x?.name===PM2_NAME):[];
  if(targets.length!==1) throw new Error('PM2_NOT_UNIQUE');
  return targets[0];
}
function readRuntimeSnapshot() {
  const proc=readPm2Process();
  const runtime=proc.pm2_env??{};
  let marker=null;
  try { marker=normalizeSha(readFileSync(DEPLOY_MARKER,'utf8')); } catch {}
  return {
    runtime,pm2Sha:normalizeSha(runtime.DEPLOY_SHA),markerSha:marker,
    pm2Online:runtime.status==='online',
    watchEnabled:runtime.watch===true||proc.pm2_env?.watch===true,
    canonicalCwd:runtime.pm_cwd===ROOT,
    canonicalEntrypoint:String(runtime.pm_exec_path||'')
      ===ROOT+'/api-server/dist/index.mjs',
  };
}
function pm2CommandEnv(runtime,override={}) {
  const allowed={...process.env};
  // Production DB connection exists ONLY in this one-shot remote CLI; do not
  // accidentally inherit it in a restarted public API process.
  for(const key of Object.keys(allowed)) {
    if (key==='PROD_DATABASE_URL' || key.startsWith('PG')
      || key.startsWith('TELEGRAM_BINDING_') || key.startsWith('GITHUB_')
      || key.startsWith('RUNNER_') || key.startsWith('SSH_')
      || key==='CI') delete allowed[key];
  }
  const excludedMeta=new Set([
    'name','namespace','cwd','args','status','exec_interpreter','exec_mode',
    'pm_exec_path','pm_cwd','pm_out_log_path','pm_err_log_path','pm_pid_path',
    'NODE_APP_INSTANCE','PORT','API_PORT',
  ]);
  for(const [key,value] of Object.entries(runtime)) {
    if(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
      && !excludedMeta.has(key) && key!=='PROD_DATABASE_URL'
      && !key.startsWith('PG') && !key.startsWith('TELEGRAM_BINDING_')
      && !key.startsWith('GITHUB_') && !key.startsWith('RUNNER_')
      && !key.startsWith('SSH_') && value!=null && typeof value!=='object'
      && !key.startsWith('pm_') && !key.startsWith('axm_')) {
      allowed[key]=String(value);
    }
  }
  return {...allowed,...override};
}
export async function localHealthVerified(expectedSha, { getImpl = httpGet } = {}) {
  // Read only loopback Production health; never emit its worker or account data.
  return await new Promise(resolve=>{
    let req=null,finished=false;
    const done=v=>{if(finished)return;finished=true;clearTimeout(timer);resolve(v);};
    const timer=setTimeout(()=>{req?.destroy();done(false);},5000);
    try {
      req=getImpl('http://127.0.0.1:8080/api/health',{timeout:4500},res=>{
        if(res.statusCode!==200){res.resume();done(false);return;}
        let size=0;const chunks=[];
        res.on('data',chunk=>{
          size+=chunk.length;
          if(size>131072){res.destroy();done(false);return;}
          chunks.push(chunk);
        });
        res.on('error',()=>done(false));
        res.on('end',()=>{
          let p=null;
          try{p=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
          done(p?.ok===true && p?.service==='api-server'
            && p?.route==='/api/health'
            && p?.deploySha===expectedSha
            && p?.processDeploySha===expectedSha
            && p?.identityMatch===true
            && p?.deployMarkerSha===expectedSha);
        });
      });
      req.on('timeout',()=>req.destroy());
      req.on('error',()=>done(false));
    } catch {done(false);}
  });
}
async function waitHealth(expectedSha) {
  for(let i=0;i<10;i++){
    if(await localHealthVerified(expectedSha)) return true;
    await new Promise(resolve=>setTimeout(resolve,1500));
  }
  return false;
}
function restartOnlyWithEnv(env) {
  execFileSync('pm2',['restart',PM2_NAME,'--update-env'],{
    env,timeout:45000,maxBuffer:50000,stdio:['ignore','ignore','pipe'],
  });
}
function savePm2() {
  execFileSync('pm2',['save'],{
    timeout:25000,maxBuffer:50000,stdio:['ignore','ignore','pipe'],
  });
}
function oneTimeGuard(runId, mainSha) {
  if(!/^[0-9]{1,20}$/u.test(String(runId))) throw new Error('RUN_ID_INVALID');
  const directory='/opt/stock-app-data/telegram-sixroom-binding';
  mkdirSync(directory,{recursive:true,mode:0o700});
  const filename=directory+'/apply-'+String(runId)+'-'+mainSha+'.lock';
  const handle=openSync(filename,'wx',0o600); // atomic replay prevention
  closeSync(handle);
}
export async function executeBinding({
  mode=process.env.TELEGRAM_BINDING_MODE,
  mainSha=process.env.TELEGRAM_BINDING_MAIN_SHA,
  deployedSha=process.env.TELEGRAM_BINDING_DEPLOYED_SHA,
  ownerApproved=process.env.TELEGRAM_BINDING_APPLY_APPROVED,
  runId=process.env.TELEGRAM_BINDING_RUN_ID,
  databaseUrl=process.env.PROD_DATABASE_URL,
  snapshots=readRuntimeSnapshot,
  vault=fetchVault,
  restart=restartOnlyWithEnv,
  save=savePm2,
  wait=waitHealth,
  guard=oneTimeGuard,
}={}) {
  const sanitizedMode=mode==='apply'?'apply':'plan';
  let receipt=makeReceipt(sanitizedMode,mainSha,deployedSha);
  let initial=null,proof=null;
  try {
    if (mode!=='plan'&&mode!=='apply') {
      receipt.classification='MODE_INVALID'; return receipt;
    }
    initial=snapshots();
    proof=vault(databaseUrl,initial.runtime);
    receipt=preflightBinding({
      mode,mainSha,deployedSha,proof,...initial,
    });
    if(mode==='plan'||receipt.classification!=='BINDING_READY') return receipt;
    if(ownerApproved!=='true' || String(process.env.GITHUB_RUN_ATTEMPT??'1')!=='1') {
      receipt.classification='OWNER_APPLY_APPROVAL_REQUIRED'; return receipt;
    }
    // Do not restart if another operation raced with the preview.
    const reread=snapshots();
    if(reread.pm2Sha!==initial.pm2Sha
      ||reread.markerSha!==initial.markerSha
      ||!flagsUnchanged(initial.runtime,reread.runtime)
      ||!tradingIsOff(reread.runtime)) {
      receipt.classification='RUNTIME_RACE_BLOCKED';return receipt;
    }
    guard(runId,receipt.mainSha);
    // Old values are kept only in process memory for explicit rollback.
    const oldBindings=Object.fromEntries(
      BIND_KEYS.map(key=>[key,String(initial.runtime[key]??'')])
    );
    const wanted=bindingValues(proof);
    const newEnv=pm2CommandEnv(initial.runtime,wanted);
    receipt.restartAttempts+=1;
    try {
      restart(newEnv);
      const after=snapshots();
      const valid=after.pm2Online && after.pm2Sha===receipt.expectedDeployedSha
        && after.markerSha===receipt.expectedDeployedSha
        && tradingIsOff(after.runtime)
        && flagsUnchanged(initial.runtime,after.runtime)
        && runtimeBindingMatches(after.runtime,proof)
        && await wait(receipt.expectedDeployedSha);
      receipt.postHealthVerified=valid;
      if(!valid) throw new Error('POSTBIND_VALIDATION_FAILED');
      save();
      receipt.pm2Saved=true;
      receipt.bindingMatches=true;
      receipt.changedKeys=[];
      receipt.classification='BINDING_APPLIED_VERIFIED';
      return receipt;
    } catch {
      // Another restart may be necessary to restore the exact prior bindings.
      receipt.rollbackAttempts+=1;
      try {
        restart(pm2CommandEnv(initial.runtime,oldBindings));
        const restore=snapshots();
        const restored=restore.pm2Online
          && restore.pm2Sha===initial.pm2Sha
          && restore.markerSha===initial.markerSha
          && flagsUnchanged(initial.runtime,restore.runtime)
          && BIND_KEYS.every(key=>String(restore.runtime[key]??'')===oldBindings[key])
          && await wait(receipt.expectedDeployedSha);
        if(restored) {
          save();
          receipt.pm2Saved=true;
        }
        receipt.classification=restored?'APPLY_FAILED_ROLLED_BACK':'APPLY_FAILED_ROLLBACK_UNVERIFIED';
      } catch {
        receipt.classification='APPLY_FAILED_ROLLBACK_UNVERIFIED';
      }
      return receipt;
    }
  } catch {
    receipt.classification='BINDING_PREFLIGHT_ERROR';
    return receipt;
  }
}

if (process.env.TELEGRAM_BINDING_EXECUTE==='true') {
  const receipt=await executeBinding();
  process.stdout.write(JSON.stringify(receipt)+'\n');
}
