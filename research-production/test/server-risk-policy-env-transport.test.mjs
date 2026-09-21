import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildTaskPlan } from '../src/engine.mjs';

const source = readFileSync(new URL('../deploy/activate-server.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const SHA = 'a'.repeat(40);
const KEY = 'PAPER_FORWARD_RISK_POLICY_RECORD_PATH';
const COST_KEY = 'PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH';
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const shellPath = (path) => process.platform === 'win32'
  ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : path;

// Run the complete activation script with filesystem roots relocated and all
// host/network/mutating commands replaced by strict, sandbox-only shims.
const shim = String.raw`
import { appendFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
const root = process.env.HARNESS_ROOT_NATIVE;
const [name, ...args] = process.argv.slice(2);
const native = p => process.platform === 'win32' ? p.replace(/^\/([a-z])\//i, (_, d) => d + ':/') : p;
const safe = p => {
  const path = resolve(native(p));
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)) throw Error('sandbox escape');
  return path;
};
appendFileSync(root + '/events.jsonl', JSON.stringify([name, ...args]) + '\n');
switch (name) {
  case 'id': if (args[0] === '-u') console.log('0'); break;
  case 'git':
    if (args[0] !== '-C' || args[2] !== 'rev-parse' || args[3] !== 'HEAD') throw Error('unexpected git operation');
    safe(args[1]); console.log(process.env.TARGET_SHA); break;
  case 'awk': console.log(args.some(a => a.includes('MemAvailable')) ? '10737418240' : '21474836480'); break;
  case 'nproc': console.log('2'); break;
  case 'mktemp': console.log(process.env.HARNESS_ROOT + '/env.tmp'); break;
  case 'readlink': console.log(process.env.HARNESS_ROOT + '/research/releases/' + process.env.TARGET_SHA); break;
  case 'install': {
    const paths = [];
    for (let i = 0; i < args.length; i++) {
      if (['-o', '-g', '-m'].includes(args[i])) { i++; continue; }
      if (!args[i].startsWith('-')) paths.push(safe(args[i]));
    }
    if (args.includes('-d')) for (const p of paths) mkdirSync(p, { recursive: true });
    else { mkdirSync(dirname(paths[1]), { recursive: true }); copyFileSync(paths[0], paths[1]); }
    break;
  }
  case 'rm': for (const a of args.filter(a => !a.startsWith('-'))) rmSync(safe(a), { force: true, recursive: true }); break;
  case 'ln': case 'mv': for (const a of args.filter(a => !a.startsWith('-'))) safe(a); break;
  case 'runuser':
    if (!args.includes('preflight') || args.includes('run')) throw Error('unexpected cycle execution');
    break;
  case 'df': case 'systemctl': case 'systemd-analyze': break;
  default: throw Error('unexpected host operation: ' + name);
}
`;

function activate(value, { mode = 'activate', legacy, supplemental } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'server-risk-env-'));
  const shellRoot = shellPath(root);
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(root, 'shim.mjs'), shim);
    for (const command of ['id', 'git', 'awk', 'nproc', 'mktemp', 'readlink', 'install', 'rm', 'ln', 'mv', 'runuser', 'df', 'systemctl', 'systemd-analyze']) {
      writeFileSync(join(bin, command), '#!/usr/bin/env bash\nexec "$REAL_NODE" "$HARNESS_ROOT/shim.mjs" ' + command + ' "$@"\n', { mode: 0o755 });
    }
    for (const prefix of [`research/releases/${SHA}`, 'research/current']) {
      for (const file of ['bin/research-cycle.mjs', 'src/engine.mjs', 'deploy/research-production@.service',
        ...['fast-historical', 'long-history', 'forward'].map(t => `deploy/research-production-${t}.timer`)]) {
        const path = join(root, prefix, 'research-production', file);
        mkdirSync(resolve(path, '..'), { recursive: true });
        writeFileSync(path, 'sandbox release fixture\n');
      }
    }
    const script = source.replaceAll('/opt/investment-research', `${shellRoot}/research`)
      .replaceAll('/var/lib/investment-research-production', `${shellRoot}/state`)
      .replaceAll('/etc/investment-research', `${shellRoot}/etc/research`)
      .replaceAll('/etc/systemd/system', `${shellRoot}/etc/systemd`)
      .replaceAll('/opt/stock-app/.deploy/current-sha', `${shellRoot}/app-sha`);
    const env = { ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
      TARGET_SHA: SHA, HARNESS_ROOT: shellRoot, HARNESS_ROOT_NATIVE: root, REAL_NODE: shellPath(process.execPath),
      MSYS2_ENV_CONV_EXCL: '*' };
    delete env[KEY];
    delete env[COST_KEY];
    delete env.GENERIC_RISK_POLICY_LIVE_RECORD_PATH;
    if (value !== undefined) env[KEY] = value;
    if (supplemental !== undefined) env[COST_KEY] = supplemental;
    if (legacy !== undefined) env.GENERIC_RISK_POLICY_LIVE_RECORD_PATH = legacy;
    const result = spawnSync(bash, ['-s', '--', mode], { env,
      input: 'export PATH="$HARNESS_ROOT/bin:$PATH"\n' + script, cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(result.error);
    const envPath = join(root, 'etc/research/research-production.env');
    const eventsPath = join(root, 'events.jsonl');
    return { ...result, sentinelPresent: existsSync(join(root, 'sentinel')),
      environment: existsSync(envPath) ? readFileSync(envPath, 'utf8') : null,
      events: existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').trim().split('\n').map(JSON.parse) : [] };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('missing, empty and legacy-only paths remain absent in the installed EnvironmentFile', () => {
  for (const [value, options] of [[undefined, {}], ['', {}], [undefined, { legacy: '/legacy/policy.record' }]]) {
    const result = activate(value, options);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.environment, /RISK_POLICY/);
    assert.match(result.environment, /^RESEARCH_CODE_SHA=a{40}$/m);
    for (const key of ['LIVE_TRADING', 'LIVE_TRADING_ENABLED', 'REAL_ORDER_ENABLED', 'REAL_TRADING_ENABLED',
      'PRIVATE_API_ENABLED', 'PRIVATE_ACCOUNT_ACCESS', 'PRIVATE_TRADING_API_ALLOWED', 'ORDER_AUTHORITY', 'ORDER_SUBMISSION_ENABLED']) {
      assert.match(result.environment, new RegExp(`^${key}=false$`, 'm'));
    }
  }
});

test('explicit paths are escaped as systemd quoted data, never evaluated or used as files', () => {
  for (const value of ['/owner/policy.record', '/owner supplied/\'"back\\slash $HOME $(touch sentinel) `touch sentinel` #%;/policy.record']) {
    const result = activate(value);
    assert.equal(result.status, 0, result.stderr);
    const expected = `${KEY}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    assert.deepEqual(result.environment.split('\n').filter(line => line.startsWith(`${KEY}=`)), [expected]);
    const quoted = result.environment.split('\n').find(line => line.startsWith(`${KEY}=`)).slice(KEY.length + 2, -1);
    // EnvironmentFile's double-quoted escape rules; shell expansion is absent.
    const decoded = quoted.replace(/\\(["\\`$])/gu, '$1');
    assert.equal(decoded, value);
    if (process.platform !== 'win32') {
      const plan = buildTaskPlan({ profile: 'forward', stateRoot: '/sandbox/state', researchSha: SHA,
        activationAtMs: 12345, env: { [KEY]: decoded } });
      assert.equal(plan.find(task => task.kind === 'paper').env[KEY], value);
      assert.equal(Object.hasOwn(plan.find(task => task.kind === 'shadow').env, KEY), false);
    }
    assert.equal(result.sentinelPresent, false);
    assert.ok(result.events.every(event => !event.slice(1).includes(value)), 'record path must never be read or written');
    const install = result.events.find(event => event[0] === 'install' && event.at(-1).endsWith('/research-production.env'));
    assert.deepEqual(install.slice(1, 7), ['-o', 'root', '-g', 'investment-research', '-m', '0640']);
    assert.equal(result.stdout.includes(value), false);
    assert.equal(result.stderr.includes(value), false);
    assert.ok(result.events.some(event => event[0] === 'systemctl' && event[1] === 'enable'), 'existing activation completes in the sandbox');
  }
});

test('invalid paths fail before preflight or activation tools, env writes, symlink changes and timer traps', () => {
  for (const mode of ['preflight', 'activate']) {
    for (const value of ['relative/policy.record', '/owner/../policy.record', '/owner//policy.record',
      '/owner/./policy.record', '/owner/policy.record/', ' /owner/policy.record', '/owner/policy.record ',
      '/owner/policy\nREAL_ORDER_ENABLED=true', '/owner/policy\r.record', '/owner/policy\t.record', '/owner/policy\x7f.record']) {
      const result = activate(value, { mode });
      assert.equal(result.status, 64, `${mode} ${JSON.stringify(value)}: ${result.stderr}`);
      assert.match(result.stderr, /normalized absolute path/);
      assert.equal(result.environment, null);
      assert.deepEqual(result.events, []);
    }
  }
});

test('supplemental cost path survives server EnvironmentFile into Paper only; missing stays absent', () => {
  for (const supplemental of [undefined, '']) {
    const result = activate(undefined, { supplemental });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.environment, /PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH=/);
  }
  const value = '/owner supplied/cost \'"back\\slash $HOME $(touch sentinel) `touch sentinel` #%;/record.json';
  const result = activate(undefined, { supplemental: value });
  assert.equal(result.status, 0, result.stderr);
  const expected = `${COST_KEY}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  assert.deepEqual(result.environment.split('\n').filter(line => line.startsWith(`${COST_KEY}=`)), [expected]);
  const decoded = expected.slice(COST_KEY.length + 2, -1).replace(/\\(["\\`$])/gu, '$1');
  assert.equal(decoded, value);
  if (process.platform !== 'win32') {
    const plan = buildTaskPlan({ profile: 'forward', stateRoot: '/sandbox/state', researchSha: SHA,
      activationAtMs: 12345, env: { [COST_KEY]: decoded } });
    assert.equal(plan.find(task => task.kind === 'paper').env[COST_KEY], value);
    assert.equal(Object.hasOwn(plan.find(task => task.kind === 'shadow').env, COST_KEY), false);
  }
  assert.equal(result.sentinelPresent, false);
  assert.ok(result.events.every(event => !event.slice(1).includes(value)));
});

test('unsafe supplemental cost paths fail before server activation mutation', () => {
  for (const mode of ['preflight', 'activate']) {
    for (const supplemental of ['relative/cost.json', '/owner/../cost.json',
      '/owner/cost\nREAL_ORDER_ENABLED=true', '/owner/cost\r.json']) {
      const result = activate(undefined, { mode, supplemental });
      assert.equal(result.status, 64, `${mode} ${JSON.stringify(supplemental)}: ${result.stderr}`);
      assert.match(result.stderr, /PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH must be a normalized absolute path/);
      assert.equal(result.environment, null);
      assert.deepEqual(result.events, []);
    }
  }
});
