import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1,
} from './research-canonical-bundle-assembler.service.ts';
import {
  buildCanonicalBundleComponentReadinessV1,
  canonicalBundleComponentBindingDigestV1,
  registerCanonicalBundleComponentV1,
} from './research-canonical-component-registry.service.ts';

const SHA='a'.repeat(40);
const H=(x)=>x.repeat(64);
const binding={
  researchCodeSha:SHA,
  strategyIdentityDigest:H('1'),
  datasetDigest:H('2'),
  parameterHash:H('3'),
};

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'canonical-component-registry-'));
  const sourceDir=join(root,'owner-output');
  await mkdir(sourceDir);
  return {root,sourceDir};
}

test('registry is write-once, binding-scoped and reports exact missing component keys',async()=>{
  const f=await fixture();
  try{
    const dslPath=join(f.sourceDir,'dsl.json');
    await writeFile(dslPath,JSON.stringify({kind:'dsl',value:1}));
    const sourceBytes=await readFile(dslPath);
    const first=await registerCanonicalBundleComponentV1({
      inputRoot:f.root,binding,key:'dsl',ownerRef:'#550',payloadPath:dslPath,
    });
    const second=await registerCanonicalBundleComponentV1({
      inputRoot:f.root,binding,key:'dsl',ownerRef:'#550',payloadPath:dslPath,
    });
    assert.equal(first.status,'registered');
    assert.equal(second.status,'already_present');
    assert.equal(first.bindingDigest,canonicalBundleComponentBindingDigestV1(binding));
    assert.match(first.sourceByteDigest,/^[0-9a-f]{64}$/);
    assert.deepEqual(await readFile(first.payloadPath),sourceBytes);

    const readiness=await buildCanonicalBundleComponentReadinessV1({
      inputRoot:f.root,binding,
    });
    assert.equal(readiness.status,'BLOCKED_MISSING_COMPONENTS');
    assert.deepEqual(readiness.presentKeys,['dsl']);
    assert.equal(readiness.missingKeys.length,RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1.length-1);
    assert.equal(readiness.missingKeys.includes('modelReference'),true);
    assert.equal(readiness.executionAuthority,'NONE');
  }finally{
    await rm(f.root,{recursive:true,force:true});
  }
});

test('all exact components produce a COMPLETE assembler-ready path spec',async()=>{
  const f=await fixture();
  try{
    for(const [index,key] of RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1.entries()){
      const path=join(f.sourceDir,`${key}.json`);
      await writeFile(path,JSON.stringify({key,index}));
      await registerCanonicalBundleComponentV1({
        inputRoot:f.root,binding,key,ownerRef:`owner:${key}`,payloadPath:path,
      });
    }
    const readiness=await buildCanonicalBundleComponentReadinessV1({
      inputRoot:f.root,binding,
    });
    assert.equal(readiness.status,'COMPLETE');
    assert.deepEqual(readiness.missingKeys,[]);
    assert.equal(Object.keys(readiness.componentPaths).length,RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1.length);
    assert.equal(Object.values(readiness.payloadDigests).every(x=>/^[0-9a-f]{64}$/.test(x)),true);
    for(const key of RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1){
      const envelope=JSON.parse(await readFile(join(f.root,'registry',readiness.bindingDigest,`${key}.json`),'utf8'));
      assert.match(envelope.sourceByteDigest,/^[0-9a-f]{64}$/);
    }
    assert.match(readiness.readinessDigest,/^[0-9a-f]{64}$/);
  }finally{
    await rm(f.root,{recursive:true,force:true});
  }
});

test('cross-binding registration cannot satisfy another candidate bundle',async()=>{
  const f=await fixture();
  try{
    const path=join(f.sourceDir,'dsl.json');
    await writeFile(path,JSON.stringify({kind:'dsl'}));
    await registerCanonicalBundleComponentV1({
      inputRoot:f.root,binding,key:'dsl',ownerRef:'#550',payloadPath:path,
    });
    const other={...binding,parameterHash:H('4')};
    const readiness=await buildCanonicalBundleComponentReadinessV1({
      inputRoot:f.root,binding:other,
    });
    assert.equal(readiness.presentKeys.length,0);
    assert.equal(readiness.missingKeys.length,RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1.length);
  }finally{
    await rm(f.root,{recursive:true,force:true});
  }
});

test('same payload bytes cannot be rebound to a different owner inside the same binding/key',async()=>{
  const f=await fixture();
  try{
    const path=join(f.sourceDir,'dsl.json');
    await writeFile(path,'{\n  "value": 1\n}\n');
    const first=await registerCanonicalBundleComponentV1({
      inputRoot:f.root,binding,key:'dsl',ownerRef:'#550',payloadPath:path,
    });
    assert.deepEqual(await readFile(first.payloadPath),await readFile(path));
    await assert.rejects(
      registerCanonicalBundleComponentV1({
        inputRoot:f.root,binding,key:'dsl',ownerRef:'#551',payloadPath:path,
      }),
      /CONTENT_CONFLICT/,
    );
  }finally{
    await rm(f.root,{recursive:true,force:true});
  }
});

test('component payload conflict and tamper are rejected',async()=>{
  const f=await fixture();
  try{
    const path=join(f.sourceDir,'dsl.json');
    await writeFile(path,JSON.stringify({value:1}));
    const registered=await registerCanonicalBundleComponentV1({
      inputRoot:f.root,binding,key:'dsl',ownerRef:'#550',payloadPath:path,
    });
    await writeFile(path,JSON.stringify({value:2}));
    await assert.rejects(
      registerCanonicalBundleComponentV1({
        inputRoot:f.root,binding,key:'dsl',ownerRef:'#550',payloadPath:path,
      }),
      /CONTENT_CONFLICT/,
    );
    await writeFile(registered.payloadPath,JSON.stringify({value:999}));
    await assert.rejects(
      buildCanonicalBundleComponentReadinessV1({inputRoot:f.root,binding}),
      /TAMPER_DETECTED/,
    );
  }finally{
    await rm(f.root,{recursive:true,force:true});
  }
});

test('payload outside input root and invalid binding identity are refused',async()=>{
  const f=await fixture();
  const outsideRoot=await mkdtemp(join(tmpdir(),'component-outside-'));
  try{
    const outside=join(outsideRoot,'dsl.json');
    await writeFile(outside,JSON.stringify({value:1}));
    await assert.rejects(
      registerCanonicalBundleComponentV1({
        inputRoot:f.root,binding,key:'dsl',ownerRef:'#550',payloadPath:outside,
      }),
      /OUTSIDE_INPUT_ROOT/,
    );
    assert.throws(
      ()=>canonicalBundleComponentBindingDigestV1({...binding,parameterHash:'bad'}),
      /PARAMETER_HASH_INVALID/,
    );
  }finally{
    await rm(f.root,{recursive:true,force:true});
    await rm(outsideRoot,{recursive:true,force:true});
  }
});


test('relative root and payload paths fail closed',async()=>{
  const f=await fixture();
  try{
    const path=join(f.sourceDir,'dsl.json');
    await writeFile(path,JSON.stringify({value:1}));
    await assert.rejects(
      registerCanonicalBundleComponentV1({
        inputRoot:'relative-registry-root',
        binding,
        key:'dsl',
        ownerRef:'#550',
        payloadPath:path,
      }),
      /MUST_BE_ABSOLUTE/,
    );
    await assert.rejects(
      registerCanonicalBundleComponentV1({
        inputRoot:f.root,
        binding,
        key:'dsl',
        ownerRef:'#550',
        payloadPath:'relative-payload.json',
      }),
      /PAYLOAD_PATH_MUST_BE_ABSOLUTE/,
    );
  }finally{
    await rm(f.root,{recursive:true,force:true});
  }
});

test('registry and registered-components symlink outputs are rejected before write',async()=>{
  for(const unsafeName of ['registry','registered-components']){
    const f=await fixture();
    const outside=await mkdtemp(join(tmpdir(),'canonical-component-registry-outside-'));
    try{
      const path=join(f.sourceDir,'dsl.json');
      await writeFile(path,JSON.stringify({value:1}));
      await symlink(outside,join(f.root,unsafeName),'dir');
      await assert.rejects(
        registerCanonicalBundleComponentV1({
          inputRoot:f.root,
          binding,
          key:'dsl',
          ownerRef:'#550',
          payloadPath:path,
        }),
        /COMPONENT_(REGISTRY_ROOT|PAYLOAD_ROOT)_UNSAFE/,
      );
    }finally{
      await rm(f.root,{recursive:true,force:true});
      await rm(outside,{recursive:true,force:true});
    }
  }
});
