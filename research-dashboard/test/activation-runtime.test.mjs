import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, symlinkSync, readlinkSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../deploy/activate-server.sh', import.meta.url), 'utf8');
const target = 'a'.repeat(40);
const previous = 'b'.repeat(40);
const overview = (status = 'PRESENT', n = 7) => ({
  schemaVersion: 'research-dashboard-overview-v1',
  safety: { readOnlyDashboard: true, liveTrading: false, privateApi: false, orderAuthority: false },
  research: { liquidityIndependence: {
    // INVALID means a file was observed but rejected by the existing reader.
    present: status !== 'MISSING', status,
    effectiveIndependentN: status === 'PRESENT' ? n : null,
  } },
  profitability: { proven: false },
});

// Execute the complete shipped Bash script. Only absolute filesystem roots
// are relocated. OS commands are strict sandbox shims, never real systemd,
// network, git-clone, sudo, or production operations. Node/Python probe logic
// and Bash traps/branches run unchanged, including the /proc evidence reader.
const shim = String.raw`#!/usr/bin/env python3
import json, os, shutil, sys
from pathlib import Path
root = Path(os.environ['HARNESS_ROOT'])
state_path = root / 'service.json'
s = json.loads(state_path.read_text())
opts = json.loads((root / 'options.json').read_text())
name = Path(sys.argv[0]).name
args = sys.argv[1:]

def safe(value):
    # Lexical containment: do not follow the fake cwd/socket symlinks here.
    path = Path(os.path.abspath(value))
    if not path.is_relative_to(root):
        raise RuntimeError('sandbox path violation')
    return path

def save():
    state_path.write_text(json.dumps(s))

def event():
    with (root / 'events.jsonl').open('a') as f:
        f.write(json.dumps([name, *args]) + '\n')

def proc(pid, release):
    p = root / 'proc' / str(pid)
    (p / 'fd').mkdir(parents=True, exist_ok=True)
    (p / 'net').mkdir(exist_ok=True)
    cwd = p / 'cwd'
    if cwd.is_symlink(): cwd.unlink()
    cwd.symlink_to(release / 'research-dashboard')
    command = str(root / 'dashboard/current/research-dashboard/server.py')
    if opts.get('wrong_command'): command += '.wrong'
    (p / 'cmdline').write_bytes(('python3\0' + command + '\0').encode())
    fd = p / 'fd/10'
    if fd.is_symlink(): fd.unlink()
    fd.symlink_to('socket:[500]')
    inode = '999' if opts.get('foreign_listener') else '500'
    (p / 'net/tcp').write_text('header\n0: 0100007F:46AA 00000000:0000 0A 0 0 0 0 0 ' + inode + '\n')
    if opts.get('missing_proc'): (p / 'cmdline').unlink()

def start():
    release = (root / 'dashboard/current').resolve(strict=True)
    s['pid'] += 1
    if not opts.get('unchanged_start'): s['started'] += 100
    s['active'] = True
    s['runtime'] = str(release)
    cwd_release = root / 'dashboard/releases' / ('b' * 40) if opts.get('wrong_cwd') else release
    proc(s['pid'], cwd_release)
    if opts.get('zero_pid'): s['pid'] = 0
    save()

if name == 'id':
    print('0' if args == ['-u'] else 'uid=123(investment-research)')
elif name == 'df':
    print('Filesystem 1B-blocks Used Available Use% Mounted\nfixture 9999999999 1 9999999998 1% /')
elif name == 'runuser':
    command = args[args.index('--') + 1:]
    if command[:2] == ['test', '-r']:
        assert safe(command[2]).is_dir()
    else:
        assert command[:2] == ['env', '-i'] and 'python3' in command
elif name in ('sudo', 'ssh', 'scp', 'rsync', 'docker', 'pm2', 'psql'):
    raise RuntimeError('forbidden host command')
elif name == 'systemctl':
    event()
    assert args[0] == 'daemon-reload' or 'research-dashboard.service' in args
    cmd = args[0]
    if cmd == 'is-active': sys.exit(0 if s['active'] else 3)
    elif cmd == 'is-enabled': sys.exit(0 if s['enabled'] else 1)
    elif cmd == 'show':
        if '--property=MainPID' in args: print(s['pid'] if s['active'] else 0)
        elif '--property=ExecMainStartTimestampMonotonic' in args: print(s['started'])
        else: print('ActiveState=' + ('active' if s['active'] else 'inactive'))
    elif cmd == 'enable':
        s['enabled'] = True
        save()
        if '--now' in args and not s['active']: start()
    elif cmd == 'restart':
        s['restarts'] += 1
        save()
        if opts.get('restart_fail') and s['restarts'] == 1: sys.exit(1)
        if opts.get('leave_inactive') and s['restarts'] == 1:
            s['active'] = False
            save()
        elif not opts.get('no_replace') or s['restarts'] > 1: start()
    elif cmd == 'disable':
        s['enabled'] = False
        if '--now' in args: s['active'] = False
        save()
    elif cmd == 'daemon-reload': pass
    else: raise RuntimeError('unexpected systemctl operation')
elif name == 'git':
    event()
    if args[0] == '-C' and args[2:] == ['rev-parse', 'HEAD']:
        print((safe(args[1]) / '.sha').read_text().strip())
    else:
        # Fixtures use pre-existing releases. Never fall back to real network.
        raise RuntimeError('unexpected git operation')
elif name == 'curl':
    event()
    assert '-X' not in args and '--request' not in args
    url = next(a for a in args if a.startswith('http:'))
    assert url in ('http://127.0.0.1:18090/api/health', 'http://127.0.0.1:18090/api/research/overview')
    output = safe(args[args.index('-o') + 1])
    health = url.endswith('/api/health')
    if opts.get('health_timeout') and health: sys.exit(28)
    if opts.get('overview_http_fail') and not health: sys.exit(22)
    if health:
        data = dict(ok=True, service='investment-research-dashboard', readOnly=True,
                    liveTrading=False, privateApi=False, orderAuthority=False)
        if opts.get('unsafe_health'): data['liveTrading'] = True
    else:
        data = json.loads((root / 'overview.json').read_text())
        if Path(s['runtime']).name != 'a' * 40: data['research'].pop('liquidityIndependence', None)
    output.write_text('invalid-json' if opts.get('invalid_json') and not health else json.dumps(data))
    if not health and opts.get('pid_drift'): start()
    if not health and opts.get('symlink_drift'):
        current = root / 'dashboard/current'
        current.unlink()
        current.symlink_to(root / 'dashboard/releases' / ('b' * 40))
elif name in ('journalctl', 'sleep'):
    event()
elif name in ('install', 'rm', 'ln', 'mv', 'chown'):
    event()
    paths = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in ('-o', '-g', '-m'): i += 2; continue
        if name == 'chown' and ':' in a: i += 1; continue
        if not a.startswith('-'): paths.append(safe(a))
        i += 1
    if name == 'install':
        if '-d' in args:
            for p in paths: p.mkdir(parents=True, exist_ok=True)
        else:
            assert len(paths) == 2
            shutil.copyfile(*paths)
    elif name == 'rm':
        for p in paths:
            if p.is_symlink() or p.is_file(): p.unlink()
            elif p.is_dir(): shutil.rmtree(p)
    elif name == 'ln':
        assert len(paths) == 2
        dest = paths[1]
        if dest.is_symlink() or dest.is_file(): dest.unlink()
        dest.symlink_to(paths[0])
    elif name == 'mv':
        assert len(paths) == 2
        os.replace(*paths)
    elif name == 'chown': pass
else:
    raise RuntimeError('unexpected shim command')
`;

function runScenario(options = {}, response = overview(), mode = 'activate') {
  const root = mkdtempSync(join(tmpdir(), 'research-activation-test-'));
  const dashboard = join(root, 'dashboard');
  const oldRelease = join(dashboard, 'releases', previous);
  const newRelease = join(dashboard, 'releases', target);
  const initiallyActive = options.active !== false;
  const initiallyEnabled = options.enabled !== false;
  try {
    for (const release of [oldRelease, newRelease]) {
      mkdirSync(join(release, 'research-dashboard/deploy'), { recursive: true });
      mkdirSync(join(release, 'research-dashboard/public'), { recursive: true });
      writeFileSync(join(release, '.sha'), release === newRelease ? target : previous);
      writeFileSync(join(release, 'research-dashboard/server.py'), '# fixture only\n');
      writeFileSync(join(release, 'research-dashboard/v3_independence.py'), '# fixture only\n');
      writeFileSync(join(release, 'research-dashboard/public/index.html'), 'fixture');
      writeFileSync(join(release, 'research-dashboard/deploy/research-dashboard.service'), 'new-unit');
    }
    for (const name of ['bin', 'tmp', 'home', 'etc', 'research-state/forward/liquidity', 'app/.deploy', 'research-release']) {
      mkdirSync(join(root, name), { recursive: true });
    }
    const current = join(dashboard, 'current');
    const initialRelease = options.same_release ? newRelease : oldRelease;
    if (!options.first_install) {
      symlinkSync(initialRelease, current);
      writeFileSync(join(root, 'etc/research-dashboard.service'), 'old-unit');
    }
    symlinkSync(join(root, 'research-release'), join(root, 'research-current'));
    writeFileSync(join(root, 'app/.deploy/current-sha'), 'c'.repeat(40));
    const stateFile = join(root, 'research-state/forward/liquidity/v3-authoritative-independence-summary.json');
    const fixture = JSON.stringify({ fixture: true, neverEconomicCredit: true });
    writeFileSync(stateFile, fixture);
    writeFileSync(join(root, 'service.json'), JSON.stringify({ active: initiallyActive,
      enabled: initiallyEnabled, pid: 100, started: options.invalid_initial_start ? 0 : 100,
      restarts: 0, runtime: initialRelease }));
    writeFileSync(join(root, 'options.json'), JSON.stringify(options));
    writeFileSync(join(root, 'overview.json'), JSON.stringify(response));
    writeFileSync(join(root, 'shim.py'), shim, { mode: 0o755 });
    for (const name of ['id', 'df', 'runuser', 'sudo', 'systemctl', 'git', 'curl', 'journalctl', 'sleep',
      'install', 'rm', 'ln', 'mv', 'chown', 'ssh', 'scp', 'rsync', 'docker', 'pm2', 'psql']) {
      symlinkSync(join(root, 'shim.py'), join(root, 'bin', name));
    }
    const roots = [
      ['/opt/investment-research-dashboard', dashboard],
      ['/var/lib/investment-research-production', join(root, 'research-state')],
      ['/opt/stock-app', join(root, 'app')],
      ['/opt/investment-research/current', join(root, 'research-current')],
      ['/etc/systemd/system', join(root, 'etc')],
      ['/proc/', join(root, 'proc') + '/'],
    ];
    let sandboxSource = source;
    for (const [from, to] of roots) sandboxSource = sandboxSource.replaceAll(from, to);
    assert.doesNotMatch(sandboxSource, /\/opt\/(stock-app|investment-research)|\/var\/lib\/investment|\/etc\/systemd|[\'\"]\/proc\//);
    const entry = join(root, 'activate.sh');
    writeFileSync(entry, sandboxSource);
    const result = spawnSync('/bin/bash', [entry, mode], {
      cwd: root, timeout: 15000, encoding: 'utf8',
      env: { PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
        TARGET_SHA: target, HARNESS_ROOT: root, TMPDIR: join(root, 'tmp'), HOME: join(root, 'home'), LANG: 'C.UTF-8' },
    });
    assert.equal(result.error, undefined, result.error?.message);
    const service = JSON.parse(readFileSync(join(root, 'service.json'), 'utf8'));
    const events = existsSync(join(root, 'events.jsonl'))
      ? readFileSync(join(root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    assert.equal(readFileSync(stateFile, 'utf8'), fixture, 'no canonical research data writes');
    assert.equal(readFileSync(join(root, 'app/.deploy/current-sha'), 'utf8'), 'c'.repeat(40), 'app SHA preserved');
    assert.equal(readlinkSync(join(root, 'research-current')), join(root, 'research-release'), 'Research release preserved');
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'overview.json'), 'utf8')), response, 'observed values not fabricated');
    const unit = join(root, 'etc/research-dashboard.service');
    return { ...result, service, events, newRelease, initialRelease,
      current: existsSync(current) ? readlinkSync(current) : null,
      unit: existsSync(unit) ? readFileSync(unit, 'utf8') : null,
      tmpFiles: readdirSync(join(root, 'tmp')),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectSuccess(options = {}, response = overview()) {
  const r = runScenario(options, response);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RESEARCH_DASHBOARD_ACTIVATED=true/);
  assert.match(r.stdout, /RUNTIME_RELEASE_IDENTITY_VERIFIED=true/);
  assert.match(r.stdout, /RUNTIME_IDENTITY=[1-9][0-9]*:[1-9][0-9]*/);
  assert.equal(r.current, r.newRelease);
  assert.equal(r.service.runtime, r.newRelease);
  assert.equal(r.service.restarts, 1);
  assert.equal(r.service.active, true);
  assert.equal(r.service.enabled, true);
  assert.deepEqual(r.tmpFiles, [], 'runner probe/backup temporary files are cleaned');
  return r;
}

function expectRollback(options = {}, response = overview()) {
  const r = runScenario(options, response);
  assert.notEqual(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /RESEARCH_DASHBOARD_ACTIVATED=true/);
  assert.doesNotMatch(r.stderr, /unbound variable/);
  assert.equal(r.current, options.first_install ? null : r.initialRelease, 'previous release restored');
  assert.equal(r.unit, options.first_install ? null : 'old-unit', 'previous unit restored');
  assert.equal(r.service.active, options.active !== false, 'previous running state restored');
  assert.equal(r.service.enabled, options.enabled !== false, 'previous enablement restored');
  assert.deepEqual(r.tmpFiles, [], 'failed probe/backup temporary files are cleaned');
  return r;
}

test('active old process is replaced, not merely enabled', () => expectSuccess());
test('inactive service starts the target release', () => expectSuccess({ active: false, enabled: false }));
test('same-release activation still requires a fresh process', () => expectSuccess({ same_release: true }));
test('first install starts without inventing a previous release', () => expectSuccess({ first_install: true, active: false, enabled: false }));
for (const status of ['MISSING', 'INVALID']) {
  test(`honest ${status} consumer remains ${status}, not fake PRESENT or zero`, () => {
    const r = expectSuccess({}, overview(status));
    assert.match(r.stdout, new RegExp(`V3_CONSUMER_STATUS=${status}`));
  });
}
test('PRESENT counts are not pinned to 15 or another historical sample', () => expectSuccess({}, overview('PRESENT', 73)));
for (const fault of ['restart_fail', 'leave_inactive', 'no_replace', 'unchanged_start', 'wrong_cwd', 'wrong_command',
  'foreign_listener', 'missing_proc', 'zero_pid', 'pid_drift', 'symlink_drift', 'health_timeout', 'overview_http_fail',
  'invalid_json', 'unsafe_health']) {
  test(`${fault}: fail closed and restore the active previous release`, () => expectRollback({ [fault]: true }));
}
for (const [label, consumer] of [['absent', undefined], ['null', null], ['array', []], ['unknown-status', { status: 'READY', present: true }],
  ['wrong-presence', { status: 'PRESENT', present: false }], ['invalid-presence', { status: 'INVALID', present: false }]]) {
  test(`reject ${label} V3 consumer instead of publishing activation success`, () => {
    const v = overview();
    if (consumer === undefined) delete v.research.liquidityIndependence;
    else v.research.liquidityIndependence = consumer;
    expectRollback({}, v);
  });
}
for (const [label, modify] of [
  ['schema', v => { v.schemaVersion = 'wrong'; }],
  ['read-only', v => { v.safety.readOnlyDashboard = false; }],
  ['trading', v => { v.safety.liveTrading = true; }],
  ['private-api', v => { v.safety.privateApi = true; }],
  ['order-authority', v => { v.safety.orderAuthority = true; }],
  ['profitability', v => { v.profitability.proven = true; }],
]) {
  test(`existing ${label} safety check is retained`, () => {
    const v = overview(); modify(v); expectRollback({}, v);
  });
}
test('rollback restores active but originally disabled unit', () => expectRollback({ enabled: false, restart_fail: true }));
test('rollback restores inactive but enabled unit', () => expectRollback({ active: false, enabled: true, restart_fail: true }));
test('failed first install removes new link/unit and leaves service stopped', () => expectRollback({ first_install: true, active: false, enabled: false, restart_fail: true }));
test('unproven previous start time blocks before lifecycle mutation', () => {
  const r = runScenario({ invalid_initial_start: true });
  assert.notEqual(r.status, 0);
  assert.equal(r.service.restarts, 0);
  assert.equal(r.current, r.initialRelease);
});
test('preflight never starts, enables, restarts, or switches a release', () => {
  const r = runScenario({}, overview(), 'preflight');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RESEARCH_DASHBOARD_PREFLIGHT=PASS/);
  assert.equal(r.service.restarts, 0);
  assert.equal(r.current, r.initialRelease);
  assert.equal(r.events.filter(e => e[0] === 'systemctl').length, 0);
});
