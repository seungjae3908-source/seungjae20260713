import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_STATE_ROOT = '/var/lib/investment-research-production';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 18090;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const PROFILES = ['forward', 'fast-historical', 'long-history'];

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalIntegerCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function optionalBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

async function readJsonOptional(path) {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return null;
    if (metadata.size > MAX_JSON_BYTES) throw new Error(`state file exceeds ${MAX_JSON_BYTES} bytes`);
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`unable to read research state ${path}: ${String(error?.message ?? error).slice(0, 240)}`);
  }
}

function summarizeTask(row = {}) {
  return Object.freeze({
    id: String(row.id ?? 'unknown'),
    status: String(row.status ?? 'unknown'),
    durationMs: finiteNumber(row.durationMs),
    startedAt: finiteNumber(row.startedAt),
    endedAt: finiteNumber(row.endedAt),
    timedOut: row.timedOut === true,
  });
}

function summarizeCycle(profile, value) {
  if (!value || typeof value !== 'object') {
    return Object.freeze({
      profile,
      present: false,
      status: 'not_started',
      concurrency: null,
      taskCount: null,
      successCount: null,
      blockedDataCount: null,
      failedCount: null,
      tasks: [],
    });
  }
  const hasTaskEvidence = Array.isArray(value.results);
  const tasks = hasTaskEvidence ? value.results.map(summarizeTask) : [];
  return Object.freeze({
    profile,
    present: true,
    status: String(value.status ?? 'unknown'),
    cycleId: typeof value.cycleId === 'string' ? value.cycleId : null,
    researchSha: typeof value.researchSha === 'string' ? value.researchSha : null,
    generatedAt: finiteNumber(value.generatedAt),
    concurrency: optionalIntegerCount(value.concurrency),
    taskCount: optionalIntegerCount(value.taskCount) ?? (hasTaskEvidence ? tasks.length : null),
    successCount: optionalIntegerCount(value.successCount) ?? (hasTaskEvidence ? tasks.filter((task) => task.status === 'success').length : null),
    blockedDataCount: optionalIntegerCount(value.blockedDataCount) ?? (hasTaskEvidence ? tasks.filter((task) => task.status === 'blocked_data').length : null),
    failedCount: optionalIntegerCount(value.failedCount) ?? (hasTaskEvidence ? tasks.filter((task) => task.status === 'failed').length : null),
    tasks,
  });
}

function summarizePaperRuntime(value) {
  if (!value || typeof value !== 'object') {
    return Object.freeze({
      present: false,
      status: 'not_started',
      scheduleActive: null,
      allProvidersReady: null,
      publicForwardEvidenceAccumulating: null,
      paperTradeOutcomeAccumulating: null,
      privateRequestCount: null,
      financialMutationCount: null,
      orderCount: null,
      liveTrading: null,
      orderAuthority: null,
      safetyEvidenceComplete: true,
      lanes: [],
    });
  }
  const lanes = Array.isArray(value.lanes)
    ? value.lanes.map((lane) => ({
        market: String(lane?.market ?? lane?.lane ?? lane?.provider ?? 'unknown'),
        status: String(lane?.status ?? 'unknown'),
      }))
    : [];
  const privateRequestCount = optionalIntegerCount(value.privateRequestCount);
  const financialMutationCount = optionalIntegerCount(value.financialMutationCount);
  const orderCount = optionalIntegerCount(value.orderCount);
  const liveTrading = optionalBoolean(value.liveTrading);
  const orderAuthority = optionalBoolean(value.orderAuthority);
  const safetyEvidenceComplete = [
    privateRequestCount,
    financialMutationCount,
    orderCount,
    liveTrading,
    orderAuthority,
  ].every((item) => item !== null);
  return Object.freeze({
    present: true,
    status: String(value.status ?? 'unknown'),
    cycleId: typeof value.cycleId === 'string' ? value.cycleId : null,
    scheduleActive: optionalBoolean(value.scheduleActive),
    allProvidersReady: optionalBoolean(value.allProvidersReady),
    publicForwardEvidenceAccumulating: optionalBoolean(value.publicForwardEvidenceAccumulating),
    paperTradeOutcomeAccumulating: optionalBoolean(value.paperTradeOutcomeAccumulating),
    privateRequestCount,
    financialMutationCount,
    orderCount,
    liveTrading,
    orderAuthority,
    safetyEvidenceComplete,
    lanes,
  });
}

function summarizePaperLedger(value) {
  if (!value || typeof value !== 'object') {
    return Object.freeze({ present: false, cycleCount: null, positionCount: null, settlementCount: null });
  }
  return Object.freeze({
    present: true,
    cycleCount: Array.isArray(value.cycles) ? value.cycles.length : null,
    positionCount: Array.isArray(value.positions) ? value.positions.length : null,
    settlementCount: Array.isArray(value.settlements) ? value.settlements.length : null,
  });
}

function summarizeShadowGroups(value) {
  if (!value || typeof value !== 'object') return [];
  const source = value.groups && typeof value.groups === 'object' && !Array.isArray(value.groups)
    ? value.groups
    : value;
  const groups = [];
  for (const [name, row] of Object.entries(source)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const total = finiteNumber(row.total ?? row.totalCount ?? row.records ?? row.sampleSize);
    const settled = finiteNumber(row.settled ?? row.settledCount);
    const pending = finiteNumber(row.pending ?? row.pendingCount);
    const collapsed = row.predictionHealth?.collapsed ?? row.collapsed;
    const macroF1 = finiteNumber(row.macroF1 ?? row.metrics?.macroF1);
    const balancedAccuracy = finiteNumber(row.balancedAccuracy ?? row.metrics?.balancedAccuracy);
    if ([total, settled, pending, macroF1, balancedAccuracy].every((item) => item === null) && collapsed === undefined) continue;
    groups.push({
      name,
      total,
      settled,
      pending,
      collapsed: typeof collapsed === 'boolean' ? collapsed : null,
      macroF1,
      balancedAccuracy,
    });
  }
  return groups;
}

function countShadowRecords(value) {
  const seen = new Set();
  let foundRecords = false;
  let total = 0;
  let settled = 0;
  let pending = 0;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (Array.isArray(node.records)) {
      foundRecords = true;
      total += node.records.length;
      for (const record of node.records) {
        if (record?.status === 'settled') settled += 1;
        if (record?.status === 'pending') pending += 1;
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'records') continue;
      visit(child);
    }
  };
  visit(value);
  return Object.freeze({
    present: Boolean(value),
    totalRecords: foundRecords ? total : null,
    settledRecords: foundRecords ? settled : null,
    pendingRecords: foundRecords ? pending : null,
  });
}

function newestTimestamp(cycles) {
  return cycles.reduce((max, cycle) => Math.max(max, finiteNumber(cycle.generatedAt) ?? 0), 0) || null;
}

function sumKnownCycleCounts(cycles, key) {
  const presentCycles = cycles.filter((cycle) => cycle.present);
  if (presentCycles.some((cycle) => cycle[key] === null)) return null;
  return presentCycles.reduce((sum, cycle) => sum + (cycle[key] ?? 0), 0);
}

export async function buildResearchOverview({ stateRoot = DEFAULT_STATE_ROOT } = {}) {
  const root = resolve(stateRoot);
  const cycleValues = await Promise.all(PROFILES.map((profile) => readJsonOptional(join(root, 'latest', `${profile}.json`))));
  const cycles = cycleValues.map((value, index) => summarizeCycle(PROFILES[index], value));
  const [paperRuntimeRaw, paperLedgerRaw, shadowSummaryRaw, shadowStateRaw] = await Promise.all([
    readJsonOptional(join(root, 'forward', 'paper', 'status', 'runtime-status.json')),
    readJsonOptional(join(root, 'forward', 'paper', 'state', 'recurring-paper-loop.json')),
    readJsonOptional(join(root, 'forward', 'shadow-summary.json')),
    readJsonOptional(join(root, 'forward', 'shadow-state.json')),
  ]);

  const paperRuntime = summarizePaperRuntime(paperRuntimeRaw);
  const paperLedger = summarizePaperLedger(paperLedgerRaw);
  const shadowGroups = summarizeShadowGroups(shadowSummaryRaw);
  const shadowRecords = countShadowRecords(shadowStateRaw);
  const failedTasks = sumKnownCycleCounts(cycles, 'failedCount');
  const blockedDataTasks = sumKnownCycleCounts(cycles, 'blockedDataCount');
  const authorityEvidenceComplete = !paperRuntime.present || paperRuntime.safetyEvidenceComplete;
  const forbiddenAuthorityObserved = paperRuntime.privateRequestCount !== null && paperRuntime.privateRequestCount > 0
    || paperRuntime.financialMutationCount !== null && paperRuntime.financialMutationCount > 0
    || paperRuntime.orderCount !== null && paperRuntime.orderCount > 0
    || paperRuntime.liveTrading === true
    || paperRuntime.orderAuthority === true;
  const researchStatus = forbiddenAuthorityObserved
    ? 'safety_block'
    : !authorityEvidenceComplete
      ? 'safety_evidence_incomplete'
      : failedTasks === null || blockedDataTasks === null
        ? 'evidence_incomplete'
        : failedTasks > 0
          ? 'attention'
          : 'collecting';

  return Object.freeze({
    schemaVersion: 'research-dashboard-overview-v1',
    generatedAt: Date.now(),
    state: Object.freeze({
      present: cycles.some((cycle) => cycle.present) || paperRuntime.present || paperLedger.present || shadowRecords.present,
      latestCycleAt: newestTimestamp(cycles),
    }),
    safety: Object.freeze({
      readOnlyDashboard: true,
      liveTrading: false,
      privateApi: false,
      orderAuthority: false,
      authorityEvidenceComplete,
      forbiddenAuthorityObserved,
    }),
    research: Object.freeze({
      status: researchStatus,
      failedTasks,
      blockedDataTasks,
      cycles,
    }),
    paper: Object.freeze({ runtime: paperRuntime, ledger: paperLedger }),
    shadow: Object.freeze({ groups: shadowGroups, records: shadowRecords }),
    profitability: Object.freeze({
      proven: false,
      status: 'evidence_collection',
      note: 'Dashboard never promotes profitability by itself; promotion remains evidence-gated in the research pipeline.',
    }),
  });
}

function json(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function applySecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function resolveStaticPath(publicRoot, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = resolve(publicRoot, relative);
  const normalizedRoot = resolve(publicRoot) + sep;
  if (!(candidate + sep).startsWith(normalizedRoot) && candidate !== resolve(publicRoot)) return null;
  return candidate;
}

export function createResearchDashboardServer({ stateRoot = DEFAULT_STATE_ROOT, publicRoot = join(MODULE_DIR, 'public') } = {}) {
  return createServer(async (req, res) => {
    applySecurityHeaders(res);
    const method = req.method ?? 'GET';
    if (!['GET', 'HEAD'].includes(method)) {
      res.setHeader('allow', 'GET, HEAD');
      return json(res, 405, { ok: false, error: 'read_only_dashboard' });
    }

    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/health') {
        return json(res, 200, {
          ok: true,
          service: 'investment-research-dashboard',
          readOnly: true,
          liveTrading: false,
          privateApi: false,
          orderAuthority: false,
        });
      }
      if (url.pathname === '/api/research/overview') {
        const overview = await buildResearchOverview({ stateRoot });
        return json(res, 200, overview);
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { ok: false, error: 'not_found' });

      const filePath = resolveStaticPath(publicRoot, decodeURIComponent(url.pathname));
      if (!filePath) return json(res, 404, { ok: false, error: 'not_found' });
      let metadata;
      try {
        metadata = await stat(filePath);
      } catch (error) {
        if (error?.code === 'ENOENT') return json(res, 404, { ok: false, error: 'not_found' });
        throw error;
      }
      if (!metadata.isFile()) return json(res, 404, { ok: false, error: 'not_found' });
      const body = await readFile(filePath);
      const extension = extname(filePath);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
        'cache-control': extension === '.html' || filePath.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
        'content-length': body.length,
      });
      if (method === 'HEAD') return res.end();
      res.end(body);
    } catch (error) {
      json(res, 500, { ok: false, error: 'research_state_unavailable', detail: String(error?.message ?? error).slice(0, 240) });
    }
  });
}

export function startResearchDashboard({
  host = process.env.RESEARCH_DASHBOARD_HOST || DEFAULT_HOST,
  port = Number(process.env.RESEARCH_DASHBOARD_PORT || DEFAULT_PORT),
  stateRoot = process.env.RESEARCH_STATE_ROOT || DEFAULT_STATE_ROOT,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RESEARCH_DASHBOARD_PORT must be a valid TCP port');
  const server = createResearchDashboardServer({ stateRoot });
  server.listen(port, host, () => {
    console.log(JSON.stringify({
      service: 'investment-research-dashboard',
      host,
      port,
      stateRoot,
      readOnly: true,
      liveTrading: false,
      privateApi: false,
      orderAuthority: false,
    }));
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) startResearchDashboard();
