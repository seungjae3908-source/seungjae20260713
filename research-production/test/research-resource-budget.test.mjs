import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RESEARCH_RESOURCE_POLICY_V1,
  planResearchResourceBudgetV1,
} from '../src/research-resource-budget.mjs';

function snapshot(overrides={}) {
  return {
    cpuCount: 8,
    load1: 2,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeMemoryBytes: 8 * 1024 ** 3,
    freeDiskBytes: 100 * 1024 ** 3,
    minimumFreeDiskBytes: 5 * 1024 ** 3,
    ...overrides,
  };
}

test('healthy resources preserve configured bounded concurrency',()=>{
  const plan=planResearchResourceBudgetV1({
    profile:'fast-historical',
    configuredConcurrency:4,
    snapshot:snapshot(),
  });
  assert.equal(plan.status,'RUN');
  assert.equal(plan.maxConcurrentJobs,4);
  assert.deepEqual(plan.reasons,[]);
  assert.equal(plan.safety.runtimeConcurrencyMutation,false);
  assert.equal(plan.safety.executionAuthority,'NONE');
});

test('forward lane is permanently constrained to one worker',()=>{
  const plan=planResearchResourceBudgetV1({
    profile:'forward',
    configuredConcurrency:16,
    snapshot:snapshot(),
  });
  assert.equal(plan.status,'RUN');
  assert.equal(plan.baseConcurrency,1);
  assert.equal(plan.maxConcurrentJobs,1);
});

test('elevated CPU load throttles concurrency instead of starting more work',()=>{
  const plan=planResearchResourceBudgetV1({
    profile:'long-history',
    configuredConcurrency:8,
    snapshot:snapshot({load1:6.4}),
  });
  assert.equal(plan.status,'THROTTLED');
  assert.equal(plan.maxConcurrentJobs,4);
  assert.ok(plan.reasons.includes('CPU_LOAD_ELEVATED'));
});

test('severe CPU load or memory pressure reduces work to one',()=>{
  const cpu=planResearchResourceBudgetV1({
    profile:'fast-historical',
    configuredConcurrency:8,
    snapshot:snapshot({load1:8.8}),
  });
  assert.equal(cpu.status,'THROTTLED');
  assert.equal(cpu.maxConcurrentJobs,1);
  assert.ok(cpu.reasons.includes('CPU_LOAD_SEVERE'));

  const memory=planResearchResourceBudgetV1({
    profile:'fast-historical',
    configuredConcurrency:8,
    snapshot:snapshot({freeMemoryBytes:2 * 1024 ** 3}),
  });
  assert.equal(memory.status,'THROTTLED');
  assert.equal(memory.maxConcurrentJobs,1);
  assert.ok(memory.reasons.includes('MEMORY_PRESSURE'));
});

test('critical memory or disk below safety floor holds new research work',()=>{
  const memory=planResearchResourceBudgetV1({
    profile:'fast-historical',
    configuredConcurrency:4,
    snapshot:snapshot({freeMemoryBytes:512 * 1024 ** 2}),
  });
  assert.equal(memory.status,'HOLD');
  assert.equal(memory.maxConcurrentJobs,0);
  assert.ok(memory.reasons.includes('MEMORY_CRITICAL'));

  const disk=planResearchResourceBudgetV1({
    profile:'fast-historical',
    configuredConcurrency:4,
    snapshot:snapshot({freeDiskBytes:4 * 1024 ** 3}),
  });
  assert.equal(disk.status,'HOLD');
  assert.equal(disk.maxConcurrentJobs,0);
  assert.ok(disk.reasons.includes('DISK_BELOW_SAFETY_FLOOR'));
});

test('policy thresholds are explicit and cannot be internally inverted',()=>{
  assert.throws(()=>planResearchResourceBudgetV1({
    profile:'fast-historical',
    configuredConcurrency:4,
    snapshot:snapshot(),
    policy:{...DEFAULT_RESEARCH_RESOURCE_POLICY_V1,memoryHoldFreeRatio:0.3,memoryThrottleFreeRatio:0.2},
  }),/hold threshold/);
});
