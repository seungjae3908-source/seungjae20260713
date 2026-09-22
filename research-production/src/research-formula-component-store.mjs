import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, link, lstat, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  assertFormulaCandidateV1,
  canonicalSerializeStrategyFormulaV1,
  GENERATED_FORMULA_CANDIDATE_SCHEMA_VERSION,
} from '../../market-prediction-lab/src/autonomous-strategy-formula-generator-v1.js';

export const RESEARCH_FORMULA_COMPONENT_EXPORT_CONTRACT_V1 =
  'research-formula-component-export/v1';

const HASH64=/^[0-9a-f]{64}$/i;
const SAFE_ID=/^[A-Za-z0-9._:-]{1,220}$/;

function hash(value){
  return createHash('sha256').update(canonicalSerializeStrategyFormulaV1(value),'utf8').digest('hex');
}
function absolute(value,name){
  const raw=String(value??'').trim();
  if(!raw||!isAbsolute(raw)) throw new TypeError(`${name} must be absolute`);
  return resolve(raw);
}
async function safeComponentRoot(value){
  const root=absolute(value,'componentRoot');
  let probe=root;
  while(true){
    try{
      const info=await lstat(probe);
      if(info.isSymbolicLink()) throw new Error('componentRoot must not contain symbolic links');
      if(resolve(await realpath(probe))!==probe) throw new Error('componentRoot must not contain symbolic links');
      break;
    }catch(error){
      if(error?.code!=='ENOENT') throw error;
      const parent=dirname(probe);
      if(parent===probe) throw error;
      probe=parent;
    }
  }
  return root;
}
async function ensureSafeDirectory(path,name,{recursive=false}={}){
  try{
    await mkdir(path,{recursive,mode:0o700});
  }catch(error){
    if(error?.code!=='EEXIST') throw error;
  }
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()) throw new Error(`${name} must be a regular non-symlink directory`);
  if(resolve(await realpath(path))!==path) throw new Error(`${name} must not traverse symbolic links`);
  return path;
}
async function writeOnce(directory,fileName,value){
  const finalPath=join(directory,basename(fileName));
  const temp=join(directory,`.pending-${randomUUID()}`);
  const bytes=`${JSON.stringify(value,null,2)}\n`;
  const handle=await open(temp,'wx',0o600);
  try{
    await handle.writeFile(bytes,'utf8');
    await handle.sync();
  }finally{
    await handle.close();
  }
  try{
    await link(temp,finalPath);
    return Object.freeze({status:'created',path:finalPath,digest:hash(value)});
  }catch(error){
    if(error?.code!=='EEXIST') throw error;
    const info=await lstat(finalPath);
    if(!info.isFile()||info.isSymbolicLink()||resolve(await realpath(finalPath))!==finalPath){
      throw new Error('FORMULA_COMPONENT_EXISTING_PATH_UNSAFE');
    }
    const existing=JSON.parse(await readFile(finalPath,'utf8'));
    if(hash(existing)!==hash(value)) throw new Error('FORMULA_COMPONENT_CONTENT_CONFLICT');
    return Object.freeze({status:'already_present',path:finalPath,digest:hash(existing)});
  }finally{
    try{await unlink(temp);}catch{}
  }
}
function validateGeneratedCandidate(formula,generated){
  if(!generated||typeof generated!=='object'||Array.isArray(generated)) throw new TypeError('generatedCandidate required');
  if(generated.schemaVersion!==GENERATED_FORMULA_CANDIDATE_SCHEMA_VERSION
    ||generated.formulaCandidateId!==formula.candidateId
    ||generated.formulaHash!==formula.formulaHash
    ||generated.hypothesisId!==formula.hypothesisId
    ||generated.strategyFamily!==formula.strategyFamily
    ||generated.familyFingerprint!==formula.familyFingerprint
    ||generated.semanticFingerprint!==formula.semanticFingerprint
    ||!generated.selectedParameters||typeof generated.selectedParameters!=='object'||Array.isArray(generated.selectedParameters)
    ||!HASH64.test(String(generated.parameterIdentity??''))
    ||generated.parameterIdentity!==hash({
      formulaHash:formula.formulaHash,
      selectedParameters:generated.selectedParameters,
    })
    ||generated.generation!==0
    ||generated.searchProvenance?.datasetIdentity!==formula.provenance?.datasetIdentity
    ||generated.searchProvenance?.finalHoldoutAccess!==false
    ||generated.safety?.executionAuthority!=='NONE'
    ||generated.safety?.arbitraryExecutableCodeAllowed!==false){
    throw new Error('GENERATED_FORMULA_CANDIDATE_PROVENANCE_INVALID');
  }
  return generated;
}
function buildDsl(formula){
  return Object.freeze({
    market:formula.market,
    timeframe:formula.timeframe,
    direction:formula.direction,
    availableDataFields:formula.availableDataFields,
    entryDsl:formula.entryDsl,
    exitDsl:formula.exitDsl,
    parameterSpace:formula.parameterSpace,
    limits:formula.dslLimits,
  });
}
function validateTournamentCandidate(candidate){
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate)) throw new TypeError('tournament candidate required');
  if(candidate.researchSurvivor!==true
    ||candidate.failure!==null
    ||candidate.terminalState!=='RESEARCH_SURVIVOR'
    ||candidate.profitable!==false
    ||candidate.provisionalChampion!==false
    ||candidate.validatedChampion!==false
    ||candidate.tradingAuthority!==false
    ||candidate.safety?.executionAuthority!=='NONE'){
    throw new Error('FORMULA_COMPONENT_SURVIVOR_REQUIRED');
  }
  const formula=assertFormulaCandidateV1(candidate.formulaCandidate);
  const generated=validateGeneratedCandidate(formula,candidate.generatedCandidate);
  if(candidate.formulaCandidateId!==formula.candidateId
    ||candidate.generatedCandidateId!==generated.generatedCandidateId
    ||candidate.strategyHash!==formula.formulaHash
    ||candidate.parameterIdentity!==generated.parameterIdentity){
    throw new Error('FORMULA_COMPONENT_TOURNAMENT_IDENTITY_MISMATCH');
  }
  return {formula,generated};
}

export async function exportResearchFormulaComponentsV1({
  componentRoot,
  candidate,
}={}){
  const root=await safeComponentRoot(componentRoot);
  const {formula,generated}=validateTournamentCandidate(candidate);
  if(!SAFE_ID.test(generated.generatedCandidateId)) throw new Error('GENERATED_CANDIDATE_ID_UNSAFE');
  await ensureSafeDirectory(root,'componentRoot',{recursive:true});
  const componentsRoot=await ensureSafeDirectory(join(root,'formula-components'),'formula-components');
  const directory=await ensureSafeDirectory(join(componentsRoot,generated.generatedCandidateId),'formula component directory');
  const dsl=buildDsl(formula);

  const [dslWrite,formulaWrite,generatedWrite]=await Promise.all([
    writeOnce(directory,'dsl.json',dsl),
    writeOnce(directory,'formulaCandidate.json',formula),
    writeOnce(directory,'generatedCandidate.json',generated),
  ]);
  const recordCore=Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_FORMULA_COMPONENT_EXPORT_CONTRACT_V1,
    generatedCandidateId:generated.generatedCandidateId,
    formulaCandidateId:formula.candidateId,
    formulaHash:formula.formulaHash,
    parameterIdentity:generated.parameterIdentity,
    datasetIdentity:generated.searchProvenance.datasetIdentity,
    componentDigests:Object.freeze({
      dsl:dslWrite.digest,
      formulaCandidate:formulaWrite.digest,
      generatedCandidate:generatedWrite.digest,
    }),
    safety:Object.freeze({
      originalTournamentSnapshotsOnly:true,
      recomputationAllowed:false,
      finalHoldoutAccessAllowed:false,
      profitabilityClaimAllowed:false,
      championPromotionAllowed:false,
      liveTrading:false,
      autoTrading:false,
      privateTradingApi:false,
      realOrder:false,
      executionAuthority:'NONE',
    }),
  });
  const record=Object.freeze({...recordCore,recordDigest:hash(recordCore)});
  const recordWrite=await writeOnce(directory,'record.json',record);

  return Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_FORMULA_COMPONENT_EXPORT_CONTRACT_V1,
    status:[dslWrite,formulaWrite,generatedWrite,recordWrite].some(row=>row.status==='created')
      ?'exported':'already_present',
    directory,
    paths:Object.freeze({
      dsl:dslWrite.path,
      formulaCandidate:formulaWrite.path,
      generatedCandidate:generatedWrite.path,
      record:recordWrite.path,
    }),
    generatedCandidateId:generated.generatedCandidateId,
    formulaCandidateId:formula.candidateId,
    formulaHash:formula.formulaHash,
    parameterIdentity:generated.parameterIdentity,
    datasetIdentity:generated.searchProvenance.datasetIdentity,
    executionAuthority:'NONE',
  });
}
