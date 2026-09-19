import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1,
} from './research-canonical-bundle-assembler.service.ts';
import {
  buildCanonicalBundleComponentReadinessV1,
  registerCanonicalBundleComponentV1,
} from './research-canonical-component-registry.service.ts';
import {
  finalizeResearchCanonicalBundleFromRegistryV1,
} from './research-canonical-bundle-finalizer.service.ts';
import {
  researchBundleFixture as fixture,
  AUTHORITATIVE_NOW_MS as NOW,
} from './research-bundle.test-fixtures.mjs';
import {
  buildResearchDatasetIdentity,
  sha256Canonical as hash,
} from '../../../market-prediction-lab/src/research-cache-provenance.js';
import {
  resolveCanonicalStrategyIdentity,
} from '../../../market-prediction-lab/src/canonical-strategy-identity-v1.js';

const H=(x)=>x.repeat(64);

function canonicalFixture(){
  const f=fixture();
  const bundle=structuredClone(f.bundle);
  const dataset=bundle.dataset;
  const oldIdentity=dataset.identity;
  dataset.identity=buildResearchDatasetIdentity({
    ...oldIdentity,
    rows:dataset.rows,
    provider:'OWNER_PUBLISHED',
    providerVersion:'v1',
    sourceType:'OWNER_PUBLISHED',
  });
  const scope={
    datasetId:dataset.id,
    datasetDigest:dataset.identity.datasetDigest,
    market:bundle.strategy.market,
    symbol:dataset.identity.symbol,
    timeframe:bundle.strategy.timeframe,
    researchCodeSha:bundle.strategy.researchCodeSha,
  };
  const seal=(id,payload)=>({id,payload,digest:hash(payload)});
  bundle.evidenceClass='CANONICAL';
  bundle.strategy.datasetDigest=scope.datasetDigest;
  dataset.receipt=seal('OWNER_DATASET_RECEIPT',{
    ...scope,datasetIdentityId:dataset.identity.datasetIdentityId,rowCount:dataset.rows.length,
  });
  bundle.splitPolicy=seal('OWNER_SPLIT',{...bundle.splitPolicy.payload,...scope});
  bundle.splitReceipt=seal('OWNER_SPLIT_RECEIPT',{
    ...bundle.splitReceipt.payload,...scope,policyDigest:bundle.splitPolicy.digest,
  });
  const cost=bundle.costPolicy.payload;
  bundle.costPolicy=seal(bundle.costPolicy.id,{
    ...cost,...scope,
    components:Object.fromEntries(Object.entries(cost.components).map(([key,value])=>[
      key,{...value,...scope,source:'OWNER_OBSERVED',provenance:['OWNER_OBSERVED']},
    ])),
  });
  bundle.oosPolicy=seal('OWNER_OOS',{
    ...bundle.oosPolicy.payload,...scope,splitReceiptDigest:bundle.splitReceipt.digest,
  });
  bundle.wfPolicy=seal('OWNER_WF',{...bundle.wfPolicy.payload,...scope});
  bundle.holdoutPolicy=seal('OWNER_HOLDOUT',{
    ...bundle.holdoutPolicy.payload,
    market:scope.market,symbol:scope.symbol,timeframe:scope.timeframe,researchCodeSha:scope.researchCodeSha,
  });
  const strategy=resolveCanonicalStrategyIdentity(bundle.strategy);
  Object.assign(bundle.modelReference.producerManifest,{
    strategyIdentity:strategy.identity,
    strategyIdentityDigest:strategy.strategyIdentityDigest,
    datasetDigest:scope.datasetDigest,
    sourceAttestation:{
      sourceKind:'GENUINE_MARKET_DATA',
      reconstructed:false,
      synthetic:false,
      shadowDerived:false,
      finalHoldoutIncluded:false,
    },
  });
  return { ...f,bundle,strategyIdentityDigest:strategy.strategyIdentityDigest };
}

async function environment(){
  const inputRoot=await mkdtemp(join(tmpdir(),'canonical-finalizer-input-'));
  const stateRoot=await mkdtemp(join(tmpdir(),'canonical-finalizer-state-'));
  const ownerOutput=join(inputRoot,'owner-output');
  await mkdir(ownerOutput);
  await mkdir(join(stateRoot,'catalog'));
  const f=canonicalFixture();
  const binding={
    researchCodeSha:f.bundle.strategy.researchCodeSha,
    strategyIdentityDigest:f.strategyIdentityDigest,
    datasetDigest:f.bundle.dataset.identity.datasetDigest,
    parameterHash:H('3'),
  };
  const payloadPaths={};
  for(const key of RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1){
    const value=key==='dsl'?f.dsl:f.bundle[key];
    const path=join(ownerOutput,`${key}.json`);
    await writeFile(path,JSON.stringify(value));
    payloadPaths[key]=path;
  }
  return {inputRoot,stateRoot,ownerOutput,f,binding,payloadPaths};
}

async function registerAll(env,omit=null){
  for(const key of RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1){
    if(key===omit) continue;
    await registerCanonicalBundleComponentV1({
      inputRoot:env.inputRoot,
      binding:env.binding,
      key,
      ownerRef:`owner:${key}`,
      payloadPath:env.payloadPaths[key],
    });
  }
}

test('missing registered component blocks before assembly or publication',async()=>{
  const env=await environment();
  try{
    await registerAll(env,'modelReference');
    const result=await finalizeResearchCanonicalBundleFromRegistryV1({
      inputRoot:env.inputRoot,
      stateRoot:env.stateRoot,
      binding:env.binding,
      validationNow:()=>NOW,
    });
    assert.equal(result.status,'BLOCKED_MISSING_COMPONENTS');
    assert.equal(result.assembled,false);
    assert.equal(result.published,false);
    assert.deepEqual(result.missingKeys,['modelReference']);
    await assert.rejects(readFile(join(env.stateRoot,'publication-receipts','missing.json')),/ENOENT/);
  }finally{
    await rm(env.inputRoot,{recursive:true,force:true});
    await rm(env.stateRoot,{recursive:true,force:true});
  }
});

test('complete binding-scoped registry assembles and publishes exact READBACK_VERIFIED bundle',async()=>{
  const env=await environment();
  try{
    await registerAll(env);
    const readiness=await buildCanonicalBundleComponentReadinessV1({
      inputRoot:env.inputRoot,binding:env.binding,
    });
    assert.equal(readiness.status,'COMPLETE');

    const result=await finalizeResearchCanonicalBundleFromRegistryV1({
      inputRoot:env.inputRoot,
      stateRoot:env.stateRoot,
      binding:env.binding,
      validationNow:()=>NOW,
    });
    assert.equal(result.status,'READBACK_VERIFIED');
    assert.equal(result.assembled,true);
    assert.equal(result.published,true);
    assert.equal(result.evidenceCredit,0);
    assert.equal(result.profitabilityProven,false);
    assert.equal(result.runtimeActivationAllowed,false);
    assert.equal(result.executionAuthority,'NONE');
    assert.deepEqual(result.componentDigests,readiness.payloadDigests);
    assert.match(result.dslDigest,/^[0-9a-f]{64}$/);
    assert.match(result.bundleDigest,/^[0-9a-f]{64}$/);
    assert.match(result.publicationReceiptDigest,/^[0-9a-f]{64}$/);

    const receipt=JSON.parse(await readFile(result.publicationReceiptPath,'utf8'));
    assert.equal(receipt.contract,'research-canonical-bundle-offline-publication-receipt/v1');
    assert.equal(receipt.researchCodeSha,env.binding.researchCodeSha);
    assert.equal(receipt.bundleDigest,result.bundleDigest);
    assert.equal(receipt.publicationStatus,'READBACK_VERIFIED');
    assert.equal(receipt.executionAuthority,'NONE');
  }finally{
    await rm(env.inputRoot,{recursive:true,force:true});
    await rm(env.stateRoot,{recursive:true,force:true});
  }
});

test('registry tamper blocks finalizer before assembly and publication',async()=>{
  const env=await environment();
  try{
    await registerAll(env);
    const readiness=await buildCanonicalBundleComponentReadinessV1({
      inputRoot:env.inputRoot,binding:env.binding,
    });
    await writeFile(readiness.componentPaths.dataset,JSON.stringify({tampered:true}));
    await assert.rejects(
      finalizeResearchCanonicalBundleFromRegistryV1({
        inputRoot:env.inputRoot,
        stateRoot:env.stateRoot,
        binding:env.binding,
        validationNow:()=>NOW,
      }),
      /TAMPER_DETECTED/,
    );
  }finally{
    await rm(env.inputRoot,{recursive:true,force:true});
    await rm(env.stateRoot,{recursive:true,force:true});
  }
});

test('finalizer is idempotent after durable assembly and publication',async()=>{
  const env=await environment();
  try{
    await registerAll(env);
    const first=await finalizeResearchCanonicalBundleFromRegistryV1({
      inputRoot:env.inputRoot,stateRoot:env.stateRoot,binding:env.binding,validationNow:()=>NOW,
    });
    const second=await finalizeResearchCanonicalBundleFromRegistryV1({
      inputRoot:env.inputRoot,stateRoot:env.stateRoot,binding:env.binding,validationNow:()=>NOW,
    });
    assert.equal(first.status,'READBACK_VERIFIED');
    assert.equal(second.status,'READBACK_VERIFIED');
    assert.equal(second.bundleDigest,first.bundleDigest);
    assert.equal(second.publicationReceiptDigest,first.publicationReceiptDigest);
  }finally{
    await rm(env.inputRoot,{recursive:true,force:true});
    await rm(env.stateRoot,{recursive:true,force:true});
  }
});

test('production finalizer CLI exposes no test fixture, bypass or validation clock',async()=>{
  const source=await readFile(
    join(process.cwd(),'api-server','scripts','finalize-research-canonical-bundle.ts'),
    'utf8',
  );
  assert.doesNotMatch(source,/test-fixtures|allowTestEvidence|validationNow|--now|TEST_ONLY/);
  assert.match(source,/RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT/);
  assert.match(source,/RESEARCH_BUNDLE_STATE_ROOT/);
});
