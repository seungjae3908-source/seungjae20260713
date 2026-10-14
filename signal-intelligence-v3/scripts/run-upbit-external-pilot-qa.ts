// @ts-nocheck
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UpbitExternalPilotPublicDataClient } from '../../api-server/src/services/upbit-external-pilot-public-data.service';
import {
  buildEmptyExternalPilotHandoffFile,
  ExistingMarketAiExternalPilotReviewer,
  produceUpbitTrendPullbackExternalPilot,
  resolveExternalPilotFreeAiPolicy,
} from '../../api-server/src/services/external-strategy-pilot-producer.service';
import { parseExternalStrategyPilotHandoffFile } from '../../api-server/src/services/member-auto-trading-background-worker.service';
import { appendPublicQaCycle } from '../../api-server/src/services/external-strategy-pilot-statistics.service';

const serviceSha = String(process.env.SIGNAL_INTELLIGENCE_SERVICE_SHA ?? '').trim().toLowerCase();
if (!/^[a-f0-9]{40}$/u.test(serviceSha)) throw new Error('SIGNAL_INTELLIGENCE_SERVICE_SHA_REQUIRED');

const outputFile = path.resolve(process.env.EXTERNAL_PILOT_QA_OUTPUT_FILE
  ?? './state/external-pilot/upbit-public-qa.json');
const handoffFile = path.resolve(process.env.MEMBER_AUTO_TRADING_EXTERNAL_PILOT_HANDOFF_PATH
  ?? './state/external-pilot/member-auto-trading-latest.json');
const historyFile = path.resolve(process.env.EXTERNAL_PILOT_STATISTICS_HISTORY_PATH
  ?? './state/external-pilot/public-signal-history-v1.json');
const symbols = [...new Set(String(process.env.EXTERNAL_PILOT_UPBIT_SYMBOLS ?? 'KRW-BTC,KRW-ETH,KRW-XRP')
  .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean))].slice(0, 10);
if (symbols.length === 0) throw new Error('EXTERNAL_PILOT_UPBIT_SYMBOLS_REQUIRED');

function costPolicy() {
  const commissionRate = Number(process.env.EXTERNAL_PILOT_UPBIT_COMMISSION_RATE);
  const entryCommissionRate = Number(process.env.EXTERNAL_PILOT_UPBIT_ENTRY_COMMISSION_RATE);
  const exitCommissionRate = Number(process.env.EXTERNAL_PILOT_UPBIT_EXIT_COMMISSION_RATE);
  const minimumOrderKrw = Number(process.env.EXTERNAL_PILOT_UPBIT_MINIMUM_ORDER_KRW);
  const version = String(process.env.EXTERNAL_PILOT_UPBIT_COST_POLICY_VERSION ?? '').trim();
  const provenance = String(process.env.EXTERNAL_PILOT_UPBIT_COST_PROVENANCE ?? '').trim();
  const quality = String(process.env.EXTERNAL_PILOT_UPBIT_COST_QUALITY ?? '').trim();
  const observedAtMs = Date.parse(String(process.env.EXTERNAL_PILOT_UPBIT_COST_OBSERVED_AT ?? ''));
  if (!Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate >= 0.1
    || !version || !provenance || !Number.isFinite(observedAtMs)
    || !['ACCOUNT_READBACK', 'DOCUMENTED_CURRENT_POLICY'].includes(quality)) return null;
  return Object.freeze({
    version, commissionRate, provenance, observedAtMs, quality,
    ...(Number.isFinite(entryCommissionRate) && entryCommissionRate >= 0
      ? { entryCommissionRate } : {}),
    ...(Number.isFinite(exitCommissionRate) && exitCommissionRate >= 0
      ? { exitCommissionRate } : {}),
    ...(Number.isFinite(minimumOrderKrw) && minimumOrderKrw > 0
      ? { minimumOrderKrw } : {}),
  });
}

async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}

const startedAtMs = Date.now();
const client = new UpbitExternalPilotPublicDataClient();
const aiPolicy = resolveExternalPilotFreeAiPolicy();
const aiReviewer = process.env.EXTERNAL_PILOT_AI_REVIEW_ENABLED === 'true' && aiPolicy.configured
  ? new ExistingMarketAiExternalPilotReviewer(undefined, Date.now, aiPolicy)
  : null;
const configuredCost = costPolicy();
const rows = [];
let selectedHandoff = null;

for (const symbol of symbols) {
  try {
    const snapshot = await client.snapshot(symbol);
    const produced = await produceUpbitTrendPullbackExternalPilot({
      serviceSha,
      snapshot,
      costPolicy: configuredCost,
      aiReviewer,
      nowMs: Date.now(),
    });
    const admitted = produced.state === 'READY'
      ? parseExternalStrategyPilotHandoffFile(produced.handoff, Date.now()).entryCount
      : 0;
    const row = Object.freeze({ ...produced, workerContractAdmissionCount: admitted });
    rows.push(row);
    if (!selectedHandoff || row.state === 'READY') selectedHandoff = row.handoff;
    if (row.state === 'READY') break;
  } catch (error) {
    rows.push(Object.freeze({
      schemaVersion: 'external-strategy-pilot-producer-result-v1',
      market: 'CRYPTO_SPOT',
      symbol,
      strategyId: 'TREND_PULLBACK_REACCEL_V1',
      observationKind: 'PROVIDER_ERROR',
      state: 'BLOCKED_DATA',
      naturalCandidateCount: 0,
      riskAdmissionCount: 0,
      handoffEntryCount: 0,
      workerContractAdmissionCount: 0,
      blockers: [String(error?.message ?? error).slice(0, 240)],
      metrics: {},
      handoff: null,
    }));
  }
}

selectedHandoff ??= buildEmptyExternalPilotHandoffFile(
  serviceSha, Date.now(), `external-pilot:provider-blocked:${Date.now()}`,
);
parseExternalStrategyPilotHandoffFile(selectedHandoff, Date.now());
await atomicJson(handoffFile, selectedHandoff);

const totals = rows.reduce((sum, row) => ({
  naturalCandidateCount: sum.naturalCandidateCount + Number(row.naturalCandidateCount ?? 0),
  riskAdmissionCount: sum.riskAdmissionCount + Number(row.riskAdmissionCount ?? 0),
  handoffEntryCount: sum.handoffEntryCount + Number(row.handoffEntryCount ?? 0),
  workerContractAdmissionCount: sum.workerContractAdmissionCount + Number(row.workerContractAdmissionCount ?? 0),
  providerSuccessCount: sum.providerSuccessCount + (row.observationKind === 'LIVE_PUBLIC_MARKET' ? 1 : 0),
  providerFailureCount: sum.providerFailureCount + (row.observationKind === 'PROVIDER_ERROR' ? 1 : 0),
  errorCount: sum.errorCount + (row.state === 'BLOCKED_DATA' ? 1 : 0),
}), { naturalCandidateCount: 0, riskAdmissionCount: 0, handoffEntryCount: 0,
  workerContractAdmissionCount: 0, providerSuccessCount: 0, providerFailureCount: 0, errorCount: 0 });
const report = Object.freeze({
  schemaVersion: 'upbit-external-strategy-pilot-public-qa-v1',
  serviceSha,
  startedAt: new Date(startedAtMs).toISOString(),
  completedAt: new Date().toISOString(),
  elapsedMs: Date.now() - startedAtMs,
  market: 'CRYPTO_SPOT',
  provider: 'UPBIT_PUBLIC',
  symbolsRequested: Object.freeze(symbols),
  actualPublicData: totals.providerSuccessCount > 0,
  completePublicData: totals.providerFailureCount === 0,
  observationKind: totals.providerFailureCount === 0 ? 'LIVE_PUBLIC_MARKET' : 'PARTIAL_PROVIDER_OBSERVATION',
  strategyId: 'TREND_PULLBACK_REACCEL_V1',
  costPolicyConfigured: configuredCost != null,
  aiReviewConfigured: aiReviewer != null,
  aiReviewConfigurationReason: process.env.EXTERNAL_PILOT_AI_REVIEW_ENABLED === 'true'
    ? aiPolicy.reason : 'EXTERNAL_PILOT_AI_REVIEW_DISABLED',
  aiReviewProvider: aiPolicy.configured ? aiPolicy.provider : null,
  aiReviewModel: aiPolicy.configured ? aiPolicy.model : null,
  rows: Object.freeze(rows),
  totals: Object.freeze(totals),
  safety: Object.freeze({
    executionAuthority: 'NONE',
    privateTradingApiAllowed: false,
    accountReadbackPerformed: false,
    orderSubmitted: false,
    orderCancelled: false,
    liveArmChanged: false,
  }),
});
await atomicJson(outputFile, report);
let previousHistory = null;
try {
  previousHistory = JSON.parse(await readFile(historyFile, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await atomicJson(historyFile, appendPublicQaCycle(previousHistory, report));
console.log(JSON.stringify(report));
