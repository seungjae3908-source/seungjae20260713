import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { collectResearchActivationPreflight, readBoundedPrivateFile } from '../../ops/research-activation-preflight.mjs';

const researchSha = 'a'.repeat(40), appSha = 'b'.repeat(40);
const { PREFLIGHT_IDS } = createRequire(import.meta.url)('../../.github/scripts/research-production-readonly-contract.cjs');
const state = '/var/lib/investment-research-production';
function fixture({ missing = false, unsafe = false, conflict = false, mutation = false } = {}) {
  const files = new Map([
    ['/opt/stock-app/.deploy/current-sha', appSha],
    ['/etc/investment-research/research-production.env', [
      'LIVE_TRADING=false', 'LIVE_TRADING_ENABLED=false', 'REAL_ORDER_ENABLED=false',
      'REAL_TRADING_ENABLED=false', 'PRIVATE_API_ENABLED=false', 'PRIVATE_ACCOUNT_ACCESS=false',
      'PRIVATE_TRADING_API_ALLOWED=false', 'ORDER_AUTHORITY=false', 'ORDER_SUBMISSION_ENABLED=false',
      ...(unsafe ? ['LIVE_TRADING=true'] : []),
    ].join('\n')],
    ['/opt/stock-app/.env', 'GEMINI_API_KEY=test-only-public-provider-key\nGROQ_API_KEY=test-only-other-provider-key\nYOUTUBE_DATA_API_KEY=test-only-video-key'],
    ...(conflict ? [['/opt/stock-app/.env.production', 'GEMINI_API_KEY=conflicting-test-only-key']] : []),
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
  assert.match(source, /declare -a WATCH_SERVICES=\(\s*research-production-market-watch\.service\s*\)/u);
  for (const line of source.split('\n').filter(line=>line.includes('systemctl disable --now')&&line.includes('CORE_TIMERS'))) {
    assert.ok(line.includes('"${WATCH_SERVICES[@]}"'));
  }
  assert.match(source, /verify_timers_stopped .*"\$\{WATCH_SERVICES\[@\]\}"/u);
  assert.match(source, /for timer in .*"\$\{WATCH_SERVICES\[@\]\}"/u);
  assert.ok(source.indexOf('verify_timers_stopped "${CORE_TIMERS[@]}"') < source.indexOf('mv -Tf -- "$NEXT_CURRENT" "$CURRENT"'));
  assert.match(source, /RUN_AS_RESEARCH=\("\$\{SUDO\[@\]\}" runuser/u);
  assert.match(source, /RESEARCH_NODE_ENV_PARSER_REQUIRED/u);
  assert.doesNotMatch(source, /systemctl (?:restart|stop|disable|start).*stock-app|pm2 (?:restart|stop|start)/u);
});
