import fs from 'node:fs';

const [file, requestedSha] = process.argv.slice(2);
const sha = String(requestedSha ?? '').trim().toLowerCase();
if (!file || !/^[0-9a-f]{40}$/.test(sha)) {
  throw new Error('STAGING_AUTOMATION_RESEARCH_VERIFY_ARGUMENT_INVALID');
}

const value = JSON.parse(fs.readFileSync(file, 'utf8'));
const features = value?.features ?? {};
if (
  value?.schemaVersion !== 'staging-automation-paper-research-backtester-verdict-v2'
  || value?.targetSha !== sha
  || value?.scope !== 'AUTOMATION_PAPER_RESEARCH_BACKTESTER_ONLY'
  || value?.scopedStagingQa !== 'PASS'
  || value?.release_ready !== true
  || value?.productionReleaseReady !== true
  || !['PREREQUISITES_PRESENT', 'PREACTIVATION_BLOCKERS_RECORDED'].includes(value?.operationalReadiness)
  || value?.failed !== 0
  || value?.skipped !== 0
  || features.automaticTrading !== 'PASS'
  || features.automaticPaperTrading !== 'PASS'
  || features.researchCenter !== 'PASS'
  || features.backtester !== 'PASS'
  || value?.telegramExcludedFromScope !== true
  || value?.automaticTradingActivated !== false
  || value?.liveTradingAuthorityGranted !== false
  || value?.autoTradingAuthorityGranted !== false
  || value?.realOrders !== 0
  || value?.cancels !== 0
  || value?.amends !== 0
  || value?.transfers !== 0
  || value?.withdrawals !== 0
  || value?.providerPrivateRequests !== 0
  || value?.productionDbMutations !== 0
  || value?.fullStagingReleaseVerdict !== 'NOT_EVALUATED_BY_SCOPED_LANE'
  || value?.activationReady !== (value?.operationalReadiness === 'PREREQUISITES_PRESENT')
) {
  throw new Error('STAGING_AUTOMATION_RESEARCH_VERDICT_INVALID');
}

console.log(JSON.stringify({
  ok: true,
  targetSha: sha,
  scope: value.scope,
  release_ready: true,
  liveTradingAuthorityGranted: false,
  autoTradingAuthorityGranted: false,
}));
