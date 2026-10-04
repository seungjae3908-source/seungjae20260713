'use strict';

const fs = require('node:fs');
const {
  REQUIRED_PROVIDERS,
  ZERO_COUNTERS,
  ZERO_SAFETY_COUNTERS,
  assertAccountReceipt,
  assertComprehensiveReceipt,
  assertCredentialReceipt,
} = require('./production-postdeploy-qa-evidence.cjs');

const [targetSha, runIdText, boundaryText, comprehensivePath, accountPath, credentialPath, activationPath] = process.argv.slice(2);
if (!activationPath) {
  throw new Error('Usage: verify-production-preactivation-evidence.cjs <sha> <run-id> <deployment-boundary> <comprehensive> <account> <credential> <activation-ready>');
}
const productionDeployRunId = Number(runIdText);
const context = { targetSha, productionDeployRunId };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const comprehensive = read(comprehensivePath);
const account = read(accountPath);
const credential = read(credentialPath);
const activation = read(activationPath);
assertComprehensiveReceipt(comprehensive, context);
assertAccountReceipt(account, context);
assertCredentialReceipt(credential, context);

const boundary = Date.parse(String(boundaryText ?? ''));
if (!Number.isFinite(boundary)) throw new Error('PREACTIVATION_EVIDENCE_BOUNDARY_INVALID');
for (const [name, receipt] of Object.entries({ comprehensive, account, credential, activation })) {
  const generatedAt = Date.parse(String(receipt?.generatedAt ?? ''));
  if (!Number.isFinite(generatedAt) || generatedAt < boundary) {
    throw new Error(`PREACTIVATION_${name.toUpperCase()}_EVIDENCE_NOT_FRESH`);
  }
}

const sha = String(targetSha).toLowerCase();
if (activation?.schemaVersion !== 'production-postdeploy-activation-ready-v3'
  || activation?.targetSha !== sha
  || activation?.mainSha !== sha
  || activation?.productionSha !== sha
  || activation?.productionDeployRunId !== productionDeployRunId
  || activation?.identityMatch !== true
  || activation?.comprehensiveQa !== 'PASS'
  || activation?.credentialReuse !== '4/4 PASS'
  || activation?.realOrderSubmitted !== false
  || activation?.liveTradingAuthorityGranted !== false
  || activation?.autoTradingAuthorityGranted !== false
  || activation?.activeConflictingTradingGates !== 0
  || activation?.bitgetPositionMode !== 'one_way_mode'
  || activation?.bitgetMarginModePolicy !== 'isolated'
  || activation?.bitgetLeveragePolicy !== '2-7'
  || activation?.duplicateWorkerExecutionCount !== 0
  || activation?.pm2FlagDriftCount !== 0
  || activation?.legacyCryptoAutoAuthorityGranted !== false
  || activation?.activationReady !== true) {
  throw new Error('PREACTIVATION_ACTIVATION_READY_RECEIPT_INVALID');
}
for (const provider of REQUIRED_PROVIDERS) {
  if (activation?.providers?.[provider] !== 'PASS') {
    throw new Error(`PREACTIVATION_PROVIDER_NOT_READY:${provider}`);
  }
}
for (const key of [...ZERO_COUNTERS, ...ZERO_SAFETY_COUNTERS]) {
  if (activation?.[key] !== 0) throw new Error(`PREACTIVATION_${key.toUpperCase()}_NOT_ZERO`);
}

process.stdout.write(JSON.stringify({
  ok: true,
  targetSha: sha,
  productionDeployRunId,
  activationReady: true,
}) + '\n');
