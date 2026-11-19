import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverResearchProviderConfig, materializeResearchProviderEnv } from '../bin/research-provider-bootstrap.mjs';

const YT='TEST_ONLY_YOUTUBE_KEY_123456';
const GEM='TEST_ONLY_GEMINI_KEY_123456';
const GROQ='TEST_ONLY_GROQ_KEY_123456';

async function appRoot(){
  const root=await mkdtemp(join(tmpdir(),'research-provider-app-'));
  await mkdir(join(root,'api-server'),{recursive:true});
  await writeFile(join(root,'.env'),[
    `YOUTUBE_DATA_API_KEY=${YT}`,
    `GEMINI_API_KEY=${GEM}`,
    'SUPABASE_SERVICE_ROLE_KEY=SHOULD_NOT_COPY',
    'BITGET_API_KEY=SHOULD_NOT_COPY',
  ].join('\n')+'\n',{mode:0o600});
  await writeFile(join(root,'api-server','.env.production'),[
    `GROQ_API_KEY=${GROQ}`,
    'DATABASE_URL=SHOULD_NOT_COPY',
  ].join('\n')+'\n',{mode:0o600});
  return root;
}
test('preflight reports provider presence without credential values',async()=>{
  const root=await appRoot();
  try{
    const result=await discoverResearchProviderConfig({appRoot:root,includePm2:false});
    assert.deepEqual(result.providers,{youtube:'PRESENT',gemini:'PRESENT',groq:'PRESENT'});
    assert.equal(result.fullStackReady,true);
    const publicJson=JSON.stringify({providers:result.providers,sources:result.sources,fullStackReady:result.fullStackReady});
    for(const secret of [YT,GEM,GROQ])assert.equal(publicJson.includes(secret),false);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('materialize copies only research provider credentials and fixed research models',async()=>{
  const root=await appRoot(),out=await mkdtemp(join(tmpdir(),'research-provider-out-'));
  try{
    const result=await materializeResearchProviderEnv({appRoot:root,outputRoot:out,includePm2:false});
    assert.equal(result.fullStackReady,true);
    const text=await readFile(join(out,'research-providers.env'),'utf8');
    for(const secret of [YT,GEM,GROQ])assert.equal(text.includes(secret),true);
    for(const forbidden of ['SUPABASE_SERVICE_ROLE_KEY','BITGET_API_KEY','DATABASE_URL','SHOULD_NOT_COPY'])assert.equal(text.includes(forbidden),false);
    assert.match(text,/GEMINI_MODEL=gemini-3\.1-flash-lite/);
    assert.match(text,/GROQ_MODEL=openai\/gpt-oss-20b/);
  }finally{await rm(root,{recursive:true,force:true});await rm(out,{recursive:true,force:true});}
});
test('conflicting provider values fail closed and cannot be materialized',async()=>{
  const root=await appRoot(),out=await mkdtemp(join(tmpdir(),'research-provider-out-'));
  try{
    await writeFile(join(root,'.env.production'),`YOUTUBE_DATA_API_KEY=DIFFERENT_TEST_KEY_123456\n`,{mode:0o600});
    const result=await discoverResearchProviderConfig({appRoot:root,includePm2:false});
    assert.equal(result.providers.youtube,'CONFLICT');
    await assert.rejects(()=>materializeResearchProviderEnv({appRoot:root,outputRoot:out,includePm2:false}),/PROVIDER_BOOTSTRAP_CONFLICT/);
  }finally{await rm(root,{recursive:true,force:true});await rm(out,{recursive:true,force:true});}
});
test('missing any of YouTube Gemini Groq blocks full-stack materialization',async()=>{
  const root=await mkdtemp(join(tmpdir(),'research-provider-app-')),out=await mkdtemp(join(tmpdir(),'research-provider-out-'));
  try{
    await writeFile(join(root,'.env'),`YOUTUBE_DATA_API_KEY=${YT}\nGROQ_API_KEY=${GROQ}\n`,{mode:0o600});
    const result=await discoverResearchProviderConfig({appRoot:root,includePm2:false});
    assert.equal(result.providers.gemini,'MISSING');
    assert.equal(result.fullStackReady,false);
    await assert.rejects(()=>materializeResearchProviderEnv({appRoot:root,outputRoot:out,includePm2:false}),/PROVIDER_BOOTSTRAP_FULL_STACK_REQUIRED/);
  }finally{await rm(root,{recursive:true,force:true});await rm(out,{recursive:true,force:true});}
});
