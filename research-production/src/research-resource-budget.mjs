import { statfs } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { resolve } from 'node:path';

export const RESEARCH_RESOURCE_BUDGET_CONTRACT_V1 = 'research-resource-budget/v1';

export const DEFAULT_RESEARCH_RESOURCE_POLICY_V1 = Object.freeze({
  memoryHoldFreeRatio: 0.08,
  memoryThrottleFreeRatio: 0.18,
  loadThrottlePerCpu: 0.75,
  loadSeverePerCpu: 1.0,
  absoluteConcurrencyCap: 16,
});

const PROFILES = new Set(['forward', 'fast-historical', 'long-history', 'all']);

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function positiveInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(`${name} must be a positive integer <= ${max}`);
  return value;
}

function nonNegative(value, name) {
  const n = finite(value, name);
  if (n < 0) throw new RangeError(`${name} must be non-negative`);
  return n;
}

function ratio(value, name) {
  const n = finite(value, name);
  if (n < 0 || n > 1) throw new RangeError(`${name} must be between zero and one`);
  return n;
}

function validatePolicy(raw = DEFAULT_RESEARCH_RESOURCE_POLICY_V1) {
  const policy = {
    memoryHoldFreeRatio: ratio(raw.memoryHoldFreeRatio, 'memoryHoldFreeRatio'),
    memoryThrottleFreeRatio: ratio(raw.memoryThrottleFreeRatio, 'memoryThrottleFreeRatio'),
    loadThrottlePerCpu: nonNegative(raw.loadThrottlePerCpu, 'loadThrottlePerCpu'),
    loadSeverePerCpu: nonNegative(raw.loadSeverePerCpu, 'loadSeverePerCpu'),
    absoluteConcurrencyCap: positiveInteger(raw.absoluteConcurrencyCap, 'absoluteConcurrencyCap', 64),
  };
  if (policy.memoryHoldFreeRatio >= policy.memoryThrottleFreeRatio) {
    throw new Error('memory hold threshold must be below throttle threshold');
  }
  if (policy.loadThrottlePerCpu >= policy.loadSeverePerCpu) {
    throw new Error('load throttle threshold must be below severe threshold');
  }
  return Object.freeze(policy);
}

function validateSnapshot(raw = {}) {
  const cpuCount = positiveInteger(raw.cpuCount, 'cpuCount', 4096);
  const load1 = nonNegative(raw.load1, 'load1');
  const totalMemoryBytes = positiveInteger(raw.totalMemoryBytes, 'totalMemoryBytes');
  const freeMemoryBytes = nonNegative(raw.freeMemoryBytes, 'freeMemoryBytes');
  const freeDiskBytes = nonNegative(raw.freeDiskBytes, 'freeDiskBytes');
  const minimumFreeDiskBytes = nonNegative(raw.minimumFreeDiskBytes, 'minimumFreeDiskBytes');
  if (freeMemoryBytes > totalMemoryBytes) throw new Error('freeMemoryBytes cannot exceed totalMemoryBytes');
  return Object.freeze({
    cpuCount,
    load1,
    totalMemoryBytes,
    freeMemoryBytes,
    freeDiskBytes,
    minimumFreeDiskBytes,
  });
}

export function planResearchResourceBudgetV1({
  profile,
  configuredConcurrency,
  snapshot,
  policy: rawPolicy = DEFAULT_RESEARCH_RESOURCE_POLICY_V1,
} = {}) {
  if (!PROFILES.has(profile)) throw new TypeError('unsupported research profile');
  const configured = positiveInteger(configuredConcurrency, 'configuredConcurrency', 64);
  const evidence = validateSnapshot(snapshot);
  const policy = validatePolicy(rawPolicy);

  const memoryFreeRatio = evidence.freeMemoryBytes / evidence.totalMemoryBytes;
  const loadPerCpu = evidence.load1 / evidence.cpuCount;
  const baseConcurrency = profile === 'forward'
    ? 1
    : Math.max(1, Math.min(configured, evidence.cpuCount, policy.absoluteConcurrencyCap));
  const reasons = [];

  let status = 'RUN';
  let maxConcurrentJobs = baseConcurrency;

  if (evidence.freeDiskBytes < evidence.minimumFreeDiskBytes) {
    status = 'HOLD';
    maxConcurrentJobs = 0;
    reasons.push('DISK_BELOW_SAFETY_FLOOR');
  }
  if (memoryFreeRatio < policy.memoryHoldFreeRatio) {
    status = 'HOLD';
    maxConcurrentJobs = 0;
    reasons.push('MEMORY_CRITICAL');
  }

  if (status !== 'HOLD') {
    if (memoryFreeRatio < policy.memoryThrottleFreeRatio) {
      status = 'THROTTLED';
      maxConcurrentJobs = Math.min(maxConcurrentJobs, 1);
      reasons.push('MEMORY_PRESSURE');
    }
    if (loadPerCpu >= policy.loadSeverePerCpu) {
      status = 'THROTTLED';
      maxConcurrentJobs = Math.min(maxConcurrentJobs, 1);
      reasons.push('CPU_LOAD_SEVERE');
    } else if (loadPerCpu >= policy.loadThrottlePerCpu) {
      status = 'THROTTLED';
      maxConcurrentJobs = Math.min(maxConcurrentJobs, Math.max(1, Math.floor(baseConcurrency / 2)));
      reasons.push('CPU_LOAD_ELEVATED');
    }
  }

  if (profile === 'forward' && maxConcurrentJobs > 1) {
    throw new Error('forward research concurrency must remain one');
  }

  return Object.freeze({
    schemaVersion: 1,
    contract: RESEARCH_RESOURCE_BUDGET_CONTRACT_V1,
    profile,
    status,
    configuredConcurrency: configured,
    baseConcurrency,
    maxConcurrentJobs,
    reasons: Object.freeze([...new Set(reasons)]),
    evidence: Object.freeze({
      cpuCount: evidence.cpuCount,
      loadPerCpu,
      memoryFreeRatio,
      freeDiskBytes: evidence.freeDiskBytes,
      minimumFreeDiskBytes: evidence.minimumFreeDiskBytes,
    }),
    policy,
    safety: Object.freeze({
      readOnlyPlanner: true,
      processKilled: false,
      serviceMutation: false,
      scheduleMutation: false,
      runtimeConcurrencyMutation: false,
      liveTrading: false,
      autoTrading: false,
      privateTradingApi: false,
      realOrder: false,
      executionAuthority: 'NONE',
    }),
  });
}

export async function readResearchResourceSnapshotV1({
  stateRoot,
  minimumFreeDiskBytes,
} = {}) {
  const root = resolve(String(stateRoot ?? ''));
  if (!root.startsWith('/')) throw new TypeError('stateRoot must resolve to an absolute path');
  const filesystem = await statfs(root);
  const freeDiskBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  return Object.freeze({
    cpuCount: cpus().length,
    load1: loadavg()[0],
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    freeDiskBytes,
    minimumFreeDiskBytes: nonNegative(Number(minimumFreeDiskBytes), 'minimumFreeDiskBytes'),
  });
}
