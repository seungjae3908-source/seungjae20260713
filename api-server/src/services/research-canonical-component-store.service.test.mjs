import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1,
} from './research-canonical-bundle-assembler.service.ts';
import {
  buildResearchCanonicalComponentManifestV1,
  registerResearchCanonicalComponentV1,
} from './research-canonical-component-store.service.ts';

const SHA='a'.repeat(40);

async function environment(){
  const root=await mkdtemp(join(tmpdir(),'canonical-component-store-'));
  const sourceRoot=join(root,'sources');
  const inputRoot=join(root,'input');
  await mkdir(sourceRoot);
  await mkdir(inputRoot);
  return {root,sourceRoot,inputRoot};
}

async function source(env,key,value={key,payload:[1,2,3]}){
  const path=join(env.sourceRoot,`${key}.json`);
  await writeFile(path,JSON.stringify(value));
  return path;
}

test('register preserves owner JSON bytes write-once with zero evidence authority',async()=>{
  const env=await environment();
  try{
    const path=await source(env,'dsl',{schemaVersion:1,name:'dsl'});
    const before=await readFile(path);
    const first=await registerResearchCanonicalComponentV1({
      sourceRoot:env.sourceRoot,inputRoot:env.inputRoot,researchCodeSha:SHA,
      componentKey:'dsl',ownerRef:'#550',sourcePath:path,
    });
    assert.equal(first.status,'registered');
    assert.equal(first.componentKey,'dsl');
    assert.equal(first.ownerRef,'#550');
    assert.equal(first.evidenceCredit,0);
    assert.equal(first.profitabilityProven,false);
    assert.equal(first.promotionEligible,false);
    assert.equal(first.executionAuthority,'NONE');
    assert.deepEqual(await readFile(first.componentPath),before);
    assert.match(first.byteDigest,/^[0-9a-f]{64}$/);
    assert.match(first.jsonDigest,/^[0-9a-f]{64}$/);

    const repeated=await registerResearchCanonicalComponentV1({
      sourceRoot:env.sourceRoot,inputRoot:env.inputRoot,researchCodeSha:SHA,
      componentKey:'dsl',ownerRef:'#550',sourcePath:path,
    });
    assert.equal(repeated.status,'already_present');
    assert.equal(repeated.byteDigest,first.byteDigest);
    assert.equal(repeated.recordDigest,first.recordDigest);
  }finally{
    await rm(env.root,{recursive:true,force:true});
  }
});

test('partial manifest reports exact missing components and cannot pretend 15/15 readiness',async()=>{
  const env=await environment();
  try{
    const path=await source(env,'formulaCandidate',{schemaVersion:1,id:'formula'});
    const saved=await registerResearchCanonicalComponentV1({
      sourceRoot:env.sourceRoot,inputRoot:env.inputRoot,researchCodeSha:SHA,
      componentKey:'formulaCandidate',ownerRef:'#550',sourcePath:path,
    });
    const manifest=await buildResearchCanonicalComponentManifestV1({
      inputRoot:env.inputRoot,
      researchCodeSha:SHA,
      selectedComponentDigests:{formulaCandidate:saved.byteDigest},
    });
    assert.equal(manifest.complete,false);
    assert.equal(manifest.readyComponentCount,1);
    assert.equal(manifest.requiredComponentCount,RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1.length);
    assert.equal(manifest.missingComponents.includes('formulaCandidate'),false);
    assert.equal(manifest.missingComponents.length,RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1.length-1);
    assert.equal(manifest.evidenceCredit,0);
    assert.equal(manifest.executionAuthority,'NONE');
  }finally{
    await rm(env.root,{recursive:true,force:true});
  }
});

test('all 15 registered components produce complete assembler-compatible path manifest',async()=>{
  const env=await environment();
  try{
    const selected={};
    for(const key of RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1){
      const path=await source(env,key,{component:key,value:`owner-value-${key}`});
      const saved=await registerResearchCanonicalComponentV1({
        sourceRoot:env.sourceRoot,inputRoot:env.inputRoot,researchCodeSha:SHA,
        componentKey:key,ownerRef:`owner:${key}`,sourcePath:path,
      });
      selected[key]=saved.byteDigest;
    }
    const manifest=await buildResearchCanonicalComponentManifestV1({
      inputRoot:env.inputRoot,researchCodeSha:SHA,selectedComponentDigests:selected,
    });
    assert.equal(manifest.complete,true);
    assert.equal(manifest.readyComponentCount,15);
    assert.deepEqual(manifest.missingComponents,[]);
    assert.deepEqual(Object.keys(manifest.componentPaths).sort(),[...RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1].sort());
    assert.equal(Object.values(manifest.componentRecordDigests).every((value)=>/^[0-9a-f]{64}$/.test(value)),true);
    assert.match(manifest.manifestDigest,/^[0-9a-f]{64}$/);
  }finally{
    await rm(env.root,{recursive:true,force:true});
  }
});

test('same bytes cannot be rebound to a different owner or research SHA silently',async()=>{
  const env=await environment();
  try{
    const path=await source(env,'dataset',{dataset:'same'});
    await registerResearchCanonicalComponentV1({
      sourceRoot:env.sourceRoot,inputRoot:env.inputRoot,researchCodeSha:SHA,
      componentKey:'dataset',ownerRef:'owner:A',sourcePath:path,
    });
    await assert.rejects(
      registerResearchCanonicalComponentV1({
        sourceRoot:env.sourceRoot,inputRoot:env.inputRoot,researchCodeSha:SHA,
        componentKey:'dataset',ownerRef:'owner:B',sourcePath:path,
      }),
      /CONTENT_CONFLICT/,
    );
    await assert.rejects(
      registerResearchCanonicalComponentV1({
        sourceRoot:env.sourceRoot,inputRoot:env.inputRoot,researchCodeSha:'b'.repeat(40),
        componentKey:'dataset',ownerRef:'owner:A',sourcePath:path,
      }),
      /CONTENT_CONFLICT/,
    );
  }finally{
    await rm(env.root,{recursive:true,force:true});
  }
});

test('manifest rejects tampered record and mismatched research SHA',async()=>{
  const env=await environment();
  try{
    const path=await source(env,'modelReference',{model:'v1'});
    const saved=await registerResearchCanonicalComponentV1({
      sourceRoot:env.sourceRoot,inputRoot:env.inputRoot,researchCodeSha:SHA,
      componentKey:'modelReference',ownerRef:'model-owner',sourcePath:path,
    });
    await assert.rejects(
      buildResearchCanonicalComponentManifestV1({
        inputRoot:env.inputRoot,researchCodeSha:'b'.repeat(40),
        selectedComponentDigests:{modelReference:saved.byteDigest},
      }),
      /RECORD_INVALID/,
    );

    const record=JSON.parse(await readFile(saved.recordPath,'utf8'));
    record.ownerRef='tampered-owner';
    await writeFile(saved.recordPath,JSON.stringify(record));
    await assert.rejects(
      buildResearchCanonicalComponentManifestV1({
        inputRoot:env.inputRoot,researchCodeSha:SHA,
        selectedComponentDigests:{modelReference:saved.byteDigest},
      }),
      /RECORD_DIGEST_MISMATCH/,
    );
  }finally{
    await rm(env.root,{recursive:true,force:true});
  }
});

test('source outside source root, unknown component key and unknown selection key fail closed',async()=>{
  const env=await environment();
  const outside=join(await mkdtemp(join(tmpdir(),'component-outside-')),'x.json');
  try{
    await writeFile(outside,JSON.stringify({x:1}));
    await assert.rejects(
      registerResearchCanonicalComponentV1({
        sourceRoot:env.sourceRoot,inputRoot:env.inputRoot,researchCodeSha:SHA,
        componentKey:'dsl',ownerRef:'#550',sourcePath:outside,
      }),
      /SOURCE_OUTSIDE_ROOT/,
    );
    const inside=await source(env,'unknown',{x:1});
    await assert.rejects(
      registerResearchCanonicalComponentV1({
        sourceRoot:env.sourceRoot,inputRoot:env.inputRoot,researchCodeSha:SHA,
        componentKey:'madeUp',ownerRef:'#550',sourcePath:inside,
      }),
      /COMPONENT_KEY_INVALID/,
    );
    await assert.rejects(
      buildResearchCanonicalComponentManifestV1({
        inputRoot:env.inputRoot,researchCodeSha:SHA,
        selectedComponentDigests:{madeUp:'f'.repeat(64)},
      }),
      /SELECTION_KEY_INVALID/,
    );
  }finally{
    await rm(env.root,{recursive:true,force:true});
    await rm(join(outside,'..'),{recursive:true,force:true});
  }
});

test('production component CLI exposes no evidence-credit or test-fixture bypass',async()=>{
  const sourceText=await readFile(
    join(process.cwd(),'api-server','scripts','manage-research-canonical-components.ts'),'utf8',
  );
  assert.match(sourceText,/RESEARCH_CODE_SHA/);
  assert.match(sourceText,/RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT/);
  assert.doesNotMatch(sourceText,/test-fixtures|allowTestEvidence|evidenceCredit\s*=\s*[1-9]|TEST_ONLY/);
});
