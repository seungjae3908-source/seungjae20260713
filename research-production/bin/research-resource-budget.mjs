#!/usr/bin/env node
import { planResearchResourceBudgetV1, readResearchResourceSnapshotV1 } from '../src/research-resource-budget.mjs';

try {
  const profile=String(process.env.RESEARCH_PROFILE??'fast-historical');
  const configuredConcurrency=Number(process.env.RESEARCH_CONCURRENCY??4);
  const stateRoot=String(process.env.RESEARCH_STATE_ROOT??'/var/lib/investment-research-production');
  const minimumFreeDiskBytes=Number(process.env.RESEARCH_MIN_FREE_BYTES??5*1024**3);
  const snapshot=await readResearchResourceSnapshotV1({stateRoot,minimumFreeDiskBytes});
  const plan=planResearchResourceBudgetV1({profile,configuredConcurrency,snapshot});
  process.stdout.write(`${JSON.stringify(plan,null,2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    schemaVersion:1,
    contract:'research-resource-budget/v1',
    status:'FAILED_CLOSED',
    error:String(error?.message??error).slice(0,300),
    maxConcurrentJobs:0,
    liveTrading:false,
    executionAuthority:'NONE',
  })}\n`);
  process.exitCode=1;
}
