/** Strict opt-in read-only Watch event-log adapter. The Stage-1 watcher is
 * a separately approved service; this module does NOT start or configure it.
 * Production source is fixed, never a URL/user path. Root override is only for
 * injected, disposable Node unit-test fixtures.
 */
import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {join} from 'node:path';
import {emptyV3WatchHandoff,verifyV3WatchHandoff} from './public-watch-v3-priority.mjs';
const ROOT='/var/lib/investment-research-production';
const SHA=/^[a-f0-9]{40}$/u;
async function safeDirectory(path){
  const stat=await lstat(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o022)!==0)
    throw Error('PUBLIC_WATCH_PATH_UNSAFE');
}
async function safeBoundedFile(path,{maxBytes,tailBytes=null}={}){
  const pre=await lstat(path);
  if(!pre.isFile()||pre.isSymbolicLink()||pre.nlink!==1
    ||(pre.mode&0o022)!==0||!Number.isSafeInteger(pre.size)
    ||pre.size<1||pre.size>maxBytes)
    throw Error('PUBLIC_WATCH_FILE_UNSAFE');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const post=await handle.stat();
    if(!post.isFile()||post.ino!==pre.ino||post.dev!==pre.dev
      ||post.size!==pre.size||post.nlink!==1||(post.mode&0o022)!==0)
      throw Error('PUBLIC_WATCH_FILE_CHANGED');
    const begin=tailBytes===null?0:Math.max(0,post.size-tailBytes);
    const size=post.size-begin;
    const buffer=Buffer.alloc(size);
    let got=0;
    while(got<size){
      const n=(await handle.read(buffer,got,size-got,begin+got)).bytesRead;
      if(n<=0)throw Error('PUBLIC_WATCH_FILE_SHORT_READ');
      got+=n;
    }
    let content=buffer.toString('utf8');
    if(begin>0){
      const newline=content.indexOf('\n');
      if(newline<0)throw Error('PUBLIC_WATCH_EVENT_LOG_TRUNCATED');
      content=content.slice(newline+1);
    }
    return content;
  }finally{await handle.close();}
}
/** Only sanitized OS errors can reach the V3 Watch status. No raw paths or secrets. */
export function classifyV3WatchReadError(error){
  if(error?.code==='EACCES'||error?.code==='EPERM')
    return 'WATCH_PERMISSION_DENIED';
  if(error?.code==='ENOENT')return 'WATCH_NOT_PUBLISHED';
  if(['PUBLIC_WATCH_PATH_UNSAFE','PUBLIC_WATCH_FILE_UNSAFE',
    'PUBLIC_WATCH_FILE_CHANGED','PUBLIC_WATCH_FILE_SHORT_READ',
    'PUBLIC_WATCH_EVENT_LOG_TRUNCATED'].includes(error?.message))
    return 'WATCH_INPUT_UNSAFE';
  if(error instanceof SyntaxError)return 'WATCH_INPUT_INVALID_JSON';
  return 'SOURCE_UNAVAILABLE';
}
export async function readV3StageOneWatch({
  enabled=false,expectedResearchSha,nowMs=Date.now(),root=ROOT,
}={}){
  if(enabled!==true)return emptyV3WatchHandoff('DISABLED');
  if(!SHA.test(expectedResearchSha??''))
    return emptyV3WatchHandoff('UNCONFIGURED');
  try{
    await safeDirectory(root);
    await safeDirectory(join(root,'latest'));
    const statusText=await safeBoundedFile(
      join(root,'latest','lightweight-market-watch.json'),{maxBytes:65_536});
    const raw=JSON.parse(statusText);
    // Check the exact, fresh watch proof before accessing a second file.
    const base=verifyV3WatchHandoff(raw,[],{nowMs,expectedResearchSha});
    if(!['EVENT_COUNT_MISMATCH','VALIDATED','PARTIAL_SOURCE'].includes(base.status))
      return base;
    if(raw.newCandidateCount===0)return base;
    const observed=new Date(raw.observedAt);
    if(!Number.isFinite(observed.getTime())
      ||observed.getTime()>nowMs+5000
      ||nowMs-observed.getTime()>180_000)
      return emptyV3WatchHandoff('SOURCE_STALE');
    await safeDirectory(join(root,'watch'));
    await safeDirectory(join(root,'watch','events'));
    const day=observed.toISOString().slice(0,10);
    const text=await safeBoundedFile(join(root,'watch','events',day+'.jsonl'),{
      maxBytes:64*1024*1024,tailBytes:262_144,
    });
    if(!text.endsWith('\n'))return emptyV3WatchHandoff('EVENT_LOG_INVALID');
    const lines=text.split('\n').filter(Boolean);
    if(lines.length>1024||lines.some(s=>Buffer.byteLength(s,'utf8')>16_384))
      return emptyV3WatchHandoff('EVENT_LOG_INVALID');
    const events=lines.map(s=>JSON.parse(s));
    return verifyV3WatchHandoff(raw,events,{nowMs,expectedResearchSha});
  }catch(error){
    return emptyV3WatchHandoff(classifyV3WatchReadError(error));
  }
}
