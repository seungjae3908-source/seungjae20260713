'use strict';

const fs = require('node:fs');
const {
  REQUIRED_PROVIDERS,
  ZERO_COUNTERS,
  ZERO_SAFETY_COUNTERS,
  assertAccountReceipt,
  assertAutomaticPositionIsolationReceipt,
  assertAutoLiveReceipt,
  assertAutoLiveSignalReceipt,
  assertComprehensiveReceipt,
  assertCredentialReceipt,
  assertTradingCoreReceipt,
} = require('./production-postdeploy-qa-evidence.cjs');
const { findUniqueEvidenceFile } = require('./production-preactivation-evidence-paths.cjs');

const requirePositionIsolation = process.argv.includes('--require-automatic-position-isolation');
const args = process.argv.slice(2).filter((arg) => arg !== '--require-automatic-position-isolation');
if (args.length < 4) {
  throw new Error('Usage: verify-production-preactivation-evidence.cjs <sha> <run-id> <deployment-boundary> <evidence-dir|comprehensive> [account credential activation-ready]');
}

const [targetSha, runIdText, boundaryText] = args;
const productionDeployRunId = Number(runIdText);
const context = { targetSha, productionDeployRunId };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

let comprehensive = null;
let tradingCore = null;
let autoLive = null;
let autoLiveSignal = null;
let account;
let credential;
let activation;

if (args.length === 4 && fs.existsSync(args[3]) && fs.statSync(args[3]).isDirectory()) {
  const root = args[3];
  const evidence = (filename) => findUniqueEvidenceFile(root, filename);
  const activationPath = evidence(`production-postdeploy-activation-ready-${String(targetSha).toLowerCase()}.json`);
  account = read(evidence('production-account-readonly-live-qa.json'));
  credential = read(evidence('production-live-credential-reuse-qa.json'));
  activation = read(activationPath);
  if (activation?.qaScope === 'trading_core') {
    tradingCore = read(evidence('production-trading-core-qa.json'));
  } else if (activation?.qaScope === 'auto_live') {
    autoLive = read(evidence('production-auto-live-qa.json'));
    autoLiveSignal = read(evidence('production-auto-live-signal-source.json'));
  } else {
    comprehensive = read(evidence('production-comprehensive-readonly-qa.json'));
  }
} else {
  const [, , , comprehensivePath, accountPath, credentialPath, activationPath] = args;
  if (!activationPath) {
    throw new Error('Legacy usage requires <comprehensive> <account> <credential> <activation-ready>');
  }
  comprehensive = read(comprehensivePath);
  account = read(accountPath);
  credential = read(credentialPath);
  activation = read(activationPath);
}

const qaScope = ['full', 'trading_core', 'auto_live'].includes(activation?.qaScope)
  ? activation.qaScope
  : activation?.schemaVersion === 'production-postdeploy-activation-ready-v3' ? 'full' : null;
if (!qaScope) throw new Error('PREACTIVATION_QA_SCOPE_INVALID');
if (qaScope === 'trading_core') {
  assertTradingCoreReceipt(tradingCore, context);
} else if (qaScope === 'auto_live') {
  assertAutoLiveReceipt(autoLive, context);
  assertAutoLiveSignalReceipt(autoLiveSignal, context);
} else {
  assertComprehensiveReceipt(comprehensive, context);
}
assertAccountReceipt(account, context);
if (qaScope === 'auto_live' || requirePositionIsolation) assertAutomaticPositionIsolationReceipt(account);
assertCredentialReceipt(credential, context);

// An older full/trading-core/UI receipt is not an AUTO safety-control proof.
// The current subset expressly cannot prove the remaining execution/runtime
// controls. Keep every AUTO activation route closed until a complete, audited
// control collector is wired; never interpret absent fields as zero/success.
if (requirePositionIsolation || qaScope === 'auto_live') {
  throw new Error('PREACTIVATION_AUTOMATIC_LIVE_COMPLETE_CONTROL_AUDIT_REQUIRED');
}

const boundary = Date.parse(String(boundaryText ?? ''));
if (!Number.isFinite(boundary)) throw new Error('PREACTIVATION_EVIDENCE_BOUNDARY_INVALID');
const scopedReceipts = qaScope === 'trading_core'
  ? { tradingCore, account, credential, activation }
  : qaScope === 'auto_live'
    ? { autoLive, autoLiveSignal, account, credential, activation }
  : { comprehensive, account, credential, activation };
for (const [name, receipt] of Object.entries(scopedReceipts)) {
  const generatedAt = Date.parse(String(receipt?.generatedAt ?? ''));
  if (!Number.isFinite(generatedAt) || generatedAt < boundary) {
    throw new Error(`PREACTIVATION_${name.toUpperCase()}_EVIDENCE_NOT_FRESH`);
  }
}

const sha = String(targetSha).toLowerCase();
const v3Full = activation?.schemaVersion === 'production-postdeploy-activation-ready-v3'
  && qaScope === 'full'
  && activation?.comprehensiveQa === 'PASS';
const v4Scoped = activation?.schemaVersion === 'production-postdeploy-activation-ready-v4'
  && activation?.qaScope === qaScope
  && (qaScope === 'trading_core'
    ? activation?.tradingCoreQa === 'PASS' && activation?.comprehensiveQa === 'NOT_RUN'
    : qaScope === 'auto_live'
      ? activation?.autoLiveQa === 'PASS'
        && activation?.canonicalAutoLiveSignalSource === 'PASS'
        && activation?.tradingCoreQa === 'NOT_RUN'
        && activation?.comprehensiveQa === 'NOT_RUN'
      : activation?.comprehensiveQa === 'PASS');
if ((!v3Full && !v4Scoped)
  || activation?.targetSha !== sha
  || activation?.mainSha !== sha
  || activation?.productionSha !== sha
  || activation?.productionDeployRunId !== productionDeployRunId
  || activation?.identityMatch !== true
  || activation?.credentialReuse !== '4/4 PASS'
  || activation?.realOrderSubmitted !== false
  || activation?.liveTradingAuthorityGranted !== false
  || activation?.autoTradingAuthorityGranted !== false
  || activation?.activeConflictingTradingGates !== 0
  || activation?.bitgetPositionMode !== 'one_way_mode'
  || activation?.bitgetMarginModePolicy !== 'isolated'
  || activation?.bitgetLeveragePolicy !== '2-7'
  || activation?.bitgetAdministratorLeveragePolicy !== '2-7'
  || activation?.bitgetMemberLeveragePolicy !== '2-3'
  || activation?.duplicateWorkerExecutionCount !== 0
  || activation?.pm2FlagDriftCount !== 0
  || activation?.legacyCryptoAutoAuthorityGranted !== false
  || (qaScope === 'auto_live' && (activation?.memberAutoLivePilotReady !== true
    || activation?.automaticPositionIsolation !== 'PASS'))
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
  qaScope,
  activationReady: true,
}) + '\n');
