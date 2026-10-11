// Run over protected SSH stdin. No files, services, policies, or provider calls
// are changed. Collect every independent check, rather than failing at the first.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as util from 'node:util';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

const STATE = '/var/lib/investment-research-production';
const ROOT = '/opt/investment-research';
const ENV_ROOT = '/etc/investment-research';
const APP = '/opt/stock-app';
const parseEnv = util.parseEnv;
const { resolve, isAbsolute } = posix;
const SHA = /^[a-f0-9]{40}$/u;
const KEY = /^[A-Za-z0-9_.-]{8,512}$/u;
const GUARDS = ['LIVE_TRADING', 'LIVE_TRADING_ENABLED', 'REAL_ORDER_ENABLED',
  'REAL_TRADING_ENABLED', 'PRIVATE_API_ENABLED', 'PRIVATE_ACCOUNT_ACCESS',
  'PRIVATE_TRADING_API_ALLOWED', 'ORDER_AUTHORITY', 'ORDER_SUBMISSION_ENABLED'];
const PROVIDERS = ['YOUTUBE_DATA_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY'];
const PROVIDER_ALLOWLIST = [...PROVIDERS, 'GEMINI_MODEL', 'GROQ_MODEL'];
const INPUTS = ['RESEARCH_ADAPTIVE_POLICY_RECORD_PATH', 'RESEARCH_DATA_FACTORY_EVIDENCE_PATH',
  'RESEARCH_ADAPTIVE_EVIDENCE_CATALOG_PATH', 'RESEARCH_ADAPTIVE_DEVELOPMENT_DIAGNOSTICS_PATH',
  'RESEARCH_ADAPTIVE_RUNTIME_BINDINGS_PATH', 'PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH'];

export function readBoundedPrivateFile(file, io = fs, maximum = 4 * 1024 * 1024) {
  const descriptor = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = io.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum
      || (before.mode & 0o022) !== 0) throw new Error('UNSAFE_INPUT');
    const text = io.readFileSync(descriptor, 'utf8');
    const after = io.fstatSync(descriptor);
    if (Buffer.byteLength(text) !== before.size || before.size !== after.size
      || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs
      || before.ino !== after.ino || before.dev !== after.dev || before.uid !== after.uid
      || after.nlink !== 1 || (after.mode & 0o022) !== 0) throw new Error('CHANGED_INPUT');
    return text;
  } finally { io.closeSync(descriptor); }
}

export function collectResearchActivationPreflight({ researchSha, appSha, io = fs,
  command = (name, args) => execFileSync(name, args, { encoding: 'utf8', timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 128 * 1024 }),
  nowMs = Date.now(), nodeVersion = process.versions.node, watchUnitDigest,
} = {}) {
  if (!SHA.test(researchSha ?? '') || !SHA.test(appSha ?? '')) throw new Error('PREFLIGHT_IDENTITY_INVALID');
  const checks = [];
  const check = (id, phase, task) => {
    try {
      const status = task();
      if (!['PASS', 'BLOCKED', 'PENDING', 'MISSING', 'INVALID', 'UNKNOWN'].includes(status)) throw new Error('INVALID_CHECK');
      checks.push({ id, phase, status });
    } catch (error) {
      // Do not include exception messages, paths, raw state, account data or keys.
      checks.push({ id, phase, status: error?.code === 'ENOENT' ? 'MISSING' : 'INVALID' });
    }
  };
  const read = (file, maximum) => readBoundedPrivateFile(file, io, maximum);
  const json = file => JSON.parse(read(file));
  const optionalEnv = file => {
    try { return parseEnv(read(file, 128 * 1024)); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  };
  const insideState = value => typeof value === 'string' && isAbsolute(value)
    && resolve(value) === value && value.startsWith(STATE + '/') && !/[\x00-\x1f\x7f]/u.test(value);
  const safeDirectory = file => {
    const meta = io.lstatSync(file);
    return meta.isDirectory() && !meta.isSymbolicLink() && (meta.mode & 0o022) === 0
      && io.realpathSync(file) === file;
  };
  const version = nodeVersion.split('.').map(Number);
  check('NODE_ENV_PARSER', 'prerequisite', () => version[0] > 20
    || version[0] === 20 && version[1] >= 12 ? 'PASS' : 'BLOCKED');
  for (const name of ['git', 'systemctl', 'systemd-analyze', 'runuser']) {
    check('TOOL_' + name.toUpperCase().replaceAll('-', '_'), 'prerequisite', () => {
      command('/bin/bash', ['-c', 'command -v "$1" >/dev/null', 'read-only-tool-check', name]);
      return 'PASS';
    });
  }
  check('APP_DEPLOY_SHA', 'prerequisite', () => read(APP + '/.deploy/current-sha').trim() === appSha ? 'PASS' : 'BLOCKED');
  check('CORE_DISK_AND_INODES', 'prerequisite', () => {
    const free = Number(command('df', ['-PB1', '/']).trim().split('\n')[1]?.trim().split(/\s+/u)[3]);
    const inodes = Number(command('df', ['-Pi', '/']).trim().split('\n')[1]?.trim().split(/\s+/u)[3]);
    return free >= 5368709120 && inodes >= 50000 ? 'PASS' : 'BLOCKED';
  });
  check('WATCH_RESOURCE_BUDGET', 'prerequisite', () => {
    const cores = Number(command('nproc', []).trim());
    const memory = Number(/^MemAvailable:\s+(\d+)/mu.exec(io.readFileSync('/proc/meminfo', 'utf8'))?.[1]);
    const load = Number(io.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
    const disk = Number(command('df', ['-Pk', STATE]).trim().split('\n')[1]?.trim().split(/\s+/u)[3]);
    return cores >= 2 && cores <= 4 && memory >= 1048576 && load >= 0 && load < 1.5
      && disk >= 5767168 ? 'PASS' : 'BLOCKED';
  });
  check('RESEARCH_STATE_DIRECTORY', 'prerequisite', () => safeDirectory(STATE) ? 'PASS' : 'BLOCKED');
  check('RESEARCH_STATE_OWNER', 'prerequisite', () => {
    const uid = Number(command('id', ['-u', 'investment-research']).trim());
    return uid > 0 && io.lstatSync(STATE).uid === uid ? 'PASS' : 'BLOCKED';
  });
  check('WATCH_INSTALLED_UNIT_COMPATIBLE', 'prerequisite', () => {
    let source;
    try { source = read('/etc/systemd/system/research-production-market-watch.service', 65536); }
    catch (error) { if (error?.code === 'ENOENT') return 'PASS'; throw error; }
    return /^[a-f0-9]{64}$/u.test(watchUnitDigest ?? '')
      && createHash('sha256').update(source).digest('hex') === watchUnitDigest ? 'PASS' : 'BLOCKED';
  });
  let env = null;
  check('RESEARCH_SAFE_ENV', 'prerequisite', () => {
    const raw = read(ENV_ROOT + '/research-production.env', 128 * 1024);
    env = parseEnv(raw);
    return GUARDS.every(key => env[key] === 'false'
      && raw.split(/\r?\n/u).filter(line => line.startsWith(key + '=')).length === 1) ? 'PASS' : 'BLOCKED';
  });
  check('CORE_CURRENT_RELEASE', 'postactivation', () =>
    io.realpathSync(ROOT + '/current') === ROOT + '/releases/' + researchSha
      && command('git', ['-c', 'safe.directory=' + ROOT + '/releases/' + researchSha,
        '-C', ROOT + '/current', 'rev-parse', 'HEAD']).trim() === researchSha ? 'PASS' : 'PENDING');

  let isolated = null;
  check('PROVIDER_ONLY_ENV_SCOPE', 'prerequisite', () => {
    isolated = optionalEnv(ENV_ROOT + '/research-providers.env');
    return !isolated || Object.keys(isolated).every(key => PROVIDER_ALLOWLIST.includes(key)) ? 'PASS' : 'BLOCKED';
  });
  // Only filesystem credential presence is inspected. No pm2 jlist (which may
  // start a daemon), no provider calls and no trading credentials are copied.
  const sources = [];
  if (isolated) sources.push(isolated);
  else for (const relative of ['.env', '.env.production', 'api-server/.env', 'api-server/.env.production']) {
    check('APP_PROVIDER_SOURCE_' + sources.length + '_' + relative.replaceAll(/[^A-Z0-9]/giu, '_').toUpperCase(), 'prerequisite', () => {
      const candidate = optionalEnv(APP + '/' + relative);
      if (candidate) sources.push(candidate);
      return 'PASS';
    });
  }
  for (const [provider, keys] of [['YOUTUBE', ['YOUTUBE_DATA_API_KEY']],
    ['GEMINI', ['GEMINI_API_KEY', 'GOOGLE_API_KEY']], ['GROQ', ['GROQ_API_KEY']]]) {
    check('PROVIDER_' + provider, 'prerequisite', () => {
      const values = [...new Set(sources.flatMap(source => keys.map(key => source[key]?.trim()).filter(Boolean)))];
      return values.length === 0 ? 'MISSING' : values.length === 1 && KEY.test(values[0]) ? 'PASS' : 'BLOCKED';
    });
  }
  check('FREE_AI_POLICY', 'postactivation', () => {
    const ai = optionalEnv(ENV_ROOT + '/research-ai.env');
    return ai?.RESEARCH_AI_FREE_TIER_CONFIRMED === 'true' && ['groq', 'gemini'].includes(ai?.AI_CHAT_PROVIDER)
      && Number(ai?.RESEARCH_AI_MAX_CALLS_PER_SCAN ?? 3) >= 1
      && Number(ai?.RESEARCH_AI_MAX_CALLS_PER_SCAN ?? 3) <= 3 ? 'PASS' : 'PENDING';
  });
  check('VIDEO_POLICY', 'postactivation', () => optionalEnv(ENV_ROOT + '/research-video.env')
    ?.RESEARCH_VIDEO_DISCOVERY_APPROVED === 'true' ? 'PASS' : 'PENDING');
  check('SHARED_APP_AI_CONSENT_IDENTITY', 'functionality', () => {
    const value = json(ENV_ROOT + '/research-free-confirmation.json');
    return value.schemaVersion === 'research-free-owner-confirmation-v1' && value.targetSha === appSha
      && value.freeOnlyConfirmed === true && value.executionAuthority === 'NONE' && value.paidFallback === false
      ? 'UNKNOWN' : 'BLOCKED'; // app process policy/provider state still needs authenticated readback
  });
  check('DASHBOARD_PYTHON_RUNTIME', 'prerequisite', () => {
    command('python3', ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)']);
    return 'PASS';
  });
  check('DASHBOARD_CURRENT_RELEASE', 'postactivation', () =>
    io.realpathSync('/opt/investment-research-dashboard/current') === '/opt/investment-research-dashboard/releases/' + researchSha
      ? 'PASS' : 'PENDING');
  check('APP_RESEARCH_BUNDLE_STORE_CONFIGURATION', 'functionality', () => {
    const values = [];
    for (const relative of ['.env','.env.production','api-server/.env','api-server/.env.production']) {
      const candidate = optionalEnv(APP + '/' + relative)?.RESEARCH_BUNDLE_STATE_ROOT;
      if (candidate) values.push(candidate);
    }
    const roots = [...new Set(values)];
    if (roots.length === 0) return 'MISSING';
    return roots.length === 1 && (roots[0] === STATE || insideState(roots[0]))
      && safeDirectory(roots[0]) ? 'UNKNOWN' : 'BLOCKED';
  });
  for (const key of INPUTS) check(key, 'functionality', () => {
    const file = env?.[key];
    if (!file) return 'MISSING';
    if (!insideState(file) || io.realpathSync(file) !== file) return 'BLOCKED';
    const value = json(file);
    // Presence/JSON validity is not digest, approval, cost or dataset admission.
    return value && typeof value === 'object' && !Array.isArray(value) ? 'UNKNOWN' : 'INVALID';
  });
  for (const market of ['KR_STOCK', 'US_STOCK']) check('STOCK_INPUT_' + market, 'functionality', () => {
    const value = json(STATE + '/market-watch-input/' + market + '.json');
    const age = nowMs - Date.parse(value.asOf);
    return value.schemaVersion === 'research-stock-public-snapshot-v1' && value.market === market
      && age >= -5000 && age <= 180000 && Array.isArray(value.quotes) && value.quotes.length > 0
      ? 'UNKNOWN' : 'BLOCKED'; // producer/rights/roster remain independently unverified
  });
  for (const profile of ['forward', 'fast-historical', 'long-history']) check('CURRENT_CYCLE_' + profile.toUpperCase().replaceAll('-', '_'), 'postactivation', () => {
    const value = json(STATE + '/latest/' + profile + '.json');
    return value.schemaVersion === 'research-production-cycle-v1' && value.researchSha === researchSha
      && ['complete', 'partial_failure', 'blocked_data'].includes(value.status) ? 'PASS' : 'PENDING';
  });
  for (const [id, file] of [['FACTORY', 'latest/research-factory.json'], ['AI_REVIEW', 'ai-review/latest.json'],
    ['VIDEO_DISCOVERY', 'video-research/latest.json'], ['PAPER_LOOP', 'forward/paper/state/recurring-paper-loop.json']]) {
    check(id + '_FUNCTIONAL_EVIDENCE', 'functionality', () => {
      const value = json(STATE + '/' + file);
      return (value.researchSha ?? value.identity?.researchCodeSha) === researchSha ? 'UNKNOWN' : 'PENDING';
    });
  }
  for (const unit of ['fast-historical.timer', 'long-history.timer', 'forward.timer', 'temporal-evidence.timer',
    'factory-status.timer', 'maintenance.timer', 'ai-review.timer', 'video-discovery.timer',
    'approved-job-intake.timer', 'workspace-worker.service', 'market-watch.service']) {
    check('UNIT_' + unit.toUpperCase().replaceAll(/[^A-Z0-9]/gu, '_'), 'postactivation', () => {
      const value = command('systemctl', ['show', 'research-production-' + unit,
        '--property=ActiveState', '--property=UnitFileState']).trim();
      return value.split('\n').includes('ActiveState=active') && value.split('\n').includes('UnitFileState=enabled')
        ? 'PASS' : 'PENDING';
    });
  }
  const prerequisiteBlockers = checks.filter(check => check.phase === 'prerequisite' && check.status !== 'PASS').map(check => check.id);
  const remainingChecks = checks.filter(check => check.phase !== 'prerequisite' && check.status !== 'PASS').map(check => check.id);
  return {
    schemaVersion: 'research-activation-preflight-v1', researchSha, appSha,
    observedAt: new Date(nowMs).toISOString(), checks, prerequisiteBlockers, remainingChecks,
    prerequisitesReady: prerequisiteBlockers.length === 0,
    fullyFunctional: false, closedLoopProven: false, profitabilityProven: false,
    credentialsExposed: false, executionAuthority: 'NONE',
    serverFilesWritten: 0, processRestarts: 0, databaseMutations: 0, policyMutations: 0,
    providerCalls: 0, providerPrivateRequests: 0, orders: 0,
  };
}
