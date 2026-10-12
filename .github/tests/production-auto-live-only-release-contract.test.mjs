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
  const isolatedPlan = read('ops/production-auto-live-signal-identity.cjs');

  // The PUBLIC-only collector must have a separate protected owner action,
  // never a hidden side effect of the four-market automatic order gate.
  const autoTradingGate = read('.github/workflows/production-automatic-trading-gate.yml');
  const sourceOnlyStart = autoTradingGate.indexOf('  install-public-signal:');
  assert.ok(sourceOnlyStart > autoTradingGate.indexOf('  disable:'));
  const sourceOnly = autoTradingGate.slice(sourceOnlyStart);
  assert.ok(sourceOnly.includes("startsWith(github.event.comment.body, '/install-auto-live-public-signal ')"));
  assert.ok(sourceOnly.includes('environment: production'));
  assert.ok(sourceOnly.includes('AUTO_LIVE_PUBLIC_INSTALL_EXACT_MAIN_FULL_CI_REQUIRED'));
  assert.ok(sourceOnly.includes('AUTO_LIVE_PUBLIC_INSTALL_SOURCE_CONTENT_SHA_MISMATCH'));
  assert.ok(sourceOnly.includes('AUTO_LIVE_PUBLIC_INSTALL_CHECKOUT_SHA_MISMATCH'));
  assert.ok(sourceOnly.includes('AUTO_LIVE_PUBLIC_INSTALL_SCHEDULE_READBACK_INVALID'));
  assert.ok(sourceOnly.includes("status:'CONFIGURATION_VERIFIED_ONLY'"));
  assert.ok(sourceOnly.includes('AUTO_LIVE_PUBLIC_INSTALL_ACTIVE_OPERATION_CONFLICT'));
  assert.ok(sourceOnly.includes('AUTO_LIVE_INDEPENDENT_SOURCE_INSTALL=true'));
  assert.ok(sourceOnly.includes('AUTO_LIVE_INDEPENDENT_SIGNAL_INSTALL_APPROVED=true'));
  assert.ok(sourceOnly.includes('producer_invocation_verified: false'));
  assert.ok(sourceOnly.includes('live_auto_authority_granted: false'));
  assert.ok(sourceOnly.includes('24_hour_uninterrupted_collection_verified: false'));
  assert.equal(sourceOnly.includes('bash ops/disable-paper-forward-schedule.sh'), false);
  assert.equal(sourceOnly.includes('pm2 restart'), false);

  // When deployed app SHA is older than main, a separate sealed checkout of
  // reviewed public-only source must be verified; never silently deploy app.
  for (const proof of [
    'PUBLIC_BUNDLE_SHA256',
    'PUBLIC_MANIFEST_SHA256',
    'PUBLIC_HELPER_SHA256',
    'PUBLIC_SOURCE_STAGE',
    'AUTO_LIVE_PUBLIC_INSTALL_SOURCE_CONTENT_SHA_MISMATCH',
    'AUTO_LIVE_PUBLIC_INSTALL_MAIN_CHANGED_BEFORE_CRON',
    'AUTO_LIVE_PUBLIC_INSTALL_REQUIRED_STATUS_PROVENANCE_INVALID',
    'application-ci/verified',
    'browser-ui/verified',
    'database-rls/verified',
    'security-integration/verified',
    'ai-privacy/verified',
    'futures-public-network-smoke/verified',
    'sha256sum --status -c SHA256SUMS',
    'AUTO_LIVE_INDEPENDENT_SOURCE_SEAL_DIR',
    'AUTO_LIVE_INDEPENDENT_SOURCE_MANIFEST_HASH',
    'AUTO_LIVE_INDEPENDENT_SOURCE_HELPER_HASH',
    'production-auto-live-signal-identity.cjs',
    'AUTO_LIVE_PUBLIC_INSTALL_CLEANUP_SCOPE_INVALID',
    'AUTO_LIVE_PUBLIC_INSTALL_LATE_OPERATION_CONFLICT',
    'AUTO_LIVE_PUBLIC_INSTALL_HOST_DEPENDENCY_MISSING',
    'AUTO_LIVE_PUBLIC_INSTALL_CRON_DAEMON_MISSING',
    'AUTO_LIVE_PUBLIC_INSTALL_PARENT_NOT_WRITABLE',
    'AUTO_LIVE_PUBLIC_INSTALL_NODE_UNSUPPORTED',
    "steps.public_install.outcome == 'success'",
    "steps.source_readback.outcome != 'success'",
    'AUTO_LIVE_PUBLIC_INSTALL_ROLLBACK_SCOPE_INVALID',
    'AUTO_LIVE_PUBLIC_INSTALL_POSTAUDIT_FAILED_CLOSED_DISABLED',
  ]) assert.ok(sourceOnly.includes(proof), 'sealed standalone public source missing: '+proof);
  assert.equal(sourceOnly.includes('/opt/stock-app/.deploy/current-sha'),false);
  assert.equal(sourceOnly.includes('cd /opt/stock-app &&'),false);
  assert.ok(isolatedPlan.includes('sealed public source manifest mismatch'));
  assert.ok(isolatedPlan.includes('sealed helper source content mismatch'));
  assert.ok(isolatedPlan.includes('bin/production-auto-live-signal-identity.cjs'));
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
  // This release installs ONLY a separately owned public observer after
  // explicit protected Production approval; not automatic trade authority.
  assert.ok(isolatedPlan.includes('inspectIndependentAutoLivePublicSourcePlan('));
  assert.ok(isolatedPlan.includes('runAutoLiveIndependentPublicSourcePreflight()'));
  assert.ok(isolatedPlan.includes('ownerInstallApprovalRequired: true'));
  assert.ok(production.includes('AUTO_LIVE_INDEPENDENT_SOURCE_INSTALL=true'));
  assert.ok(production.includes('AUTO_LIVE_INDEPENDENT_SIGNAL_INSTALL_APPROVED=true'));
  assert.ok(signalIdentity.includes('buildIndependentAutoLivePublicInstallScript()'));
  assert.ok(signalIdentity.includes('installIndependentAutoLivePublicSource('));
  assert.ok(!production.includes('bash ops/disable-paper-forward-schedule.sh'));
  // The exact LIVE activation gate must bind PM2 and pre-arm to the
  // independent collector, never to the historical Paper handoff.
  const autoGate = read('.github/workflows/production-automatic-trading-gate.yml');
  assert.ok(autoGate.includes('const automaticLiveHandoffPath ='));
  assert.ok(autoGate.includes('/opt/stock-app-data/auto-live-signal-v1/runtime-state/handoff/member-auto-trading-latest.json'));
  assert.ok(autoGate.includes('const handoffPath = automaticLiveHandoffPath;'));
  assert.ok(autoGate.includes('published.default?.readProductionAutoLiveSignalHandoff'));
  assert.ok(autoGate.includes('h = readTrustedHandoff(handoffPath);'));
  assert.ok(autoGate.includes('MEMBER_AUTO_TRADING_HANDOFF_PATH: enabled ? automaticLiveHandoffPath'));
  assert.ok(autoGate.includes('AUTOMATIC_TRADING_INDEPENDENT_HANDOFF_BINDING_INVALID'));
  assert.ok(autoGate.includes("MEMBER_AUTO_TRADING_HANDOFF_PATH: String(before.MEMBER_AUTO_TRADING_HANDOFF_PATH ?? '')"));
  assert.ok(!autoGate.includes('/opt/stock-app-data/paper-forward-v1/runtime-state/handoff/member-auto-trading-latest.json'));
  const tradeRoute = read('api-server/src/routes/trade-automation.ts');
  const auditPath = tradeRoute.indexOf("router.get('/live-preactivation-readiness'");
  const nextRoute = tradeRoute.indexOf("router.get('/status'", auditPath);
  assert.ok(auditPath >= 0 && nextRoute > auditPath);
  const readOnlyAudit = tradeRoute.slice(auditPath, nextRoute);
  assert.ok(readOnlyAudit.includes("source: independentAutoLiveSource"));
  assert.ok(readOnlyAudit.includes("new SupabaseMemberAutoTradingBackgroundSource("));
  assert.ok(readOnlyAudit.includes("'/opt/stock-app-data/auto-live-signal-v1/runtime-state/handoff/member-auto-trading-latest.json'"));
  assert.ok(!readOnlyAudit.includes("new SupabaseMemberAutoTradingBackgroundSource()"));

  // Bound pre-DB and last-moment checks to the dedicated root. Historical
  // Paper owner state and cron remain unmodified, even when Paper is ACTIVE.
  const preflight = read('ops/production-auto-live-signal-identity.cjs');
  const earlyOwner = production.indexOf(
    '- name: Verify independent AUTO LIVE source availability before any database or application mutation');
  const databaseMutation = production.indexOf(
    '- name: Require canonical Production trade schema and journal privileges before application mutation');
  const lastOwner = production.indexOf('AUTO_LIVE_INDEPENDENT_SOURCE_PREFLIGHT=true AUTO_LIVE_TARGET_SHA="$TARGET_SHA"');
  const installCall = production.indexOf('node ops/production-auto-live-signal-identity.cjs');
  assert.ok(earlyOwner > 0 && earlyOwner < databaseMutation);
  assert.ok(lastOwner > databaseMutation && lastOwner < installCall);
  assert.ok(production.includes('< ops/production-auto-live-signal-identity.cjs'));
  assert.ok(production.includes('AUTO_LIVE_INDEPENDENT_SOURCE_PREFLIGHT=true AUTO_LIVE_TARGET_SHA=%q'));
  assert.ok(production.includes('AUTO_LIVE_INDEPENDENT_SOURCE_INSTALL=true'));
  assert.ok(preflight.includes('AUTO_LIVE_INDEPENDENT_SOURCE_ALREADY_OWNED'));
  assert.ok(preflight.includes('AUTO_LIVE_INDEPENDENT_SOURCE_STATE_ALREADY_OWNED'));
  assert.ok(preflight.includes("lstatSync('/opt/stock-app-data/auto-live-signal-v1')"));
  assert.ok(preflight.includes('autoTradingActivationReady: false'));
  assert.ok(!production.includes('PAPER_FORWARD_STATE_ROOT=/opt/stock-app-data/paper-forward-v1'));
  assert.ok(!production.includes('bash ops/install-paper-forward-schedule.sh'));

  // Public source is now installed through the separately gated owner CLI.
  // Verify the actual pinned installer, not a retired workflow inline env.
  assert.ok(signalIdentity.includes("PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED='false'"));
  assert.ok(signalIdentity.includes("RESEARCH_PRODUCTION='false'"));
  assert.ok(signalIdentity.includes("LIVE_TRADING='false'"));
  assert.ok(signalIdentity.includes("REAL_ORDER_ENABLED='false'"));
  assert.ok(signalIdentity.includes("PRIVATE_TRADING_API_ALLOWED='false'"));
  assert.ok(production.includes('production-auto-live-signal-refresh.json'));
  assert.ok(production.includes('tail -n 1 "$state_root/logs/cron.log"'));
  assert.ok(production.includes('value?.naturalRuntimeSha !== process.env.TARGET_SHA'));
  assert.ok(production.includes("require('./.github/scripts/production-postdeploy-qa-evidence.cjs').assertAutoLiveSignalReceipt(value"));
  assert.ok(production.includes('targetSha: process.env.TARGET_SHA, productionDeployRunId: Number(process.env.GITHUB_RUN_ID)'));
  assert.ok(evidenceBuilder.includes('signal?.handoffEvaluatedAfterScheduleActivation !== true'));
  assert.ok(signalAudit.includes('signalIdentity.inspectSignalEntryIdentity(handoff.entries, targetSha)'));
  assert.ok(signalAudit.includes('signalIdentity.readProductionAutoLiveSignalHandoff(handoffPath)'));
  assert.ok(!signalAudit.includes("JSON.parse(readFileSync(handoffPath, 'utf8'))"));
  assert.ok(signalIdentity.includes('CANONICAL_AUTO_SIGNAL_HANDOFF_PATH'));
  assert.ok(signalIdentity.includes('MAX_AUTO_SIGNAL_HANDOFF_BYTES'));
  assert.ok(signalIdentity.includes('O_NOFOLLOW'));
  assert.ok(signalIdentity.includes('O_NONBLOCK'));
  assert.ok(signalIdentity.includes('readBoundedAutoLiveSourceArtifact('));
  assert.ok(signalIdentity.includes('io.readSync(fd, bytes,'));
  assert.ok(!signalIdentity.includes("io.readFileSync(fd, 'utf8')"));
  assert.ok(signalAudit.includes('signalIdentity.readProductionAutoLiveScheduleActivation(activationPath)'));
  assert.ok(signalAudit.includes('signalIdentity.readProductionAutoLiveScheduleWrapper(wrapperPath)'));
  assert.ok(signalAudit.includes("scheduleRoot = '/opt/stock-app-data/auto-live-signal-v1'"));
  assert.ok(production.includes('state_root=/opt/stock-app-data/auto-live-signal-v1'));
  assert.ok(!signalAudit.includes("readFileSync(activationPath, 'utf8')"));
  assert.ok(!signalAudit.includes("readFileSync(wrapperPath, 'utf8')"));
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
