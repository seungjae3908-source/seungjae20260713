import fs from 'node:fs';

const [filename, expectedSha] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
if (!/^[0-9a-f]{40}$/u.test(expectedSha ?? '')
  || value?.schemaVersion !== 'staging-auto-live-verdict-v1'
  || value?.targetSha !== expectedSha
  || value?.scope !== 'AUTOMATIC_LIVE_ONLY'
  || value?.scopedStagingQa !== 'PASS'
  || value?.release_ready !== true
  || value?.failed !== 0
  || value?.skipped !== 0
  || value?.markets !== 4
  || value?.providers !== 4
  || value?.paperTrading !== 'OUT_OF_SCOPE'
  || value?.telegram !== 'OUT_OF_SCOPE'
  || ['orders', 'cancels', 'amends', 'transfers', 'withdrawals'].some((key) => value?.[key] !== 0)
  || value?.liveTradingAuthorityGranted !== false
  || value?.autoTradingAuthorityGranted !== false) {
  throw new Error('STAGING_AUTO_LIVE_VERDICT_INVALID');
}
console.log(JSON.stringify({ ok: true, targetSha: expectedSha, release_ready: true }));
