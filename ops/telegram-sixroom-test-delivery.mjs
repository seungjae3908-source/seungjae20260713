/**
 * One-shot, owner/protected Production Telegram SIX-ROOM delivery proof.
 * Bounded GET preflight followed by <=1 POST sendMessage per Vault room.
 * No production deployment, DB changes, PM2 restart, webhook changes,
 * trading/private provider API, bot token/ID/IP logging, or retry-to-pass.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';

export const ROOM_KEYS = Object.freeze({
  TELEGRAM_KR_STOCK_CHAT_ID: ['KR_STOCK', '국내주식'],
  TELEGRAM_US_STOCK_CHAT_ID: ['US_STOCK', '해외주식'],
  TELEGRAM_CRYPTO_SPOT_CHAT_ID: ['CRYPTO_SPOT', '코인현물'],
  TELEGRAM_CRYPTO_FUTURES_CHAT_ID: ['CRYPTO_FUTURES', '코인선물'],
  TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID: ['HOLDINGS', '보유종목'],
  TELEGRAM_AUTO_TRADING_CHAT_ID: ['AUTO_TRADING', '자동매매'],
});
const ROOM_CODES = Object.values(ROOM_KEYS).map(([code]) => code);
const NO_RESULT = 'NOT_CHECKED';

export function safeSha(s) {
  const result = String(s ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/u.test(result) ? result : null;
}

export function verifyVaultSixRooms(rooms, owner, ownerVerified) {
  if (!rooms || typeof rooms !== 'object' || Array.isArray(rooms)
    || Object.keys(rooms).length !== 6
    || Object.keys(ROOM_KEYS).some(key => !Object.hasOwn(rooms, key))
    || Object.values(rooms).some(value =>
      typeof value !== 'string' || !/^-100[0-9]{8,15}$/u.test(value))
    || new Set(Object.values(rooms)).size !== 6) return false;
  return typeof owner === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(owner)
    && ownerVerified === true;
}

export function roomPostPermission(chat, member) {
  const type = String(chat?.type ?? '');
  if (!['group', 'supergroup', 'channel'].includes(type)) return false;
  const status = String(member?.status ?? '');
  if (!['creator','administrator','member','restricted'].includes(status)) return false;
  if (type === 'channel') {
    return status === 'creator'
      || (status === 'administrator' && member?.can_post_messages === true);
  }
  if (status === 'restricted') return member?.can_send_messages === true;
  if (status === 'member' && chat?.permissions?.can_send_messages === false) return false;
  return true;
}

export function makeTestText(label, runId) {
  if (!/^[0-9]{1,20}$/u.test(String(runId))) throw new Error('RUN_ID_INVALID');
  return [
    '🧪 [Telegram 연결 테스트]',
    '',
    '대상: ' + label,
    '유형: 관리자 승인 6방 전달 점검',
    '이 메시지는 테스트이며 투자 신호·실제 주문·체결이 아닙니다.',
    '검증 Run: ' + String(runId),
  ].join('\n');
}

export function createSanitizedReceipt(mainSha, pm2Sha, markerSha, pm2Online, activationApproved) {
  return {
    schemaVersion:'telegram-sixroom-owner-test-send-v1',
    mainSha:safeSha(mainSha),
    pm2Sha:safeSha(pm2Sha),
    markerSha:safeSha(markerSha),
    pm2Online:pm2Online === true,
    activationApproved:activationApproved === true,
    vaultValid:false,
    botIdentityVerified:false,
    roomsVerified:false,
    roomResults:Object.fromEntries(ROOM_CODES.map(code=>[code, NO_RESULT])),
    telegramSends:0,
    telegramAccepted:0,
    dbWrites:0,
    financialMutations:0,
    webhookMutations:0,
    tradingAuthorityModified:false,
    secretValuesRecorded:false,
    classification:'NOT_STARTED',
  };
}

/** Purely injected API for deterministic tests. One send attempt per room.
 * Once the first send fails/returns ambiguous, STOP: do not auto-retry.
 */
export async function performSixRoomDelivery({
  mainSha, pm2Sha, markerSha, pm2Online, activationApproved,
  rooms, owner, ownerVerified, botToken, expectedBotUsername, runId,
  botGet, botSend,
}) {
  const record=createSanitizedReceipt(mainSha,pm2Sha,markerSha,pm2Online,activationApproved);
  if (!record.mainSha || !record.pm2Sha || !record.markerSha
    || !record.pm2Online || record.pm2Sha !== record.markerSha) {
    record.classification='PM2_IDENTITY_BLOCKED';
    return record;
  }
  record.vaultValid=verifyVaultSixRooms(rooms,owner,ownerVerified);
  if (!record.vaultValid) {
    record.classification='VAULT_BINDING_BLOCKED';
    return record;
  }
  if (!record.activationApproved) {
    record.classification='TELEGRAM_ACTIVATION_DISABLED';
    return record;
  }
  if (typeof botToken!=='string'
    || !/^[0-9]{6,20}:[A-Za-z0-9_-]{20,}$/u.test(botToken)
    || !/^[A-Za-z0-9_]{3,64}$/u.test(String(expectedBotUsername).replace(/^@/u,''))) {
    record.classification='BOT_IDENTITY_UNCONFIGURED';
    return record;
  }
  const expectedName=String(expectedBotUsername).replace(/^@/u,'').toLowerCase();
  let bot=null;
  try { bot=await botGet('getMe',{}); } catch {}
  if (bot?.is_bot !== true || !Number.isSafeInteger(bot?.id)
    || bot.id<=0 || String(bot?.username??'').toLowerCase()!==expectedName) {
    record.classification='BOT_IDENTITY_UNVERIFIED';
    return record;
  }
  record.botIdentityVerified=true;

  // All six rooms must pass before the first (non-reversible) send.
  for (const [key, [label]] of Object.entries(ROOM_KEYS)) {
    try {
      const chat=await botGet('getChat',{chat_id:rooms[key]});
      const membership=await botGet('getChatMember',{
        chat_id:rooms[key], user_id:bot.id,
      });
      record.roomResults[label]=roomPostPermission(chat,membership)
        ? 'PREFLIGHT_PASS' : 'POST_PERMISSION_BLOCKED';
    } catch {
      record.roomResults[label]='ROOM_API_UNREACHABLE';
    }
  }
  if (Object.values(record.roomResults).some(v=>v!=='PREFLIGHT_PASS')) {
    record.classification='SIX_ROOM_PERMISSION_BLOCKED';
    return record;
  }
  record.roomsVerified=true;
  for (const [key,[label,title]] of Object.entries(ROOM_KEYS)) {
    record.telegramSends+=1;
    let message=null;
    try {
      message=await botSend({
        chat_id:rooms[key],
        text:makeTestText(title,runId),
        disable_notification:true,
        protect_content:true,
        link_preview_options:{is_disabled:true},
      });
    } catch {}
    if (!Number.isSafeInteger(message?.message_id) || message.message_id<=0) {
      record.roomResults[label]='SEND_UNCONFIRMED';
      record.classification='PARTIAL_OR_UNKNOWN_DELIVERY';
      return record;
    }
    record.telegramAccepted+=1;
    record.roomResults[label]='SENT_CONFIRMED';
  }
  record.classification='SIX_ROOM_DELIVERY_CONFIRMED';
  return record;
}

function parseDatabaseTarget(dbUrl, runtimeUrl) {
  const site=new URL(String(runtimeUrl??''));
  const match=/^([a-z0-9]{10,})\.supabase\.co$/iu.exec(site.hostname);
  if(site.protocol!=='https:'||!match) throw new Error('SUPABASE_PROJECT_MISMATCH');
  const project=match[1];
  const db=new URL(String(dbUrl??''));
  const username=decodeURIComponent(db.username);
  const direct=db.hostname==='db.'+project+'.supabase.co' && username==='postgres';
  const pooler=/(^|\.)pooler\.supabase\.com$/iu.test(db.hostname)
    && username==='postgres.'+project;
  if (!['postgres:','postgresql:'].includes(db.protocol)
    || !(direct||pooler) || decodeURIComponent(db.pathname)!=='/postgres'
    || !['5432','6543'].includes(db.port||'5432') || !db.password) {
    throw new Error('SUPABASE_PROJECT_MISMATCH');
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

function readVault(productionDbUrl, runtime) {
  const target=parseDatabaseTarget(productionDbUrl,runtime.SUPABASE_URL||runtime.VITE_SUPABASE_URL);
  const env={...process.env};
  for (const key of Object.keys(env)) {
    if (key.startsWith('PG')||key==='PROD_DATABASE_URL') delete env[key];
  }
  Object.assign(env,{
    PGHOST:target.host,PGPORT:target.port,PGUSER:target.user,
    PGPASSWORD:target.password,PGDATABASE:target.database,
    PGSSLMODE:'require',PGCONNECT_TIMEOUT:'10',
  });
  const result=spawnSync('psql',['-X','-qAt','-v','ON_ERROR_STOP=1'],{
    input:VAULT_SQL,encoding:'utf8',env,timeout:20000,maxBuffer:100000,
    stdio:['pipe','pipe','pipe'],
  });
  if(result.error||result.status!==0||!result.stdout?.trim()) {
    throw new Error('VAULT_READ_UNAVAILABLE');
  }
  const proof=JSON.parse(result.stdout.trim());
  if(proof.roomsUnique!==true||proof.ownerUnique!==true) {
    throw new Error('VAULT_NONUNIQUE');
  }
  return proof;
}

/** GET (verification) and POST (sendMessage) to Telegram only, forced IPv4.
 * Errors are consumed without printing request paths (contain bot token).
 * No automatic retry of a POST, even after a timeout.
 */
async function callTelegram(botToken,method,params={}) {
  if (!['getMe','getChat','getChatMember','sendMessage'].includes(method)) {
    throw new Error('METHOD_NOT_ALLOWED');
  }
  const isPost=method==='sendMessage';
  const url=new URL('https://api.telegram.org/bot'+botToken+'/'+method);
  if(!isPost) for(const [key,val] of Object.entries(params)) {
    url.searchParams.set(key,String(val));
  }
  const data=isPost?Buffer.from(JSON.stringify(params),'utf8'):null;
  return await new Promise(resolve=>{
    let settled=false;
    let req=null;
    const finish=(data)=>{if(!settled){settled=true;resolve(data);}};
    try {
      req=httpsRequest(url,{
        method:isPost?'POST':'GET',family:4,autoSelectFamily:false,timeout:15000,
        headers:isPost?{'Content-Type':'application/json','Content-Length':data.length,
          Accept:'application/json'}:{Accept:'application/json'},
      },response=>{
        const chunks=[];let bytes=0;
        response.on('data',chunk=>{
          bytes+=chunk.length;
          if(bytes>65536){response.destroy();finish(null);return;}
          chunks.push(chunk);
        });
        response.on('error',()=>finish(null));
        response.on('end',()=>{
          let body=null;
          try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
          finish(response.statusCode===200&&body?.ok===true?body.result??null:null);
        });
      });
      req.on('timeout',()=>req.destroy());
      req.on('error',()=>finish(null));
      if(data)req.write(data);
      req.end();
    } catch {finish(null);}
  });
}

export async function runProtectedTestSend() {
  const mainSha=safeSha(process.env.TELEGRAM_TEST_MAIN_SHA);
  const runId=String(process.env.TELEGRAM_TEST_RUN_ID??'');
  let record=createSanitizedReceipt(mainSha,null,null,false,false);
  try {
    if (!mainSha || !/^[0-9]{1,20}$/u.test(runId)) {
      record.classification='INVALID_OWNER_COMMAND';
      return record;
    }
    const processes=JSON.parse(execFileSync('pm2',['jlist'],{
      encoding:'utf8',timeout:10000,maxBuffer:20000000,
    }));
    const matches=Array.isArray(processes)?
      processes.filter(p=>p?.name==='stock-app'):[];
    if(matches.length!==1) {
      record.classification='PM2_NOT_UNIQUE';
      return record;
    }
    const runtime=matches[0].pm2_env??{};
    const pm2Sha=safeSha(runtime.DEPLOY_SHA);
    let marker=null;
    try{marker=safeSha(readFileSync('/opt/stock-app/.deploy/current-sha','utf8'));}catch{}
    const online=runtime.status==='online';
    const activated=runtime.LIVE_TELEGRAM_ACTIVATION_APPROVED==='true';
    record=createSanitizedReceipt(mainSha,pm2Sha,marker,online,activated);
    if (!pm2Sha || !marker || pm2Sha!==marker || !online) {
      record.classification='PM2_IDENTITY_BLOCKED';
      return record;
    }
    const proof=readVault(process.env.PROD_DATABASE_URL,runtime);
    return await performSixRoomDelivery({
      mainSha,pm2Sha,markerSha:marker,pm2Online:online,activationApproved:activated,
      rooms:proof.rooms,owner:proof.owner,ownerVerified:proof.ownerVerified,
      botToken:String(runtime.TELEGRAM_BOT_TOKEN??'').trim(),
      expectedBotUsername:String(runtime.TELEGRAM_BOT_USERNAME??''),
      runId,
      botGet:(m,p)=>callTelegram(String(runtime.TELEGRAM_BOT_TOKEN??'').trim(),m,p),
      botSend:p=>callTelegram(String(runtime.TELEGRAM_BOT_TOKEN??'').trim(),'sendMessage',p),
    });
  } catch {
    record.classification='TEST_PREFLIGHT_FAILED';
    return record;
  }
}

if (process.env.TELEGRAM_SIXROOM_TEST_SEND_EXECUTE==='true') {
  const record=await runProtectedTestSend();
  process.stdout.write(JSON.stringify(record)+'\n');
}
