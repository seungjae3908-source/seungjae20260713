import fs from 'node:fs';

const [file, expectedSha, expectedRunId] = process.argv.slice(2);
const sha = String(expectedSha ?? '').toLowerCase();
const runId = Number(expectedRunId);
if (!file || !/^[0-9a-f]{40}$/.test(sha) || !Number.isSafeInteger(runId) || runId <= 0) {
  throw new Error('PRODUCTION_AUTOMATION_RESEARCH_VERIFY_ARGUMENT_INVALID');
}
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
const features = value?.features ?? {};
if (
  value?.schemaVersion !== 'production-automation-research-core-qa-v1'
  || value?.targetSha !== sha
  || value?.productionDeployRunId !== runId
  || value?.officialProductionOrigin !== true
  || value?.authenticatedProductionSession !== true
  || value?.phase !== 'PREACTIVATION'
  || !Number.isFinite(Date.parse(String(value?.generatedAt ?? '')))
  || features.automaticTrading !== 'PASS'
  || features.automaticPaperTrading !== 'PASS'
  || features.researchCenter !== 'PASS'
  || features.backtester !== 'PASS'
  || features.telegramTradeJournal !== 'PASS'
  || value?.backtestMode !== 'backtest-only'
  || value?.paperRuntimeContractVerified !== true
  || typeof value?.paperRuntimeReadyAtDeploy !== 'boolean'
  || !Array.isArray(value?.paperRuntimeBlockers)
  || value.paperRuntimeBlockers.some((entry) => typeof entry !== 'string' || !/^[A-Z][A-Z0-9_]{1,90}$/.test(entry))
  || value?.telegramTradeJournalReady !== true
  || value?.journalReadbackReady !== true
  || value?.telegramJournalPreferenceConfigured !== true
  || value?.telegramRuntimeContractVerified !== true
  || typeof value?.telegramConnectedAtDeploy !== 'boolean'
  || typeof value?.telegramWorkerReadyAtDeploy !== 'boolean'
  || value?.telegramTestDelivered !== false
  || value?.telegramTestMessages !== 0
  || value?.telegramTestDeferredToProtectedActivation !== true
  || value?.policyMutationPerformed !== false
  || value?.liveTradingAuthorityGranted !== false
  || value?.autoTradingAuthorityGranted !== false
  || value?.orders !== 0
  || value?.cancels !== 0
  || value?.amends !== 0
  || value?.transfers !== 0
  || value?.withdrawals !== 0
  || value?.providerPrivateRequests !== 0
  || value?.secretsRecorded !== false
) {
  throw new Error('PRODUCTION_AUTOMATION_RESEARCH_RECEIPT_INVALID');
}
console.log(JSON.stringify({ ok: true, targetSha: sha, productionDeployRunId: runId }));
