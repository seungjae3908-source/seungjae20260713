#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { collectCryptoFuturesTemporalEvidenceV1 } from '../src/crypto-temporal-public-collector.mjs';
import {
  assertTemporalEvidenceLedgerV1,
  createTemporalEvidenceLedgerV1,
} from '../src/temporal-evidence-ledger.mjs';

function parseSymbols(value){
  const rows=[...new Set(String(value??'BTCUSDT,ETHUSDT').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean))];
  if(rows.length<1||rows.length>20||rows.some(x=>!/^[A-Z0-9]{3,30}$/.test(x))) throw new Error('RESEARCH_TEMPORAL_CRYPTO_SYMBOLS invalid');
  return rows;
}
function exactSha(value){
  const sha=String(value??'').trim().toLowerCase();
  if(!/^[0-9a-f]{40}$/.test(sha)) throw new Error('RESEARCH_CODE_SHA must be exact 40-char SHA');
  return sha;
}
function safeRoot(value){
  const root=resolve(String(value??'/var/lib/investment-research-production'));
  if(!isAbsolute(root)) throw new Error('state root must be absolute');
  for(const forbidden of ['/opt/stock-app-data','/srv/stock-app','/var/lib/stock-app']){
    if(root===forbidden||root.startsWith(`${forbidden}/`)) throw new Error('temporal research state overlaps protected app storage');
  }
  return root;
}
async function readLedger(path,researchSha){
  try{
    const parsed=JSON.parse(await readFile(path,'utf8'));
    assertTemporalEvidenceLedgerV1(parsed);
    return parsed;
  }catch(error){
    if(error?.code==='ENOENT') return createTemporalEvidenceLedgerV1({researchSha});
    throw error;
  }
}
async function atomicJson(path,value){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temp=`${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});
  await rename(temp,path);
}

try{
  const researchSha=exactSha(process.env.RESEARCH_CODE_SHA);
  const stateRoot=safeRoot(process.env.RESEARCH_STATE_ROOT);
  const symbols=parseSymbols(process.env.RESEARCH_TEMPORAL_CRYPTO_SYMBOLS);
  const ledgerPath=join(stateRoot,'temporal-evidence','crypto-futures-ledger.json');
  const latestPath=join(stateRoot,'latest','temporal-crypto-futures.json');
  const ledger=await readLedger(ledgerPath,researchSha);
  const result=await collectCryptoFuturesTemporalEvidenceV1({
    ledger,
    symbols,
    longShortPeriod:String(process.env.RESEARCH_TEMPORAL_LONG_SHORT_PERIOD??'1h'),
    producerSha:researchSha,
  });
  await atomicJson(ledgerPath,result.ledger);
  await atomicJson(latestPath,{
    schemaVersion:result.schemaVersion,
    generatedAt:Date.now(),
    researchSha,
    status:result.status,
    failedCount:result.failedCount,
    results:result.results,
    observationCount:result.ledger.observations.length,
    ledgerDigest:result.ledger.ledgerDigest,
    safety:result.safety,
  });
  process.stdout.write(`${JSON.stringify({
    status:result.status,
    researchSha,
    symbols,
    failedCount:result.failedCount,
    observationCount:result.ledger.observations.length,
    ledgerDigest:result.ledger.ledgerDigest,
    executionAuthority:'NONE',
  },null,2)}\n`);
  if(result.status==='partial_failure') process.exitCode=1;
}catch(error){
  process.stderr.write(`${JSON.stringify({
    status:'failed_closed',
    error:String(error?.message??error).slice(0,800),
    liveTrading:false,
    privateApi:false,
    realOrders:false,
    executionAuthority:'NONE',
  })}\n`);
  process.exitCode=1;
}
