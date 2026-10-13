#!/usr/bin/env node
// Read-only Research provider archive-day inspector. No network, no writes.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectImmutableMinuteDayRollupV1 } from
  '../src/four-market-minute-daily-rollup-v1.mjs';

const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const fail=why=>{throw new Error(why);};
const key=/^--(market|symbol|day)=(.{1,64})$/u;
async function main(){
  const args=process.argv.slice(2);
  if(!args.length || args.length===1&&args[0]==='--dry-run')
    return emit({status:'DISABLED',providerGETCount:0,archiveFilesWritten:0,
      executionAuthority:'NONE'});
  if(args[0]!=='--inspect'||args.length!==4
    ||process.env.RESEARCH_MINUTE_SOURCE_READONLY_ENABLED!=='true')
    fail('MINUTE_ROLLUP_OWNER_READONLY_APPROVAL_REQUIRED');
  const parts=Object.create(null);
  for(const raw of args.slice(1)){
    const match=key.exec(raw);
    if(!match||Object.hasOwn(parts,match[1]))
      fail('MINUTE_ROLLUP_ARGS_INVALID');
    parts[match[1]]=match[2];
  }
  if(!parts.market||!parts.symbol||!parts.day)
    fail('MINUTE_ROLLUP_ARGS_INVALID');
  const sha=String(process.env.RESEARCH_CODE_SHA??'').toLowerCase();
  if(!/^[0-9a-f]{40}$/u.test(sha))fail('MINUTE_ROLLUP_SHA_REQUIRED');
  const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  const actual=execFileSync('git',['rev-parse','HEAD'],{
    cwd:repo,timeout:5_000,encoding:'utf8',
  }).trim();
  if(actual!==sha)fail('MINUTE_ROLLUP_SHA_MISMATCH');
  const result=await inspectImmutableMinuteDayRollupV1({
    root:process.env.RESEARCH_MINUTE_ARCHIVE_ROOT,
    market:parts.market,symbol:parts.symbol,day:parts.day,
    researchSha:sha,
  });
  // Only safe count/digest/status facts. Never send raw source OHLCV
  // to HTTP, app members, Telegram, or third-party AI.
  const intervals=result.derivedReport?.intervalData??{};
  emit({
    contract:result.contract,status:result.status,reason:result.reason,
    market:result.market,symbol:result.symbol,day:result.day,
    sourceMinutePages:result.sourceMinutePages,
    sourceMinuteRows:result.sourceMinuteRows,
    duplicateOverlappingSourceRows:result.duplicateOverlappingSourceRows??null,
    missingOneMinuteSlots:result.missingOneMinuteSlots,
    missingOneMinutePreview:result.missingOneMinutePreview??[],
    originalProducerShas:result.originalProducerShas??[],
    sourceMinutesDigest:result.sourceMinutesDigest??null,
    derived:Object.fromEntries(Object.entries(intervals).map(([name,v])=>[
      name,{completeBarCount:v.completeBarCount,
        missingUnverifiedSourceBuckets:v.missingUnverifiedSourceBuckets,
        barDataUnavailableAtCutoffBuckets:v.barDataUnavailableAtCutoffBuckets,
        notYetClosedBuckets:v.notYetClosedBuckets,
        barsSha256:v.barsSha256},
    ])),
    independentPITProven:false,profitabilityProven:false,
    paperAdmissionAllowed:false,providerGETCount:0,
    archiveFilesWritten:0,executionAuthority:'NONE',
  });
  if(result.status!=='SOURCE_ONLY_COMPLETE_DAY_MINUTES')process.exitCode=2;
}
main().catch(error=>{
  const reason=/^MINUTE_ROLLUP_[A-Z0-9_]{1,80}$/u.test(error?.message??'')
    ?error.message:'MINUTE_ROLLUP_READONLY_OPERATION_FAILED';
  emit({status:'BLOCKED',reason,providerGETCount:0,
    archiveFilesWritten:0,executionAuthority:'NONE'});
  process.exitCode=2;
});
