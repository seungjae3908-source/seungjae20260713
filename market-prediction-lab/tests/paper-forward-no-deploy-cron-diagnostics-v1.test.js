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

test('V2 extracts only a sanitized Node module-load fatal signature and never leaks its path', () => {
  const secretPath = '/srv/private/customer-secret/credential-value.js';
  const evidence = build(baseObservation({
    cronLogText: [
      '[paper-forward-cron] invoked_at=2026-09-16T00:15:00Z',
      `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${secretPath}' imported from /hidden/runner.js`,
    ].join('\n'),
    cronLogMetadata: {
      sizeBytes: 200,
      modifiedAtMs: Date.parse('2026-09-16T00:15:01.500Z'),
    },
  }));

  assert.equal(DIAGNOSTIC_SCHEMA_VERSION, 'paper-forward-no-deploy-readonly-diagnostic-v2');
  assert.equal(evidence.schemaVersion, DIAGNOSTIC_SCHEMA_VERSION);
  assert.equal(evidence.classification, 'CRON_STARTUP_MODULE_LOAD_FAILURE');
  assert.deepEqual(evidence.cronLog.startupFatalSignatures, ['ERR_MODULE_NOT_FOUND']);
  assert.deepEqual(evidence.cronLog.startupFatalCategories, ['NODE_MODULE_LOAD']);
  assert.equal(evidence.cronLog.safeFatalSignaturesOnly, true);
  assert.equal(evidence.cronLog.rawLogIncluded, false);
  assert.equal(JSON.stringify(evidence).includes(secretPath), false);
  assert.equal(JSON.stringify(evidence).includes('/hidden/runner.js'), false);
});

test('V2 admits PAPER_STATE and AUTHORITATIVE code tokens but drops surrounding sensitive text', () => {
  const secret = 'postgres://private-user:private-password@db.internal/private';
  const evidence = build(baseObservation({
    cronLogText: [
      '[paper-forward-cron] invoked_at=2026-09-16T00:15:00Z',
      `debug=${secret}`,
      'Error: PAPER_STATE_SNAPSHOT_STALE_OR_FUTURE',
      'Error: AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_MANIFEST_INVALID',
    ].join('\n'),
    cronLogMetadata: {
      sizeBytes: 260,
      modifiedAtMs: Date.parse('2026-09-16T00:15:02.000Z'),
    },
  }));

  assert.deepEqual(evidence.cronLog.startupFatalSignatures, [
    'AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_MANIFEST_INVALID',
    'PAPER_STATE_SNAPSHOT_STALE_OR_FUTURE',
  ]);
  assert.deepEqual(evidence.cronLog.startupFatalCategories, [
    'PAPER_STATE',
    'AUTHORITATIVE_RUNTIME',
  ]);
  assert.equal(evidence.classification, 'CRON_RUNTIME_FAILED_BEFORE_INVOCATION_RECORD');
  assert.equal(JSON.stringify(evidence).includes(secret), false);
  assert.ok(Object.values(evidence.safety).every((value) => value === false));
});

test('V2 classifies a short-lived cron as a fast exit even when no allowlisted fatal token exists', () => {
  const evidence = build(baseObservation({
    cronLogText: [
      '[paper-forward-cron] invoked_at=2026-09-16T00:15:00Z',
      'unclassified startup failure text that must not be emitted',
    ].join('\n'),
    cronLogMetadata: {
      sizeBytes: 120,
      modifiedAtMs: Date.parse('2026-09-16T00:15:02.250Z'),
    },
  }));

  assert.equal(evidence.classification, 'CRON_FAST_EXIT_BEFORE_INVOCATION_RECORD');
  assert.equal(evidence.cronLog.fastExitObserved, true);
  assert.equal(evidence.cronLog.latestMarkerToLogMtimeMs, 2250);
  assert.equal(evidence.cronLog.fastExitWindowMs, 30_000);
  assert.deepEqual(evidence.cronLog.startupFatalSignatures, []);
  assert.equal(JSON.stringify(evidence).includes('unclassified startup failure text'), false);
});

test('V2 recognizes the wrapper pinned-runner failure without exposing runtime paths', () => {
  const runtimePath = `/opt/stock-app-data/paper-forward-v1/releases/${TARGET_SHA}/private-runner`;
  const evidence = build(baseObservation({
    cronLogText: [
      '[paper-forward-cron] invoked_at=2026-09-16T00:15:00Z',
      '[paper-forward-cron] pinned runner missing',
      runtimePath,
    ].join('\n'),
    cronLogMetadata: {
      sizeBytes: 180,
      modifiedAtMs: Date.parse('2026-09-16T00:15:00.500Z'),
    },
  }));

  assert.equal(evidence.classification, 'CRON_STARTUP_PINNED_RUNTIME_FAILURE');
  assert.deepEqual(evidence.cronLog.startupFatalSignatures, ['PAPER_FORWARD_PINNED_RUNNER_MISSING']);
  assert.deepEqual(evidence.cronLog.startupFatalCategories, ['PINNED_RUNTIME']);
  assert.equal(JSON.stringify(evidence).includes(runtimePath), false);
});

test('V2 workflow reports only sanitized fatal tokens and preserves the read-only boundary', async () => {
  const workflowPath = fileURLToPath(new URL(
    '../../.github/workflows/paper-forward-no-deploy-readonly-diagnostics.yml',
    import.meta.url,
  ));
  const collectorPath = fileURLToPath(new URL(
    '../../ops/collect-paper-forward-no-deploy-diagnostics.mjs',
    import.meta.url,
  ));
  const [workflow, collector] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(collectorPath, 'utf8'),
  ]);

  assert.match(workflow, /paper-forward-no-deploy-readonly-diagnostic-v2/);
  assert.match(workflow, /STARTUP_FATAL_SIGNATURES=/);
  assert.match(workflow, /STARTUP_FATAL_CATEGORIES=/);
  assert.match(workflow, /FAST_EXIT_OBSERVED=/);
  assert.match(workflow, /LATEST_MARKER_TO_LOG_MTIME_MS=/);
  assert.match(workflow, /safeFatalSignaturesOnly === true/);
  assert.doesNotMatch(workflow, /cronLogText/);
  assert.doesNotMatch(collector, /writeFile|appendFile|renameSync|rmSync|mkdirSync|chmodSync/);
  assert.match(collector, /remoteMutationPerformed: false/);
  assert.match(collector, /rawLogsIncluded: false/);
  assert.match(collector, /credentialsIncluded: false/);
});
