import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { collectResearchActivationPreflight, readBoundedPrivateFile } from '../../ops/research-activation-preflight.mjs';
import { resolveResearchVideoDiscoveryQueries } from '../src/research-video-discovery-policy.mjs';
import { parseEnv } from 'node:util';

const researchSha = 'a'.repeat(40), appSha = 'b'.repeat(40);
const { PREFLIGHT_IDS } = createRequire(import.meta.url)('../../.github/scripts/research-production-readonly-contract.cjs');
const state = '/var/lib/investment-research-production';
function fixture({ missing = false, unsafe = false, conflict = false, mutation = false, bundleRoot, aiText, videoText } = {}) {
  const files = new Map([
    ['/opt/stock-app/.deploy/current-sha', appSha],
    ['/etc/investment-research/research-production.env', [
      'LIVE_TRADING=false', 'LIVE_TRADING_ENABLED=false', 'REAL_ORDER_ENABLED=false',
      'REAL_TRADING_ENABLED=false', 'PRIVATE_API_ENABLED=false', 'PRIVATE_ACCOUNT_ACCESS=false',
      'PRIVATE_TRADING_API_ALLOWED=false', 'ORDER_AUTHORITY=false', 'ORDER_SUBMISSION_ENABLED=false',
      ...(unsafe ? ['LIVE_TRADING=true'] : []),
    ].join('\n')],
    ['/opt/stock-app/.env', 'GEMINI_API_KEY=test-only-public-provider-key\nGROQ_API_KEY=test-only-other-provider-key\nYOUTUBE_DATA_API_KEY=test-only-video-key'
      + (bundleRoot === undefined ? '' : '\nRESEARCH_BUNDLE_STATE_ROOT=' + bundleRoot)],
    ...(conflict ? [['/opt/stock-app/.env.production', 'GEMINI_API_KEY=conflicting-test-only-key']] : []),
    ...(aiText === undefined ? [] : [['/etc/investment-research/research-ai.env', aiText]]),
    ...(videoText === undefined ? [] : [['/etc/investment-research/research-video.env', videoText]]),
  ]);
  const missingError = () => Object.assign(new Error('not recorded'), { code: 'ENOENT' });
  let statTicks = 0;
  const io = {
    openSync(file) { if (missing || !files.has(file)) throw missingError(); return file; },
    fstatSync(file) { return { isFile: () => true, nlink: 1, size: Buffer.byteLength(files.get(file)),
      mode: 0o640, uid: 10, ctimeMs: mutation ? ++statTicks : 1, mtimeMs: 1, ino: 10, dev: 1 }; },
    readFileSync(file) {
      if (file === '/proc/meminfo') return 'MemAvailable: 2097152 kB\n';
      if (file === '/proc/loadavg') return '0.1 0.2 0.3 1/1 1';
      return files.get(file);
    },
    closeSync() {},
    lstatSync() { if (missing) throw missingError(); return { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o750, uid: 10 }; },
    realpathSync(file) { if (missing) throw missingError(); return file.endsWith('/current')
      ? '/opt/investment-research/releases/' + researchSha : file; },
  };
  const command = (name, args) => {
    if (name === 'df') return 'Filesystem Size Used Avail Use% Mounted\ntest 1 1 21474836480 1% /';
    if (name === 'nproc') return '2';
    if (name === 'id') return '10';
    if (name === 'git') return researchSha;
    if (name === 'systemctl') return 'ActiveState=inactive\nUnitFileState=disabled';
    return '';
  };
  return { io, command, researchSha, appSha, nowMs: 1000000, nodeVersion: '22.0.0' };
}

test('all independent checks are collected even when prerequisites and later inputs are missing', () => {
  const result = collectResearchActivationPreflight(fixture({ missing: true }));
  assert.ok(result.checks.length >= 40);
  assert.ok(result.prerequisiteBlockers.includes('APP_DEPLOY_SHA'));
  assert.ok(result.remainingChecks.includes('PAPER_LOOP_FUNCTIONAL_EVIDENCE'));
  assert.ok(result.remainingChecks.includes('UNIT_MARKET_WATCH_SERVICE'));
  assert.equal(result.prerequisitesReady, false);
  assert.equal(result.fullyFunctional, false);
});
test('ready prerequisites do not manufacture economic, policy, or postactivation evidence', () => {
  const result = collectResearchActivationPreflight(fixture());
  assert.equal(result.prerequisitesReady, true);
  assert.ok(PREFLIGHT_IDS.every(id => result.checks.some(row => row.id === id)));
  assert.ok(result.remainingChecks.includes('RESEARCH_ADAPTIVE_POLICY_RECORD_PATH'));
  assert.ok(result.remainingChecks.includes('PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH'));
  for (const field of ['fullyFunctional', 'closedLoopProven', 'profitabilityProven', 'credentialsExposed']) assert.equal(result[field], false);
  for (const field of ['orders', 'providerCalls', 'databaseMutations', 'policyMutations', 'processRestarts', 'serverFilesWritten']) assert.equal(result[field], 0);
  assert.equal(JSON.stringify(result).includes('test-only-public-provider-key'), false);
});
test('duplicate safety flags and provider conflicts block without suppressing other checks', () => {
  const result = collectResearchActivationPreflight(fixture({ unsafe: true, conflict: true }));
  assert.ok(result.prerequisiteBlockers.includes('RESEARCH_SAFE_ENV'));
  assert.ok(result.prerequisiteBlockers.includes('PROVIDER_GEMINI'));
  assert.ok(result.checks.some(row => row.id === 'STOCK_INPUT_US_STOCK'));
});

test('every AI/video config blocker is collected before activation without fabricating consent or calls', () => {
  const result = collectResearchActivationPreflight(fixture({
    aiText: 'AI_CHAT_PROVIDER=groq\nRESEARCH_AI_MAX_CALLS_PER_SCAN=4\n',
    videoText: 'RESEARCH_VIDEO_DISCOVERY_APPROVED=true\nRESEARCH_VIDEO_DISCOVERY_QUERIES_JSON=[]\n',
  }));
  assert.ok(result.prerequisiteBlockers.includes('AI_POLICY_CONFIGURATION'));
  assert.ok(result.prerequisiteBlockers.includes('VIDEO_POLICY_CONFIGURATION'));
  assert.ok(result.checks.some(row => row.id === 'PAPER_LOOP_FUNCTIONAL_EVIDENCE'));
  assert.equal(result.prerequisitesReady, false);
  assert.equal(result.providerCalls, 0);
  assert.equal(result.policyMutations, 0);
  const optional = collectResearchActivationPreflight(fixture({ videoText: 'RESEARCH_VIDEO_DISCOVERY_APPROVED=false\n' }));
  assert.equal(optional.checks.find(row => row.id === 'VIDEO_POLICY_CONFIGURATION').status, 'PASS');
  assert.equal(optional.checks.find(row => row.id === 'VIDEO_POLICY').status, 'PENDING');
});

test('standalone SSH audit matches worker query admission and rejects every later bounded setting', () => {
  for (const raw of ['', '[]', '{}', '["valid"]', '["same"," same "]', '["Ａ","A"]',
    '["password=TEST_ONLY_VALUE"]', '["bad\\u0000query"]', 'invalid-json']) {
    const videoText = 'RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON=' + raw + '\n';
    let valid = true;
    try { resolveResearchVideoDiscoveryQueries(parseEnv(videoText)); } catch { valid = false; }
    const row = collectResearchActivationPreflight(fixture({ videoText })).checks
      .find(row => row.id === 'VIDEO_POLICY_CONFIGURATION');
    assert.equal(row.status === 'PASS', valid);
  }
  for (const videoText of ['RESEARCH_VIDEO_DISCOVERY_MAX_RESULTS=4', 'RESEARCH_VIDEO_DISCOVERY_MAX_RESULTS=1.5',
    'RESEARCH_VIDEO_DISCOVERY_PUBLISHED_AFTER_HOURS=2161', 'RESEARCH_VIDEO_DISCOVERY_REGION_CODE=UNKNOWN',
    'RESEARCH_VIDEO_DISCOVERY_RELEVANCE_LANGUAGE=invalid-language', 'PRIVATE_API_ENABLED=true',
    'YOUTUBE_DATA_API_KEY=TEST_ONLY_NOT_A_KEY']) {
    const result = collectResearchActivationPreflight(fixture({ videoText }));
    assert.ok(result.prerequisiteBlockers.includes('VIDEO_POLICY_CONFIGURATION'));
    assert.equal(JSON.stringify(result).includes('TEST_ONLY_NOT_A_KEY'), false);
  }
  for (const aiText of ['RESEARCH_AI_MAX_CALLS_PER_SCAN=1.5', 'AI_CHAT_PROVIDER=paid',
    'GEMINI_MODEL=paid-model', 'GROQ_API_KEY=TEST_ONLY_NOT_A_KEY']) {
    assert.ok(collectResearchActivationPreflight(fixture({ aiText })).prerequisiteBlockers.includes('AI_POLICY_CONFIGURATION'));
  }
});
test('bundle store accepts canonical safe state roots without granting admission or relaxing path safety', () => {
  const status = options => collectResearchActivationPreflight(options).checks
    .find(row => row.id === 'APP_RESEARCH_BUNDLE_STORE_CONFIGURATION').status;
  assert.equal(status(fixture()), 'MISSING');
  for (const bundleRoot of [state, state + '/bundles']) {
    assert.equal(status(fixture({ bundleRoot })), 'UNKNOWN');
  }
  for (const bundleRoot of ['/tmp/bundles', state + '-other/bundles', state + '/bundles/',
    state + '/bundles/../elsewhere', 'relative/bundles']) {
    assert.equal(status(fixture({ bundleRoot })), 'BLOCKED');
  }
  const symbolic = fixture({ bundleRoot: state + '/bundles' });
  const realpath = symbolic.io.realpathSync;
  symbolic.io.realpathSync = file => file === state + '/bundles' ? '/tmp/outside' : realpath(file);
  assert.equal(status(symbolic), 'BLOCKED');
  const writable = fixture({ bundleRoot: state + '/bundles' });
  const lstat = writable.io.lstatSync;
  writable.io.lstatSync = file => ({ ...lstat(file), mode: file === state + '/bundles' ? 0o770 : 0o750 });
  assert.equal(status(writable), 'BLOCKED');
});
test('Node 20 before parseEnv availability, low resources and changed file are rejected', () => {
  const options = fixture();
  options.nodeVersion = '20.11.1';
  const result = collectResearchActivationPreflight(options);
  assert.ok(result.prerequisiteBlockers.includes('NODE_ENV_PARSER'));
  assert.throws(() => readBoundedPrivateFile('/opt/stock-app/.deploy/current-sha', fixture({ mutation: true }).io), /CHANGED_INPUT/);
  assert.throws(() => collectResearchActivationPreflight({ ...options, appSha: 'main' }), /IDENTITY_INVALID/);
});
test('probe has no mutation, arbitrary execution, PM2 bootstrap, or provider network path', () => {
  const source = readFileSync(new URL('../../ops/research-activation-preflight.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:writeFile|appendFile|mkdir|unlink|rename|chmod|chown|fetch)\s*\(/u);
  assert.doesNotMatch(source, /command\(['"](?:pm2|curl|wget|ssh)['"]/u);
  assert.doesNotMatch(source, /command\('systemctl',\s*\['(?:start|restart|enable|disable|stop)'/u);
});
test('core cutover freezes and rolls back every research watcher before switching SHA, never shared app units', () => {
  const source = readFileSync(new URL('../deploy/activate-server.sh', import.meta.url), 'utf8').replaceAll('\r\n','\n');
  assert.match(source, /declare -ga WATCH_SERVICES=\(\s*research-production-market-watch\.service\s*\)/u);
  const freeze = source.slice(source.indexOf('freeze_research_schedules() {'), source.indexOf('require_idle_one_shots() {'));
  assert.match(freeze, /systemctl disable --now/u);
  assert.match(freeze, /RESEARCH_SCHEDULE_FREEZE_FAILED/u);
  assert.match(freeze, /RESEARCH_SCHEDULE_FREEZE_UNKNOWN/u);
  assert.match(freeze, /WATCH_SERVICES/u);
  assert.doesNotMatch(freeze, /systemctl disable --now .*\|\| true/u);
  assert.match(source, /verify_timers_stopped .*"\$\{WATCH_SERVICES\[@\]\}"/u);
  assert.match(source, /for timer in .*"\$\{WATCH_SERVICES\[@\]\}"/u);
  assert.ok(source.indexOf('verify_timers_stopped "${CORE_TIMERS[@]}"') < source.indexOf('mv -Tf -- "$NEXT_CURRENT" "$CURRENT"'));
  assert.match(source, /RUN_AS_RESEARCH=\("\$\{SUDO\[@\]\}" runuser/u);
  assert.match(source, /RESEARCH_NODE_ENV_PARSER_REQUIRED/u);
  assert.doesNotMatch(source, /systemctl (?:restart|stop|disable|start).*stock-app|pm2 (?:restart|stop|start)/u);
});
test('core Research release defers active workloads, stages first, and never masks rollback failures', () => {
  const source = readFileSync(new URL('../deploy/activate-server.sh', import.meta.url), 'utf8');
  assert.match(source, /RESEARCH_CUTOVER_BUSY/u);
  assert.doesNotMatch(source, /systemctl stop "\$\{ONESHOT_SERVICES\[@\]\}"/u);
  for (const name of ['CORE_TIMERS', 'AI_TIMERS', 'AI_DAEMONS', 'WATCH_SERVICES', 'ONESHOT_SERVICES', 'CORE_UNIT_DEFINITIONS']) {
    assert.ok(source.includes('declare -ga ' + name + '=('), 'EXIT trap must retain ' + name);
  }
  for (const name of ['WAS_ENABLED', 'WAS_ACTIVE', 'WAS_INSTALLED', 'WAS_LOAD_STATE']) {
    assert.ok(source.includes('declare -gA ' + name + '=()'), 'rollback must snapshot ' + name);
  }
  const clone = source.indexOf('git clone --quiet --filter=blob:none');
  const freeze = source.indexOf('CUTOVER_MUTATION_STARTED=true');
  const cutover = source.indexOf('mv -Tf -- "$NEXT_CURRENT" "$CURRENT"');
  assert.ok(clone > 0 && freeze > clone && cutover > freeze);
  assert.match(source.slice(clone, freeze), /require_idle_one_shots/u);
  const beforeSwitch = source.slice(freeze, cutover);
  assert.match(beforeSwitch, /verify_timers_stopped/u);
  assert.match(beforeSwitch, /require_idle_one_shots/u);
  const rollback = source.slice(source.indexOf('fail_safe() {'), source.indexOf('trap fail_safe EXIT'));
  assert.match(source, /require_idle_one_shots && restore_previous_runtime/u);
  assert.match(rollback, /restore_pre_cutover_state/u);
  assert.match(source, /RESEARCH_PRODUCTION_PRE_CUTOVER_SCHEDULES_RESTORED=true/u);
  assert.match(rollback, /RESEARCH_PRODUCTION_ROLLBACK_FAILED=true/u);
  assert.match(rollback, /status=86/u);
  assert.match(rollback, /trap - EXIT/u);
  assert.match(rollback, /exit "\$status"/u);
  assert.doesNotMatch(rollback, /restore_previous_runtime \|\| true/u);
  assert.match(rollback, /RESEARCH_PRODUCTION_PRE_CUTOVER_FAILURE_RUNTIME_UNCHANGED=true/u);
  for (const profile of ['fast-historical', 'long-history', 'forward']) {
    assert.ok(source.includes('research-production@' + profile + '.service'));
  }
});

test('core Research rollback validates previous SHA, original unit bytes, env and timer state', () => {
  const source = readFileSync(new URL('../deploy/activate-server.sh', import.meta.url), 'utf8');
  const restore = source.slice(source.indexOf('restore_previous_runtime() {'), source.indexOf('fail_safe() {'));
  for (const code of ['RESEARCH_ROLLBACK_CURRENT_SHA_MISMATCH', 'RESEARCH_ROLLBACK_UNIT_BYTES_MISMATCH',
    'RESEARCH_ROLLBACK_ENV_MISMATCH', 'RESEARCH_ROLLBACK_UNIT_LOAD_STATE_MISMATCH', 'RESEARCH_ROLLBACK_UNIT_STATE_MISMATCH',
    'RESEARCH_PRODUCTION_ROLLBACK=RESTORED_VERIFIED']) {
    assert.ok(restore.includes(code), code);
  }
  assert.doesNotMatch(restore, /systemctl (?:stop|kill) "\$\{ONESHOT_SERVICES\[@\]\}"/u);
});

test('actual rollback shell reports failure instead of pretending it restored the prior runtime', () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const source = readFileSync(new URL('../deploy/activate-server.sh', import.meta.url), 'utf8');
  const rollback = source.slice(source.indexOf('fail_safe() {'), source.indexOf('trap fail_safe EXIT'));
  for (const [mutationStarted, pointerSwitched, busy, restoreResult, expectedStatus, expectedMarker] of [
    ['false', 'false', 0, 0, 1, 'RESEARCH_PRODUCTION_PRE_CUTOVER_FAILURE_RUNTIME_UNCHANGED=true'],
    ['true', 'false', 1, 0, 1, 'RESEARCH_PRODUCTION_ACTIVATION_FAILED_ROLLED_BACK=true'],
    ['true', 'true', 0, 0, 1, 'RESEARCH_PRODUCTION_ACTIVATION_FAILED_ROLLED_BACK=true'],
    ['true', 'true', 1, 0, 86, 'RESEARCH_PRODUCTION_ROLLBACK_FAILED=true'],
    ['true', 'true', 0, 1, 86, 'RESEARCH_PRODUCTION_ROLLBACK_FAILED=true'],
  ]) {
    const script = [
      'SUDO=(); CORE_TIMERS=(core.timer); AI_TIMERS=(); AI_DAEMONS=(); WATCH_SERVICES=()',
      'ROLLBACK_ENV=/not-a-real-file; ROLLBACK_UNITS=/not-a-real-directory',
      'CUTOVER_MUTATION_STARTED=' + mutationStarted,
      'CUTOVER_POINTER_SWITCHED=' + pointerSwitched,
      'ROLLBACK_VERIFIED=false',
      'systemctl() { return 0; }',
      'freeze_research_schedules() { return 0; }',
      'require_idle_one_shots() { return ' + busy + '; }',
      'restore_previous_runtime() { return ' + restoreResult + '; }',
      'restore_previous_schedules_only() { return 0; }',
      'restore_pre_cutover_state() { if [[ "$CUTOVER_POINTER_SWITCHED" == false ]]; then restore_previous_schedules_only; else require_idle_one_shots && restore_previous_runtime; fi; }',
      'cleanup_transient() { :; }',
      rollback,
      'trap fail_safe EXIT; false',
    ].join('\n');
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, expectedStatus, result.stderr || String(result.error));
    assert.match(result.stderr, new RegExp(expectedMarker, 'u'));
    if (expectedStatus === 86) assert.doesNotMatch(result.stderr, /ROLLBACK=RESTORED_VERIFIED/u);
  }
});

test('actual Research schedule freeze skips only absent units and surfaces real disable errors', () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const source = readFileSync(new URL('../deploy/activate-server.sh', import.meta.url), 'utf8');
  const freeze = source.slice(source.indexOf('freeze_research_schedules() {'), source.indexOf('require_idle_one_shots() {'));
  for (const [loadState, failedDisable, expectedStatus, expectedCalls] of [
    ['not-found', 0, 0, 0], ['loaded', 0, 0, 1],
    ['loaded', 1, 1, 1], ['mystery', 0, 1, 0],
  ]) {
    const script = [
      'SUDO=(); CORE_TIMERS=(core.timer); AI_TIMERS=(); AI_DAEMONS=(); WATCH_SERVICES=()',
      'LOAD_STATE=' + loadState + '; FAIL_DISABLE=' + failedDisable + '; DISABLE_COUNT=0',
      'systemctl() { if [[ "$1" == show ]]; then printf "%s" "$LOAD_STATE"; return 0; fi;',
      '  if [[ "$1" == disable ]]; then DISABLE_COUNT=$((DISABLE_COUNT + 1)); return "$FAIL_DISABLE"; fi; return 0; }',
      freeze,
      'freeze_research_schedules; code=$?; printf "FINAL=%s DISABLE_COUNT=%s\n" "$code" "$DISABLE_COUNT"; exit "$code"',
    ].join('\n');
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, expectedStatus, result.stderr || String(result.error));
    assert.match(result.stdout, new RegExp('DISABLE_COUNT=' + expectedCalls, 'u'));
    if (expectedStatus !== 0) assert.match(result.stderr, /RESEARCH_SCHEDULE_FREEZE_(?:FAILED|UNKNOWN)/u);
  }
});
test('real shell freeze guards reject running and unknown workloads without switching releases', () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const core = readFileSync(new URL('../deploy/activate-server.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const ai = readFileSync(new URL('../deploy/activate-ai-research.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const guards = [
    [core.slice(core.indexOf('\n  require_idle_one_shots() {'), core.indexOf('\n  restore_previous_runtime() {')), 'require_idle_one_shots', 0],
    [ai.slice(ai.indexOf('\nrequire_idle_one_shots() {'), ai.indexOf('\nresearch_sha() {')), 'disable_timers', 0],
  ];
  for (const [helper, invoke, expectedStops] of guards) {
    for (const [active, load, result] of [['inactive','loaded',0], ['failed','loaded',0],
      ['inactive','not-found',0], ['active','not-found',1], ['active','loaded',1], ['activating','loaded',1],
      ['deactivating','loaded',1], ['reloading','loaded',1], ['','',1]]) {
    const script = `SUDO=(); ONESHOT_SERVICES=(research-production@forward.service); STOPPED=0
timers=(research-production-ai-review.timer); daemon_services=(research-production-workspace-worker.service)
services=(research-production-ai-review.service)
systemctl() { if [[ "$1" == stop ]]; then STOPPED=1; return 0; fi
  if [[ "$1" == disable ]]; then return 0; fi
  if [[ "$1" == is-active || "$1" == is-enabled ]]; then return 1; fi
  if [[ "$4" == ActiveState ]]; then printf '%s' '${active}'; else printf '%s' '${load}'; fi; }
${helper}
${invoke}; status=$?; printf 'RESULT=%s;STOPPED=%s' "$status" "$STOPPED"; exit "$status"`;
    const run = spawnSync(bash, ['--noprofile', '--norc', '-c', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, result, `${active}/${load}: ${run.stderr || run.error || ''}`);
    assert.match(run.stdout, new RegExp(`STOPPED=${expectedStops}`,'u'));
    if (result === 1) assert.match(run.stderr,
      /(?:AI_)?RESEARCH_(?:WORKLOAD_(?:NOT_STOPPED|STATE_UNKNOWN)|CUTOVER_BUSY)/u);
    }
  }
});
