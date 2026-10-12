import fs from 'node:fs';
import path from 'node:path';

const directory = process.argv[2];
const targetSha = String(process.argv[3] ?? '').trim().toLowerCase();
if (!directory || !/^[0-9a-f]{40}$/u.test(targetSha)) {
  throw new Error('STAGING_AUTO_LIVE_VERDICT_ARGUMENT_INVALID');
}
const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'staging-auto-live-only.json'), 'utf8'));
if (receipt?.schemaVersion !== 'staging-auto-live-only-v1'
  || receipt?.targetSha !== targetSha
  || receipt?.stagingScopedQa !== 'PASS'
  || JSON.stringify(receipt?.viewports) !== JSON.stringify(['desktop-1440', 'tablet-1024', 'mobile-390'])
  || JSON.stringify(receipt?.markets) !== JSON.stringify(['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures'])
  || JSON.stringify(receipt?.providers) !== JSON.stringify(['toss', 'kiwoom', 'upbit', 'bitget'])
  || receipt?.automaticTradingReadinessVerified !== true
  || receipt?.paperTradingOutOfScope !== true
  || receipt?.telegramOutOfScope !== true
  || receipt?.paperRequests !== 0
  || receipt?.financialMutations !== 0
  || receipt?.privateProviderRequests !== 0
  || receipt?.realOrderSubmitted !== false
  || receipt?.liveTradingAuthorityGranted !== false
  || receipt?.autoTradingAuthorityGranted !== false
  || receipt?.productionReleaseReady !== true) {
  throw new Error('STAGING_AUTO_LIVE_RECEIPT_INVALID');
}
const verdict = {
  schemaVersion: 'staging-auto-live-verdict-v1',
  targetSha,
  scope: 'AUTOMATIC_LIVE_ONLY',
  scopedStagingQa: 'PASS',
  release_ready: true,
  failed: 0,
  skipped: 0,
  viewports: receipt.viewports,
  markets: 4,
  providers: 4,
  paperTrading: 'OUT_OF_SCOPE',
  telegram: 'OUT_OF_SCOPE',
  orders: 0,
  cancels: 0,
  amends: 0,
  transfers: 0,
  withdrawals: 0,
  liveTradingAuthorityGranted: false,
  autoTradingAuthorityGranted: false,
};
fs.writeFileSync(path.join(directory, 'staging-auto-live-verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ok: true, targetSha, release_ready: true, scope: verdict.scope }));
