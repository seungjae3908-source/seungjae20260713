#!/usr/bin/env node
// Server-private, no-provider-GET model-source readiness. This CLI never
// publishes raw OHLCV or runs the trading/backtester/Paper engines.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSealedMinuteBacktesterPeriodV1 } from
  '../src/four-market-minute-backtester-prewire-v1.mjs';

const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
const fail=code=>{throw new Error(code);};
const PROPS=new Set(['market','symbol','startDate','endDate','cursorDate']);
async function main() {
  const args=process.argv.slice(2);
  if(!args.length||args.length===1&&args[0]==='--dry-run')return emit({
    status:'DISABLED',providerGETCount:0,archiveFilesWritten:0,
    executionAuthority:'NONE',
  });
  if(args[0]!=='--inspect'||args.length<5||args.length>6
    ||process.env.RESEARCH_MINUTE_SOURCE_READONLY_ENABLED!=='true')
    fail('BACKTEST_SOURCE_OWNER_READONLY_APPROVAL_REQUIRED');
  const values=Object.create(null);
  for(const raw of args.slice(1)){
    const m=/^--([A-Za-z]+)=(.{1,64})$/u.exec(raw);
    if(!m||!PROPS.has(m[1])||Object.hasOwn(values,m[1]))
      fail('BACKTEST_SOURCE_ARGS_INVALID');
    values[m[1]]=m[2];
  }
  for(const name of ['market','symbol','startDate','endDate']){
    if(!values[name])fail('BACKTEST_SOURCE_ARGS_INVALID');
  }
  const sha=String(process.env.RESEARCH_CODE_SHA??'').toLowerCase();
  if(!/^[a-f0-9]{40}$/u.test(sha))fail('BACKTEST_SOURCE_SHA_REQUIRED');
  const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  const actual=execFileSync('git',['rev-parse','HEAD'],{
    cwd:repo,encoding:'utf8',timeout:5000,
  }).trim();
  if(actual!==sha)fail('BACKTEST_SOURCE_SHA_MISMATCH');
  const checked=await inspectSealedMinuteBacktesterPeriodV1({
    enabled:true,root:process.env.RESEARCH_MINUTE_ARCHIVE_ROOT,
    market:values.market,symbol:values.symbol,
    startDate:values.startDate,endDate:values.endDate,
    cursorDate:values.cursorDate??null,daysPerRead:7,
    researchSha:sha,
  });
  // Only bounded source counts and local checksums; never private root names,
  // source payloads or account, current strategy, order, PnL fields.
  emit({
    contract:checked.contract,status:checked.status,
    market:checked.market,symbol:checked.symbol,
    requestedStartDate:checked.requestedStartDate,
    requestedEndDate:checked.requestedEndDate,
    inspectedFirstDate:checked.inspectedFirstDate,
    inspectedLastDate:checked.inspectedLastDate,
    inspectedDayCount:checked.inspectedDayCount,
    originalMinuteDayModelInputs:checked.originalMinuteDayModelInputs,
    blockedSourceDays:checked.blockedSourceDays,
    nextCursorDate:checked.nextCursorDate,
    reports:checked.reports,
    historicalPITProven:false,
    paperAdmissionAllowed:false,profitabilityProven:false,
    providerGETCount:0,archiveFilesWritten:0,executionAuthority:'NONE',
  });
  if(checked.status==='SOURCE_LIMITED_PERIOD_PAGE')process.exitCode=2;
}
main().catch(e=>{
  const reason=/^(?:BACKTEST_SOURCE|MINUTE_ROLLUP|MINUTE_ARCHIVE)_[A-Z0-9_]{1,80}$/u.test(e?.message??'')
    ?e.message:'BACKTEST_SOURCE_READONLY_OPERATION_FAILED';
  emit({status:'BLOCKED',reason,providerGETCount:0,archiveFilesWritten:0,
    executionAuthority:'NONE'});
  process.exitCode=2;
});
