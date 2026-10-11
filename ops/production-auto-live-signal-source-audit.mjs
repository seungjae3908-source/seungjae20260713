import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  validateMemberAutoTradingPaperHandoff,
} from '../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js';

const [handoffPath, targetRaw, runIdRaw, scheduleActivatedAtRaw] = process.argv.slice(2);
const targetSha = String(targetRaw ?? '').trim().toLowerCase();
const productionDeployRunId = Number(runIdRaw);
const scheduleActivatedAtMs = Number(scheduleActivatedAtRaw);
const maximumAgeMs = 30 * 60_000;
const scheduleTag = '# stock-app-paper-forward-v1';

if (!handoffPath || !/^[0-9a-f]{40}$/u.test(targetSha)
  || !Number.isSafeInteger(productionDeployRunId) || productionDeployRunId <= 0
  || !Number.isSafeInteger(scheduleActivatedAtMs) || scheduleActivatedAtMs <= 0) {
  throw new Error('AUTO_LIVE_SIGNAL_AUDIT_ARGUMENT_INVALID');
}
if (!existsSync(handoffPath)) throw new Error('AUTO_LIVE_SIGNAL_HANDOFF_MISSING');

const nowMs = Date.now();
const handoff = validateMemberAutoTradingPaperHandoff(
  JSON.parse(readFileSync(handoffPath, 'utf8')),
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

const cron = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
if (cron.status !== 0 && cron.status !== 1) throw new Error('AUTO_LIVE_SIGNAL_SCHEDULE_INSPECTION_FAILED');
const taggedLines = String(cron.stdout ?? '').split(/\r?\n/u)
  .filter((line) => line.includes(scheduleTag));
if (taggedLines.length !== 1) throw new Error(`AUTO_LIVE_SIGNAL_SCHEDULE_COUNT_INVALID:${taggedLines.length}`);
if (existsSync('/opt/stock-app-data/paper-forward-v1/DISABLED')) {
  throw new Error('AUTO_LIVE_SIGNAL_SCHEDULE_DISABLED');
}

const markets = [...new Set(handoff.entries.map((entry) => entry.identity.market))].sort();
const receipt = {
  schemaVersion: 'production-auto-live-signal-source-v1',
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
  observedMarkets: markets,
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
