const test = require('node:test');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const { inspectIndependentAutoLivePublicSourcePlan, assertAutoLiveSignalNotDisabled, inspectAutoLiveSharedPaperForwardOwnership, inspectManagedPaperForwardSchedule, inspectSignalEntryIdentity, assertSignalEntryIdentityReceipt,
  verifyProductionAutoLivePrearmHandoff } = require('../../ops/production-auto-live-signal-identity.cjs');
const SHA = 'a'.repeat(40);
const SCHEDULE_AT = Date.parse('2026-10-13T00:20:00.000Z');
const MANAGED_CRON = '*/15 * * * * /usr/bin/flock -n /opt/stock-app-data/paper-forward-v1/cron.lock ' +
  '/opt/stock-app-data/paper-forward-v1/bin/run-paper-forward-schedule # stock-app-paper-forward-v1';
const entry = (market, researchCodeSha = SHA) => ({ identity: { market, researchCodeSha } });
test('an empty handoff is transport-only and does not prove scanner/AI invocation or candidate SHA', () => {
  const proof = inspectSignalEntryIdentity([], SHA);
  assert.equal(proof.entryShaMatch, null);
  assert.equal(proof.producerInvocationVerified, false);
  assert.deepEqual(proof.observedMarkets, []);
  assert.doesNotThrow(() => assertSignalEntryIdentityReceipt({ ...proof, entryCount: 0 }, SHA));
  assert.throws(() => assertSignalEntryIdentityReceipt({ ...proof, entryCount: 0, entryShaMatch: true }, SHA), /IDENTITY_INVALID/);
  assert.throws(() => assertSignalEntryIdentityReceipt({ ...proof, entryCount: 0,
    observedMarkets: ['KR_STOCK'] }, SHA), /IDENTITY_INVALID/);
});
test('mixed or old candidate SHA is rejected before a receipt is emitted', () => {
  for (const rows of [[entry('KR_STOCK', 'b'.repeat(40))], [entry('KR_STOCK'), entry('US_STOCK', 'b'.repeat(40))],
    [{}], [{ identity: { market: 'US_STOCK' } }]]) {
    assert.throws(() => inspectSignalEntryIdentity(rows, SHA), /HANDOFF_SHA_MISMATCH/);
  }
});
test('current candidate identities are bound exactly, never promoted into all-market AI execution proof', () => {
  const proof = inspectSignalEntryIdentity([entry('KR_STOCK'), entry('CRYPTO_FUTURES')], SHA);
  assert.equal(proof.entryShaMatch, true);
  assert.deepEqual(proof.entryResearchCodeShas, [SHA]);
  assert.deepEqual(proof.observedMarkets, ['CRYPTO_FUTURES', 'KR_STOCK']);
  assert.doesNotThrow(() => assertSignalEntryIdentityReceipt({ ...proof, entryCount: 2 }, SHA));
  for (const patch of [{ producerInvocationVerified: true }, { sourceTransportOnly: false },
    { entryResearchCodeShas: ['b'.repeat(40)] }, { observedMarkets: ['KR_STOCK', 'KR_STOCK'] },
    { entryCount: 1 }, { entryCount: Number.NaN }]) {
    assert.throws(() => assertSignalEntryIdentityReceipt({ ...proof, entryCount: 2, ...patch }, SHA), /IDENTITY_INVALID/);
  }
});

test('prearm validates published schema and SHA256 without fabricating scanner/AI capability', async () => {
  const { buildMemberAutoTradingPaperHandoff } =
    await import('../../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js');
  const nowMs = Date.parse('2026-10-12T23:00:00.000Z');
  const makeEmpty = (evaluatedAtMs = nowMs) => buildMemberAutoTradingPaperHandoff({
    cycleId: 'prearm-transport-only', evaluatedAtMs, lanes: [],
  });
  const published = makeEmpty();
  const safe = await verifyProductionAutoLivePrearmHandoff(published, SHA, nowMs);
  assert.equal(safe.entryCount, 0);
  assert.equal(safe.producerInvocationVerified, false);
  assert.equal(safe.sourceTransportOnly, true);
  assert.equal(safe.entryShaMatch, null);
  assert.deepEqual(safe.observedMarkets, []);
  await assert.rejects(() => verifyProductionAutoLivePrearmHandoff(
    { ...published, handoffDigest: 'b'.repeat(64) }, SHA, nowMs),
  /AUTOMATIC_TRADING_PREARM_HANDOFF_CONTRACT_INVALID/u);
  await assert.rejects(() => verifyProductionAutoLivePrearmHandoff(
    { ...published, safety: { ...published.safety, liveTrading: true } }, SHA, nowMs),
  /AUTOMATIC_TRADING_PREARM_HANDOFF_CONTRACT_INVALID/u);
  await assert.rejects(() => verifyProductionAutoLivePrearmHandoff(
    { ...published, status: 'BLOCKED_DATA', blockers: ['PUBLIC_DATA_MISSING'] }, SHA, nowMs),
  /AUTOMATIC_TRADING_PREARM_HANDOFF_BLOCKED_OR_STALE/u);
  await assert.rejects(() => verifyProductionAutoLivePrearmHandoff(
    makeEmpty(nowMs - 30 * 60_000 - 1), SHA, nowMs),
  /AUTOMATIC_TRADING_PREARM_HANDOFF_BLOCKED_OR_STALE/u);
  await assert.rejects(() => verifyProductionAutoLivePrearmHandoff(
    makeEmpty(nowMs + 1), SHA, nowMs),
  /AUTOMATIC_TRADING_PREARM_HANDOFF_CONTRACT_INVALID/u);
  await assert.rejects(() => verifyProductionAutoLivePrearmHandoff(
    published, 'not-a-valid-sha', nowMs),
  /AUTOMATIC_TRADING_PREARM_ARGUMENT_INVALID/u);
  await assert.rejects(() => verifyProductionAutoLivePrearmHandoff(
    published, SHA, Number.NaN),
  /AUTOMATIC_TRADING_PREARM_ARGUMENT_INVALID/u);
});

function activationFor(cronLine = MANAGED_CRON, overrides = {}) {
  return {
    schemaVersion: 'paper-forward-schedule-activation-v2',
    status: 'ACTIVE_WAITING_FOR_NATURAL_CYCLE',
    targetSha: SHA, deployedSha: SHA, activationAtMs: SCHEDULE_AT,
    installedAt: new Date(SCHEDULE_AT).toISOString(),
    scheduleActive: true, pollCadence: 'EVERY_15_MINUTES',
    canonicalCycleIntervalMs: 900_000, autoLivePublicSignalRefreshEnabled: true,
    runtimeDigest: 'b'.repeat(64),
    cronHash: createHash('sha256').update(cronLine).digest('hex'),
    paperTradeOutcomeAccumulationEnabled: false,
    simulatedFinancialAdaptersEnabled: false,
    externalFinancialMutationAllowed: false,
    publicDataOnly: true,
    liveTrading: false, privateAccountAccess: false, orderAuthority: false,
    ...overrides,
  };
}

test('only exact installed 15-minute cron and SHA-bound receipt prove schedule configuration', () => {
  const result = inspectManagedPaperForwardSchedule(MANAGED_CRON,
    activationFor(), SHA, SCHEDULE_AT, SCHEDULE_AT + 15_000);
  assert.deepEqual(result, { exactActiveCommand: true, activationBound: true,
    entryCount: 1, publicOnly: true, refreshIntervalMs: 900_000 });
  const bin = '/opt/stock-app-data/paper-forward-v1/bin/run-paper-forward-schedule';
  const bad = [
    '# stock-app-paper-forward-v1', '# ' + MANAGED_CRON,
    MANAGED_CRON.replace('*/15 * * * *', '0 * * * *'),
    MANAGED_CRON.replace('/usr/bin/flock', 'echo'),
    MANAGED_CRON.replace(bin, '/tmp/run-paper-forward-schedule'),
    MANAGED_CRON + ' ; true',
    MANAGED_CRON + '\n' + MANAGED_CRON,
    MANAGED_CRON + '\n*/15 * * * * /usr/bin/flock -n /tmp/other.lock ' + bin,
  ];
  for (const cron of bad) {
    assert.throws(() => inspectManagedPaperForwardSchedule(
      cron, activationFor(), SHA, SCHEDULE_AT, SCHEDULE_AT + 15_000,
    ), /AUTO_LIVE_SIGNAL_SCHEDULE_/u);
  }
});

test('cron configuration cannot re-use stale, mismatched or Paper-outcome activation receipts', () => {
  for (const patch of [
    { targetSha: 'c'.repeat(40) }, { deployedSha: 'c'.repeat(40) },
    { activationAtMs: SCHEDULE_AT - 10_000 },
    { installedAt: new Date(SCHEDULE_AT - 10_000).toISOString() },
    { cronHash: '0'.repeat(64) }, { scheduleActive: false },
    { pollCadence: 'EVERY_60_MINUTES' }, { canonicalCycleIntervalMs: 14_400_000 },
    { autoLivePublicSignalRefreshEnabled: false }, { paperTradeOutcomeAccumulationEnabled: true },
    { simulatedFinancialAdaptersEnabled: true }, { externalFinancialMutationAllowed: true },
    { liveTrading: true }, { privateAccountAccess: true }, { orderAuthority: true },
    { runtimeDigest: '' },
  ]) {
    assert.throws(() => inspectManagedPaperForwardSchedule(
      MANAGED_CRON, activationFor(MANAGED_CRON, patch), SHA, SCHEDULE_AT, SCHEDULE_AT + 15_000,
    ), /AUTO_LIVE_SIGNAL_SCHEDULE_ACTIVATION_PROOF_INVALID/u);
  }
  assert.throws(() => inspectManagedPaperForwardSchedule(
    MANAGED_CRON, activationFor(), SHA, SCHEDULE_AT + 1_000, SCHEDULE_AT + 15_000,
  ), /AUTO_LIVE_SIGNAL_SCHEDULE_ACTIVATION_PROOF_INVALID/u);
  assert.throws(() => inspectManagedPaperForwardSchedule(
    MANAGED_CRON, activationFor(), SHA, SCHEDULE_AT, SCHEDULE_AT - 1_000,
  ), /AUTO_LIVE_SIGNAL_SCHEDULE_ARGUMENT_INVALID/u);
});

test('audit rejects both disable sentinels and a different source-wrapper identity', () => {
  const source = readFileSync('ops/production-auto-live-signal-source-audit.mjs', 'utf8');
  assert.ok(source.includes('signalIdentity.assertAutoLiveSignalNotDisabled(scheduleRoot)'));
  const identitySource = readFileSync('ops/production-auto-live-signal-identity.cjs', 'utf8');
  assert.ok(identitySource.includes("root + '/DISABLED'"));
  assert.ok(identitySource.includes("root + '/runtime-state/DISABLED'"));
  assert.ok(identitySource.includes("stat(path)"));
  assert.ok(source.includes('timeout: 5000'));
  assert.ok(source.includes('maxBuffer: 1024 * 1024'));
  assert.doesNotMatch(source, /existsSync\(scheduleRoot\s*\+/u);
  assert.ok(source.includes('inspectManagedPaperForwardSchedule('));
  assert.ok(source.includes('AUTO_LIVE_SIGNAL_SCHEDULE_WRAPPER_INVALID'));
  assert.ok(source.includes("PAPER_FORWARD_RESEARCH_SHA='"));
  assert.ok(source.includes("AUTO_LIVE_PUBLIC_SIGNAL_REFRESH_ENABLED='true'"));
  assert.ok(source.includes("PRIVATE_TRADING_API_ALLOWED='false'"));
});

test('auto-LIVE shared-scheduler preflight passes only an empty prior Paper owner', () => {
  const clean = inspectAutoLiveSharedPaperForwardOwnership({
    targetSha: SHA, crontabText: '10 * * * * /usr/bin/date', sharedStateRootPresent: false,
  });
  assert.deepEqual(clean, {
    schemaVersion: 'automatic-live-shared-paper-owner-preflight-v1',
    status: 'PASS_NO_EXISTING_PAPER_OWNER', targetSha: SHA,
    financeOrScheduleMutationCount: 0, scannerInvocationVerified: false,
    aiIssuerVerified: false, liveActivationReady: false,
  });
  const occupied = [
    '# stock-app-paper-forward-v1',
    '# */15 * * * * /usr/bin/flock -n /opt/stock-app-data/paper-forward-v1/cron.lock',
    '*/15 * * * * /usr/bin/flock -n /tmp/x /opt/stock-app-data/paper-forward-v1/bin/run-paper-forward-schedule',
    '0 */4 * * * /usr/bin/node /srv/research/run-paper-forward-schedule.js',
  ];
  for (const crontabText of occupied) {
    assert.throws(() => inspectAutoLiveSharedPaperForwardOwnership({
      targetSha: SHA, crontabText, sharedStateRootPresent: false,
    }), /AUTO_LIVE_SHARED_PAPER_SCHEDULE_ALREADY_OWNED/u);
  }
  for (const crontabText of ['', '10 * * * * /usr/bin/date']) {
    assert.throws(() => inspectAutoLiveSharedPaperForwardOwnership({
      targetSha: SHA, crontabText, sharedStateRootPresent: true,
    }), /AUTO_LIVE_SHARED_PAPER_STATE_ALREADY_OWNED/u);
  }
  for (const fields of [
    { targetSha: 'bad', crontabText: '', sharedStateRootPresent: false },
    { targetSha: SHA, crontabText: null, sharedStateRootPresent: false },
    { targetSha: SHA, crontabText: '', sharedStateRootPresent: undefined },
  ]) {
    assert.throws(() => inspectAutoLiveSharedPaperForwardOwnership(fields),
      /AUTO_LIVE_SHARED_SCHEDULE_ARGUMENT_INVALID/u);
  }
  const preflight = readFileSync('ops/production-auto-live-signal-identity.cjs', 'utf8');
  assert.ok(preflight.includes("lstatSync('/opt/stock-app-data/paper-forward-v1')"));
  assert.ok(preflight.includes('AUTO_LIVE_SHARED_SCHEDULE_INSPECTION_UNAVAILABLE'));
  assert.ok(preflight.includes("process.env.AUTO_LIVE_SHARED_PAPER_PREFLIGHT === 'true'"));
  assert.doesNotMatch(preflight, /\b(?:execFileSync|spawnSync)\(\s*['"](?:pm2|psql|bash|sh)['"]/iu);
});


test('disabled schedule sentinels fail closed even when dangling symlinks', () => {
  const root = '/opt/stock-app-data/paper-forward-v1';
  const directory = { isDirectory: () => true, isSymbolicLink: () => false };
  const symlink = { isDirectory: () => false, isSymbolicLink: () => true };
  const marker = { isDirectory: () => false, isSymbolicLink: () => false };
  const absent = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const unreadable = Object.assign(new Error('denied'), { code: 'EACCES' });
  const statFixture = (custom = {}) => (path) => {
    if (Object.hasOwn(custom, path)) {
      if (custom[path] instanceof Error) throw custom[path];
      return custom[path];
    }
    if (path === root || path === root + '/runtime-state') return directory;
    throw absent;
  };
  assert.deepEqual(assertAutoLiveSignalNotDisabled(root, statFixture()), {
    disableSentinelPresent: false,
  });
  assert.deepEqual(assertAutoLiveSignalNotDisabled(root, statFixture({
    [root + '/runtime-state']: absent,
  })), { disableSentinelPresent: false });
  for (const markerPath of [root + '/DISABLED', root + '/runtime-state/DISABLED']) {
    for (const value of [marker, symlink]) {
      assert.throws(() => assertAutoLiveSignalNotDisabled(
        root, statFixture({ [markerPath]: value }),
      ), /AUTO_LIVE_SIGNAL_SCHEDULE_DISABLED/u);
    }
    assert.throws(() => assertAutoLiveSignalNotDisabled(
      root, statFixture({ [markerPath]: unreadable }),
    ), /AUTO_LIVE_SIGNAL_SCHEDULE_INSPECTION_UNAVAILABLE/u);
  }
  for (const badParent of [root, root + '/runtime-state']) {
    for (const value of [symlink, unreadable]) {
      assert.throws(() => assertAutoLiveSignalNotDisabled(
        root, statFixture({ [badParent]: value }),
      ), /AUTO_LIVE_SIGNAL_SCHEDULE_INSPECTION_UNAVAILABLE/u);
    }
  }
  assert.throws(() => assertAutoLiveSignalNotDisabled(
    root, statFixture({ [root]: absent }),
  ), /AUTO_LIVE_SIGNAL_SCHEDULE_INSPECTION_UNAVAILABLE/u);
  assert.throws(() => assertAutoLiveSignalNotDisabled(
    '/tmp/not-a-production-root', statFixture(),
  ), /AUTO_LIVE_SIGNAL_SCHEDULE_INSPECTION_UNAVAILABLE/u);
});

test('a dedicated Auto LIVE public source plan never replaces existing Paper or grants AI authority', () => {
  const paperCron='*/15 * * * * /usr/bin/flock -n /opt/stock-app-data/paper-forward-v1/cron.lock ' +
    '/opt/stock-app-data/paper-forward-v1/bin/run-paper-forward-schedule # stock-app-paper-forward-v1';
  const args={targetSha:SHA,deployedSha:SHA,crontabText:paperCron,isolatedRootPresent:false};
  const plan=inspectIndependentAutoLivePublicSourcePlan(args);
  assert.equal(plan.status,'DRAFT_PLAN_NOT_INSTALLED');
  assert.equal(plan.ownerInstallApprovalRequired,true);
  assert.equal(plan.paperRootMutated,false);
  assert.equal(plan.paperCronReplaced,false);
  assert.equal(plan.privateApiAllowed,false);
  assert.equal(plan.financialMutationAllowed,false);
  assert.equal(plan.producerInvocationVerified,false);
  assert.equal(plan.aiIssuerVerified,false);
  assert.equal(plan.autoTradingActivationReady,false);
  assert.ok(plan.handoffPath.startsWith('/opt/stock-app-data/auto-live-signal-v1/runtime-state/'));
  assert.ok(!plan.handoffPath.includes('/paper-forward-v1/'));
  assert.ok(plan.cronLine.startsWith('*/15 * * * * /usr/bin/flock -n '));
  assert.equal(plan.cronHash,createHash('sha256').update(plan.cronLine).digest('hex'));
  assert.ok(Object.isFrozen(plan));
  for(const altered of [
    {targetSha:'invalid'}, {deployedSha:'b'.repeat(40)},
    {crontabText:null}, {isolatedRootPresent:null},
  ]) assert.throws(()=>inspectIndependentAutoLivePublicSourcePlan({...args,...altered}),
    /AUTO_LIVE_INDEPENDENT_SOURCE_ARGUMENT_INVALID/u);
  assert.throws(()=>inspectIndependentAutoLivePublicSourcePlan({...args,crontabText:plan.cronLine}),
    /AUTO_LIVE_INDEPENDENT_SOURCE_ALREADY_OWNED/u);
  assert.throws(()=>inspectIndependentAutoLivePublicSourcePlan({...args,isolatedRootPresent:true}),
    /AUTO_LIVE_INDEPENDENT_SOURCE_STATE_ALREADY_OWNED/u);
});
