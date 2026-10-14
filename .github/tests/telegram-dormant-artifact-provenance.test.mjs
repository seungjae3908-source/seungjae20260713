import test from 'node:test';
import assert from 'node:assert/strict';
import {
 attestTelegramDormantArtifact, TELEGRAM_DORMANT_WORKFLOW,
 TELEGRAM_DORMANT_WORKFLOW_NAME,
} from '../../ops/telegram-dormant-artifact-provenance.mjs';
const sha='a'.repeat(40),repo='seungjae3908-source/seungjae20260713';
const good=()=>({
 targetSha:sha,currentMainSha:sha,repository:repo,
 run:{id:123,name:TELEGRAM_DORMANT_WORKFLOW_NAME,
  path:TELEGRAM_DORMANT_WORKFLOW,event:'push',head_branch:'main',
  head_sha:sha,repository:{full_name:repo},head_repository:{full_name:repo},
  run_attempt:1,status:'completed',conclusion:'success'},
 artifacts:[{id:456,name:'telegram-dormant-package-'+sha,expired:false,
  digest:'sha256:'+'f'.repeat(64),workflow_run:{head_sha:sha},
  size_in_bytes:347047}],
});
test('only one exact current-main, original successful push artifact is accepted',()=>{
 const x=attestTelegramDormantArtifact(good());
 assert.equal(x.ok,true);
 assert.equal(x.artifactId,456);
 assert.equal(x.digest,'sha256:'+'f'.repeat(64));
});
test('stale, malformed and mismatched SHA are all rejected',()=>{
 for(const edit of [x=>x.currentMainSha='b'.repeat(40),
  x=>x.targetSha='not-sha',x=>x.run.head_sha='c'.repeat(40),
  x=>x.artifacts[0].workflow_run.head_sha='d'.repeat(40)]) {
  const x=good();edit(x);assert.equal(attestTelegramDormantArtifact(x).ok,false);
 }
});
test('pull request, manual, rerun-to-green, wrong workflow or fork are rejected',()=>{
 for(const edit of [x=>x.run.event='pull_request',x=>x.run.event='workflow_dispatch',
  x=>x.run.head_branch='feature',x=>x.run.path='bad.yml',
  x=>x.run.name='Some Other Workflow',x=>x.run.run_attempt=2,
  x=>x.run.repository.full_name='attacker/project',
  x=>x.run.head_repository.full_name='attacker/project',
  x=>x.run.status='in_progress',x=>x.run.conclusion='failure']) {
  const x=good();edit(x);assert.equal(attestTelegramDormantArtifact(x).ok,false);
 }
});
test('expired, forged, duplicated, wrong-size or SHA-less artifact is rejected',()=>{
 for(const edit of [x=>x.artifacts[0].expired=true,
  x=>x.artifacts[0].digest='sha256:bad',x=>x.artifacts[0].id=0,
  x=>x.artifacts[0].size_in_bytes=0,
  x=>x.artifacts[0].size_in_bytes=17*1024*1024,
  x=>x.artifacts.push({...x.artifacts[0],id:457}),
  x=>x.artifacts=[],x=>x.artifacts=null]) {
  const x=good();edit(x);assert.equal(attestTelegramDormantArtifact(x).ok,false);
 }
});
