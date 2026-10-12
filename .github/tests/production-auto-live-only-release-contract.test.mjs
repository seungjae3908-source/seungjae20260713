import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const read = (file) => readFileSync(file, 'utf8');

test('Automatic LIVE-only release lane excludes Paper and Telegram while preserving protected deployment', () => {
  const staging = read('.github/workflows/staging-trading-core-only.yml');
  const production = read('.github/workflows/production-deploy.yml');
  const command = read('.github/workflows/production-postdeploy-qa.yml');
  const stagingSpec = read('stock-analyzer/e2e/staging-auto-live-only.spec.ts');
  const productionSpec = read('stock-analyzer/e2e/production-auto-live-only-qa.spec.ts');
  const policySpec = read('stock-analyzer/e2e/production-auto-live-policy-prepare.spec.ts');
  const evidenceVerifier = read('.github/scripts/verify-production-preactivation-evidence.cjs');
  const evidenceBuilder = read('.github/scripts/production-postdeploy-qa-evidence.cjs');
  const signalAudit = read('ops/production-auto-live-signal-source-audit.mjs');
  const signalIdentity = read('ops/production-auto-live-signal-identity.cjs');
  const dedicatedInstaller = read('ops/install-auto-live-public-signal-schedule.sh');
  const autoPage = read('stock-analyzer/src/pages/auto-trading.tsx');

  assert.ok(command.includes('/run-production-auto-live-release '));
  assert.ok(command.includes("qaScope = member ? 'member' : autoLive ? 'auto_live'"));
  assert.ok(command.includes("release_scope: autoLive ? 'auto_live' : 'automation_research'"));
  assert.ok(command.includes("prepare_admin_auto_live_policy: autoLive ? 'true' : 'false'"));
  assert.ok(staging.includes("steps.target.outputs.release_scope == 'auto_live'"));
  assert.ok(staging.includes("if: needs.owner-gate.outputs.release_scope == 'automation_research'"));
  assert.ok(staging.includes('STAGING_RELEASE_SCOPE="$STAGING_RELEASE_SCOPE"'));
  assert.ok(staging.includes("test ! -e \"$RUNNER_TEMP/staging-core-publisher-binding\""));
  assert.ok(staging.includes('staging-auto-live-verdict-'));
  assert.ok(production.includes('- auto_live'));
  assert.ok(production.includes("inputs.qa_scope == 'auto_live'"));
  assert.ok(production.includes('environment: production'));
  assert.ok(production.includes('production-auto-live-${{ env.TARGET_SHA }}'));
  assert.ok(production.includes('production-auto-live-qa.json'));
  assert.ok(production.includes('production-auto-live-signal-source.json'));
  assert.ok(production.includes('Install exact-SHA Automatic LIVE public-signal schedule without Paper DB or RLS'));
  // Dedicated source is available for a separately approved future migration
  // but the shared release path remains fail-closed until genuine validation.
  assert.ok(production.includes('node --test .github/tests/auto-live-public-signal-schedule-contract.test.mjs'));
  assert.ok(dedicatedInstaller.includes("ROOT='/opt/stock-app-data/auto-live-signal-v1'"));
  assert.ok(dedicatedInstaller.includes('AUTO_LIVE_PUBLIC_SIGNAL_INSTALL_APPROVED'));

  // AUTO LIVE must not disable or replace a separately owned Natural/Paper
  // schedule, even when the shared root contains only archived/disabled state.
  const preflight = read('ops/production-auto-live-signal-identity.cjs');
  const earlyOwner = production.indexOf(
    '- name: Reject shared Paper Forward owner before AUTO LIVE database or application mutation');
  const databaseMutation = production.indexOf(
    '- name: Require canonical Production trade schema and journal privileges before application mutation');
  const lastOwner = production.indexOf('AUTO_LIVE_SHARED_PAPER_PREFLIGHT=true AUTO_LIVE_TARGET_SHA="$TARGET_SHA"');
  const disableOriginal = production.indexOf('bash ops/disable-paper-forward-schedule.sh');
  assert.ok(earlyOwner > 0 && earlyOwner < databaseMutation);
  assert.ok(lastOwner > databaseMutation && lastOwner < disableOriginal);
  assert.ok(production.includes('< ops/production-auto-live-signal-identity.cjs'));
  assert.ok(production.includes('AUTO_LIVE_SHARED_PAPER_PREFLIGHT=true AUTO_LIVE_TARGET_SHA=%q'));
  assert.ok(preflight.includes('AUTO_LIVE_SHARED_PAPER_SCHEDULE_ALREADY_OWNED'));
  assert.ok(preflight.includes('AUTO_LIVE_SHARED_PAPER_STATE_ALREADY_OWNED'));
  assert.ok(preflight.includes("lstatSync('/opt/stock-app-data/paper-forward-v1')"));
  assert.ok(preflight.includes('liveActivationReady: false'));

  assert.ok(production.includes('PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED=false'));
  assert.ok(production.includes('production-auto-live-signal-refresh.json'));
  assert.ok(production.includes('tail -n 1 "$state_root/logs/cron.log"'));
  assert.ok(production.includes('value?.naturalRuntimeSha !== process.env.TARGET_SHA'));
  assert.ok(production.includes("require('./.github/scripts/production-postdeploy-qa-evidence.cjs').assertAutoLiveSignalReceipt(value"));
  assert.ok(production.includes('targetSha: process.env.TARGET_SHA, productionDeployRunId: Number(process.env.GITHUB_RUN_ID)'));
  assert.ok(evidenceBuilder.includes('signal?.handoffEvaluatedAfterScheduleActivation !== true'));
  assert.ok(signalAudit.includes('signalIdentity.inspectSignalEntryIdentity(handoff.entries, targetSha)'));
  assert.ok(signalIdentity.includes('AUTO_LIVE_SIGNAL_HANDOFF_SHA_MISMATCH'));
  assert.ok(signalAudit.includes("from './production-auto-live-signal-identity.cjs'"));
  assert.ok(!signalAudit.includes("from '../.github/"), 'runtime signal audit cannot import the excluded .github directory');
  assert.ok(production.includes('Prepare administrator four-market Automatic LIVE policy without execution authority'));
  assert.ok(production.includes('AUTO_LIVE_POLICY_PREPARATION_REQUIRED'));
  assert.ok(production.includes('AUTO_LIVE_POLICY_PREPARATION_SCOPE_INVALID'));
  assert.ok(production.includes('playwright.production-auto-live-policy-prepare.config.ts'));
  assert.ok(production.includes("inputs.qa_scope != 'auto_live'"));

  for (const spec of [stagingSpec, productionSpec]) {
    assert.ok(spec.includes("getByTestId('auto-trading-page')"));
    assert.ok(spec.includes("getByTestId('trading-mode-paper')"));
    assert.ok(spec.includes("'/api/trade-automation/status'"));
    assert.ok(spec.includes('paperRequests'));
    assert.ok(spec.includes('financialMutations') || spec.includes('mutationRequests'));
    assert.equal(spec.includes('/api/trade-automation/plans'), false);
    assert.equal(spec.includes('/api/paper-journal/'), false);
    assert.equal(spec.includes('/api/user-integrations'), false);
    assert.equal(spec.includes('/api/user-integrations/telegram'), false);
  }
  assert.ok(productionSpec.includes('orderRequests: 0'));
  assert.ok(productionSpec.includes('cancelRequests: 0'));
  assert.ok(productionSpec.includes('amendRequests: 0'));
  assert.ok(productionSpec.includes('transferRequests: 0'));
  assert.ok(productionSpec.includes('withdrawalRequests: 0'));
  assert.ok(productionSpec.includes("paperTrading: 'OUT_OF_SCOPE'"));
  assert.ok(productionSpec.includes("telegram: 'OUT_OF_SCOPE'"));
  assert.ok(productionSpec.includes("schemaVersion: 'production-auto-live-readonly-qa-v3'"));
  assert.ok(productionSpec.includes("'/api/trade-automation/live-preactivation-readiness'"));
  assert.ok(productionSpec.includes('production-auto-live-preactivation-rehearsal.json'));
  assert.ok(productionSpec.includes('assertMemberAccountSignalAudit(memberAccountSignalAudit'));
  assert.ok(evidenceBuilder.includes('assertMemberAccountSignalAudit(autoLive.memberAccountSignalAudit'));
  assert.ok(productionSpec.indexOf('production-auto-live-preactivation-rehearsal.json')
    < productionSpec.indexOf('for (const viewport'), 'component blockers must be retained before a UI assertion can fail');
  assert.ok(productionSpec.includes('providerVerificationFresh'));
  assert.ok(productionSpec.includes('pendingOrderCount'));
  assert.ok(productionSpec.includes('workerPreactivationSafe'));
  assert.ok(evidenceVerifier.includes('assertAutoLiveReceipt(autoLive, context)'));
  assert.ok(evidenceVerifier.includes("activation?.autoLiveQa === 'PASS'"));
  assert.ok(evidenceBuilder.includes('autoLive.memberAutoLivePilotReady === true'));
  assert.ok(evidenceBuilder.includes('assertAutoLiveSignalReceipt'));
  assert.ok(signalAudit.includes('validateMemberAutoTradingPaperHandoff'));
  // The count guard now belongs to the shared canonical schedule inspector,
  // not the CLI wrapper; require both its runtime call and strict verdict.
  assert.ok(signalAudit.includes('signalIdentity.inspectManagedPaperForwardSchedule('));
  assert.ok(signalIdentity.includes('AUTO_LIVE_SIGNAL_SCHEDULE_COUNT_INVALID'));
  assert.ok(signalIdentity.includes('AUTO_LIVE_SIGNAL_SCHEDULE_ACTIVATION_PROOF_INVALID'));
  assert.ok(signalAudit.includes('AUTO_LIVE_SIGNAL_SCHEDULE_WRAPPER_INVALID'));
  // The strict dangling-symlink-aware check moved to a shared helper.
  assert.ok(signalAudit.includes('signalIdentity.assertAutoLiveSignalNotDisabled(scheduleRoot)'));
  assert.ok(signalIdentity.includes("root + '/runtime-state/DISABLED'"));
  assert.ok(signalIdentity.includes("root + '/DISABLED'"));
  assert.ok(signalIdentity.includes('AUTO_LIVE_SIGNAL_SCHEDULE_DISABLED'));
  assert.ok(read('.github/scripts/production-auto-live-signal-identity.test.cjs')
    .includes('disabled schedule sentinels fail closed even when dangling symlinks'));
  assert.ok(read('.github/scripts/production-auto-live-signal-identity.test.cjs')
    .includes("only exact installed 15-minute cron and SHA-bound receipt prove schedule configuration"));
  assert.ok(signalAudit.includes('AUTO_LIVE_SIGNAL_HANDOFF_PREDATES_EXACT_SHA_SCHEDULE'));
  assert.ok(policySpec.includes("'/api/trade-automation/policy', 'PUT'"));
  assert.ok(!policySpec.includes("'/api/trade-automation/resume', 'POST'"), 'QA preparation cannot implicitly remove a sticky owner stop');
  assert.ok(policySpec.includes('PREACTIVATION_MEMBER_STOP_REQUIRES_OWNER_RESUME'));
  assert.ok(policySpec.includes('approvedAdministratorAutomaticLivePolicy(policy)'));
  assert.ok(policySpec.includes('administratorAutomaticLivePolicyBlockers(policy)'));
  for (const counter of ['orderRequests', 'cancelRequests', 'amendRequests', 'transferRequests', 'withdrawalRequests']) {
    assert.ok(policySpec.includes(`${counter}: 0`));
  }
  assert.equal(evidenceBuilder.includes("qaScope === 'trading_core' ? tradingCore.memberAutoLivePilotReady === true : true"), false);
  assert.ok(autoPage.includes("if (mode !== 'paper' || paperOrigin !== 'automatic')"));
  assert.ok(autoPage.includes("if (mode !== 'paper' || paperOrigin !== 'automatic' || fixture"));
  assert.ok(autoPage.includes("if (mode === 'auto' && section === 'settings') return;"));
  assert.ok(read('api-server/src/routes/trade-automation.ts')
    .includes("accountMode === 'paper' && origin === 'automatic'"));
  assert.ok(autoPage.includes('showLegacyPaperReadinessInsideAutoDashboard'));
});

test('Automatic LIVE-only Staging verdict is exact-SHA and fail closed', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'auto-live-staging-'));
  const sha = 'a'.repeat(40);
  const receipt = {
    schemaVersion: 'staging-auto-live-only-v1',
    targetSha: sha,
    stagingScopedQa: 'PASS',
    viewports: ['desktop-1440', 'tablet-1024', 'mobile-390'],
    markets: ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures'],
    providers: ['toss', 'kiwoom', 'upbit', 'bitget'],
    automaticTradingReadinessVerified: true,
    paperTradingOutOfScope: true,
    telegramOutOfScope: true,
    paperRequests: 0,
    financialMutations: 0,
    privateProviderRequests: 0,
    realOrderSubmitted: false,
    liveTradingAuthorityGranted: false,
    autoTradingAuthorityGranted: false,
    productionReleaseReady: true,
  };
  const build = () => spawnSync(process.execPath, [
    '.github/scripts/build-staging-auto-live-only-verdict.mjs', directory, sha,
  ], { encoding: 'utf8' });
  try {
    writeFileSync(path.join(directory, 'staging-auto-live-only.json'), JSON.stringify(receipt));
    let result = build();
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(readFileSync(path.join(directory, 'staging-auto-live-verdict.json'), 'utf8'));
    assert.equal(verdict.release_ready, true);
    assert.equal(verdict.scope, 'AUTOMATIC_LIVE_ONLY');
    result = spawnSync(process.execPath, [
      '.github/scripts/verify-staging-auto-live-verdict.mjs',
      path.join(directory, 'staging-auto-live-verdict.json'), sha,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(path.join(directory, 'staging-auto-live-only.json'), JSON.stringify({
      ...receipt, financialMutations: 1,
    }));
    result = build();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /STAGING_AUTO_LIVE_RECEIPT_INVALID/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
