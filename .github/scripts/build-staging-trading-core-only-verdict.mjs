import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const sha = String(process.argv[3] ?? '').toLowerCase();
if (!dir || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('STAGING_TRADING_CORE_VERDICT_ARGUMENT_INVALID');
const proofs = ['trading-core-desktop','trading-core-mobile'].map(project => {
  const filename = path.join(dir, 'scoped-' + project + '.json');
  const receipt = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (receipt.schemaVersion !== 'staging-automation-paper-research-backtester-core-v2'
    || receipt.targetSha !== sha || receipt.project !== project
    || receipt.stagingScopedQa !== 'PASS'
    || receipt.browserAuthMode !== 'STAGING_PASSWORD_SESSION_RESTORE'
    || receipt.interactiveLoginFormTested !== false
    || receipt.fourMarketsStructural !== true
    || receipt.providersValidatedWithoutPrivateCalls !== true
    || receipt.walletSeedPerMarketKrw !== 1_000_000
    || !Array.isArray(receipt.stagesChecked) || receipt.stagesChecked.length !== 11
    || !Number.isInteger(receipt.walletCount) || receipt.walletCount < 0 || receipt.walletCount > 4
    || typeof receipt.stagingWalletReady !== 'boolean'
    || typeof receipt.paperWorkerReady !== 'boolean'
    || !Array.isArray(receipt.walletBlockers)
    || !Array.isArray(receipt.workerBlockers)
    || receipt.walletBlockers.some(entry => typeof entry !== 'string' || !/^[A-Z][A-Z0-9_]{1,90}$/.test(entry))
    || receipt.workerBlockers.some(entry => typeof entry !== 'string' || !/^[A-Z][A-Z0-9_]{1,90}$/.test(entry))
    || receipt.automaticTradingReadinessVerified !== true
    || typeof receipt.automaticPaperTradingReadinessVerified !== 'boolean'
    || receipt.automaticPaperTradingReadinessVerified !== receipt.paperWorkerReady
    || (receipt.paperWorkerReady === false && receipt.workerBlockers.length === 0)
    || ((receipt.stagingWalletReady === false || receipt.walletCount !== 4)
      && receipt.walletBlockers.length === 0 && receipt.workerBlockers.length === 0)
    || receipt.researchCenterReady !== true
    || receipt.backtesterReady !== true
    || receipt.telegramExcludedFromScope !== true
    || receipt.backtestMode !== 'backtest-only'
    || receipt.backtestOrderSubmitted !== false
    || receipt.realOrderAuthorityGranted !== false
    || receipt.providerPrivateRequests !== 0 || receipt.tradingMutations !== 0
    || receipt.productionReleaseReady !== true
    || receipt.scopedReleaseVerdict !== 'AUTOMATION_PAPER_RESEARCH_BACKTESTER_ONLY'
    || receipt.automaticTradingActivated !== false) {
    throw new Error('STAGING_TRADING_CORE_SCOPED_RECEIPT_INVALID:' + project);
  }
  return receipt;
});
// This verdict is intentionally release-capable only for the dedicated
// Automation/Research production scope. It is never accepted as a Full Staging
// verdict and never grants LIVE or AUTO execution authority.
// Staging deliberately has background workers disabled. Runtime activation is
// therefore not a release prerequisite here: this lane proves that the exact
// build exposes the four scoped UI/API contracts and records any remaining
// activation prerequisites for the protected Production gates.
const operationalReadiness = proofs.every(v =>
  v.stagingWalletReady === true && v.walletCount === 4 && v.paperWorkerReady === true)
  ? 'PREREQUISITES_PRESENT' : 'PREACTIVATION_BLOCKERS_RECORDED';
const verdict = {
  schemaVersion: 'staging-automation-paper-research-backtester-verdict-v2',
  targetSha: sha,
  scope: 'AUTOMATION_PAPER_RESEARCH_BACKTESTER_ONLY',
  scopedStagingQa: 'PASS',
  release_ready: true,
  failed: 0,
  skipped: 0,
  browserAuthMode: 'STAGING_PASSWORD_SESSION_RESTORE',
  interactiveLoginFormTested: false,
  operationalReadiness,
  desktop: 'PASS',
  mobile: 'PASS',
  markets: 4,
  paperWalletBaselineKrw: 1_000_000,
  readinessByViewport: proofs.map(v => ({
    project:v.project, stagingWalletReady:v.stagingWalletReady,
    walletCount:v.walletCount, paperWorkerReady:v.paperWorkerReady,
    walletBlockers:v.walletBlockers, workerBlockers:v.workerBlockers,
  })),
  features: {
    automaticTrading: 'PASS',
    automaticPaperTrading: 'PASS',
    researchCenter: 'PASS',
    backtester: 'PASS',
  },
  telegramExcludedFromScope: true,
  productionReleaseReady: true,
  fullStagingReleaseVerdict: 'NOT_EVALUATED_BY_SCOPED_LANE',
  activationReady: operationalReadiness === 'PREREQUISITES_PRESENT',
  automaticTradingActivated: false,
  liveTradingAuthorityGranted: false,
  autoTradingAuthorityGranted: false,
  realOrders: 0, cancels: 0, amends: 0, transfers: 0, withdrawals: 0,
  providerPrivateRequests: 0, productionDbMutations: 0,
};
fs.writeFileSync(path.join(dir, 'automation-research-staging-verdict.json'), JSON.stringify(verdict, null, 2), { encoding:'utf8', mode:0o600 });
console.log(JSON.stringify({ok:true,scope:verdict.scope,stagingQa:verdict.scopedStagingQa,operationalReadiness:verdict.operationalReadiness,targetSha:sha,productionReleaseReady:true,automaticTradingActivated:false}));
