import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runResearchCanonicalChainV1 } from '../src/research-canonical-chain.mjs';

const SHA='a'.repeat(40);
const H='b'.repeat(64);

async function env(){
  const repo=await mkdtemp(join(tmpdir(),'canonical-chain-repo-'));
  const input=join(repo,'input');
  const bundleState=join(repo,'bundle-state');
  const researchState=join(repo,'research-state');
  await Promise.all([mkdir(input),mkdir(bundleState),mkdir(researchState)]);
  const dsl=join(input,'dsl.json');
  const components=join(input,'components.json');
  await writeFile(dsl,'{}');
  await writeFile(components,JSON.stringify({dsl}));
  return {repo,input,bundleState,researchState,dsl,components};
}
function runnerFor(e){
  const calls=[];
  const runner=(request)=>{
    calls.push(request);
    const target=request.args[0];
    if(target.includes('assemble-research-canonical-bundle')){
      return {status:0,stderr:'',stdout:JSON.stringify({
        status:'assembled',researchCodeSha:SHA,dslDigest:H,bundleDigest:'c'.repeat(64),
        bundlePath:join(e.input,'assembled',`${H}.json`),
        evidenceCredit:0,profitabilityProven:false,executionAuthority:'NONE',
      })};
    }
    if(target.includes('publish-research-canonical-bundle')){
      return {status:0,stderr:'',stdout:JSON.stringify({
        status:'published',researchCodeSha:SHA,publicationStatus:'READBACK_VERIFIED',
        receiptPath:join(e.bundleState,'publication-receipts',`${H}.json`),
        evidenceCredit:0,profitabilityProven:false,executionAuthority:'NONE',
      })};
    }
    return {status:0,stderr:'',stdout:JSON.stringify({
      status:'persisted',bindingsDigest:'d'.repeat(64),
      availableKeys:['a','b','c','d','e'],missingKeys:[],
      allBindingsAvailable:true,executionAuthority:'NONE',
    })};
  };
  return {runner,calls};
}

test('chain executes assembler publisher then runtime bindings with explicit roots and no activation',async()=>{
  const e=await env();
  const {runner,calls}=runnerFor(e);
  const result=await runResearchCanonicalChainV1({
    repoRoot:e.repo,researchSha:SHA,inputRoot:e.input,bundleStateRoot:e.bundleState,
    researchStateRoot:e.researchState,componentsPath:e.components,runner,
  });
  assert.equal(result.status,'CANONICAL_CHAIN_READY_NON_ACTIVATING');
  assert.equal(result.allBindingsAvailable,true);
  assert.equal(result.safety.runtimeActivationAllowed,false);
  assert.equal(result.safety.executionAuthority,'NONE');
  assert.equal(calls.length,3);
  assert.match(calls[0].args[0],/assemble-research-canonical-bundle/);
  assert.match(calls[1].args[0],/publish-research-canonical-bundle/);
  assert.match(calls[2].args[0],/research-runtime-bindings-build/);
  assert.equal(calls[1].env.RESEARCH_BUNDLE_STATE_ROOT,e.bundleState);
  assert.equal(calls[2].env.RESEARCH_STATE_ROOT,e.researchState);
});

test('publisher is not called if assembler fails',async()=>{
  const e=await env();
  let calls=0;
  const runner=()=>{
    calls+=1;
    return {status:1,stdout:'',stderr:'assembly failed'};
  };
  await assert.rejects(
    runResearchCanonicalChainV1({
      repoRoot:e.repo,researchSha:SHA,inputRoot:e.input,bundleStateRoot:e.bundleState,
      researchStateRoot:e.researchState,componentsPath:e.components,runner,
    }),
    /ASSEMBLER_FAILED/,
  );
  assert.equal(calls,1);
});

test('bindings are not called when publisher has not independently verified readback',async()=>{
  const e=await env();
  let calls=0;
  const runner=(request)=>{
    calls+=1;
    if(calls===1) return {status:0,stderr:'',stdout:JSON.stringify({
      status:'assembled',researchCodeSha:SHA,dslDigest:H,bundleDigest:'c'.repeat(64),
      bundlePath:join(e.input,'assembled',`${H}.json`),
    })};
    return {status:0,stderr:'',stdout:JSON.stringify({
      status:'published',researchCodeSha:SHA,publicationStatus:'MISSING_EVIDENCE',
      receiptPath:join(e.bundleState,'publication-receipts',`${H}.json`),
      evidenceCredit:0,profitabilityProven:false,executionAuthority:'NONE',
    })};
  };
  await assert.rejects(
    runResearchCanonicalChainV1({
      repoRoot:e.repo,researchSha:SHA,inputRoot:e.input,bundleStateRoot:e.bundleState,
      researchStateRoot:e.researchState,componentsPath:e.components,runner,
    }),
    /PUBLISHER_AUTHORITY_INVALID/,
  );
  assert.equal(calls,2);
});

test('paths returned outside declared roots fail before the next stage',async()=>{
  const e=await env();
  const runner=()=>({status:0,stderr:'',stdout:JSON.stringify({
    status:'assembled',researchCodeSha:SHA,dslDigest:H,bundleDigest:'c'.repeat(64),
    bundlePath:'/tmp/outside-bundle.json',
  })});
  await assert.rejects(
    runResearchCanonicalChainV1({
      repoRoot:e.repo,researchSha:SHA,inputRoot:e.input,bundleStateRoot:e.bundleState,
      researchStateRoot:e.researchState,componentsPath:e.components,runner,
    }),
    /bundlePath must be below expected root/,
  );
});

test('chain refuses incomplete bindings even after valid publication',async()=>{
  const e=await env();
  let calls=0;
  const runner=(request)=>{
    calls+=1;
    if(calls===1) return {status:0,stderr:'',stdout:JSON.stringify({
      status:'assembled',researchCodeSha:SHA,dslDigest:H,bundleDigest:'c'.repeat(64),
      bundlePath:join(e.input,'assembled',`${H}.json`),
    })};
    if(calls===2) return {status:0,stderr:'',stdout:JSON.stringify({
      status:'published',researchCodeSha:SHA,publicationStatus:'READBACK_VERIFIED',
      receiptPath:join(e.bundleState,'publication-receipts',`${H}.json`),
      evidenceCredit:0,profitabilityProven:false,executionAuthority:'NONE',
    })};
    return {status:0,stderr:'',stdout:JSON.stringify({
      status:'persisted',bindingsDigest:'d'.repeat(64),
      availableKeys:['a','b','c','d'],missingKeys:['canonicalBundleSource'],
      allBindingsAvailable:false,executionAuthority:'NONE',
    })};
  };
  await assert.rejects(
    runResearchCanonicalChainV1({
      repoRoot:e.repo,researchSha:SHA,inputRoot:e.input,bundleStateRoot:e.bundleState,
      researchStateRoot:e.researchState,componentsPath:e.components,runner,
    }),
    /RUNTIME_BINDINGS_NOT_COMPLETE/,
  );
  assert.equal(calls,3);
});


test('relative roots are rejected before any subprocess invocation',async()=>{
  const e=await env();
  let calls=0;
  await assert.rejects(
    runResearchCanonicalChainV1({
      repoRoot:'relative-repo',researchSha:SHA,inputRoot:e.input,bundleStateRoot:e.bundleState,
      researchStateRoot:e.researchState,componentsPath:e.components,runner:()=>{calls+=1;return {status:0,stdout:'{}',stderr:''};},
    }),
    /repoRoot must be absolute/,
  );
  assert.equal(calls,0);
});

test('components symlink is rejected before parsing or subprocess invocation',async()=>{
  const e=await env();
  const outside=join(e.repo,'outside-components.json');
  await writeFile(outside,JSON.stringify({dsl:e.dsl}));
  const link=join(e.input,'components-link.json');
  await symlink(outside,link);
  let calls=0;
  await assert.rejects(
    runResearchCanonicalChainV1({
      repoRoot:e.repo,researchSha:SHA,inputRoot:e.input,bundleStateRoot:e.bundleState,
      researchStateRoot:e.researchState,componentsPath:link,runner:()=>{calls+=1;return {status:0,stdout:'{}',stderr:''};},
    }),
    /componentsPath must be a regular non-symlink file/,
  );
  assert.equal(calls,0);
});
