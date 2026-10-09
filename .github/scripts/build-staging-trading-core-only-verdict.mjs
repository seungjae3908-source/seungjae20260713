import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const sha = String(process.argv[3] ?? '').toLowerCase();
if (!dir || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('STAGING_TRADING_CORE_VERDICT_ARGUMENT_INVALID');
const proofs = ['trading-core-desktop','trading-core-mobile'].map(project => {
  const filename = path.join(dir, 'scoped-' + project + '.json');
  const receipt = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (receipt.schemaVersion !== 'staging-trading-core-only-v1'
    || receipt.targetSha !== sha || receipt.project !== project
    || receipt.stagingScopedQa !== 'PASS'
    || receipt.browserAuthMode !== 'STAGING_PASSWORD_SESSION_RESTORE'
    || receipt.interactiveLoginFormTested !== false
    || receipt.fourMarketsStructural !== true
    || receipt.providersValidatedWithoutPrivateCalls !== true
    || receipt.walletSeedPerMarketKrw !== 1_000_000
    || !Array.isArray(receipt.stagesChecked) || receipt.stagesChecked.length !== 8
    || !Number.isInteger(receipt.walletCount) || receipt.walletCount < 0 || receipt.walletCount > 4
    || typeof receipt.stagingWalletReady !== 'boolean'
    || typeof receipt.paperWorkerReady !== 'boolean'
    || receipt.canaryPaperFillObserved !== false
    || receipt.telegramSentReceiptObserved !== false
    || receipt.realOrderAuthorityGranted !== false
    || receipt.providerPrivateRequests !== 0 || receipt.tradingMutations !== 0
    || receipt.productionReleaseReady !== false
    || receipt.fullStagingReleaseVerdict !== 'NOT_EVALUATED'
    || receipt.automaticTradingActivated !== false) {
    throw new Error('STAGING_TRADING_CORE_SCOPED_RECEIPT_INVALID:' + project);
  }
  return receipt;
});
// A read-only structural QA PASS must not imply a seeded Paper wallet,
 // a running background worker, a fill, or a sent Telegram message.
const operationalReadiness = proofs.every(v =>
  v.stagingWalletReady === true && v.walletCount === 4 && v.paperWorkerReady === true)
  ? 'PREREQUISITES_PRESENT' : 'BLOCKED';
const verdict = {
  schemaVersion: 'staging-trading-core-only-verdict-v1',
  targetSha: sha,
  scope: 'TRADING_CORE_ONLY',
  scopedStagingQa: 'PASS',
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
  canaryPaperFillObserved: false,
  telegramSentReceiptObserved: false,
  productionReleaseReady: false,
  fullStagingReleaseVerdict: 'NOT_EVALUATED',
  automaticTradingActivated: false,
  realOrders: 0, providerPrivateRequests: 0, productionDbMutations: 0,
};
fs.writeFileSync(path.join(dir, 'trading-core-scoped-staging-verdict.json'), JSON.stringify(verdict, null, 2), { encoding:'utf8', mode:0o600 });
console.log(JSON.stringify({ok:true,scope:verdict.scope,stagingQa:verdict.scopedStagingQa,operationalReadiness:verdict.operationalReadiness,targetSha:sha,productionReleaseReady:false,automaticTradingActivated:false}));
