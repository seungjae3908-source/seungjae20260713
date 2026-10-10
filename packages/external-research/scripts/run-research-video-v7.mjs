#!/usr/bin/env node
/** Manual one-shot runner. Default prepare does not access credentials or network.
 * No schedule, production policy writer or approval issuer is installed.
 */
import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir } from 'node:fs/promises';
import { isAbsolute, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareVideoResearch, videoRequestBody, executeVideoResearch } from '../src/research-workspace-video-v7.js';
const fail=code=>{throw Object.assign(new Error(code),{code});};
async function readJson(path) {
  if(!isAbsolute(path))fail('VIDEO_INPUT_ABSOLUTE_PATH_REQUIRED');
  const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const st=await h.stat();if(!st.isFile()||st.size>65536||st.nlink!==1||(st.mode&0o022)||st.uid!==process.getuid())fail('VIDEO_INPUT_FILE_UNSAFE');
    const b=Buffer.alloc(65537);let n=0;
    while(n<b.length){const r=await h.read(b,n,b.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead;}
    const after=await h.stat();if(n!==st.size||n>65536||after.size!==st.size||after.mtimeMs!==st.mtimeMs||after.ctimeMs!==st.ctimeMs)fail('VIDEO_INPUT_CHANGED');
    return JSON.parse(b.subarray(0,n).toString('utf8'));
  } finally {await h.close();}
}
async function privateRoot(path) {
  if(!isAbsolute(path))fail('VIDEO_OUTPUT_ABSOLUTE_PATH_REQUIRED');
  const st=await lstat(path);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)||st.uid!==process.getuid())fail('VIDEO_OUTPUT_ROOT_UNSAFE');
  const real=await realpath(path);if(real!==path)fail('VIDEO_OUTPUT_PATH_NOT_CANONICAL');return real;
}
async function exclusive(path,bytes) {
  const h=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
}
const json=x=>JSON.stringify(x,null,2)+'\n';
export async function runVideoCli(argv,{fetchImpl=globalThis.fetch,env=process.env,clock=()=>new Date().toISOString()}={}) {
  const options={},allowed=new Set(['--spec','--output-root','--approval','--execute']);
  for(let i=0;i<argv.length;i++){
    const k=argv[i];if(!allowed.has(k)||Object.hasOwn(options,k))fail('VIDEO_CLI_ARGUMENTS_INVALID');
    if(k==='--execute'){options[k]=true;continue;}
    if(!argv[i+1]||argv[i+1].startsWith('--'))fail('VIDEO_CLI_ARGUMENTS_INVALID');options[k]=argv[++i];
  }
  if(!options['--spec']||!options['--output-root']||(!options['--execute']&&options['--approval']))fail('VIDEO_CLI_ARGUMENTS_INVALID');
  const plan=prepareVideoResearch(await readJson(options['--spec']));
  const root=await privateRoot(options['--output-root']);
  // One stable directory per exact plan: crash/unknown outcome is never auto-retried.
  const dir=join(root,plan.planDigest+(options['--execute']?'-execution':'-prepared'));
  try{await mkdir(dir,{mode:0o700});}catch(e){if(e.code==='EEXIST')fail('VIDEO_RUN_ALREADY_EXISTS');throw e;}
  await exclusive(join(dir,'plan.json'),json(plan));
  await exclusive(join(dir,'request.json'),videoRequestBody(plan));
  if(!options['--execute']){
    const receipt={status:'PREPARED_NOT_EXECUTED',planDigest:plan.planDigest,providerCalls:0,credentialRead:false,
      requiredNextStep:'EXTERNAL_EXACT_PLAN_APPROVAL_AND_PRIVATE_ONE_SHOT_EXECUTION',authority:plan.authority};
    await exclusive(join(dir,'receipt.json'),json(receipt));return receipt;
  }
  if(!options['--approval'])fail('VIDEO_APPROVAL_FILE_REQUIRED');
  const result=await executeVideoResearch({plan,fetchImpl,clock,
    loadApproval:()=>readJson(options['--approval']),
    readCredential:()=>{
      const a=env.GEMINI_API_KEY?.trim(),b=env.GOOGLE_API_KEY?.trim();
      if(a&&b&&a!==b)fail('VIDEO_CREDENTIAL_AMBIGUOUS');
      if(env.AI_CHAT_API_KEY||env.AI_CHAT_MODEL||env.OPENAI_API_KEY)fail('VIDEO_PAID_OVERRIDE_REJECTED');
      return a||b||null;
    },
    reserve:async reservation=>{
      // A trusted shared root is required across workers. No time-based lock theft.
      await exclusive(join(root,`call-${reservation.approvalId}-${reservation.planDigest}.json`),json({...reservation,status:'ATTEMPT_RESERVED'}));
      const h=await open(root,constants.O_RDONLY|constants.O_DIRECTORY);try{await h.sync();}finally{await h.close();}
      return true;
    }});
  if(result.rawResponse)await exclusive(join(dir,'provider-response.json'),result.rawResponse);
  await exclusive(join(dir,'receipt.json'),json(result.receipt));
  return result.receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.includes('--help')){
    process.stdout.write('Prepare only: node run-research-video-v7.mjs --spec /absolute/spec.json --output-root /absolute/private-directory\n'+
      'Opt-in one shot: add --execute --approval /absolute/reviewed-approval.json\n'+
      'No default video/model, key printing, approval issuance, automatic retry, publication or trading.\n');
  }else runVideoCli(process.argv.slice(2)).then(result=>{
    process.stdout.write(JSON.stringify({status:result.status,reason:result.reason??null,planDigest:result.planDigest,callsAttempted:result.callsAttempted??0})+'\n');
    if(!['PREPARED_NOT_EXECUTED','RESPONSE_RECEIVED_REVIEW_REQUIRED','INSUFFICIENT_EVIDENCE'].includes(result.status))process.exitCode=1;
  }).catch(e=>{process.stderr.write(JSON.stringify({status:'BLOCKED',reason:/^VIDEO_[A-Z_]+$/.test(e?.code)?e.code:'VIDEO_RUNNER_FAILED'})+'\n');process.exitCode=1;});
}
