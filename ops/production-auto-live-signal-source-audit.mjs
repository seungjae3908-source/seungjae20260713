import { lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import signalIdentity from './production-auto-live-signal-identity.cjs';
import {
  validateMemberAutoTradingPaperHandoff,
} from '../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js';

const [handoffPath, targetRaw, runIdRaw, scheduleActivatedAtRaw] = process.argv.slice(2);
const targetSha = String(targetRaw ?? '').trim().toLowerCase();
const productionDeployRunId = Number(runIdRaw);
const scheduleActivatedAtMs = Number(scheduleActivatedAtRaw);
const maximumAgeMs = 30 * 60_000;

if (!handoffPath || !/^[0-9a-f]{40}$/u.test(targetSha)
  || !Number.isSafeInteger(productionDeployRunId) || productionDeployRunId <= 0
  || !Number.isSafeInteger(scheduleActivatedAtMs) || scheduleActivatedAtMs <= 0) {
  throw new Error('AUTO_LIVE_SIGNAL_AUDIT_ARGUMENT_INVALID');
}
const nowMs = Date.now();
const handoff = validateMemberAutoTradingPaperHandoff(
  signalIdentity.readProductionAutoLiveSignalHandoff(handoffPath),
  nowMs,
);
if (handoff.status !== 'READY' || handoff.blockers.length !== 0) {
  throw new Error('AUTO_LIVE_SIGNAL_HANDOFF_NOT_READY');
}
if (nowMs < handoff.evaluatedAtMs || nowMs - handoff.evaluatedAtMs > maximumAgeMs) {
  throw new Error('AUTO_LIVE_SIGNAL_HANDOFF_STALE');
}
if (handoff.evaluatedAtMs < scheduleActivatedAtMs) {
  throw new Error('AUTO_LIVE_SIGNAL_HANDOFF_PREDATES_EXACT_SHA_SCHEDULE');
}
if (handoff.safety.executionAuthority !== 'NONE'
  || handoff.safety.publicDataOnly !== true
  || handoff.safety.simulatedOnly !== true
  || handoff.safety.liveTrading !== false
  || handoff.safety.privateTradingApiAllowed !== false
  || handoff.safety.orderSubmitted !== false) {
  throw new Error('AUTO_LIVE_SIGNAL_HANDOFF_AUTHORITY_INVALID');
}

// Read-only command: bound execution time and output size, fail closed on
// stderr/exit errors rather than deriving schedule proof from partial output.
const cron = spawnSync('crontab', ['-l'], {
  encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
  env: { ...process.env, LC_ALL: 'C' },
});
if (cron.error || cron.signal || cron.status !== 0 || typeof cron.stdout !== 'string') {
  throw new Error('AUTO_LIVE_SIGNAL_SCHEDULE_INSPECTION_FAILED');
}
const scheduleRoot = '/opt/stock-app-data/paper-forward-v1';
const activationPath = scheduleRoot + '/activation.json';
const wrapperPath = scheduleRoot + '/bin/run-paper-forward-schedule';
let activation;
try {
  const activationStat = lstatSync(activationPath);
  if (!activationStat.isFile() || activationStat.isSymbolicLink()
    || activationStat.size <= 0 || activationStat.size > 32 * 1024) {
    throw new Error('INVALID_ACTIVATION_FILE');
  }
  activation = JSON.parse(readFileSync(activationPath, 'utf8'));
} catch {
  throw new Error('AUTO_LIVE_SIGNAL_SCHEDULE_ACTIVATION_MISSING_OR_INVALID');
}
signalIdentity.inspectManagedPaperForwardSchedule(
  String(cron.stdout ?? ''), activation, targetSha, scheduleActivatedAtMs, nowMs,
);
signalIdentity.assertAutoLiveSignalNotDisabled(scheduleRoot);
try {
  const wrapperStat = lstatSync(wrapperPath);
  if (!wrapperStat.isFile() || wrapperStat.isSymbolicLink()
    || (wrapperStat.mode & 0o111) === 0
    || (wrapperStat.mode & 0o077) !== 0 || wrapperStat.size > 64 * 1024) {
    throw new Error('INVALID_WRAPPER_MODE');
  }
  const wrapper = readFileSync(wrapperPath, 'utf8');
  if (!wrapper.includes("PAPER_FORWARD_RESEARCH_SHA='" + targetSha + "'")
    || !wrapper.includes("AUTO_LIVE_PUBLIC_SIGNAL_REFRESH_ENABLED='true'")
    || !wrapper.includes("PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED='false'")
    || !wrapper.includes("LIVE_TRADING='false'")
    || !wrapper.includes("PRIVATE_TRADING_API_ALLOWED='false'")) {
    throw new Error('INVALID_WRAPPER_IDENTITY');
  }
} catch {
  throw new Error('AUTO_LIVE_SIGNAL_SCHEDULE_WRAPPER_INVALID');
}

const identity = signalIdentity.inspectSignalEntryIdentity(handoff.entries, targetSha);
const receipt = {
  schemaVersion: 'production-auto-live-signal-source-v2',
  targetSha,
  productionDeployRunId,
  generatedAt: new Date(nowMs).toISOString(),
  scheduleActivatedAt: new Date(scheduleActivatedAtMs).toISOString(),
  handoffEvaluatedAfterScheduleActivation: true,
  canonicalValidation: true,
  handoffStatus: 'READY',
  handoffFresh: true,
  maximumAgeMinutes: 30,
  entryCount: handoff.entryCount,
  ...identity,
  scheduleActive: true,
  scheduleEntryCount: 1,
  disableSentinelPresent: false,
  publicDataOnly: true,
  privateRequestCount: 0,
  financialMutationCount: 0,
  orderRequests: 0,
  cancelRequests: 0,
  amendRequests: 0,
  transferRequests: 0,
  withdrawalRequests: 0,
  realOrderSubmitted: false,
  liveTradingAuthorityGranted: false,
  autoTradingAuthorityGranted: false,
  executionAuthority: 'NONE',
  secretValuesRecorded: false,
  accountValuesRecorded: false,
};

process.stdout.write(`${JSON.stringify(receipt)}\n`);
