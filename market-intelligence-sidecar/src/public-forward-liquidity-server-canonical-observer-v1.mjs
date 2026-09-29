import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildServerCanonicalCreditKey,
} from './public-forward-liquidity-server-canonical-runtime-v1.mjs';
import {
  resolveServerEvidenceShadowSlot,
} from './public-forward-liquidity-server-shadow-worker-v1.mjs';

export const SERVER_CANONICAL_OBSERVER_SCHEMA =
  'public-forward-liquidity-server-canonical-observer-v1';
export const SERVER_CANONICAL_TARGET_WORKFLOW_ID = 347888347;

function exactSha(value, code) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) throw new Error(code);
  return normalized;
}
function timeMs(value) { const parsed = Date.parse(String(value ?? '')); return Number.isFinite(parsed) && parsed > 0 ? parsed : null; }
async function fetchJson(url) {
  const response = await fetch(url,{headers:{accept:'application/vnd.github+json','user-agent':'stock-app-server-canonical-observer-v1','x-github-api-version':'2022-11-28'},signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error(`SERVER_CANONICAL_GITHUB_HTTP_${response.status}`);
  return response.json();
}
export async function readPublicGithubMainSha({repository}={}) {
  const repo=String(repository??'').trim();
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) throw new Error('SERVER_CANONICAL_REPOSITORY_INVALID');
  const branch=await fetchJson(`https://api.github.com/repos/${repo}/branches/main`);
  return exactSha(branch?.commit?.sha,'SERVER_CANONICAL_REMOTE_MAIN_SHA_INVALID');
}
export async function observePublicGithubScheduleDelivery({repository,currentMainSha,runtimeActivation,nowMs}={}) {
  const repo=String(repository??'').trim(); const mainSha=exactSha(currentMainSha,'SERVER_CANONICAL_CURRENT_MAIN_SHA_INVALID'); const root=`https://api.github.com/repos/${repo}`;
  const [workflow,targetPage,repoPage]=await Promise.all([fetchJson(`${root}/actions/workflows/${SERVER_CANONICAL_TARGET_WORKFLOW_ID}`),fetchJson(`${root}/actions/workflows/${SERVER_CANONICAL_TARGET_WORKFLOW_ID}/runs?event=schedule&branch=main&per_page=100`),fetchJson(`${root}/actions/runs?event=schedule&branch=main&per_page=100`)]);
  const targetRuns=Array.isArray(targetPage?.workflow_runs)?targetPage.workflow_runs:[]; const repoRuns=Array.isArray(repoPage?.workflow_runs)?repoPage.workflow_runs:[]; const targetLatest=targetRuns[0]??null; const repositoryLatest=repoRuns.find((run)=>Number(run?.workflow_id)!==SERVER_CANONICAL_TARGET_WORKFLOW_ID&&run?.head_sha===mainSha)??null;
  const authority=resolveServerEvidenceShadowSlot({nowMs}); const slotStart=authority?.eligible===true?authority.slot.nominalScheduledAtMs:null; const slotEnd=authority?.eligible===true?authority.slot.slotEndExclusiveMs:null; const currentMainRuns=targetRuns.filter((run)=>run?.head_sha===mainSha);
  const sinceAuthority=currentMainRuns.filter((run)=>{const createdAt=timeMs(run?.created_at);return createdAt!=null&&createdAt>=runtimeActivation.authorizedAtMs;}); const sameSlot=currentMainRuns.filter((run)=>{const createdAt=timeMs(run?.created_at);return createdAt!=null&&slotStart!=null&&slotEnd!=null&&createdAt>=slotStart&&createdAt<slotEnd;});
  return Object.freeze({targetWorkflowId:SERVER_CANONICAL_TARGET_WORKFLOW_ID,targetWorkflowState:workflow?.state??null,targetLatestScheduleWorkflowId:Number(targetLatest?.workflow_id??SERVER_CANONICAL_TARGET_WORKFLOW_ID),targetLatestScheduleEvent:targetLatest?.event??null,targetLatestScheduleHeadSha:targetLatest?.head_sha??null,targetLatestScheduleCreatedAtMs:timeMs(targetLatest?.created_at),targetCurrentMainScheduleRunCount:currentMainRuns.length,targetScheduleRunCountSinceCutoverAuthority:sinceAuthority.length,targetSameSlotScheduleRunCount:sameSlot.length,targetRecoveryObserved:sinceAuthority.length>0,repositoryLatestScheduleCreatedAtMs:timeMs(repositoryLatest?.created_at),repositoryLatestScheduleWorkflowId:Number(repositoryLatest?.workflow_id??0)||null,repositoryLatestScheduleEvent:repositoryLatest?.event??null,repositoryLatestScheduleHeadSha:repositoryLatest?.head_sha??null,observedAtMs:Number(nowMs)});
}
async function readJson(path){return JSON.parse(await readFile(path,'utf8'));}
async function listNestedReceipts(root,filename){const values=[];let slots=[];try{slots=await readdir(root,{withFileTypes:true});}catch(error){if(error?.code==='ENOENT')return values;throw error;}for(const slot of slots){if(!slot.isDirectory())continue;const slotRoot=join(root,slot.name);const attempts=await readdir(slotRoot,{withFileTypes:true});for(const attempt of attempts){if(!attempt.isDirectory())continue;try{values.push(await readJson(join(slotRoot,attempt.name,filename)));}catch(error){if(error?.code!=='ENOENT')throw error;}}}return values;}
export async function buildServerCanonicalLocalCreditLedger({stateRoot,nowMs}={}){const authority=resolveServerEvidenceShadowSlot({nowMs});if(authority?.eligible!==true)return Object.freeze({lookupComplete:true,creditKeyDigest:null,matchingCanonicalCredits:[]});const key=buildServerCanonicalCreditKey({policyDigest:authority.slot.canonicalSlotKey.policyDigest,cohortDigest:authority.slot.canonicalSlotKey.cohortDigest,slotIndex:authority.slotIndex});const receipts=await listNestedReceipts(join(stateRoot,'server-canonical-v1','slots'),'server-canonical-receipt.json');const matchingCanonicalCredits=receipts.filter((receipt)=>receipt?.creditKeyDigest===key.keyDigest&&(receipt?.readyForProtectedCanonicalIngestGate===true||receipt?.prospectiveSlotCredit===1||receipt?.canonicalEconomicCredit===1));return Object.freeze({lookupComplete:true,creditKeyDigest:key.keyDigest,matchingCanonicalCredits});}
export async function buildServerCanonicalHistoricalShadowLedger({stateRoot}={}){const receipts=await listNestedReceipts(join(stateRoot,'slots'),'shadow-receipt.json');const promoted=receipts.filter((receipt)=>receipt?.serverCanonical===true||Number(receipt?.canonicalEconomicCredit??0)!==0||Number(receipt?.prospectiveSlotCredit??0)!==0);return Object.freeze({lookupComplete:true,canonicalCreditN:promoted.length,retroactivePromotionPerformed:promoted.length>0});}
