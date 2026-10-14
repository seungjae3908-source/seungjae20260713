/**
 * Owner-only personal Telegram 1:1 ONE-SHOT TEST.
 * Strict read-only Vault/connection lookup, GET getMe/getChat and max ONE
 * Telegram sendMessage. No events, deliveries, link revocation, orders or retry.
 * No private identifiers, bot paths, tokens or SQL error bodies in output.
 */
import {execFileSync, spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {request as httpsRequest} from 'node:https';

const SHA=/^[a-f0-9]{40}$/u;
const CHAT=/^[1-9][0-9]{5,18}$/u;
const USERNAME=/^@?[A-Za-z0-9_]{3,64}$/u;
const TOKEN=/^[0-9]{6,20}:[A-Za-z0-9_-]{20,}$/u;
const safeSha=v=>typeof v==='string'&&SHA.test(v)?v:null;
const safeChat=v=>typeof v==='string'&&CHAT.test(v)?v:null;

export function personalOwnerTestText(runId) {
 if(!/^[1-9][0-9]{0,19}$/u.test(String(runId)))throw Error('TEST_RUN_ID_INVALID');
 return [
  '🧪 [개인 텔레그램 연결 테스트]',
  '',
  '대상: 관리자 개인 채팅',
  '유형: 관리자 승인 1:1 수신 확인',
  '투자 신호·실제 주문·체결·매매 지시가 아닙니다.',
  '검증 Run: '+String(runId),
 ].join('\n');
}
export function validateOwnerPersonalBinding(binding) {
 if(!binding||typeof binding!=='object'||Array.isArray(binding))return false;
 return binding.ownerUnique===true && binding.ownerVerified===true
  && binding.ownerConnections===1 && binding.allActiveConnections===1
  && safeChat(binding.privateChatId)!==null
  && binding.telegramUserId===binding.privateChatId;
}
export function createPersonalTestReceipt(mainSha,pm2Sha,markerSha,online,approved) {
 return {
  schemaVersion:'telegram-owner-personal-one-shot-test-v1',
  mainSha:safeSha(mainSha),pm2Sha:safeSha(pm2Sha),markerSha:safeSha(markerSha),
  pm2Online:online===true,activationApproved:approved===true,
  ownerVerified:false,privateChatVerified:false,botIdentityVerified:false,
  telegramSends:0,telegramAccepted:0,
  dbWrites:0,connectionMutations:0,webhookMutations:0,financialMutations:0,
  secretValuesRecorded:false,classification:'NOT_STARTED',
 };
}
export async function performOwnerPersonalTest({
 mainSha,pm2Sha,markerSha,pm2Online,activationApproved,
 binding,botToken,expectedBotUsername,runId,botGet,botSend,
}) {
 const result=createPersonalTestReceipt(mainSha,pm2Sha,markerSha,pm2Online,activationApproved);
 if(!result.mainSha||!result.pm2Sha||!result.markerSha||!result.pm2Online
    ||result.pm2Sha!==result.markerSha){
  result.classification='PM2_IDENTITY_BLOCKED';return result;
 }
 if(!result.activationApproved){
  result.classification='TELEGRAM_ACTIVATION_DISABLED';return result;
 }
 if(!validateOwnerPersonalBinding(binding)){
  result.classification='PERSONAL_OWNER_BINDING_BLOCKED';return result;
 }
 result.ownerVerified=true;
 if(!TOKEN.test(String(botToken||''))||!USERNAME.test(String(expectedBotUsername||''))){
  result.classification='BOT_IDENTITY_UNCONFIGURED';return result;
 }
 let text;
 try{text=personalOwnerTestText(runId);}
 catch{result.classification='INVALID_RUN_ID';return result;}
 const username=String(expectedBotUsername).replace(/^@/u,'').toLowerCase();
 let bot;
 try{bot=await botGet('getMe',{});}catch{}
 if(bot?.is_bot!==true||!Number.isSafeInteger(bot.id)||bot.id<1
    ||String(bot.username||'').toLowerCase()!==username){
  result.classification='BOT_IDENTITY_UNVERIFIED';return result;
 }
 result.botIdentityVerified=true;
 let chat;
 try{chat=await botGet('getChat',{chat_id:binding.privateChatId});}catch{}
 if(chat?.type!=='private'||String(chat.id??'')!==binding.privateChatId){
  result.classification='PERSONAL_CHAT_UNVERIFIED';return result;
 }
 result.privateChatVerified=true;
 // A remote POST is non-idempotent. One attempt max, with no retry on timeout.
 result.telegramSends=1;
 let message;
 try{
  message=await botSend({
   chat_id:binding.privateChatId,text,
   disable_notification:true,protect_content:true,
   link_preview_options:{is_disabled:true},
  });
 }catch{}
 if(!Number.isSafeInteger(message?.message_id)||message.message_id<=0
   ||String(message?.chat?.id??'')!==binding.privateChatId){
  result.classification='PERSONAL_SEND_UNCONFIRMED';return result;
 }
 result.telegramAccepted=1;
 result.classification='PERSONAL_BOT_API_ACCEPTED';
 return result;
}
function parseDatabaseTarget(dbUrl,runtimeUrl){
 const supabase=new URL(String(runtimeUrl||''));
 const m=/^([a-z0-9]{10,})\.supabase\.co$/iu.exec(supabase.hostname);
 if(supabase.protocol!=='https:'||!m)throw Error('DB_TARGET_NOT_VERIFIED');
 const db=new URL(String(dbUrl||'')), ref=m[1], user=decodeURIComponent(db.username);
 const direct=db.hostname==='db.'+ref+'.supabase.co'&&user==='postgres';
 const pooler=/(^|\.)pooler\.supabase\.com$/iu.test(db.hostname)&&user==='postgres.'+ref;
 if(!['postgres:','postgresql:'].includes(db.protocol)
    ||!(direct||pooler)||decodeURIComponent(db.pathname)!=='/postgres'
    ||!['5432','6543'].includes(db.port||'5432')||!db.password)
    throw Error('DB_TARGET_NOT_VERIFIED');
 return {host:db.hostname,port:db.port||'5432',
  user,password:decodeURIComponent(db.password),database:'postgres'};
}
// No account/credential/portfolio mutations or SELECT *; only one uniquely
// approved owner private Telegram address, kept inside protected host RAM.
const SQL=[
 'BEGIN READ ONLY;',
 'WITH owner AS (SELECT decrypted_secret::text AS id FROM vault.decrypted_secrets',
 " WHERE name='telegram_sixroom_owner_member_id_v1'),",
 'matching AS (SELECT t.telegram_chat_id,t.telegram_user_id FROM',
 ' public.telegram_connections t JOIN public.profiles p ON p.id=t.user_id',
 ' WHERE t.user_id::text=(SELECT id FROM owner)',
 " AND t.status='ACTIVE' AND t.revoked_at IS NULL",
 " AND p.is_active IS TRUE AND lower(p.role) IN ('owner','admin','super_admin')",
 " AND lower(p.status::text)='approved'",
 ' AND (p.membership_expires_at IS NULL OR p.membership_expires_at>now()))',
 "SELECT jsonb_build_object('ownerUnique',(SELECT count(*)=1 FROM owner),",
 " 'ownerVerified',(SELECT count(*)=1 FROM matching),",
 " 'ownerConnections',(SELECT count(*) FROM matching),",
 " 'allActiveConnections',(SELECT count(*) FROM public.telegram_connections",
 "   WHERE status='ACTIVE' AND revoked_at IS NULL),",
 " 'privateChatId',(SELECT telegram_chat_id FROM matching),",
 " 'telegramUserId',(SELECT telegram_user_id FROM matching))::text;",
 'COMMIT;',
].join('\n');
function readOwnerConnection(dbUrl,runtime){
 const target=parseDatabaseTarget(dbUrl,runtime.SUPABASE_URL||runtime.VITE_SUPABASE_URL);
 const env={...process.env};
 for(const key of Object.keys(env)){
  if(key.startsWith('PG')||key==='PROD_DATABASE_URL')delete env[key];
 }
 Object.assign(env,{
  PGHOST:target.host,PGPORT:target.port,PGUSER:target.user,
  PGPASSWORD:target.password,PGDATABASE:target.database,PGSSLMODE:'require',
  PGCONNECT_TIMEOUT:'10',PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=12000',
 });
 const response=spawnSync('psql',['-X','-qAt','-v','ON_ERROR_STOP=1'],{
  input:SQL,encoding:'utf8',timeout:20000,maxBuffer:16384,
  env,stdio:['pipe','pipe','pipe'],
 });
 if(response.error||response.status!==0)throw Error('OWNER_CONNECTION_READ_UNAVAILABLE');
 return JSON.parse(String(response.stdout||'').trim());
}
async function telegramApi(token,method,params={}){
 if(!['getMe','getChat','sendMessage'].includes(method))throw Error('METHOD_NOT_ALLOWED');
 const send=method==='sendMessage';
 const url=new URL('https://api.telegram.org/bot'+token+'/'+method);
 if(!send)for(const [name,value] of Object.entries(params))url.searchParams.set(name,String(value));
 const bytes=send?Buffer.from(JSON.stringify(params),'utf8'):null;
 return await new Promise(resolve=>{
  let done=false,request;
  const finish=value=>{if(!done){done=true;resolve(value);}};
  try{
   request=httpsRequest(url,{
    method:send?'POST':'GET',family:4,autoSelectFamily:false,timeout:15000,
    headers:send?{'Content-Type':'application/json','Content-Length':bytes.length,
      Accept:'application/json'}:{Accept:'application/json'},
   },response=>{
    let size=0;const chunks=[];
    response.on('data',part=>{
     size+=part.length;
     if(size>32768){response.destroy();finish(null);}
     else chunks.push(part);
    });
    response.on('error',()=>finish(null));
    response.on('end',()=>{
     let payload;try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
     finish(response.statusCode===200&&payload?.ok===true?payload.result??null:null);
    });
   });
   request.on('timeout',()=>request.destroy());
   request.on('error',()=>finish(null));
   if(bytes)request.write(bytes);
   request.end();
  }catch{finish(null);}
 });
}
export async function runProtectedOwnerPersonalTest(){
 const mainSha=safeSha(process.env.TELEGRAM_OWNER_PERSONAL_MAIN_SHA);
 const runId=String(process.env.TELEGRAM_OWNER_PERSONAL_RUN_ID??'');
 let result=createPersonalTestReceipt(mainSha,null,null,false,false);
 try{
  if(!mainSha||!personalOwnerTestText(runId)){
   result.classification='INVALID_OWNER_COMMAND';return result;
  }
  const list=JSON.parse(execFileSync('pm2',['jlist'],{
   encoding:'utf8',timeout:10000,maxBuffer:20000000,stdio:['ignore','pipe','pipe'],
  }));
  const rows=Array.isArray(list)?list.filter(row=>row?.name==='stock-app'):[];
  if(rows.length!==1){result.classification='PM2_NOT_UNIQUE';return result;}
  const runtime=rows[0]?.pm2_env??{};
  const pm2Sha=safeSha(runtime.DEPLOY_SHA);
  let markerSha=null;
  try{markerSha=safeSha(readFileSync('/opt/stock-app/.deploy/current-sha','utf8').trim());}
  catch{}
  const online=runtime.status==='online', approved=runtime.LIVE_TELEGRAM_ACTIVATION_APPROVED==='true';
  result=createPersonalTestReceipt(mainSha,pm2Sha,markerSha,online,approved);
  if(!pm2Sha||!markerSha||pm2Sha!==markerSha||!online||!approved){
   result.classification='PM2_OR_ACTIVATION_BLOCKED';return result;
  }
  const binding=readOwnerConnection(process.env.PROD_DATABASE_URL,runtime);
  const token=String(runtime.TELEGRAM_BOT_TOKEN??'').trim();
  return await performOwnerPersonalTest({
   mainSha,pm2Sha,markerSha,pm2Online:online,activationApproved:approved,
   binding,botToken:token,expectedBotUsername:String(runtime.TELEGRAM_BOT_USERNAME??''),
   runId,botGet:(method,params)=>telegramApi(token,method,params),
   botSend:params=>telegramApi(token,'sendMessage',params),
  });
 }catch{
  result.classification='PERSONAL_PREFLIGHT_FAILED';return result;
 }
}
if(process.env.TELEGRAM_OWNER_PERSONAL_TEST_EXECUTE==='true'){
 const result=await runProtectedOwnerPersonalTest();
 process.stdout.write(JSON.stringify(result)+'\n');
}
