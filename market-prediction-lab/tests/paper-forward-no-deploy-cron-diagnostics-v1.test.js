import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DIAGNOSTIC_SCHEMA_VERSION,
  buildPaperForwardNoDeployDiagnostics,
} from '../../ops/collect-paper-forward-no-deploy-diagnostics.mjs';

const TARGET_SHA = 'a'.repeat(40);
const FAILED_RUN_ID = 35038921110;
const ACTIVATION_AT_MS = Date.parse('2026-09-16T00:14:04.924Z');
const FAILED_AT_MS = Date.parse('2026-09-16T00:33:49.000Z');

function baseObservation(overrides = {}) {
  return {
    activationText: JSON.stringify({
      status: 'ACTIVE_WAITING_FOR_NATURAL_CYCLE',
      targetSha: TARGET_SHA,
      paperRuntimeSourceSha: TARGET_SHA,
      activationAtMs: ACTIVATION_AT_MS,
      scheduleActive: true,
      productionAppDeployPerformed: false,
      productionAppMutationAllowed: false,
    }),
    invocationsText: '',
    cronLogText: '',
    cronLogMetadata: { sizeBytes: 0, modifiedAtMs: FAILED_AT_MS },
    processText: '',
    locksText: JSON.stringify({ locks: [] }),
    crontabText: '',
    stateText: JSON.stringify({
      identity: { researchCodeSha: TARGET_SHA },
      cycles: [],
      positions: [],
      settlements: [],
    }),
    statusText: JSON.stringify({
      status: 'READY',
      scheduleActive: false,
      lanes: [],
      externalFinancialMutationAllowed: false,
    }),
    disabledText: JSON.stringify({ status: 'DISABLED' }),
    rootDisabledSentinel: { observationAvailable: true, present: true },
    runtimeDisabledSentinel: { observationAvailable: true, present: true },
    productionAppSha: 'b'.repeat(40),
    ...overrides,
  };
}

function build(observation) {
  return buildPaperForwardNoDeployDiagnostics({
    targetSha: TARGET_SHA,
    failedRunId: FAILED_RUN_ID,
    failedAtMs: FAILED_AT_MS,
    observedAtMs: FAILED_AT_MS + 60_000,
    observation,
  });
}

test('sanitizes cron output and identifies a runtime failure before invocation persistence', () => {
  const secret = 'SENSITIVE_RUNTIME_LOG_VALUE_DO_NOT_LEAK';
  const evidence = build(baseObservation({
    cronLogText: [
      '[paper-forward-cron] invoked_at=2026-09-16T00:15:00Z',
      secret,
      'Error: PAPER_FORWARD_AUTHORITATIVE_ACCOUNT_SEED_REQUIRED',
    ].join('\n'),
    cronLogMetadata: { sizeBytes: 173, modifiedAtMs: FAILED_AT_MS - 10_000 },
  }));

  assert.equal(evidence.schemaVersion, DIAGNOSTIC_SCHEMA_VERSION);
  assert.equal(evidence.classification, 'CRON_RUNTIME_FAILED_BEFORE_INVOCATION_RECORD');
  assert.equal(evidence.schedule.expectedCronTicksWithinFailureWindow, 2);
  assert.deepEqual(evidence.cronLog.errorCodes, ['PAPER_FORWARD_AUTHORITATIVE_ACCOUNT_SEED_REQUIRED']);
  assert.equal(evidence.cronLog.rawLogIncluded, false);
  assert.equal(JSON.stringify(evidence).includes(secret), false);
  assert.ok(Object.values(evidence.safety).every((value) => value === false));
});

test('distinguishes an active runtime or held flock from a missing cron launch', () => {
  const evidence = build(baseObservation({
    processText: `119 node /opt/stock-app-data/paper-forward-v1/releases/${TARGET_SHA}/market-prediction-lab/scripts/run-paper-forward-schedule.js`,
    locksText: JSON.stringify({ locks: [{ path: '/opt/stock-app-data/paper-forward-v1/cron.lock' }] }),
  }));

  assert.equal(evidence.classification, 'RUNTIME_IN_FLIGHT_OR_LOCKED');
  assert.equal(evidence.runtimeProcess.matchingProcessCount, 1);
  assert.equal(evidence.runtimeProcess.oldestElapsedSeconds, 119);
  assert.equal(evidence.cronLock.cronLockHeld, true);
  assert.equal(evidence.runtimeProcess.processArgumentsIncluded, false);
  assert.equal(evidence.cronLock.lockOwnerIncluded, false);
});

test('labels an invocation completed after the bounded activation window without replay credit', () => {
  const evidence = build(baseObservation({
    invocationsText: JSON.stringify({
      triggerSource: 'cron',
      invokedAtMs: FAILED_AT_MS - 30_000,
      completedAtMs: FAILED_AT_MS + 10_000,
      status: 'COMPLETED',
      mutationCount: 1,
      naturalScheduleInvocation: true,
      privateRequestCount: 0,
      financialMutationCount: 0,
      orderCount: 0,
      liveTrading: false,
      orderAuthority: false,
    }),
  }));

  assert.equal(evidence.classification, 'LATE_COMPLETION_AFTER_ACTIVATION_TIMEOUT');
  assert.equal(evidence.invocations.recordCountAfterActivation, 1);
  assert.equal(evidence.invocations.latest.mutationCount, 1);
  assert.equal(evidence.safety.paperScheduleMutationPerformed, false);
});

test('keeps unavailable evidence distinct from zero and fails closed', () => {
  const evidence = build(baseObservation({ cronLogText: null }));

  assert.equal(evidence.classification, 'INSUFFICIENT_RUNTIME_EVIDENCE');
  assert.equal(evidence.cronLog.available, false);
  assert.equal(evidence.cronLog.sha256, null);
  assert.equal(evidence.cronLog.invocationMarkerCountAfterActivation, null);
  assert.equal(evidence.schedule.crontabObservationAvailable, true);
});

test('workflow binds OWNER command to a failed exact-target run and uses a mutation-free remote collector', async () => {
  const workflowPath = fileURLToPath(new URL(
    '../../.github/workflows/paper-forward-no-deploy-readonly-diagnostics.yml',
    import.meta.url,
  ));
  const activationPath = fileURLToPath(new URL(
    '../../.github/workflows/paper-forward-schedule-no-deploy-activation.yml',
    import.meta.url,
  ));
  const collectorPath = fileURLToPath(new URL(
    '../../ops/collect-paper-forward-no-deploy-diagnostics.mjs',
    import.meta.url,
  ));
  const [workflow, activation, collector] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(activationPath, 'utf8'),
    readFile(collectorPath, 'utf8'),
  ]);

  assert.match(workflow, /AUTHOR_ASSOCIATION !== 'OWNER'/);
  assert.match(workflow, /\^\\\/diagnose-paper-forward-no-deploy \(\[0-9a-f\]\{40\}\) \(\[1-9\]\[0-9\]\*\)\$/);
  assert.match(workflow, /run\.conclusion !== 'failure'/);
  assert.match(workflow, /activate\?\.conclusion !== 'failure'/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /node --input-type=module - %q %q %q/);
  assert.match(workflow, /paper-forward-no-deploy-diagnostic-\$\{\{ env\.TARGET_SHA \}\}-run-\$\{\{ env\.FAILED_RUN_ID \}\}/);

  assert.doesNotMatch(collector, /writeFile|appendFile|renameSync|rmSync|mkdirSync|chmodSync/);
  assert.match(collector, /commandText\('crontab', \['-l'\]\)/);
  assert.match(collector, /remoteMutationPerformed: false/);
  assert.match(collector, /credentialsIncluded: false/);

  const before = activation.indexOf('Capture sanitized Paper cron failure diagnostics before disable');
  const disable = activation.indexOf('Disable schedule automatically on any activation failure');
  const after = activation.indexOf('Capture sanitized Paper cron failure diagnostics after disable');
  const upload = activation.indexOf('Upload sanitized activation evidence');
  assert.ok(before > 0 && before < disable);
  assert.ok(disable < after && after < upload);
});
