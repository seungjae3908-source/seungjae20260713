#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve, sep } from 'node:path';

const SHA40=/^[0-9a-f]{40}$/u;
const TASK_ID=/^[a-z0-9][a-z0-9-]{1,80}$/u;
const SAFE_TOKEN=/^[A-Z0-9_]{2,128}$/u;

function text(value){
  return typeof value==='string'&&value.trim()?value.trim():null;
}

export function resolveResearchTaskStderrPathV1({
  cycle,
  stateRoot,
  taskId,
  targetSha,
}={}){
  const root=text(stateRoot);
  const id=text(taskId);
  const sha=text(targetSha)?.toLowerCase();
  if(!root||!isAbsolute(root)) throw new TypeError('stateRoot must be absolute');
  if(!id||!TASK_ID.test(id)) throw new TypeError('taskId invalid');
  if(!sha||!SHA40.test(sha)) throw new TypeError('targetSha invalid');
  if(!cycle||typeof cycle!=='object'||Array.isArray(cycle)) return null;
  if(cycle.researchSha!==sha) return null;
  const row=(Array.isArray(cycle.results)?cycle.results:[])
    .find((item)=>item?.id===id&&item?.status==='failed');
  const candidate=text(row?.stderrPath);
  if(!candidate||!isAbsolute(candidate)) return null;
  const resolved=resolve(candidate);
  const runsRoot=`${join(resolve(root),'runs')}${sep}`;
  if(!resolved.startsWith(runsRoot)) return null;
  if(!resolved.endsWith(`${sep}${id}${sep}stderr.log`)) return null;
  return resolved;
}

function safeSignatures(source){
  const signatures=new Set();
  const domain=/\b(?:PAPER_FORWARD|PAPER_STATE|AUTHORITATIVE|SHADOW|ETH_V6|RESEARCH)_[A-Z0-9_]{2,96}\b/gu;
  for(const match of source.match(domain)??[]) signatures.add(match);
  const exact=[
    'ERR_MODULE_NOT_FOUND',
    'ERR_PACKAGE_PATH_NOT_EXPORTED',
    'ERR_UNSUPPORTED_DIR_IMPORT',
    'ERR_INVALID_PACKAGE_CONFIG',
    'ERR_UNKNOWN_FILE_EXTENSION',
    'ERR_INVALID_MODULE_SPECIFIER',
    'ERR_REQUIRE_ESM',
    'MODULE_NOT_FOUND',
  ];
  for(const code of exact) if(source.includes(code)) signatures.add(code);
  if(/\bSyntaxError\b/u.test(source)) signatures.add('NODE_SYNTAX_ERROR');
  if(/\bReferenceError\b/u.test(source)) signatures.add('NODE_REFERENCE_ERROR');
  if(/\bTypeError\b/u.test(source)) signatures.add('NODE_TYPE_ERROR');
  if(/\bENOENT\b/u.test(source)) signatures.add('FS_ENOENT');
  if(/\bEACCES\b/u.test(source)) signatures.add('FS_EACCES');
  if(/\bERR_ACCESS_DENIED\b/u.test(source)) signatures.add('FS_ACCESS_DENIED');
  return [...signatures].filter((value)=>SAFE_TOKEN.test(value)).sort().slice(0,24);
}

function categoriesFor(signatures){
  const categories=new Set();
  for(const value of signatures){
    if(value.startsWith('PAPER_FORWARD_')) categories.add('PAPER_FORWARD_RUNTIME');
    else if(value.startsWith('PAPER_STATE_')) categories.add('PAPER_STATE');
    else if(value.startsWith('AUTHORITATIVE_')) categories.add('AUTHORITATIVE_RUNTIME');
    else if(value.startsWith('SHADOW_')||value.startsWith('ETH_V6_')) categories.add('SHADOW_RUNTIME');
    else if(value.startsWith('RESEARCH_')) categories.add('RESEARCH_RUNTIME');
    else if(value.startsWith('ERR_')||value.startsWith('MODULE_')||value.startsWith('NODE_')) categories.add('NODE_RUNTIME');
    else if(value.startsWith('FS_')) categories.add('FILESYSTEM');
  }
  return [...categories].sort();
}

export function buildSafeResearchTaskFailureSignatureV1({
  profile,
  taskId,
  stderrText,
}={}){
  const normalizedProfile=text(profile);
  const id=text(taskId);
  if(!normalizedProfile||!/^[a-z][a-z0-9-]{1,40}$/u.test(normalizedProfile)){
    throw new TypeError('profile invalid');
  }
  if(!id||!TASK_ID.test(id)) throw new TypeError('taskId invalid');
  const source=String(stderrText??'');
  const signatures=safeSignatures(source);
  const categories=categoriesFor(signatures);
  return Object.freeze({
    schemaVersion:'research-production-task-failure-signature-v1',
    profile:normalizedProfile,
    taskId:id,
    present:true,
    signatureCount:signatures.length,
    signatures:Object.freeze(signatures),
    categories:Object.freeze(categories.length?categories:['UNCLASSIFIED']),
    stderrTailSizeBytes:Buffer.byteLength(source,'utf8'),
    stderrTailSha256:createHash('sha256').update(source).digest('hex'),
    rawLogIncluded:false,
  });
}

function safeField(value){
  return String(value??'')
    .replace(/[^A-Za-z0-9_.:,-]/gu,'_')
    .slice(0,1024);
}

export function formatSafeResearchTaskFailureSignatureV1(value){
  if(value?.schemaVersion!=='research-production-task-failure-signature-v1'
    ||value?.present!==true
    ||value?.rawLogIncluded!==false){
    throw new TypeError('valid task failure signature required');
  }
  return [
    'TASK_FAILURE_SIGNATURE',
    `profile=${safeField(value.profile)}`,
    `id=${safeField(value.taskId)}`,
    'present=true',
    `signature_count=${value.signatureCount}`,
    `signatures=${safeField(value.signatures.length?value.signatures.join(','):'NONE')}`,
    `categories=${safeField(value.categories.join(','))}`,
    `stderr_tail_size_bytes=${value.stderrTailSizeBytes}`,
    `stderr_tail_sha256=${value.stderrTailSha256}`,
    'raw_log_included=false',
  ].join(' ');
}

async function readStdin(){
  let raw='';
  process.stdin.setEncoding('utf8');
  for await(const chunk of process.stdin) raw+=chunk;
  return raw;
}

async function main(){
  const [command,...args]=process.argv.slice(2);
  if(command==='resolve-path'){
    const [stateRoot,taskId,targetSha]=args;
    const raw=await readStdin();
    const cycle=JSON.parse(raw);
    const path=resolveResearchTaskStderrPathV1({cycle,stateRoot,taskId,targetSha});
    if(path) process.stdout.write(path);
    return;
  }
  if(command==='extract'){
    const [profile,taskId]=args;
    const raw=await readStdin();
    const value=buildSafeResearchTaskFailureSignatureV1({
      profile,
      taskId,
      stderrText:raw,
    });
    process.stdout.write(`${formatSafeResearchTaskFailureSignatureV1(value)}\n`);
    return;
  }
  throw new Error('command must be resolve-path or extract');
}

const invokedAsFile=process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname);
if(invokedAsFile){
  main().catch((error)=>{
    process.stderr.write(`[research-task-failure-signature] ${String(error?.message??error).replace(/[\r\n]+/gu,'_').slice(0,240)}\n`);
    process.exitCode=1;
  });
}
