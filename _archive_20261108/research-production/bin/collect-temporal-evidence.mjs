#!/usr/bin/env node
import {
  exactResearchShaV1,
  parseTemporalSymbolsV1,
  runTemporalEvidenceCollectionV1,
  safeTemporalStateRootV1,
} from '../src/temporal-evidence-collection-run-v1.mjs';

try{
  const researchSha=exactResearchShaV1(process.env.RESEARCH_CODE_SHA);
  const stateRoot=safeTemporalStateRootV1(process.env.RESEARCH_STATE_ROOT);
  const symbols=parseTemporalSymbolsV1(process.env.RESEARCH_TEMPORAL_CRYPTO_SYMBOLS);
  const run=await runTemporalEvidenceCollectionV1({
    stateRoot,
    researchSha,
    symbols,
    longShortPeriod:String(process.env.RESEARCH_TEMPORAL_LONG_SHORT_PERIOD??'1h'),
  });
  process.stdout.write(`${JSON.stringify({
    status:run.status,
    researchSha,
    symbols,
    failedCount:run.record?.failedCount??null,
    consecutiveFailures:run.record?.consecutiveFailures??null,
    observationCount:run.record?.observationCount??null,
    ledgerDigest:run.record?.ledgerDigest??null,
    lockHolderState:run.lockHolderState??null,
    executionAuthority:'NONE',
  },null,2)}\n`);
  process.exitCode=run.exitCode;
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
