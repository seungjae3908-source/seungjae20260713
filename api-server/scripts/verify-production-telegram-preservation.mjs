import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

// Execute the real deployment branches with local-only PM2/filesystem/probe doubles.
// Never execute the complete deployment script, SSH, an application server or a send.
const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'ops/deploy-production.sh'), 'utf8').replaceAll('\r\n', '\n');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const between = (start, end, offset = 0) => {
  const first = source.indexOf(start, offset);
  const last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `deployment boundary missing: ${start}`);
  return source.slice(first, last);
};
const helperStart = source.includes('read_telegram_activation_state()')
  ? 'read_telegram_activation_state()' : 'telegram_runtime_activation_ready()';
const helpers = between(helperStart, 'restore_backup()');
const rollback = between('restore_backup()', 'FREE_KB=');
const sameTarget = between('if [[ "$CURRENT_SHA" == "$TARGET_SHA" ]]', 'mkdir -p "$RELEASE_DIR"');
const promotion = between('set +e', 'echo "[deploy] production deployment succeeded:', source.indexOf('canary passed;'));
const capture = between('TELEGRAM_PREDEPLOY_STATE="$(read_telegram_activation_state)"', 'if [[ "$CURRENT_SHA" == "$TARGET_SHA" ]]');
const target = 'a'.repeat(40);
const previous = 'b'.repeat(40);
const state = (approved, worker, extra = {}) => [{ name: 'stock-app', pm2_env: {
  status: 'online', DEPLOY_SHA: previous,
  ...(approved === undefined ? {} : { LIVE_TELEGRAM_ACTIVATION_APPROVED: approved }),
  ...(worker === undefined ? {} : { TELEGRAM_INTELLIGENCE_WORKER_ENABLED: worker }), ...extra,
} }];

const doubles = String.raw`
PATH="/usr/bin:$PATH"; export PATH
pm2() {
  case "$1" in
    jlist) command node -e 'process.stdout.write(require("node:fs").readFileSync(process.env.PM2_FIXTURE, "utf8"))' ;;
    restart)
      [[ "$2" == stock-app && "$3" == --update-env ]] || return 91
      command node - <<'MOCK_NODE'
const fs = require('node:fs');
const keys = ['LIVE_TELEGRAM_ACTIVATION_APPROVED', 'TELEGRAM_INTELLIGENCE_WORKER_ENABLED',
  'LIVE_TRADING', 'AUTO_TRADING', 'REAL_ORDER_ENABLED', 'PRIVATE_TRADING_API_ALLOWED', 'executionAuthority', 'DEPLOY_SHA'];
const values = Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));
fs.appendFileSync(process.env.PM2_EVENTS, JSON.stringify({ kind: 'restart', ...values }) + '\n');
const rows = JSON.parse(fs.readFileSync(process.env.PM2_FIXTURE, 'utf8'));
Object.assign(rows[0].pm2_env, values, { status: 'online' });
fs.writeFileSync(process.env.PM2_FIXTURE, JSON.stringify(rows));
MOCK_NODE
      ;;
    save) return 0 ;;
    *) echo 'unexpected mocked PM2 operation' >&2; return 92 ;;
  esac
}
sync_source_tree() { :; }
cp() { :; }
rm() { :; }
mkdir() { :; }
pnpm() { :; }
HEALTH_CALLS=0
probe_health() {
  HEALTH_CALLS=$((HEALTH_CALLS + 1))
  if [[ "$STALE_FIRST_HEALTH" == true && "$HEALTH_CALLS" == 1 ]]; then return 1; fi
  if [[ "$FAIL_TARGET_HEALTH" == true && "$2" == "$TARGET_SHA" ]]; then return 1; fi
  return 0
}
probe_data() { return 0; }
`;

function run(fragment, { rows = state('false', 'false'), same = false, stale = false,
  failTarget = false, before = '', ambient = 'true', canary = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-preservation-'));
  try {
    for (const name of ['live/.deploy', 'release/api-server/dist', 'backup/source', 'backup/api-server-dist', 'backup/stock-analyzer-dist']) {
      fs.mkdirSync(path.join(temp, name), { recursive: true });
    }
    const marker = path.join(temp, 'live/.deploy/current-sha');
    fs.writeFileSync(marker, same ? target : previous);
    fs.writeFileSync(path.join(temp, 'pm2.json'), JSON.stringify(rows));
    fs.writeFileSync(path.join(temp, 'canary.env'), 'LIVE_TELEGRAM_ACTIVATION_APPROVED=true\nTELEGRAM_INTELLIGENCE_WORKER_ENABLED=true\n');
    fs.writeFileSync(path.join(temp, 'release/api-server/dist/index.mjs'), `import fs from 'node:fs';
      fs.appendFileSync(process.env.PM2_EVENTS, JSON.stringify({ kind: 'canary',
        approved: process.env.LIVE_TELEGRAM_ACTIVATION_APPROVED,
        worker: process.env.TELEGRAM_INTELLIGENCE_WORKER_ENABLED }) + '\\n');`);
    const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        TEMP: temp, TMP: temp, TMPDIR: temp,
        PM2_FIXTURE: path.join(temp, 'pm2.json'), PM2_EVENTS: path.join(temp, 'events.jsonl'),
        PM2_NAME: 'stock-app', TARGET_SHA: target, CURRENT_SHA: same ? target : previous,
        LIVE_DIR: path.join(temp, 'live'), RELEASE_DIR: path.join(temp, 'release'),
        BACKUP_DIR: path.join(temp, 'backup'), DEPLOY_STATE_DIR: path.join(temp, 'live/.deploy'),
        LIVE_PORT: '8080', CANARY_PORT: '18081', CANARY_ENV: path.join(temp, 'canary.env'),
        PUBLIC_BASE_URL: '', STALE_FIRST_HEALTH: String(stale), FAIL_TARGET_HEALTH: String(failTarget),
        // A caller's true values must never override the recorded PM2 false state.
        LIVE_TELEGRAM_ACTIVATION_APPROVED: ambient, TELEGRAM_INTELLIGENCE_WORKER_ENABLED: ambient,
      },
      input: `set -Eeuo pipefail\n${doubles}\n${helpers}\n${rollback}\n${canary ? '' : capture}${before}\n${fragment}\n`,
    });
    assert.ifError(result.error);
    return { ...result, marker: fs.readFileSync(marker, 'utf8').trim(),
      events: fs.existsSync(path.join(temp, 'events.jsonl'))
        ? fs.readFileSync(path.join(temp, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

let checks = 0;
const failures = [];
function check(name, fn) {
  try { fn(); checks++; console.log(`[telegram-preservation] PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`[telegram-preservation] FAIL ${name}: ${error.message}`); }
}
function assertFlags(event, expected) {
  assert.equal(event.LIVE_TELEGRAM_ACTIVATION_APPROVED, expected);
  assert.equal(event.TELEGRAM_INTELLIGENCE_WORKER_ENABLED, expected);
}
function success(result) { assert.equal(result.status, 0, result.stderr || result.stdout); }

check('already-active healthy app accepts Telegram OFF without restart', () => {
  const result = run(sameTarget, { same: true });
  success(result); assert.deepEqual(result.events, []); assert.equal(result.marker, target);
});
check('already-active stale application refresh preserves false despite ambient true', () => {
  const result = run(sameTarget, { same: true, stale: true });
  success(result); assert.equal(result.events.length, 1); assertFlags(result.events[0], 'false');
});
check('new final cutover preserves false/false and target identity', () => {
  const result = run(promotion);
  success(result); assert.equal(result.events.length, 1); assertFlags(result.events[0], 'false');
  assert.equal(result.events[0].DEPLOY_SHA, target); assert.equal(result.marker, target);
});
check('explicit pre-active PM2 state is preserved, not copied from caller env', () => {
  const result = run(promotion, { rows: state('true', 'true'), ambient: 'false' });
  success(result); assert.equal(result.events.length, 1); assertFlags(result.events[0], 'true');
});
check('rollback preserves previous SHA and false state after failed promotion', () => {
  const result = run(promotion, { failTarget: true });
  assert.equal(result.status, 13, result.stderr); assert.equal(result.events.length, 2);
  result.events.forEach(event => assertFlags(event, 'false'));
  assert.equal(result.events[1].DEPLOY_SHA, previous); assert.equal(result.marker, previous);
});
check('pre-active rollback preserves recorded state', () => {
  const result = run(promotion, { rows: state('true', 'true'), failTarget: true, ambient: 'false' });
  assert.equal(result.status, 13, result.stderr); assert.equal(result.events.length, 2);
  result.events.forEach(event => assertFlags(event, 'true'));
  assert.equal(result.events[1].DEPLOY_SHA, previous);
});
check('missing state never defaults true', () => {
  const result = run(promotion, { rows: state(undefined, undefined) });
  success(result); assert.equal(result.events.length, 1); assertFlags(result.events[0], 'false');
});
check('malformed, mixed, unavailable and ambiguous states fail before restart', () => {
  for (const rows of [state('TRUE', 'true'), state('false', 'true'), state('true', undefined),
    state(null, null), state(1, 1), {}, [], [...state('false', 'false'), ...state('true', 'true')]]) {
    const result = run(promotion, { rows });
    assert.notEqual(result.status, 0); assert.deepEqual(result.events, []);
  }
});
check('disable during deployment cannot be undone by final cutover or rollback', () => {
  const disable = `command node -e 'require("node:fs").writeFileSync(process.env.PM2_FIXTURE, JSON.stringify(${JSON.stringify(state('false', 'false'))}))'`;
  for (const failTarget of [false, true]) {
    const result = run(promotion, { rows: state('true', 'true'), before: disable, failTarget });
    assert.equal(result.status, failTarget ? 13 : 0, result.stderr);
    assert.equal(result.events.length, failTarget ? 2 : 1);
    result.events.forEach(event => assertFlags(event, 'false'));
  }
});
check('canary launch overrides even a true/true env file', () => {
  const launch = between('nohup env PORT="$CANARY_PORT"', '>"$CANARY_LOG"');
  const result = run(`cd "$RELEASE_DIR/api-server"\nnohup() { "$@"; }\n${launch}`, { canary: true });
  success(result); assert.deepEqual(result.events, [{ kind: 'canary', approved: 'false', worker: 'false' }]);
});
check('every application restart retains zero trading authority', () => {
  const result = run(promotion, { failTarget: true });
  assert.equal(result.events.length, 2);
  for (const event of result.events) {
    for (const key of ['LIVE_TRADING', 'AUTO_TRADING', 'REAL_ORDER_ENABLED', 'PRIVATE_TRADING_API_ALLOWED']) assert.equal(event[key], 'false');
    assert.equal(event.executionAuthority, 'NONE');
  }
});
check('generic deploy contains no literal true assignment or Telegram-active health gate', () => {
  assert.doesNotMatch(source, /(?:LIVE_TELEGRAM_ACTIVATION_APPROVED|TELEGRAM_INTELLIGENCE_WORKER_ENABLED)=["']?true\b/);
  assert(!source.includes('telegram_runtime_activation_ready'));
});

const telegramWorkflow = fs.readFileSync(path.join(root, '.github/workflows/telegram-production-release.yml'), 'utf8');
const activationStart = telegramWorkflow.indexOf('function activateApprovedTelegram(');
const activationEnd = telegramWorkflow.indexOf('const activationChanged =', activationStart);
assert(activationStart >= 0 && activationEnd > activationStart, 'canonical Telegram-only activation seam missing');
const activationFunction = telegramWorkflow.slice(activationStart, activationEnd);
const readyRuntime = { ...state('false', 'false')[0].pm2_env, DEPLOY_SHA: target,
  TELEGRAM_BOT_TOKEN: 'test-only-not-a-token', TELEGRAM_CHAT_ID: 'test-only-not-a-destination' };
function activation(runtime, { sha = target, marker = target, commentId = '123' } = {}) {
  const calls = [];
  const activate = vm.runInNewContext(`(${activationFunction.trim()})`, {
    process: { env: {} }, execFileSync: (...args) => { calls.push(args); return ''; },
  });
  let result, error;
  try { result = activate(runtime, sha, marker, commentId); } catch (caught) { error = caught; }
  return { calls, result, error };
}
check('only canonical Telegram seam creates activation after exact approval identity', () => {
  const result = activation(readyRuntime);
  assert.ifError(result.error); assert.equal(result.result, true); assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0][0], 'pm2');
  assert.deepEqual(Array.from(result.calls[0][1]), ['restart', 'stock-app', '--update-env']);
  const env = result.calls[0][2].env;
  assertFlags(env, 'true');
  for (const key of ['LIVE_TRADING', 'AUTO_TRADING', 'REAL_ORDER_ENABLED', 'PRIVATE_TRADING_API_ALLOWED']) assert.equal(env[key], 'false');
  assert.equal(env.executionAuthority, 'NONE');
});
check('Telegram seam rejects missing approval, wrong identity, mixed state and missing configuration before mutation', () => {
  for (const [runtime, options] of [
    [readyRuntime, { commentId: '' }], [readyRuntime, { sha: 'main' }], [readyRuntime, { marker: previous }],
    [{ ...readyRuntime, DEPLOY_SHA: previous }, {}], [{ ...readyRuntime, status: 'stopped' }, {}],
    [{ ...readyRuntime, TELEGRAM_INTELLIGENCE_WORKER_ENABLED: 'true' }, {}],
    [{ ...readyRuntime, LIVE_TELEGRAM_ACTIVATION_APPROVED: 'TRUE' }, {}],
    [{ ...readyRuntime, TELEGRAM_BOT_TOKEN: '' }, {}], [{ ...readyRuntime, TELEGRAM_CHAT_ID: '' }, {}],
  ]) {
    const result = activation(runtime, options);
    assert(result.error); assert.equal(result.calls.length, 0);
  }
});
check('Telegram-specific repeat approval does not restart already-active state', () => {
  const result = activation({ ...readyRuntime, LIVE_TELEGRAM_ACTIVATION_APPROVED: 'true', TELEGRAM_INTELLIGENCE_WORKER_ENABLED: 'true' });
  assert.ifError(result.error); assert.equal(result.result, false); assert.equal(result.calls.length, 0);
});

if (failures.length) throw new Error(`${failures.length} preservation regression group(s) failed: ${failures.join('; ')}`);
console.log(`[telegram-preservation] ${checks} behavioral/static regression groups passed; Production/SSH/DB/send execution=0`);
