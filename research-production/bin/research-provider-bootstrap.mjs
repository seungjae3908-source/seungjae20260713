#!/usr/bin/env node
import { constants } from 'node:fs';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { parseEnv } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);
const APP_ENV_RELATIVE=Object.freeze([
  '.env','.env.production','api-server/.env','api-server/.env.production',
]);
const PROVIDER_KEYS=Object.freeze([
  'YOUTUBE_DATA_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','GROQ_API_KEY',
]);
const MAX_ENV_BYTES=128*1024;
const KEY_PATTERN=/^[A-Za-z0-9_.-]{8,512}$/;
const SECRET_KEY_PATTERN=/(?:SUPABASE|DATABASE|POSTGRES|BITGET|UPBIT|KIWOOM|TOSS|TELEGRAM|PASSWORD|PRIVATE|ACCOUNT|JWT|SERVICE_ROLE)/i;

function clean(value){return typeof value==='string'?value.trim():'';}
function safePath(root,relative){
  const p=resolve(root,relative),prefix=resolve(root)+'/';
  if(!p.startsWith(prefix))throw new Error('PROVIDER_BOOTSTRAP_PATH_INVALID');
  return p;
}
async function readEnvOptional(path){
  let h;
  try{
    h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=await h.stat();
    if(!before.isFile()||before.size>MAX_ENV_BYTES||before.size<0)throw new Error('PROVIDER_BOOTSTRAP_ENV_UNSAFE');
    const bytes=Buffer.alloc(before.size);let offset=0;
    while(offset<bytes.length){const chunk=await h.read(bytes,offset,bytes.length-offset,offset);if(!chunk.bytesRead)break;offset+=chunk.bytesRead;}
    const after=await h.stat();
    if(offset!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('PROVIDER_BOOTSTRAP_ENV_CHANGED');
    return parseEnv(bytes.toString('utf8'));
  }catch(error){if(error?.code==='ENOENT'||error?.code==='ELOOP')return null;throw error;}finally{await h?.close();}
}
function collect(target,source,label){
  if(!source||typeof source!=='object'||Array.isArray(source))return;
  for(const key of PROVIDER_KEYS){
    const value=clean(source[key]);
    if(!value)continue;
    if(!KEY_PATTERN.test(value))throw new Error('PROVIDER_BOOTSTRAP_VALUE_INVALID');
    const row=target.get(key)??[];
    row.push({label,value});target.set(key,row);
  }
}
function resolvedValue(target,key){
  const rows=target.get(key)??[],values=[...new Set(rows.map(r=>r.value))];
  if(values.length>1)return {state:'CONFLICT',value:null,sources:rows.map(r=>r.label)};
  if(values.length===1)return {state:'PRESENT',value:values[0],sources:rows.map(r=>r.label)};
  return {state:'MISSING',value:null,sources:[]};
}
async function pm2Environment(processName){
  try{
    const {stdout}=await execFileAsync('pm2',['jlist'],{timeout:3000,maxBuffer:4*1024*1024,encoding:'utf8'});
    const rows=JSON.parse(stdout);
    if(!Array.isArray(rows))return null;
    const matches=rows.filter(row=>row?.name===processName&&row?.pm2_env&&typeof row.pm2_env==='object'&&!Array.isArray(row.pm2_env));
    return matches.length===1?matches[0].pm2_env:null;
  }catch{return null;}
}
export async function discoverResearchProviderConfig({
  appRoot='/opt/stock-app',processName='stock-app',includePm2=true,
}={}){
  const root=resolve(appRoot),found=new Map(),sources=[];
  for(const relative of APP_ENV_RELATIVE){
    const path=safePath(root,relative),env=await readEnvOptional(path);
    if(!env)continue;sources.push(relative);collect(found,env,relative);
  }
  if(includePm2){
    const env=await pm2Environment(processName);
    if(env){sources.push('PM2_SELECTED_PROCESS');collect(found,env,'PM2_SELECTED_PROCESS');}
  }
  const raw=Object.fromEntries(PROVIDER_KEYS.map(key=>[key,resolvedValue(found,key)]));
  const geminiCandidates=[raw.GEMINI_API_KEY,raw.GOOGLE_API_KEY].filter(x=>x.state==='PRESENT');
  const geminiValues=[...new Set(geminiCandidates.map(x=>x.value))];
  const gemini=raw.GEMINI_API_KEY.state==='CONFLICT'||raw.GOOGLE_API_KEY.state==='CONFLICT'||geminiValues.length>1
    ? {state:'CONFLICT',value:null}
    : geminiValues.length===1?{state:'PRESENT',value:geminiValues[0]}:{state:'MISSING',value:null};
  const status={
    youtube:raw.YOUTUBE_DATA_API_KEY.state,
    gemini:gemini.state,
    groq:raw.GROQ_API_KEY.state,
  };
  return Object.freeze({
    schemaVersion:'research-provider-bootstrap-v1',
    appRoot:root,
    sources:Object.freeze(sources),
    providers:Object.freeze(status),
    fullStackReady:Object.values(status).every(x=>x==='PRESENT'),
    conflicts:Object.entries(status).filter(([,state])=>state==='CONFLICT').map(([name])=>name),
    _values:Object.freeze({
      youtube:raw.YOUTUBE_DATA_API_KEY.value,
      gemini:gemini.value,
      groq:raw.GROQ_API_KEY.value,
    }),
  });
}
function publicStatus(result){
  return {
    schemaVersion:result.schemaVersion,
    appRoot:result.appRoot,
    sources:result.sources,
    providers:result.providers,
    fullStackReady:result.fullStackReady,
    conflicts:result.conflicts,
    credentialValuesExposed:false,
    executionAuthority:'NONE',
    liveTrading:false,
    privateTradingApiAllowed:false,
  };
}
async function atomic(path,text){
  await mkdir(dirname(path),{recursive:true,mode:0o750});
  const temp=`${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp,text,{mode:0o600,flag:'wx'});
  await rename(temp,path);
}
export async function materializeResearchProviderEnv({appRoot='/opt/stock-app',outputRoot='/etc/investment-research',processName='stock-app',includePm2=true}={}){
  const result=await discoverResearchProviderConfig({appRoot,processName,includePm2});
  if(result.conflicts.length)throw new Error('PROVIDER_BOOTSTRAP_CONFLICT');
  if(!result.fullStackReady)throw new Error('PROVIDER_BOOTSTRAP_FULL_STACK_REQUIRED');
  const values=result._values;
  const rows=[
    '# Auto-materialized provider-only Research environment. No trading/account secrets are copied.',
    `YOUTUBE_DATA_API_KEY=${values.youtube}`,
    `GEMINI_API_KEY=${values.gemini}`,
    'GEMINI_MODEL=gemini-3.1-flash-lite',
    `GROQ_API_KEY=${values.groq}`,
    'GROQ_MODEL=openai/gpt-oss-20b',
    '',
  ];
  const serialized=rows.join('\n');
  if(SECRET_KEY_PATTERN.test(serialized.replace(/^(?:YOUTUBE_DATA_API_KEY|GEMINI_API_KEY|GROQ_API_KEY)=.*$/gm,'')))throw new Error('PROVIDER_BOOTSTRAP_SCOPE_VIOLATION');
  const target=join(resolve(outputRoot),'research-providers.env');
  await atomic(target,serialized);
  return {...publicStatus(result),materialized:true,target,credentialValuesExposed:false};
}
function parse(argv){
  const command=argv[2]??'preflight',options={};
  for(let i=3;i<argv.length;i+=1){
    const key=argv[i];if(!key.startsWith('--'))throw new Error('PROVIDER_BOOTSTRAP_ARGUMENT_INVALID');
    const value=argv[++i];if(!value||value.startsWith('--'))throw new Error('PROVIDER_BOOTSTRAP_ARGUMENT_INVALID');
    options[key.slice(2)]=value;
  }
  return {command,options};
}
if(import.meta.url===new URL(`file://${process.argv[1]}`).href){
  try{
    const {command,options}=parse(process.argv);
    const common={appRoot:options['app-root']??'/opt/stock-app',processName:options['process-name']??'stock-app',includePm2:options['include-pm2']!=='false'};
    if(command==='preflight'){
      const result=await discoverResearchProviderConfig(common);
      console.log(JSON.stringify(publicStatus(result),null,2));
      if(!result.fullStackReady)process.exitCode=2;
    }else if(command==='materialize'){
      const result=await materializeResearchProviderEnv({...common,outputRoot:options['output-root']??'/etc/investment-research'});
      console.log(JSON.stringify(result,null,2));
    }else throw new Error('PROVIDER_BOOTSTRAP_COMMAND_INVALID');
  }catch(error){
    console.error(JSON.stringify({status:'failed_closed',reason:String(error?.message??error).slice(0,160),credentialValuesExposed:false,executionAuthority:'NONE'},null,2));
    process.exitCode=1;
  }
}
