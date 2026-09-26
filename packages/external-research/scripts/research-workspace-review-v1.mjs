#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { buildResearchWorkspace } from '../src/research-workspace-v1.js';
import { renderResearchWorkspaceReview } from '../src/research-workspace-review-v1.js';
// Only local, pre-existing, explicitly selected JSON inputs. No network or provider client.
const args=process.argv.slice(2);const readArg=(name,optional=false)=>{const i=args.indexOf(name);if(i<0){if(optional)return null;throw new Error('ARGUMENT_REQUIRED:'+name);}if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('ARGUMENT_VALUE_REQUIRED');return args[i+1];};
async function json(path){if(path===null)return null;const raw=await readFile(resolve(path));if(raw.length>2*1024*1024)throw new Error('LOCAL_INPUT_TOO_LARGE');return JSON.parse(raw.toString('utf8'));}
async function main(){const out=resolve(readArg('--output'));const policy=await json(readArg('--policy'));const videoEvidence=await json(readArg('--snapshot',true));const registry=await json(readArg('--registry',true));
 const view=buildResearchWorkspace({videoEvidence,registry,policy});await mkdir(out,{recursive:true});const raw=JSON.stringify(view,null,2)+'\n';
 await writeFile(resolve(out,'workspace.json'),raw);await writeFile(resolve(out,'review.html'),renderResearchWorkspaceReview(view,{fixtureMode:args.includes('--test-fixture')}));
 await writeFile(resolve(out,'provenance.json'),JSON.stringify({schemaVersion:'workspace-review-provenance-v1',viewDigest:createHash('sha256').update(raw).digest('hex'),sourceSnapshotDigest:view.sourceSnapshotDigest??null,mode:'LOCAL_REVIEW_ONLY',testFixture:args.includes('--test-fixture'),providerCalls:0,orders:0,serverActivated:false,appRouteMounted:false},null,2)+'\n');
 console.log(JSON.stringify({sourceState:view.sourceState,registryState:view.registryState,strategies:view.strategies.length,authority:view.authority}));
}
main().catch(()=>{console.error('WORKSPACE_REVIEW_FAILED: inspect authorized local inputs; no source payload is logged');process.exitCode=1;});
