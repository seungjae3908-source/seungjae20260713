#!/usr/bin/env node
// One-command RESEARCH-ONLY local preflight: three previously audited
// read-only CLIs. No server activation, network, private trading API or order.
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

export const MARKET_WATCH_PREFLIGHT_CONTRACT = 'public-market-watch-preflight-v1';
const EXPECTED = Object.freeze([
  ['marketWatch', 'lightweight-market-watch-status.mjs', 'lightweight-market-watch-readback/v1'],
  ['cadence', 'lightweight-market-watch-cadence-status.mjs', 'public-watch-cadence-diagnostic-v1'],
  ['capacity', 'lightweight-market-watch-capacity-status.mjs', 'public-watch-capacity-planning-v1'],
]);
const SOURCE_FLAGS = Object.freeze({
  deploymentApproved: false,
  systemdEnabledOrStarted: false,
  independentlyVerified24hUptime: false,
  fourMarketWholeUniverseProven: false,
  fullCostAndOosProven: false,
  paperExecutionProven: false,
  profitabilityProven: false,
  executionAuthority: 'NONE',
});

function validConfig(root, sha) {
  return typeof root === 'string' && root.length > 1 && root !== '/'
    && isAbsolute(root) && resolve(root) === root
    && typeof sha === 'string' && /^[a-f0-9]{40}$/u.test(sha);
}
function readLocalHelper(script, contract, env) {
  const file = new URL('./' + script, import.meta.url).pathname;
  // Pass ONLY two public-research diagnostic variables, no inherited
  // account keys/production deployment secrets. No shell invocation.
  const result = spawnSync(process.execPath, [file], {
    env, encoding: 'utf8', timeout: 20_000, maxBuffer: 256 * 1024,
  });
  if ((result.status !== 0 && result.status !== 2)
    || result.signal || result.error
    || typeof result.stdout !== 'string' || !result.stdout.trim())
    throw new Error('WATCH_PREFLIGHT_HELPER_FAILED');
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { throw new Error('WATCH_PREFLIGHT_JSON_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.contract !== contract || typeof value.status !== 'string'
    || !/^[A-Z0-9_]{3,55}$/u.test(value.status)
    || value.executionAuthority !== 'NONE'
    || value.continuous24hProven !== false
    || value.profitabilityProven !== false
    || (result.status === 2 && value.status !== 'INVALID')
    || (result.status === 0 && value.status === 'INVALID'))
    throw new Error('WATCH_PREFLIGHT_HELPER_UNTRUSTED');
  return value;
}

export function summarizeWatchReadOnlyPreflight(reports) {
  if (!reports || !['marketWatch','cadence','capacity'].every(k =>
    reports[k] && typeof reports[k].status === 'string'))
    throw new Error('WATCH_PREFLIGHT_REPORTS_MISSING');
  const watch = reports.marketWatch;
  const cadence = reports.cadence;
  const capacity = reports.capacity;
  if (capacity.retentionApplied !== false
    || capacity.archiveVerified !== false
    || capacity.deletionAllowed !== false
    || cadence.cadenceWindowObserved !== false
        && cadence.cadenceWindowObserved !== true
    || cadence.executionAuthority !== 'NONE'
    || watch.executionAuthority !== 'NONE')
    throw new Error('WATCH_PREFLIGHT_FORGED_FLAGS');
  const statuses = {
    marketWatch: watch.status,
    cadence: cadence.status,
    capacity: capacity.status,
  };
  const problems = [];
  for (const [section,status] of Object.entries(statuses)) {
    if (status === 'INVALID') problems.push(section.toUpperCase()+'_INVALID');
    else if (status === 'MISSING'||status === 'INSUFFICIENT_HISTORY')
      problems.push(section.toUpperCase()+'_MISSING_EVIDENCE');
    else if (status === 'HOLD'||status === 'THROTTLED'
      || status === 'BLOCKED_DATA'||status === 'STALE'
      || status === 'PARTIAL'||status === 'INCOMPLETE_OR_INTERRUPTED'
      || status === 'NO_DISCOVERIES'
      || status.startsWith('HOLD_')||status==='INCOMPLETE_DIRECTORY_COVERAGE')
      problems.push(section.toUpperCase()+'_NOT_READY');
  }
  // Even complete local diagnostic records are not a deployment approval.
  return Object.freeze({
    contract: MARKET_WATCH_PREFLIGHT_CONTRACT,
    status: problems.some(x=>x.endsWith('_INVALID')) ? 'INVALID'
      : problems.length ? 'INCOMPLETE' : 'LOCAL_EVIDENCE_ONLY',
    checks: statuses,
    blockers: problems,
    observedCadenceSamples: Number.isSafeInteger(cadence.sampleCount)
      && cadence.sampleCount >= 0 ? cadence.sampleCount : null,
    marketCoverageCount: Number.isSafeInteger(watch.marketCoverageCount)
      && watch.marketCoverageCount >= 0 && watch.marketCoverageCount <= 4
      ? watch.marketCoverageCount : null,
    capacityProjectedDays: Number.isSafeInteger(capacity.projectedDaysAboveFloor)
      && capacity.projectedDaysAboveFloor >= 0
      ? capacity.projectedDaysAboveFloor : null,
    ...SOURCE_FLAGS,
  });
}
async function main() {
  if (process.argv.length !== 2) throw new Error('WATCH_PREFLIGHT_ARGS');
  const root=process.env.RESEARCH_STATE_ROOT??'';
  const sha=process.env.RESEARCH_CODE_SHA??'';
  if (!validConfig(root,sha)) throw new Error('WATCH_PREFLIGHT_CONFIG');
  const env={RESEARCH_STATE_ROOT:root,RESEARCH_CODE_SHA:sha};
  const reports={};
  for(const [key,script,contract] of EXPECTED)
    reports[key]=readLocalHelper(script,contract,env);
  const summary=summarizeWatchReadOnlyPreflight(reports);
  process.stdout.write(JSON.stringify(summary)+'\n');
  if(summary.status==='INVALID')process.exitCode=2;
}
main().catch(()=>{
  // Fixed-code diagnostics only: never print private paths or raw child output.
  process.stdout.write(JSON.stringify({
    contract:MARKET_WATCH_PREFLIGHT_CONTRACT,
    status:'INVALID',checks:null,blockers:['WATCH_PREFLIGHT_FAILED'],
    marketCoverageCount:null,observedCadenceSamples:null,
    capacityProjectedDays:null,...SOURCE_FLAGS,
  })+'\n');
  process.exitCode=2;
});
